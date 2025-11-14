const { bot } = require('../index')
const handle = bot.webhookCallback('/api/telegram')
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('OK')
  return handle(req, res)
}