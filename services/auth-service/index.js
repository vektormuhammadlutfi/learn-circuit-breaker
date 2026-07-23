const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { Sequelize, DataTypes } = require('sequelize')
const swaggerUi = require('swagger-ui-express')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3004
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret'

// ---------- Database (pertemuan 3 & 6: DB terpisah per service) ----------
const sequelize = new Sequelize(
  process.env.DB_NAME || 'auth_db',
  process.env.DB_USER || 'postgres',
  process.env.DB_PASS || 'postgres',
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
  },
)

const User = sequelize.define('User', {
  username: { type: DataTypes.STRING, unique: true, allowNull: false },
  password: { type: DataTypes.STRING, allowNull: false },
  role: { type: DataTypes.STRING, defaultValue: 'customer' }, // customer | admin (RBAC)
})

// ---------- Swagger (pertemuan 6) ----------
const swaggerDoc = {
  openapi: '3.0.0',
  info: {
    title: 'Auth Service',
    version: '1.0.0',
    description: 'Auth microservice untuk registrasi, login, dan penerbitan JWT (RBAC: customer/admin).',
  },
  servers: [{ url: '/', description: 'Direct' }, { url: '/api/auth', description: 'Via API Gateway' }],
  tags: [{ name: 'Auth' }, { name: 'Health' }],
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
    '/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register user baru',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisterRequest' } } },
        },
        responses: {
          201: {
            description: 'User berhasil dibuat',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UserResponse' } } },
          },
          400: {
            description: 'username / password tidak diisi',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
          409: {
            description: 'username sudah dipakai',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
        },
      },
    },
    '/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login dan menerbitkan JWT token',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } },
        },
        responses: {
          200: {
            description: 'Login berhasil',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } },
          },
          401: {
            description: 'username / password salah',
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
        properties: { service: { type: 'string' }, status: { type: 'string' } },
      },
      RegisterRequest: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', example: 'budi' },
          password: { type: 'string', format: 'password', example: 'rahasia123' },
          role: { type: 'string', enum: ['customer', 'admin'], default: 'customer' },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', example: 'budi' },
          password: { type: 'string', format: 'password', example: 'rahasia123' },
        },
      },
      LoginResponse: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'JWT, berlaku 1 jam' },
          role: { type: 'string', enum: ['customer', 'admin'] },
        },
      },
      UserResponse: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          username: { type: 'string' },
          role: { type: 'string', enum: ['customer', 'admin'] },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
    },
  },
}
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc))

// ---------- Routes ----------
app.get('/health', (req, res) => res.json({ service: 'auth-service', status: 'UP' }))

app.post('/register', async (req, res) => {
  try {
    const { username, password, role } = req.body || {}
    if (!username || !password) return res.status(400).json({ error: 'username & password wajib' })
    const hash = await bcrypt.hash(password, 10)
    const user = await User.create({ username, password: hash, role: role === 'admin' ? 'admin' : 'customer' })
    res.status(201).json({ id: user.id, username: user.username, role: user.role })
  } catch (e) {
    if (e.name === 'SequelizeUniqueConstraintError')
      return res.status(409).json({ error: 'username sudah dipakai' })
    res.status(500).json({ error: e.message })
  }
})

app.post('/login', async (req, res) => {
  const { username, password } = req.body || {}
  const user = await User.findOne({ where: { username } })
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ error: 'username / password salah' })
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
    expiresIn: '1h',
  })
  res.json({ token, role: user.role })
})

// ---------- Bootstrap (retry koneksi DB, sync, seed admin) ----------
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
  const count = await User.count()
  if (count === 0) {
    await User.create({ username: 'admin', password: await bcrypt.hash('admin123', 10), role: 'admin' })
    console.log('[seed] user admin dibuat (admin/admin123)')
  }
  app.listen(PORT, () => console.log(`auth-service listening on :${PORT}`))
}
start()
