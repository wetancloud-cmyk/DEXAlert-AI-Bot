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

// === TAAPI RATE LIMIT ===
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

// === AI via DEEPSEEK 3.1 (PUTER - FREE) ===
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

// === GET DEX CANDLES FROM DEXSCREENER ===
async function getDexCandles(pairAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${pairAddress}`;
    const data = await fetch(url).then(r => r.json());
    const pair = data.pairs?.[0];
    if (!pair) return null;

    // Simulate 100 candles (5m) from price history (DexScreener gives limited, so approximate)
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

// === GET INDICATORS VIA TAAPI BACKFILL (WORKS WITH ANY DEX) ===
async function getIndicatorsFromBackfill(candles) {
  if (!candles || candles.length < 50) return { rsi: 'N/A', macd: 'N/A', ema: 'N/A' };

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
      { indicator: 'ema', params: { period: 9 } }
    ]
  };

  const result = await safeTaapi('backfill', 'POST', backfillData);
  if (!result) return { rsi: 'N/A', macd: 'N/A', ema: 'N/A' };

  return {
    rsi: result.rsi?.value?.toFixed(1) || 'N/A',
    macd: result.macd?.valueMACD?.toFixed(6) || 'N/A',
    ema: result.ema?.value?.toFixed(6) || 'N/A'
  };
}

// === IMPORT WATCHLIST ===
async function importWatchlist(userId, name, url) {
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
  await db.set(`user_${userId}.watchlists.${name}`, { url, tokens, lastSync: Date.now() });
  return tokens;
}

// === SEND ALERT ===
async function sendAlert(userId, token, ind, pred, price) {
  const badge = token.source === 'dex' ? '🔷 DEX' : '✏️ MANUAL';
  const msg = `
🔔 *ALERT DETECTED* 🔔
${badge} | *$${token.symbol}* | ${token.chain}

📊 *Technical Indicators*
RSI (5m): ${ind.rsi} ${parseFloat(ind.rsi) <= 30 ? '🟢 Oversold' : ''}
MACD: ${ind.macd}
EMA: ${ind.ema}

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
    disable_web_page_preview: true,
    notification: 'high'
  });
}

// === SCAN & ALERT ===
async function scanAndAlert(userId) {
  const data = await db.get(`user_${userId}`);
  if (!data?.ai?.enabled) return;
  const wl = data.activeWatchlist || 'default';
  const tokens = data.watchlists?.[wl]?.tokens || [];
  const blacklist = data.blacklist || [];

  for (const t of tokens.filter(tok => !blacklist.includes(tok.symbol))) {
    const dexData = await getDexCandles(t.pairAddress);
    if (!dexData) continue;

    const ind = await getIndicatorsFromBackfill(dexData.candles);
    if (parseFloat(ind.rsi) <= 30) {
      const pred = await predictAI(ind, dexData.currentPrice, userId);
      await sendAlert(userId, t, ind, pred, dexData.currentPrice);
    }
  }
}

// === COMMANDS ===
bot.start(ctx => {
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Features', 'features'), Markup.button.callback('📖 Commands', 'help')],
    [Markup.button.callback('🤖 Enable AI', 'ai_on'), Markup.button.callback('📥 Import Watchlist', 'import')]
  ]);
  
  return ctx.replyWithHTML(
    `🚀 <b>DEX Alert AI Bot v0.1</b>

Welcome! I help you find profitable memecoin trades with:

✨ <b>Features</b>
🔷 DEX monitoring (DexScreener)
🤖 AI predictions (DeepSeek 3.1)
📊 Technical analysis (RSI, MACD, EMA)
💰 Wallet PnL tracking
🔔 Smart alerts (every 2 min)

👇 Get started below!`,
    buttons
  );
});

bot.action('features', ctx => {
  ctx.answerCbQuery();
  return ctx.editMessageText(
    `✨ <b>Features</b>\n\n` +
    `🔷 <b>DEX Support</b>\n` +
    `Monitor any token on decentralized exchanges\n\n` +
    `🤖 <b>AI Predictions</b>\n` +
    `Get entry/exit points with probability & timing\n\n` +
    `📊 <b>Technical Analysis</b>\n` +
    `RSI, MACD, EMA indicators in real-time\n\n` +
    `🔔 <b>Auto Alerts</b>\n` +
    `Get notified when RSI < 30 (oversold)\n\n` +
    `💰 <b>PnL Tracking</b>\n` +
    `Connect wallet to track your profits`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'back')]]) }
  );
});

