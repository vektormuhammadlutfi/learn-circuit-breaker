const express = require('express')
const axios = require('axios')
const jwt = require('jsonwebtoken')
const CircuitBreaker = require('opossum')
const amqp = require('amqplib')
const { Sequelize, DataTypes } = require('sequelize')
const swaggerUi = require('swagger-ui-express')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3002
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret'
const PRODUCT_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3001'
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672'
const EXCHANGE = 'ecommerce'

// ---------- Database ----------
const sequelize = new Sequelize(
  process.env.DB_NAME || 'order_db',
  process.env.DB_USER || 'postgres',
  process.env.DB_PASS || 'postgres',
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
  },
)

const Order = sequelize.define('Order', {
  userId: DataTypes.INTEGER,
  productId: DataTypes.INTEGER,
  qty: DataTypes.INTEGER,
  productName: DataTypes.STRING,
  price: DataTypes.INTEGER,
  total: DataTypes.INTEGER,
  status: DataTypes.STRING, // CONFIRMED | PENDING_VERIFICATION
  breakerState: DataTypes.STRING,
})

// ---------- Auth middleware (pertemuan 9) ----------
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: 'login dulu (token dibutuhkan)' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: 'token tidak valid' })
  }
}

// ---------- RETRY + CIRCUIT BREAKER ke product-service (pertemuan 10) ----------
async function withRetry(fn, { retries = 2, backoffMs = 200 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < retries) {
        const wait = backoffMs * 2 ** attempt
        console.warn(`[retry] percobaan ${attempt + 1} gagal (${err.message}). Ulang ${wait}ms`)
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  }
  throw lastErr
}

async function fetchProduct(productId) {
  return withRetry(async () => {
    const { data } = await axios.get(`${PRODUCT_URL}/products/${productId}`, { timeout: 2000 })
    return data
  })
}

const productBreaker = new CircuitBreaker(fetchProduct, {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 8000,
  rollingCountTimeout: 10000,
  volumeThreshold: 3,
})
productBreaker.fallback((productId) => ({
  id: productId,
  name: 'Produk (info sementara tidak tersedia)',
  price: null,
  degraded: true,
}))
productBreaker.on('open', () => console.error('[breaker] OPEN — pakai fallback'))
productBreaker.on('halfOpen', () => console.warn('[breaker] HALF_OPEN'))
productBreaker.on('close', () => console.log('[breaker] CLOSED'))

function breakerState() {
  if (productBreaker.opened) return 'OPEN'
  if (productBreaker.halfOpen) return 'HALF_OPEN'
  return 'CLOSED'
}

