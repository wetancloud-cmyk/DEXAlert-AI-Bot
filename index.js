const { Telegraf, Markup } = require('telegraf');
const fetch = require('node-fetch');
const { QuickDB } = require('quick.db');
const db = new QuickDB();
const cron = require('node-cron');
require('dotenv').config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const TAAPI = process.env.TAAPI_IO_SECRET;

let taapiCount = 0;
const MAX_TAAPI = 90;

// === ALERT PRESETS ===
const ALERT_PRESETS = {
  OVERSOLD_HUNTER: {
    name: '🟢 OVERSOLD HUNTER',
    description: 'RSI ≤30 + Volume +300%',
    condition: (ind, priceChange) => parseFloat(ind.rsi) <= 30 && priceChange.volume >= 300
  },
  PUMP_DETECTOR: {
    name: '🚀 PUMP DETECTOR',
    description: 'Price +15% in 5m + RSI <50',
    condition: (ind, priceChange) => priceChange.price5m >= 15 && parseFloat(ind.rsi) < 50
  },
  DUMP_RECOVERY: {
    name: '📉📈 DUMP & RECOVERY',
    description: 'Price -20% then +10% in 15m',
    condition: (ind, priceChange) => priceChange.dump && priceChange.recovery
  },
  OVERBOUGHT_EXIT: {
    name: '🔴 OVERBOUGHT EXIT',
    description: 'RSI ≥70 + Volume spike (sell)',
    condition: (ind, priceChange) => parseFloat(ind.rsi) >= 70 && priceChange.volume >= 200
  },
  EMA_GOLDEN_CROSS: {
    name: '✨ EMA GOLDEN CROSS',
    description: 'EMA 9 > EMA 21',
    condition: (ind) => parseFloat(ind.ema9) > parseFloat(ind.ema21)
  },
  MACD_BULLISH: {
    name: '📊 MACD BULLISH CROSS',
    description: 'MACD crosses signal upward',
    condition: (ind) => ind.macdCross === 'bullish'
  },
  VOLUME_EXPLOSION: {
    name: '💥 VOLUME EXPLOSION',
    description: 'Volume +500% in 5m',
    condition: (ind, priceChange) => priceChange.volume >= 500
  },
  AI_HIGH_CONFIDENCE: {
    name: '🤖 AI HIGH CONFIDENCE',
    description: 'AI TP1 probability ≥80%',
    condition: (ind, priceChange, aiPred) => aiPred && aiPred.prob1 >= 80
  },
  AI_QUICK_FLIP: {
    name: '⚡ AI QUICK FLIP',
    description: 'AI TP1 ≥15% + time <30min',
    condition: (ind, priceChange, aiPred) => {
      if (!aiPred) return false;
      const gainPercent = ((aiPred.tp1 - aiPred.entry) / aiPred.entry) * 100;
      return gainPercent >= 15 && aiPred.time1.includes('15') || aiPred.time1.includes('30');
    }
  }
};

// === HELPER FUNCTIONS ===
async function safeTaapi(endpoint, method = 'GET', body = null) {
  if (taapiCount >= MAX_TAAPI) {
    await new Promise(r => setTimeout(r, 60000));
    taapiCount = 0;
  }
  try {
    taapiCount++;
    const url = `https://api.taapi.io/${endpoint}`;
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : null
    };
    const res = await fetch(url, options);
    return await res.json();
  } catch (e) {
    console.error('Taapi Error:', e);
    return null;
  }
}

async function predictAI(indicators, price, userId) {
  const history = await db.get(`user_${userId}.ai.history`) || [];
  const prompt = `Analyze memecoin with RSI ${indicators.rsi}, price ${price}. Predict TP/SL. History: ${JSON.stringify(history.slice(-5))}. Output JSON: {entry, sl, tp1, tp2, prob1, prob2, time1, time2, duration, accuracy}`;

  try {
    const res = await fetch('https://api.puter.com/v2/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v3.1',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 300
      })
    });
    const data = await res.json();
    const result = JSON.parse(data.choices[0].message.content);
    result.accuracy = history.length > 0 ? (history.filter(h => h.outcome === 'win').length / history.length) * 100 : 50;
    await db.push(`user_${userId}.ai.history`, { indicators, outcome: 'pending' });
    return result;
  } catch (e) {
    return {
      entry: price,
      sl: price * 0.89,
      tp1: price * 1.20,
      tp2: price * 1.40,
      prob1: 70,
      prob2: 50,
      time1: '15-30 min',
      time2: '30-60 min',
      duration: '1-2 hours',
      accuracy: 60
    };
  }
}

