const express = require('express')
const jwt = require('jsonwebtoken')
const { Sequelize, DataTypes } = require('sequelize')
const swaggerUi = require('swagger-ui-express')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3001
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret'

// ---------- Database ----------
const sequelize = new Sequelize(
  process.env.DB_NAME || 'product_db',
  process.env.DB_USER || 'postgres',
  process.env.DB_PASS || 'postgres',
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
  },
)

const Product = sequelize.define('Product', {
  name: { type: DataTypes.STRING, allowNull: false },
  price: { type: DataTypes.INTEGER, allowNull: false },
  stock: { type: DataTypes.INTEGER, defaultValue: 0 },
})

// ---------- RBAC middleware (pertemuan 9) ----------
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: 'token dibutuhkan' })
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    if (payload.role !== 'admin') return res.status(403).json({ error: 'butuh role admin' })
    req.user = payload
    next()
  } catch {
    return res.status(401).json({ error: 'token tidak valid' })
  }
}

// ---------- Chaos (pertemuan 10: simulasi service failure) ----------
const chaos = { down: false, latencyMs: 0 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.get('/health', (req, res) => res.json({ service: 'product-service', status: 'UP', chaos }))
app.post('/admin/chaos', (req, res) => {
  const { down, latencyMs } = req.body || {}
  if (typeof down === 'boolean') chaos.down = down
  if (typeof latencyMs === 'number') chaos.latencyMs = latencyMs
  console.log('[chaos] state →', chaos)
  res.json({ ok: true, chaos })
})

// ---------- Swagger ----------
app.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup({
    openapi: '3.0.0',
    info: {
      title: 'Product Service',
      version: '1.0.0',
      description: 'Product microservice: katalog produk + endpoint chaos untuk simulasi kegagalan (circuit breaker demo).',
    },
    servers: [{ url: '/', description: 'Direct' }, { url: '/api/products', description: 'Via API Gateway' }],
    tags: [{ name: 'Products' }, { name: 'Admin' }, { name: 'Health' }],
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
      '/products': {
        get: {
          tags: ['Products'],
          summary: 'Daftar semua produk',
          responses: {
            200: {
              description: 'Daftar produk',
              content: {
                'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } } },
              },
            },
            503: {
              description: 'Service sedang down (mode chaos)',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
        post: {
          tags: ['Products'],
          summary: 'Buat produk baru (butuh role admin)',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ProductRequest' } } },
          },
          responses: {
            201: {
              description: 'Produk berhasil dibuat',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } },
            },
            400: {
              description: 'name / price tidak diisi',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            401: {
              description: 'Token tidak ada / tidak valid',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            403: {
              description: 'Butuh role admin',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/products/{id}': {
        get: {
          tags: ['Products'],
          summary: 'Detail produk berdasarkan ID',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: {
            200: {
              description: 'Detail produk',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } },
            },
            404: {
              description: 'Produk tidak ditemukan',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/admin/chaos': {
        post: {
          tags: ['Admin'],
          summary: 'Set kondisi chaos (down / latency) untuk simulasi kegagalan service',
          requestBody: {
            required: false,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ChaosRequest' } } },
          },
          responses: {
            200: {
              description: 'State chaos terbaru',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ChaosResponse' } } },
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
            chaos: { $ref: '#/components/schemas/ChaosState' },
          },
        },
        Product: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            price: { type: 'integer' },
            stock: { type: 'integer' },
          },
        },
        ProductRequest: {
          type: 'object',
          required: ['name', 'price'],
          properties: {
            name: { type: 'string', example: 'Kopi Robusta 250g' },
            price: { type: 'integer', example: 75000 },
            stock: { type: 'integer', default: 0, example: 50 },
          },
        },
        ChaosState: {
          type: 'object',
          properties: { down: { type: 'boolean' }, latencyMs: { type: 'integer' } },
        },
        ChaosRequest: {
          type: 'object',
          properties: {
            down: { type: 'boolean', example: true },
            latencyMs: { type: 'integer', example: 4000 },
          },
        },
        ChaosResponse: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, chaos: { $ref: '#/components/schemas/ChaosState' } },
        },
        ErrorResponse: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  }),
)

// Middleware chaos hanya untuk route data produk (bukan health/docs/chaos)
app.use('/products', async (req, res, next) => {
  if (chaos.latencyMs > 0) await sleep(chaos.latencyMs)
  if (chaos.down) return res.status(503).json({ error: 'product-service sedang down (simulasi)' })
  next()
})

// ---------- Routes ----------
app.get('/products', async (req, res) => res.json(await Product.findAll({ order: [['id', 'ASC']] })))

app.get('/products/:id', async (req, res) => {
  const p = await Product.findByPk(req.params.id)
  if (!p) return res.status(404).json({ error: 'product not found' })
  res.json(p)
})

app.post('/products', requireAdmin, async (req, res) => {
  const { name, price, stock } = req.body || {}
  if (!name || price == null) return res.status(400).json({ error: 'name & price wajib' })
  const p = await Product.create({ name, price, stock: stock || 0 })
  res.status(201).json(p)
})

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
  if ((await Product.count()) === 0) {
    await Product.bulkCreate([
      { name: 'Kopi Arabika 250g', price: 85000, stock: 40 },
      { name: 'Teh Hijau 100g', price: 45000, stock: 100 },
      { name: 'Gula Aren 500g', price: 30000, stock: 25 },
    ])
    console.log('[seed] 3 produk awal dibuat')
  }
  app.listen(PORT, () => console.log(`product-service listening on :${PORT}`))
}
start()
