const express = require('express')
const amqp = require('amqplib')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3003
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672'
const EXCHANGE = 'ecommerce'

const notifications = [] // in-memory store notifikasi yang diterima

app.get('/health', (req, res) =>
  res.json({ service: 'notification-service', status: 'UP', totalReceived: notifications.length }),
)
app.get('/notifications', (req, res) => res.json(notifications))

// ---------- RabbitMQ consumer (pertemuan 8: komunikasi asinkron) ----------
async function consume() {
  // Retry tak terbatas menunggu RabbitMQ siap (first boot bisa >1 menit).
  let attempt = 0
  while (true) {
    attempt++
    try {
      const conn = await amqp.connect(RABBITMQ_URL)
      const channel = await conn.createChannel()
      await channel.assertExchange(EXCHANGE, 'topic', { durable: false })
      const q = await channel.assertQueue('notification.order', { durable: false })
      await channel.bindQueue(q.queue, EXCHANGE, 'order.created')
      console.log('[mq] menunggu event order.created ...')

      channel.consume(q.queue, (msg) => {
        if (!msg) return
        const order = JSON.parse(msg.content.toString())
        const notif = {
          id: notifications.length + 1,
          message: `📦 Order #${order.id} (${order.productName}) status ${order.status}`,
          order,
          at: new Date().toISOString(),
        }
        notifications.push(notif)
        console.log(`[notif] ${notif.message}`)
        channel.ack(msg)
      })

      conn.on('close', () => {
        console.warn('[mq] koneksi tertutup, reconnect...')
        setTimeout(consume, 3000)
      })
      return
    } catch (e) {
      console.log(`[mq] belum siap (percobaan ${attempt}): ${e.message}`)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}

app.listen(PORT, () => console.log(`notification-service listening on :${PORT}`))
consume()