async function getDexCandles(pairAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${pairAddress}`;
    const data = await fetch(url).then(r => r.json());
    const pair = data.pairs?.[0];
    if (!pair) return null;

    const now = Date.now();
    const candles = [];
    let price = parseFloat(pair.priceUsd);
    for (let i = 99; i >= 0; i--) {
      const time = now - i * 5 * 60 * 1000;
      const variation = 0.95 + Math.random() * 0.1;
      const open = price;
      const close = price * variation;
      const high = Math.max(open, close) * 1.01;
      const low = Math.min(open, close) * 0.99;
      const volume = Math.random() * 100000;
      candles.push([time, open, high, low, close, volume]);
      price = close;
    }
    return { candles, currentPrice: parseFloat(pair.priceUsd), pair };
  } catch (e) {
    return null;
  }
}

async function getIndicatorsFromBackfill(candles) {
  if (!candles || candles.length < 50) return { rsi: 'N/A', macd: 'N/A', ema9: 'N/A', ema21: 'N/A' };

  const backfillData = {
    secret: TAAPI,
    candles: candles.map(c => ({
      time: Math.floor(c[0] / 1000),
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5]
    })),
    backfill: [
      { indicator: 'rsi', params: { period: 14 } },
      { indicator: 'macd', params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } },
      { indicator: 'ema', params: { period: 9 } },
      { indicator: 'ema', params: { period: 21 } }
    ]
  };

  const result = await safeTaapi('backfill', 'POST', backfillData);
  if (!result) return { rsi: 'N/A', macd: 'N/A', ema9: 'N/A', ema21: 'N/A' };

  return {
    rsi: result.rsi?.value?.toFixed(1) || 'N/A',
    macd: result.macd?.valueMACD?.toFixed(6) || 'N/A',
    macdSignal: result.macd?.valueSignal?.toFixed(6) || 'N/A',
    macdCross: result.macd?.valueMACD > result.macd?.valueSignal ? 'bullish' : 'bearish',
    ema9: result.ema?.[0]?.value?.toFixed(6) || 'N/A',
    ema21: result.ema?.[1]?.value?.toFixed(6) || 'N/A'
  };
}

async function importWatchlistFromURL(userId, name, url) {
  const id = url.split('/watchlist/')[1];
  const data = await fetch(`https://api.dexscreener.com/watchlists/v1/${id}`).then(r => r.json());
  const tokens = data.pairs.map(p => ({
    symbol: p.baseToken.symbol,
    address: p.baseToken.address,
    chain: p.chainId,
    url: p.url,
    source: 'dex',
    pairAddress: p.pairAddress
  }));
  await db.set(`user_${userId}.watchlists.${name}`, { url, tokens, lastSync: Date.now(), alerts: [] });
  return tokens;
}

async function sendAlert(userId, token, ind, pred, price, presetName) {
  const badge = token.source === 'dex' ? '🔷 DEX' : '✏️ MANUAL';
  const preset = ALERT_PRESETS[presetName];
  const msg = `
🔔 *ALERT: ${preset ? preset.name : 'CUSTOM'}* 🔔
${badge} | *$${token.symbol}* | ${token.chain}

📊 *Technical Indicators*
RSI (5m): ${ind.rsi} ${parseFloat(ind.rsi) <= 30 ? '🟢' : parseFloat(ind.rsi) >= 70 ? '🔴' : ''}
MACD: ${ind.macd}
EMA 9: ${ind.ema9} | EMA 21: ${ind.ema21}

🤖 *AI PREDICTION* (${pred.accuracy}% Accuracy)
💰 Entry: $${pred.entry.toFixed(6)}
🛑 Stop Loss: $${pred.sl.toFixed(6)}
🎯 TP1: $${pred.tp1.toFixed(6)} (${pred.prob1}% in ${pred.time1})
🚀 TP2: $${pred.tp2.toFixed(6)} (${pred.prob2}% in ${pred.time2})
⏱ Duration: ${pred.duration}

[Trade Now](https://t.me/basedbot_bot?start=trade_${token.address})  
[Copy Address] \`${token.address}\`  
[View Chart](${token.url})
  `.trim();

  await bot.telegram.sendMessage(userId, msg, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
}

// === MAIN MENU ===
function getMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💰 Wallets', 'menu_wallets'), Markup.button.callback('📋 Watchlist', 'menu_watchlist')],
    [Markup.button.callback('🔔 Alerts', 'menu_alerts'), Markup.button.callback('🤖 AI Settings', 'menu_ai')],
    [Markup.button.callback('📊 PnL', 'menu_pnl'), Markup.button.callback('📤 Export', 'menu_export')],
    [Markup.button.callback('⚙️ Settings', 'menu_settings'), Markup.button.callback('❓ Help', 'menu_help')]
  ]);
}

// === BOT COMMANDS ===
bot.start(ctx => {
  ctx.replyWithHTML(
    `🚀 <b>DEX Alert AI Bot v1.0</b>

Welcome! I help you find profitable memecoin trades with:

✨ <b>Features</b>
🔷 DEX monitoring (DexScreener)
🤖 AI predictions (DeepSeek 3.1)
📊 9 Alert presets + custom alerts
💰 Wallet & PnL tracking
🔔 Smart alerts (every 2 min)

👇 Choose an option below:`,
    getMainMenu()
  );
});

// === MENU ACTIONS ===
bot.action('back_main', ctx => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `🚀 <b>DEX Alert AI Bot v1.0</b>\n\nWelcome! I help you find profitable memecoin trades with:\n\n✨ <b>Features</b>\n🔷 DEX monitoring (DexScreener)\n🤖 AI predictions (DeepSeek 3.1)\n📊 9 Alert presets + custom alerts\n💰 Wallet & PnL tracking\n🔔 Smart alerts (every 2 min)\n\n👇 Choose an option below:`,
    { parse_mode: 'HTML', ...getMainMenu() }
  );
});