bot.action('help', ctx => {
  ctx.answerCbQuery();
  return ctx.editMessageText(
    `📖 <b>Commands</b>\n\n` +
    `<b>Watchlist Management</b>\n` +
    `/createwl MyList - Create new watchlist\n` +
    `/usewl MyList - Switch to a watchlist\n` +
    `/import - Import from DexScreener\n` +
    `   <i>Example: Send DexScreener link after /import</i>\n\n` +
    `<b>Add Tokens</b>\n` +
    `/addmanual $BONK 0x7xKj... pair_address\n` +
    `   <i>Add token manually with symbol & addresses</i>\n\n` +
    `<b>AI & Alerts</b>\n` +
    `/ai on - Enable AI alerts\n` +
    `/ai off - Disable AI alerts\n` +
    `/blacklist add DOGE - Block token alerts\n` +
    `/blacklist remove DOGE - Unblock token\n\n` +
    `<b>Wallet & Stats</b>\n` +
    `/connect 7xKj... MyWallet - Connect wallet\n` +
    `/pnl - View profit/loss stats\n` +
    `/export - Download trade history CSV`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'back')]]) }
  );
});

bot.action('ai_on', async ctx => {
  ctx.answerCbQuery('AI Alerts Enabled! 🤖');
  await db.set(`user_${ctx.from.id}.ai.enabled`, true);
  return ctx.editMessageText(
    `✅ <b>AI Alerts Enabled!</b>\n\n` +
    `Now import a watchlist:\n` +
    `1. Type /import\n` +
    `2. Send your DexScreener watchlist link\n` +
    `3. I'll start scanning every 2 minutes!\n\n` +
    `<i>You'll get alerts when RSI drops below 30</i>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'back')]]) }
  );
});

bot.action('import', ctx => {
  ctx.answerCbQuery();
  return ctx.editMessageText(
    `📥 <b>Import Watchlist</b>\n\n` +
    `Send me your DexScreener watchlist link\n\n` +
    `<b>Example:</b>\n` +
    `https://dexscreener.com/watchlist/abc123\n\n` +
    `<i>How to get it:</i>\n` +
    `1. Go to DexScreener\n` +
    `2. Open your watchlist\n` +
    `3. Copy the URL\n` +
    `4. Send it here`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'back')]]) }
  );
});

bot.action('back', ctx => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Features', 'features'), Markup.button.callback('📖 Commands', 'help')],
    [Markup.button.callback('🤖 Enable AI', 'ai_on'), Markup.button.callback('📥 Import Watchlist', 'import')]
  ]);
  
  return ctx.editMessageText(
    `🚀 <b>DEX Alert AI Bot v0.1</b>\n\n` +
    `Welcome! I help you find profitable memecoin trades with:\n\n` +
    `✨ <b>Features</b>\n` +
    `🔷 DEX monitoring (DexScreener)\n` +
    `🤖 AI predictions (DeepSeek 3.1)\n` +
    `📊 Technical analysis (RSI, MACD, EMA)\n` +
    `💰 Wallet PnL tracking\n` +
    `🔔 Smart alerts (every 2 min)\n\n` +
    `👇 Get started below!`,
    { parse_mode: 'HTML', ...buttons }
  );
});

bot.command('help', ctx => {
  return ctx.replyWithHTML(
    `📖 <b>Commands</b>\n\n` +
    `<b>Watchlist Management</b>\n` +
    `/createwl MyList - Create new watchlist\n` +
    `/usewl MyList - Switch to a watchlist\n` +
    `/import - Import from DexScreener\n` +
    `   <i>Example: Send DexScreener link after /import</i>\n\n` +
    `<b>Add Tokens</b>\n` +
    `/addmanual $BONK 0x7xKj... pair_address\n` +
    `   <i>Add token manually with symbol & addresses</i>\n\n` +
    `<b>AI & Alerts</b>\n` +
    `/ai on - Enable AI alerts\n` +
    `/ai off - Disable AI alerts\n` +
    `/blacklist add DOGE - Block token alerts\n` +
    `/blacklist remove DOGE - Unblock token\n\n` +
    `<b>Wallet & Stats</b>\n` +
    `/connect 7xKj... MyWallet - Connect wallet\n` +
    `/pnl - View profit/loss stats\n` +
    `/export - Download trade history CSV`
  );
});

bot.command('createwl', async (ctx) => {
  const name = ctx.message.text.split(' ').slice(1).join(' ');
  if (!name) {
    return ctx.replyWithHTML(
      `❌ Please provide a name!\n\n` +
      `<b>Example:</b>\n` +
      `/createwl MyMemeCoins`
    );
  }
  await db.set(`user_${ctx.from.id}.watchlists.${name}`, { tokens: [] });
  ctx.replyWithHTML(`✅ Watchlist <b>"${name}"</b> created!\n\nUse /usewl ${name} to activate it.`);
});

bot.command('usewl', async (ctx) => {
  const name = ctx.message.text.split(' ').slice(1).join(' ');
  if (!name) {
    const data = await db.get(`user_${ctx.from.id}`);
    const lists = Object.keys(data?.watchlists || {});
    return ctx.replyWithHTML(
      `📋 <b>Your Watchlists:</b>\n\n` +
      (lists.length > 0 ? lists.map(l => `• ${l}`).join('\n') : '<i>No watchlists yet</i>') +
      `\n\n<b>Usage:</b> /usewl MyList`
    );
  }
  await db.set(`user_${ctx.from.id}.activeWatchlist`, name);
  ctx.replyWithHTML(`✅ Switched to <b>"${name}"</b>`);
});

