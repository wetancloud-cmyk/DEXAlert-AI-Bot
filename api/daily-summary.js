const { bot, db } = require('../index')
module.exports = async (req, res) => {
  try {
    const allData = await db.all()
    const userIds = allData.filter(item => item.id.startsWith('user_')).map(item => item.id.split('_')[1])
    for (const userId of userIds) {
      await bot.telegram.sendMessage(userId, '📊 Daily Summary: Use /pnl summary to view your stats!')
    }
    res.json({ ok: true, sent: userIds.length })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
}