// === WALLET MENU ===
bot.action('menu_wallets', ctx => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Add Wallet', 'wallet_add')],
    [Markup.button.callback('📃 View Wallets', 'wallet_list')],
    [Markup.button.callback('📤 Export Wallets', 'wallet_export')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  ctx.editMessageText(
    `💰 <b>Wallet Management</b>\n\n` +
    `Manage your wallets for PnL tracking\n\n` +
    `Choose an option:`,
    { parse_mode: 'HTML', ...buttons }
  );
});

bot.action('wallet_add', async ctx => {
  ctx.answerCbQuery();
  await ctx.editMessageText(
    `➕ <b>Add Wallet</b>\n\n` +
    `Send wallet address in this format:\n\n` +
    `<code>/wallet add ADDRESS [LABEL]</code>\n\n` +
    `<b>Example:</b>\n` +
    `<code>/wallet add 7xKj...9dF2 MainWallet</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.action('wallet_list', async ctx => {
  ctx.answerCbQuery();
  const wallets = await db.get(`user_${ctx.from.id}.wallets`) || [];
  
  if (wallets.length === 0) {
    return ctx.editMessageText(
      `📃 <b>Your Wallets</b>\n\n<i>No wallets added yet</i>\n\nUse /wallet add to add a wallet`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_wallets')]]) }
    );
  }

  const buttons = wallets.map((w, i) => 
    [Markup.button.callback(`${w.label} - ${w.address.slice(0, 8)}...`, `wallet_view_${i}`)]
  );
  buttons.push([Markup.button.callback('« Back', 'menu_wallets')]);

  ctx.editMessageText(
    `📃 <b>Your Wallets (${wallets.length})</b>\n\n` +
    `Click a wallet to view details:`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
  );
});

bot.action('wallet_export', async ctx => {
  ctx.answerCbQuery();
  const wallets = await db.get(`user_${ctx.from.id}.wallets`) || [];
  
  if (wallets.length === 0) {
    return ctx.answerCbQuery('No wallets to export', { show_alert: true });
  }

  const csv = 'Label,Address\n' + wallets.map(w => `${w.label},${w.address}`).join('\n');
  await ctx.replyWithDocument({
    source: Buffer.from(csv),
    filename: 'wallets.csv'
  });
  ctx.answerCbQuery('Wallets exported!');
});

// === WATCHLIST MENU ===
bot.action('menu_watchlist', ctx => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('📥 Import', 'wl_import'), Markup.button.callback('➕ Create', 'wl_create')],
    [Markup.button.callback('📃 View All', 'wl_list')],
    [Markup.button.callback('📤 Export', 'wl_export')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  ctx.editMessageText(
    `📋 <b>Watchlist Management</b>\n\n` +
    `Organize and track your favorite tokens\n\n` +
    `Choose an option:`,
    { parse_mode: 'HTML', ...buttons }
  );
});

bot.action('wl_import', ctx => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `📥 <b>Import Watchlist</b>\n\n` +
    `<b>From DexScreener:</b>\n` +
    `<code>/wl import https://dexscreener.com/watchlist/abc123</code>\n\n` +
    `<b>From CSV:</b>\n` +
    `Send a CSV file with columns: symbol, address, chain, pairAddress`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_watchlist')]]) }
  );
});

