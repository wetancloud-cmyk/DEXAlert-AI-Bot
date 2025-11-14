const { db, scanAndAlert, bot } = require('../index')
module.exports = async (req, res) => {
  try {
    const now = new Date()
    const isMidnightUTC = now.getUTCHours() === 0 && now.getUTCMinutes() === 0
    const allData = await db.all()
    const userIds = allData.filter(item => item.id.startsWith('user_')).map(item => item.id.split('_')[1])

    for (const userId of userIds) await scanAndAlert(userId)

    if (isMidnightUTC) {
      for (const userId of userIds) {
        await bot.telegram.sendMessage(userId, '📊 Daily Summary: Use /pnl summary to view your stats!')
      }
    }

    res.json({ ok: true, processed: userIds.length, midnightUTC: isMidnightUTC })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
}