// ---------- RabbitMQ publisher (pertemuan 8) ----------
let channel = null
async function connectMQ() {
  // Retry tak terbatas: RabbitMQ bisa butuh >1 menit untuk siap saat first boot.
  let attempt = 0
  while (true) {
    attempt++
    try {
      const conn = await amqp.connect(RABBITMQ_URL)
      channel = await conn.createChannel()
      await channel.assertExchange(EXCHANGE, 'topic', { durable: false })
      console.log(`[mq] terhubung ke RabbitMQ (percobaan ${attempt})`)
      conn.on('close', () => {
        channel = null
        setTimeout(connectMQ, 3000)
      })
      return
    } catch (e) {
      console.log(`[mq] belum siap (percobaan ${attempt}): ${e.message}`)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}
function publishOrderCreated(order) {
  if (!channel) return console.warn('[mq] channel belum siap, event dilewati')
  channel.publish(EXCHANGE, 'order.created', Buffer.from(JSON.stringify(order)))
  console.log(`[mq] publish order.created #${order.id}`)
}

// ---------- Swagger ----------
app.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup({
    openapi: '3.0.0',
    info: {
      title: 'Order Service',
      version: '1.0.0',
      description:
        'Order microservice: pembuatan order dengan retry + circuit breaker ke product-service, dan publish event ke RabbitMQ.',
    },
    servers: [{ url: '/', description: 'Direct' }, { url: '/api/orders', description: 'Via API Gateway' }],
    tags: [{ name: 'Orders' }, { name: 'Breaker' }, { name: 'Health' }],
    paths: {
      '/health': {
        get: {
          tags: ['Health'],
          summary: 'Health check',
          responses: {
            200: {
              description: 'Service sehat',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } },
            },
          },
        },
      },
      '/breaker/stats': {
        get: {
          tags: ['Breaker'],
          summary: 'Status & statistik circuit breaker ke product-service',
          responses: {
            200: {
              description: 'Status breaker',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/BreakerStats' } } },
            },
          },
        },
      },
      '/orders': {
        get: {
          tags: ['Orders'],
          summary: 'Daftar order milik user yang sedang login',
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'Daftar order',
              content: {
                'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } },
              },
            },
            401: {
              description: 'Token tidak ada / tidak valid',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
        post: {
          tags: ['Orders'],
          summary: 'Buat order baru (mengambil data produk via circuit breaker)',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderRequest' } } },
          },
          responses: {
            201: {
              description: 'Order berhasil dibuat',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
            },
            400: {
              description: 'productId tidak diisi',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            401: {
              description: 'Token tidak ada / tidak valid',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        HealthResponse: {
          type: 'object',
          properties: {
            service: { type: 'string' },
            status: { type: 'string' },
            breaker: { type: 'string', enum: ['CLOSED', 'HALF_OPEN', 'OPEN'] },
          },
        },
        BreakerStats: {
          type: 'object',
          properties: {
            state: { type: 'string', enum: ['CLOSED', 'HALF_OPEN', 'OPEN'] },
            stats: { type: 'object', description: 'Statistik internal dari opossum (fires, failures, successes, dll)' },
          },
        },
        OrderRequest: {
          type: 'object',
          required: ['productId'],
          properties: {
            productId: { type: 'integer', example: 1 },
            qty: { type: 'integer', default: 1, example: 2 },
          },
        },
        Order: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            userId: { type: 'integer' },
            productId: { type: 'integer' },
            qty: { type: 'integer' },
            productName: { type: 'string' },
            price: { type: 'integer', nullable: true },
            total: { type: 'integer', nullable: true },
            status: { type: 'string', enum: ['CONFIRMED', 'PENDING_VERIFICATION'] },
            breakerState: { type: 'string', enum: ['CLOSED', 'HALF_OPEN', 'OPEN'] },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  }),
)

// ---------- Routes ----------
app.get('/health', (req, res) =>
  res.json({ service: 'order-service', status: 'UP', breaker: breakerState() }),
)
app.get('/breaker/stats', (req, res) =>
  res.json({ state: breakerState(), stats: productBreaker.stats }),
)

app.post('/orders', requireAuth, async (req, res) => {
  const { productId, qty = 1 } = req.body || {}
  if (!productId) return res.status(400).json({ error: 'productId wajib' })

  const product = await productBreaker.fire(productId)
  const total = product.price != null ? product.price * qty : null

  const order = await Order.create({
    userId: req.user.id,
    productId,
    qty,
    productName: product.name,
    price: product.price,
    total,
    status: product.degraded ? 'PENDING_VERIFICATION' : 'CONFIRMED',
    breakerState: breakerState(),
  })

  publishOrderCreated({ id: order.id, userId: order.userId, productName: order.productName, status: order.status })
  res.status(201).json(order)
})

app.get('/orders', requireAuth, async (req, res) =>
  res.json(await Order.findAll({ where: { userId: req.user.id }, order: [['id', 'DESC']] })),
)

// ---------- Bootstrap ----------
async function start() {
  for (let i = 1; i <= 15; i++) {
    try {
      await sequelize.authenticate()
      break
    } catch (e) {
      console.log(`[db] belum siap (${i}/15): ${e.message}`)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  await sequelize.sync()
  connectMQ() // async, tidak memblokir start
  app.listen(PORT, () =>
    console.log(`order-service listening on :${PORT} → product:${PRODUCT_URL}`),
  )
}
start()