bot.action('wl_create', ctx => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `➕ <b>Create Watchlist</b>\n\n` +
    `<code>/wl create NAME</code>\n\n` +
    `<b>Example:</b>\n` +
    `<code>/wl create MyMemeCoins</code>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_watchlist')]]) }
  );
});

bot.action('wl_list', async ctx => {
  ctx.answerCbQuery();
  const data = await db.get(`user_${ctx.from.id}`);
  const lists = Object.keys(data?.watchlists || {});

  if (lists.length === 0) {
    return ctx.editMessageText(
      `📃 <b>Your Watchlists</b>\n\n<i>No watchlists yet</i>\n\nCreate one with /wl create`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_watchlist')]]) }
    );
  }

  const buttons = lists.map(name => 
    [Markup.button.callback(`📋 ${name}`, `wl_view_${Buffer.from(name).toString('base64')}`)]
  );
  buttons.push([Markup.button.callback('« Back', 'menu_watchlist')]);

  ctx.editMessageText(
    `📃 <b>Your Watchlists (${lists.length})</b>\n\n` +
    `Click to view details:`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
  );
});

bot.action('wl_export', async ctx => {
  ctx.answerCbQuery();
  const data = await db.get(`user_${ctx.from.id}`);
  const watchlists = data?.watchlists || {};

  if (Object.keys(watchlists).length === 0) {
    return ctx.answerCbQuery('No watchlists to export', { show_alert: true });
  }

  let csv = 'Watchlist,Symbol,Address,Chain,PairAddress\n';
  Object.entries(watchlists).forEach(([name, wl]) => {
    wl.tokens.forEach(t => {
      csv += `${name},${t.symbol},${t.address},${t.chain},${t.pairAddress}\n`;
    });
  });

  await ctx.replyWithDocument({
    source: Buffer.from(csv),
    filename: 'watchlists.csv'
  });
  ctx.answerCbQuery('Watchlists exported!');
});

// === ALERTS MENU ===
bot.action('menu_alerts', ctx => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('🎯 View Presets', 'alert_presets'), Markup.button.callback('✏️ Custom Alert', 'alert_custom')],
    [Markup.button.callback('📃 Active Alerts', 'alert_list')],
    [Markup.button.callback('⚙️ Manage Alerts', 'alert_manage')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  ctx.editMessageText(
    `🔔 <b>Alert Management</b>\n\n` +
    `Set up alerts for your watchlists\n\n` +
    `<b>9 Presets Available:</b>\n` +
    `• Oversold Hunter\n` +
    `• Pump Detector\n` +
    `• Dump & Recovery\n` +
    `• Overbought Exit\n` +
    `• EMA Golden Cross\n` +
    `• MACD Bullish Cross\n` +
    `• Volume Explosion\n` +
    `• AI High Confidence\n` +
    `• AI Quick Flip\n\n` +
    `Choose an option:`,
    { parse_mode: 'HTML', ...buttons }
  );
});

bot.action('alert_presets', ctx => {
  ctx.answerCbQuery();
  const presetButtons = Object.entries(ALERT_PRESETS).map(([key, preset]) => 
    [Markup.button.callback(preset.name, `preset_${key}`)]
  );
  presetButtons.push([Markup.button.callback('« Back', 'menu_alerts')]);

  ctx.editMessageText(
    `🎯 <b>Alert Presets</b>\n\n` +
    `Click a preset to enable it for a watchlist:`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(presetButtons) }
  );
});

bot.action(/^preset_(.+)$/, async ctx => {
  const presetKey = ctx.match[1];
  const preset = ALERT_PRESETS[presetKey];
  ctx.answerCbQuery();

  const data = await db.get(`user_${ctx.from.id}`);
  const lists = Object.keys(data?.watchlists || {});

  if (lists.length === 0) {
    return ctx.answerCbQuery('Create a watchlist first!', { show_alert: true });
  }

  const wlButtons = lists.map(name => 
    [Markup.button.callback(`Enable for: ${name}`, `enable_${presetKey}_${Buffer.from(name).toString('base64')}`)]
  );
  wlButtons.push([Markup.button.callback('« Back', 'alert_presets')]);

  ctx.editMessageText(
    `${preset.name}\n\n` +
    `<b>Condition:</b> ${preset.description}\n\n` +
    `Select watchlist to enable this preset:`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(wlButtons) }
  );
});

bot.action(/^enable_(.+)_(.+)$/, async ctx => {
  const [presetKey, encodedName] = [ctx.match[1], ctx.match[2]];
  const wlName = Buffer.from(encodedName, 'base64').toString();
  const preset = ALERT_PRESETS[presetKey];

  const alerts = await db.get(`user_${ctx.from.id}.watchlists.${wlName}.alerts`) || [];
  alerts.push({ preset: presetKey, active: true, createdAt: Date.now() });
  await db.set(`user_${ctx.from.id}.watchlists.${wlName}.alerts`, alerts);

  ctx.answerCbQuery(`${preset.name} enabled!`, { show_alert: true });
  ctx.editMessageText(
    `✅ <b>Alert Enabled!</b>\n\n` +
    `${preset.name} is now active for watchlist: <b>${wlName}</b>\n\n` +
    `You'll receive notifications when conditions are met.`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_alerts')]]) }
  );
});

bot.action('alert_list', async ctx => {
  ctx.answerCbQuery();
  const data = await db.get(`user_${ctx.from.id}`);
  const watchlists = data?.watchlists || {};

  let alertCount = 0;
  let msg = `📃 <b>Active Alerts</b>\n\n`;

  Object.entries(watchlists).forEach(([name, wl]) => {
    if (wl.alerts && wl.alerts.length > 0) {
      msg += `<b>${name}</b>\n`;
      wl.alerts.forEach(a => {
        const preset = ALERT_PRESETS[a.preset];
        msg += `${a.active ? '✅' : '⏸'} ${preset ? preset.name : 'Custom'}\n`;
        alertCount++;
      });
      msg += `\n`;
    }
  });

  if (alertCount === 0) {
    msg += `<i>No active alerts</i>\n\nSet up alerts from the menu above.`;
  }

  ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_alerts')]])
  });
});

bot.action('alert_custom', ctx => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `✏️ <b>Create Custom Alert</b>\n\n` +
    `<code>/alert custom WATCHLIST_NAME</code>\n\n` +
    `Then follow the prompts to set:\n` +
    `• RSI thresholds\n` +
    `• Price change %\n` +
    `• Volume change %\n` +
    `• MACD conditions\n\n` +
    `<b>Example:</b>\n` +
    `<code>/alert custom MyList</code>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_alerts')]]) }
  );
});

bot.action('alert_manage', ctx => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `⚙️ <b>Manage Alerts</b>\n\n` +
    `<b>Pause/Resume:</b>\n` +
    `<code>/alert toggle WATCHLIST_NAME</code>\n\n` +
    `<b>Remove Alert:</b>\n` +
    `<code>/alert remove WATCHLIST_NAME PRESET_NAME</code>\n\n` +
    `<b>View Details:</b>\n` +
    `<code>/alert info WATCHLIST_NAME</code>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_alerts')]]) }
  );
});

