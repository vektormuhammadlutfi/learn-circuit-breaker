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
    info: { title: 'Product Service', version: '1.0.0' },
    paths: {
      '/products': { get: { summary: 'Daftar produk' }, post: { summary: 'Buat produk (admin)' } },
      '/products/{id}': { get: { summary: 'Detail produk' } },
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