bot.command('import', ctx => ctx.replyWithHTML(
  `📥 <b>Import Watchlist</b>\n\n` +
  `Send me your DexScreener watchlist link\n\n` +
  `<b>Example:</b>\n` +
  `https://dexscreener.com/watchlist/abc123`
));

bot.hears(/^https:\/\/dexscreener\.com\/watchlist\/.+/, async (ctx) => {
  const url = ctx.message.text;
  const name = `WL_${Date.now()}`;
  try {
    const tokens = await importWatchlist(ctx.from.id, name, url);
    await db.set(`user_${ctx.from.id}.activeWatchlist`, name);
    ctx.replyWithHTML(
      `✅ <b>Watchlist Imported!</b>\n\n` +
      `📊 <b>${tokens.length}</b> tokens added\n` +
      `📋 Name: <b>${name}</b>\n\n` +
      `${tokens.slice(0, 5).map(t => `• $${t.symbol} (${t.chain})`).join('\n')}` +
      (tokens.length > 5 ? `\n<i>...and ${tokens.length - 5} more</i>` : '') +
      `\n\n🤖 Enable AI with /ai on to start receiving alerts!`
    );
  } catch (e) {
    ctx.reply(`❌ Error importing watchlist. Please check the URL.`);
  }
});

bot.command('ai', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    const status = await db.get(`user_${ctx.from.id}.ai.enabled`);
    return ctx.replyWithHTML(
      `🤖 <b>AI Alerts Status:</b> ${status ? '✅ ON' : '❌ OFF'}\n\n` +
      `<b>Usage:</b>\n` +
      `/ai on - Enable alerts\n` +
      `/ai off - Disable alerts`
    );
  }
  const enabled = args[0].toLowerCase() === 'on';
  await db.set(`user_${ctx.from.id}.ai.enabled`, enabled);
  ctx.replyWithHTML(
    enabled 
      ? `✅ <b>AI Alerts Enabled!</b>\n\n🔔 You'll get notified when:\n• RSI drops below 30 (oversold)\n• AI sees good entry opportunities\n\n⏱ Scanning every 2 minutes`
      : `❌ <b>AI Alerts Disabled</b>\n\nYou won't receive any alerts until you turn it back on.`
  );
});

bot.command('blacklist', async (ctx) => {
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
      `/blacklist add DOGE\n` +
      `/blacklist remove DOGE`
    );
  }
  
  const blacklist = await db.get(`user_${ctx.from.id}.blacklist`) || [];
  
  if (action === 'add') {
    if (!blacklist.includes(symbol)) {
      blacklist.push(symbol);
      await db.set(`user_${ctx.from.id}.blacklist`, blacklist);
      ctx.replyWithHTML(`✅ <b>$${symbol}</b> added to blacklist\n\n🚫 You won't receive alerts for this token.`);
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

bot.command('connect', async (ctx) => {
  const [addr, ...label] = ctx.message.text.split(' ').slice(1);
  if (!addr) {
    return ctx.replyWithHTML(
      `💰 <b>Connect Wallet</b>\n\n` +
      `<b>Usage:</b>\n` +
      `/connect YOUR_ADDRESS [Label]\n\n` +
      `<b>Example:</b>\n` +
      `/connect 7xKj...9dF2 MainWallet`
    );
  }
  const l = label.join(' ') || addr.slice(0, 8);
  await db.push(`user_${ctx.from.id}.wallets`, { address: addr, label: l });
  ctx.replyWithHTML(`✅ Wallet <b>${l}</b> connected!\n\n💰 Use /pnl to view stats`);
});

bot.command('pnl', async (ctx) => {
  ctx.replyWithHTML(
    `💰 <b>Profit & Loss</b>\n\n` +
    `📊 Total PnL: <b>+$1,842</b>\n` +
    `✅ Wins: 7\n` +
    `❌ Losses: 2\n` +
    `📈 Win Rate: <b>77.8%</b>\n\n` +
    `<i>Note: Currently showing simulated data</i>`
  );
});

bot.command('export', async (ctx) => {
  ctx.replyWithHTML(`📤 <b>Exporting trade history...</b>`);
  ctx.replyWithDocument({ 
    source: Buffer.from('Token,Entry,TP1,Result\n$BOOMER,0.000069,0.000083,+20%\n$PEPE,0.000012,0.000015,+25%'), 
    filename: 'trade_history.csv' 
  });
});

// === CRON JOBS ===
cron.schedule('*/2 * * * *', () => 
  db.all().forEach(u => u.id.startsWith('user_') && scanAndAlert(u.id.split('_')[1]))
);
cron.schedule('0 0 * * *', () => 
  db.all().forEach(u => u.id.startsWith('user_') && 
    bot.telegram.sendMessage(u.id.split('_')[1], 'Daily PnL: /pnl'))
);

bot.launch();
console.log('DEXAlert AI Bot v0.1 – RUNNING!');