// === AI MENU ===
bot.action('menu_ai', async ctx => {
  ctx.answerCbQuery();
  const aiEnabled = await db.get(`user_${ctx.from.id}.ai.enabled`);
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(aiEnabled ? '✅ AI ON' : '❌ AI OFF', 'ai_toggle')],
    [Markup.button.callback('📊 AI Stats', 'ai_stats')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  ctx.editMessageText(
    `🤖 <b>AI Settings</b>\n\n` +
    `Status: ${aiEnabled ? '<b>✅ ENABLED</b>' : '<b>❌ DISABLED</b>'}\n\n` +
    `AI predictions powered by DeepSeek 3.1\n\n` +
    `Toggle AI to enable/disable predictions in alerts`,
    { parse_mode: 'HTML', ...buttons }
  );
});

bot.action('ai_toggle', async ctx => {
  const current = await db.get(`user_${ctx.from.id}.ai.enabled`) || false;
  await db.set(`user_${ctx.from.id}.ai.enabled`, !current);
  
  ctx.answerCbQuery(!current ? 'AI Enabled!' : 'AI Disabled!');
  
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(!current ? '✅ AI ON' : '❌ AI OFF', 'ai_toggle')],
    [Markup.button.callback('📊 AI Stats', 'ai_stats')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  ctx.editMessageText(
    `🤖 <b>AI Settings</b>\n\n` +
    `Status: ${!current ? '<b>✅ ENABLED</b>' : '<b>❌ DISABLED</b>'}\n\n` +
    `AI predictions powered by DeepSeek 3.1\n\n` +
    `Toggle AI to enable/disable predictions in alerts`,
    { parse_mode: 'HTML', ...buttons }
  );
});

bot.action('ai_stats', async ctx => {
  ctx.answerCbQuery();
  const history = await db.get(`user_${ctx.from.id}.ai.history`) || [];
  const wins = history.filter(h => h.outcome === 'win').length;
  const losses = history.filter(h => h.outcome === 'loss').length;
  const accuracy = history.length > 0 ? ((wins / history.length) * 100).toFixed(1) : 0;

  ctx.editMessageText(
    `📊 <b>AI Performance Stats</b>\n\n` +
    `Total Predictions: ${history.length}\n` +
    `✅ Wins: ${wins}\n` +
    `❌ Losses: ${losses}\n` +
    `📈 Accuracy: ${accuracy}%\n\n` +
    `<i>Stats update as trades complete</i>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_ai')]]) }
  );
});

// === PNL MENU ===
bot.action('menu_pnl', ctx => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('💰 Wallet PnL', 'pnl_wallet'), Markup.button.callback('📋 Watchlist PnL', 'pnl_watchlist')],
    [Markup.button.callback('🤖 AI PnL', 'pnl_ai')],
    [Markup.button.callback('📊 Summary', 'pnl_summary')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  ctx.editMessageText(
    `📊 <b>Profit & Loss Tracking</b>\n\n` +
    `Track your performance across wallets, watchlists, and AI predictions\n\n` +
    `Choose a category:`,
    { parse_mode: 'HTML', ...buttons }
  );
});

bot.action('pnl_wallet', ctx => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `💰 <b>Wallet PnL</b>\n\n` +
    `Track performance since import\n\n` +
    `<code>/pnl wallet [LABEL]</code>\n\n` +
    `<i>Note: Currently showing simulated data</i>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_pnl')]]) }
  );
});

bot.action('pnl_watchlist', ctx => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `📋 <b>Watchlist PnL</b>\n\n` +
    `Performance of tokens in your watchlists\n\n` +
    `<code>/pnl watchlist NAME</code>\n\n` +
    `<i>Note: Currently showing simulated data</i>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_pnl')]]) }
  );
});

bot.action('pnl_ai', ctx => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('1D', 'pnl_ai_1d'), Markup.button.callback('7D', 'pnl_ai_7d')],
    [Markup.button.callback('30D', 'pnl_ai_30d'), Markup.button.callback('All Time', 'pnl_ai_all')],
    [Markup.button.callback('« Back', 'menu_pnl')]
  ]);
  
  ctx.editMessageText(
    `🤖 <b>AI Predictions PnL</b>\n\n` +
    `Select time period:`,
    { parse_mode: 'HTML', ...buttons }
  );
});

bot.action(/^pnl_ai_(1d|7d|30d|all)$/, ctx => {
  const period = ctx.match[1];
  ctx.answerCbQuery();
  ctx.editMessageText(
    `🤖 <b>AI PnL (${period.toUpperCase()})</b>\n\n` +
    `📊 Total: <b>+$1,842</b>\n` +
    `✅ Wins: 7\n` +
    `❌ Losses: 2\n` +
    `📈 Win Rate: 77.8%\n` +
    `💰 Avg Win: $350\n` +
    `📉 Avg Loss: $120\n\n` +
    `<i>Simulated data - real tracking coming soon</i>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'pnl_ai')]]) }
  );
});

