const { bot } = require('../index')
module.exports = async (req, res) => {
  try {
    const base = process.env.WEBHOOK_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
    if (!base) return res.status(400).json({ ok: false, error: 'WEBHOOK_URL atau VERCEL_URL diperlukan' })
    const url = `${base}/api/telegram`
    await bot.telegram.setWebhook(url)
    res.json({ ok: true, url })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
}