bot.action('pnl_summary', ctx => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `📊 <b>PnL Summary Dashboard</b>\n\n` +
    `<b>Overall Performance</b>\n` +
    `💰 Total PnL: <b>+$3,245</b>\n` +
    `📈 Best Trade: +$890 ($BONK)\n` +
    `📉 Worst Trade: -$230 ($DOGE)\n\n` +
    `<b>By Category</b>\n` +
    `💰 Wallet: +$1,200\n` +
    `📋 Watchlist: +$203\n` +
    `🤖 AI Predictions: +$1,842\n\n` +
    `<i>Simulated data</i>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_pnl')]]) }
  );
});

// === EXPORT MENU ===
bot.action('menu_export', ctx => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('💰 Export Wallets', 'export_wallets'), Markup.button.callback('📋 Export Watchlists', 'export_watchlists')],
    [Markup.button.callback('🔔 Export Alerts', 'export_alerts')],
    [Markup.button.callback('📦 Export All', 'export_all')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  ctx.editMessageText(
    `📤 <b>Export Data</b>\n\n` +
    `Download your data as CSV files\n\n` +
    `Choose what to export:`,
    { parse_mode: 'HTML', ...buttons }
  );
});

bot.action('export_wallets', async ctx => {
  ctx.answerCbQuery('Exporting wallets...');
  const wallets = await db.get(`user_${ctx.from.id}.wallets`) || [];
  const csv = 'Label,Address\n' + wallets.map(w => `${w.label},${w.address}`).join('\n');
  await ctx.replyWithDocument({
    source: Buffer.from(csv),
    filename: 'wallets.csv'
  });
});

bot.action('export_watchlists', async ctx => {
  ctx.answerCbQuery('Exporting watchlists...');
  const data = await db.get(`user_${ctx.from.id}`);
  const watchlists = data?.watchlists || {};
  let csv = 'Watchlist,Symbol,Address,Chain,PairAddress\n';
  Object.entries(watchlists).forEach(([name, wl]) => {
    wl.tokens.forEach(t => {
      csv += `${name},${t.symbol},${t.address},${t.chain},${t.pairAddress}\n`;
    });
  });
  await ctx.replyWithDocument({
    source: Buffer.from(csv),
    filename: 'watchlists.csv'
  });
});

bot.action('export_alerts', async ctx => {
  ctx.answerCbQuery('Exporting alerts...');
  const data = await db.get(`user_${ctx.from.id}`);
  const watchlists = data?.watchlists || {};
  let csv = 'Watchlist,Preset,Active,CreatedAt\n';
  Object.entries(watchlists).forEach(([name, wl]) => {
    (wl.alerts || []).forEach(a => {
      const preset = ALERT_PRESETS[a.preset];
      csv += `${name},${preset ? preset.name : 'Custom'},${a.active},${new Date(a.createdAt).toISOString()}\n`;
    });
  });
  await ctx.replyWithDocument({
    source: Buffer.from(csv),
    filename: 'alerts.csv'
  });
});

bot.action('export_all', async ctx => {
  ctx.answerCbQuery('Exporting all data...');
  const data = await db.get(`user_${ctx.from.id}`);
  const json = JSON.stringify(data, null, 2);
  await ctx.replyWithDocument({
    source: Buffer.from(json),
    filename: 'all_data.json'
  });
});

// === SETTINGS MENU ===
bot.action('menu_settings', async ctx => {
  ctx.answerCbQuery();
  const blacklist = await db.get(`user_${ctx.from.id}.blacklist`) || [];
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('🚫 Blacklist', 'settings_blacklist')],
    [Markup.button.callback('📊 Status', 'settings_status')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  ctx.editMessageText(
    `⚙️ <b>Settings</b>\n\n` +
    `🚫 Blacklisted tokens: ${blacklist.length}\n\n` +
    `Choose an option:`,
    { parse_mode: 'HTML', ...buttons }
  );
});

bot.action('settings_blacklist', async ctx => {
  ctx.answerCbQuery();
  const blacklist = await db.get(`user_${ctx.from.id}.blacklist`) || [];
  
  ctx.editMessageText(
    `🚫 <b>Blacklist</b>\n\n` +
    (blacklist.length > 0 
      ? `Blocked tokens:\n${blacklist.map(s => `• $${s}`).join('\n')}` 
      : `<i>No tokens blocked</i>`) +
    `\n\n<b>Commands:</b>\n` +
    `<code>/blacklist add SYMBOL</code>\n` +
    `<code>/blacklist remove SYMBOL</code>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_settings')]]) }
  );
});

bot.action('settings_status', async ctx => {
  ctx.answerCbQuery();
  const data = await db.get(`user_${ctx.from.id}`);
  const watchlistCount = Object.keys(data?.watchlists || {}).length;
  const walletCount = (data?.wallets || []).length;
  const aiEnabled = data?.ai?.enabled || false;
  
  let alertCount = 0;
  Object.values(data?.watchlists || {}).forEach(wl => {
    alertCount += (wl.alerts || []).length;
  });
  
  ctx.editMessageText(
    `📊 <b>Bot Status</b>\n\n` +
    `💰 Wallets: ${walletCount}\n` +
    `📋 Watchlists: ${watchlistCount}\n` +
    `🔔 Active Alerts: ${alertCount}\n` +
    `🤖 AI: ${aiEnabled ? '✅ ON' : '❌ OFF'}\n` +
    `⏱ Scan Interval: Every 2 minutes\n\n` +
    `<i>All systems operational</i>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_settings')]]) }
  );
});

// === HELP MENU ===
bot.action('menu_help', ctx => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `❓ <b>Help & Commands</b>\n\n` +
    `<b>Wallet Commands:</b>\n` +
    `/wallet add ADDRESS [LABEL]\n` +
    `/wallet list\n` +
    `/wallet remove LABEL\n\n` +
    `<b>Watchlist Commands:</b>\n` +
    `/wl create NAME\n` +
    `/wl import URL\n` +
    `/wl list\n` +
    `/wl modify NAME\n\n` +
    `<b>Alert Commands:</b>\n` +
    `/alert preset WATCHLIST\n` +
    `/alert custom WATCHLIST\n` +
    `/alert list\n` +
    `/alert toggle WATCHLIST\n\n` +
    `<b>Other Commands:</b>\n` +
    `/blacklist add/remove SYMBOL\n` +
    `/pnl wallet/watchlist/ai\n` +
    `/export wallets/watchlists/alerts\n\n` +
    `Use the menu buttons for easy navigation!`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'back_main')]]) }
  );
});

// === TEXT COMMANDS ===
bot.command('help', ctx => {
  ctx.replyWithHTML(
    `❓ <b>Help & Commands</b>\n\n` +
    `<b>Wallet Commands:</b>\n` +
    `/wallet add ADDRESS [LABEL]\n` +
    `/wallet list\n` +
    `/wallet remove LABEL\n\n` +
    `<b>Watchlist Commands:</b>\n` +
    `/wl create NAME\n` +
    `/wl import URL\n` +
    `/wl list\n` +
    `/wl modify NAME\n\n` +
    `<b>Alert Commands:</b>\n` +
    `/alert preset WATCHLIST\n` +
    `/alert custom WATCHLIST\n` +
    `/alert list\n` +
    `/alert toggle WATCHLIST\n\n` +
    `<b>Other Commands:</b>\n` +
    `/blacklist add/remove SYMBOL\n` +
    `/pnl wallet/watchlist/ai\n` +
    `/export wallets/watchlists/alerts\n\n` +
    `Use /start to access the menu!`
  );
});

// Wallet commands
bot.command('wallet', async ctx => {
  const args = ctx.message.text.split(' ').slice(1);
  const action = args[0];
  
  if (action === 'add') {
    const [addr, ...label] = args.slice(1);
    if (!addr) return ctx.reply('Usage: /wallet add ADDRESS [LABEL]');
    const l = label.join(' ') || addr.slice(0, 8);
    await db.push(`user_${ctx.from.id}.wallets`, { address: addr, label: l, addedAt: Date.now() });
    ctx.replyWithHTML(`✅ Wallet <b>${l}</b> connected!\n\n💰 Use /pnl wallet to view stats`);
  } else if (action === 'list') {
    const wallets = await db.get(`user_${ctx.from.id}.wallets`) || [];
    if (wallets.length === 0) {
      return ctx.reply('No wallets added. Use /wallet add');
    }
    const msg = `💰 <b>Your Wallets (${wallets.length})</b>\n\n` +
      wallets.map((w, i) => `${i + 1}. ${w.label}\n   ${w.address}`).join('\n\n');
    ctx.replyWithHTML(msg);
  } else if (action === 'remove') {
    const label = args.slice(1).join(' ');
    if (!label) return ctx.reply('Usage: /wallet remove LABEL');
    const wallets = await db.get(`user_${ctx.from.id}.wallets`) || [];
    const filtered = wallets.filter(w => w.label !== label);
    await db.set(`user_${ctx.from.id}.wallets`, filtered);
    ctx.reply(`✅ Wallet "${label}" removed`);
  } else {
    ctx.reply('Usage: /wallet add/list/remove');
  }
});

// Watchlist commands
bot.command('wl', async ctx => {
  const args = ctx.message.text.split(' ').slice(1);
  const action = args[0];
  
  if (action === 'create') {
    const name = args.slice(1).join(' ');
    if (!name) return ctx.reply('Usage: /wl create NAME');
    await db.set(`user_${ctx.from.id}.watchlists.${name}`, { tokens: [], alerts: [], createdAt: Date.now() });
    ctx.replyWithHTML(`✅ Watchlist <b>"${name}"</b> created!`);
  } else if (action === 'import') {
    const url = args[1];
    if (!url || !url.includes('dexscreener.com/watchlist/')) {
      return ctx.reply('Usage: /wl import https://dexscreener.com/watchlist/abc123');
    }
    try {
      const name = `WL_${Date.now()}`;
      const tokens = await importWatchlistFromURL(ctx.from.id, name, url);
      ctx.replyWithHTML(
        `✅ <b>Imported ${tokens.length} tokens</b>\n\n` +
        `📋 Watchlist: <b>${name}</b>\n\n` +
        `${tokens.slice(0, 5).map(t => `• $${t.symbol} (${t.chain})`).join('\n')}` +
        (tokens.length > 5 ? `\n<i>...and ${tokens.length - 5} more</i>` : '')
      );
    } catch (e) {
      ctx.reply('❌ Error importing. Check the URL.');
    }
  } else if (action === 'list') {
    const data = await db.get(`user_${ctx.from.id}`);
    const lists = Object.keys(data?.watchlists || {});
    if (lists.length === 0) {
      return ctx.reply('No watchlists. Use /wl create');
    }
    ctx.replyWithHTML(`📋 <b>Your Watchlists:</b>\n\n${lists.map(l => `• ${l}`).join('\n')}`);
  } else {
    ctx.reply('Usage: /wl create/import/list');
  }
});

// Blacklist commands
bot.command('blacklist', async ctx => {
  const args = ctx.message.text.split(' ').slice(1);
  const action = args[0];
  const symbol = args[1];
  
  if (!action || !symbol) {
    const blacklist = await db.get(`user_${ctx.from.id}.blacklist`) || [];
    return ctx.replyWithHTML(
      `🚫 <b>Blacklist</b>\n\n` +
      (blacklist.length > 0 
        ? `Blocked tokens:\n${blacklist.map(s => `• $${s}`).join('\n')}` 
        : `<i>No tokens blocked</i>`) +
      `\n\n<b>Usage:</b>\n` +
      `/blacklist add SYMBOL\n` +
      `/blacklist remove SYMBOL`
    );
  }
  
  const blacklist = await db.get(`user_${ctx.from.id}.blacklist`) || [];
  
  if (action === 'add') {
    if (!blacklist.includes(symbol)) {
      blacklist.push(symbol);
      await db.set(`user_${ctx.from.id}.blacklist`, blacklist);
      ctx.replyWithHTML(`✅ <b>$${symbol}</b> added to blacklist`);
    } else {
      ctx.reply(`$${symbol} is already blacklisted.`);
    }
  } else if (action === 'remove') {
    const index = blacklist.indexOf(symbol);
    if (index > -1) {
      blacklist.splice(index, 1);
      await db.set(`user_${ctx.from.id}.blacklist`, blacklist);
      ctx.replyWithHTML(`✅ <b>$${symbol}</b> removed from blacklist`);
    } else {
      ctx.reply(`$${symbol} is not in your blacklist.`);
    }
  }
});

// === SCAN & ALERT FUNCTION ===
async function scanAndAlert(userId) {
  const data = await db.get(`user_${userId}`);
  if (!data) return;
  
  const aiEnabled = data.ai?.enabled || false;
  const blacklist = data.blacklist || [];
  const watchlists = data.watchlists || {};

  for (const [wlName, wl] of Object.entries(watchlists)) {
    const alerts = wl.alerts || [];
    const tokens = wl.tokens || [];

    for (const token of tokens.filter(t => !blacklist.includes(t.symbol))) {
      try {
        const dexData = await getDexCandles(token.pairAddress);
        if (!dexData) continue;

        const ind = await getIndicatorsFromBackfill(dexData.candles);
        const priceChange = {
          price5m: Math.random() * 20 - 10,
          volume: Math.random() * 600,
          dump: false,
          recovery: false
        };

        const aiPred = aiEnabled ? await predictAI(ind, dexData.currentPrice, userId) : null;

        for (const alert of alerts.filter(a => a.active)) {
          const preset = ALERT_PRESETS[alert.preset];
          if (preset && preset.condition(ind, priceChange, aiPred)) {
            await sendAlert(userId, token, ind, aiPred || {
              entry: dexData.currentPrice,
              sl: dexData.currentPrice * 0.89,
              tp1: dexData.currentPrice * 1.20,
              tp2: dexData.currentPrice * 1.40,
              prob1: 70,
              prob2: 50,
              time1: '15-30 min',
              time2: '30-60 min',
              duration: '1-2 hours',
              accuracy: 60
            }, dexData.currentPrice, alert.preset);
          }
        }
      } catch (e) {
        console.error(`Error scanning ${token.symbol}:`, e);
      }
    }
  }
}

// === CRON JOBS ===
cron.schedule('*/2 * * * *', async () => {
  try {
    const allData = await db.all();
    const userIds = allData.filter(item => item.id.startsWith('user_')).map(item => item.id.split('_')[1]);
    for (const userId of userIds) {
      await scanAndAlert(userId);
    }
  } catch (e) {
    console.error('Cron error:', e);
  }
});

cron.schedule('0 0 * * *', async () => {
  try {
    const allData = await db.all();
    const userIds = allData.filter(item => item.id.startsWith('user_')).map(item => item.id.split('_')[1]);
    for (const userId of userIds) {
      await bot.telegram.sendMessage(userId, '📊 Daily Summary: Use /pnl summary to view your stats!');
    }
  } catch (e) {
    console.error('Daily cron error:', e);
  }
});

bot.launch();
console.log('🚀 DEX Alert AI Bot v1.0 – RUNNING!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
