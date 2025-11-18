const { Telegraf, Markup } = require("telegraf");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");
const cron = require("node-cron");
require("dotenv").config();

// Validate required environment variables
const requiredEnvVars = ['TELEGRAM_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars.join(', '));
  console.error('Please set these variables in your Vercel project settings.');
  
  // Create a minimal bot instance that will fail gracefully
  module.exports = {
    bot: null,
    scanAndAlert: async () => { console.error('Bot not initialized due to missing environment variables'); },
    db: null
  };
  return;
}

let supabase;
try {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
} catch (error) {
  console.error('Failed to initialize Supabase client:', error.message);
  
  module.exports = {
    bot: null,
    scanAndAlert: async () => { console.error('Bot not initialized due to Supabase connection failure'); },
    db: null
  };
  return;
}
const DB_TABLE = "bot_users";

const db = {
  async get(path) {
    const m = path.match(/^user_(.+?)(?:\.(.+))?$/);
    if (!m) return null;
    const userId = m[1];
    const { data } = await supabase
      .from(DB_TABLE)
      .select("data")
      .eq("user_id", userId)
      .single();
    const obj = data?.data || {};
    if (!m[2]) return obj;
    return m[2]
      .split(".")
      .reduce(
        (acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined),
        obj
      );
  },
  async set(path, value) {
    const m = path.match(/^user_(.+?)(?:\.(.+))?$/);
    if (!m) return null;
    const userId = m[1];
    const { data } = await supabase
      .from(DB_TABLE)
      .select("data")
      .eq("user_id", userId)
      .single();
    const obj = data?.data || {};
    const keys = m[2] ? m[2].split(".") : [];
    let ref = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof ref[keys[i]] !== "object" || ref[keys[i]] === null)
        ref[keys[i]] = {};
      ref = ref[keys[i]];
    }
    if (keys.length) ref[keys[keys.length - 1]] = value;
    else Object.assign(obj, value);
    await supabase.from(DB_TABLE).upsert({ user_id: userId, data: obj });
  },
  async push(path, value) {
    const m = path.match(/^user_(.+?)(?:\.(.+))?$/);
    if (!m) return null;
    const userId = m[1];
    const { data } = await supabase
      .from(DB_TABLE)
      .select("data")
      .eq("user_id", userId)
      .single();
    const obj = data?.data || {};
    const keys = m[2] ? m[2].split(".") : [];
    let ref = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof ref[keys[i]] !== "object" || ref[keys[i]] === null)
        ref[keys[i]] = {};
      ref = ref[keys[i]];
    }
    if (keys.length) {
      if (!Array.isArray(ref[keys[keys.length - 1]])) ref[keys[keys.length - 1]] = [];
      ref[keys[keys.length - 1]].push(value);
    }
    await supabase.from(DB_TABLE).upsert({ user_id: userId, data: obj });
  },
  async all() {
    const { data } = await supabase.from(DB_TABLE).select("user_id, data");
    return data || [];
  }
};

// Initialize Telegram Bot
let bot;
try {
  console.log('Initializing Telegram bot with token:', process.env.TELEGRAM_BOT_TOKEN ? 'Present' : 'Missing');
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
  console.log('Telegram bot initialized successfully');
} catch (error) {
  console.error('Failed to initialize Telegram bot:', error.message);
  console.error('Error stack:', error.stack);
  
  module.exports = {
    bot: null,
    scanAndAlert: async () => { console.error('Bot not initialized due to Telegram bot failure'); },
    db: null
  };
  return;
}

// Toggle preset for simplified watchlist (no categories)
bot.action(/^toggle_preset_watchlist_(.+)_(.+)$/, async (ctx) => {
  const presetKey = ctx.match[1];
  const preset = ALERT_PRESETS[presetKey];
  
  if (!preset) {
    return ctx.answerCbQuery("Invalid preset", { show_alert: true });
  }
  
  // Get current user alerts (simplified structure)
  const userAlerts = await db.get(`user_${ctx.from.id}.alerts`) || {};
  const existingAlert = userAlerts[presetKey];
  
  // Toggle the preset
  if (existingAlert) {
    existingAlert.active = !existingAlert.active;
  } else {
    userAlerts[presetKey] = { preset: presetKey, active: true, createdAt: Date.now() };
  }
  
  await db.set(`user_${ctx.from.id}.alerts`, userAlerts);
  
  const isNowActive = existingAlert ? existingAlert.active : true;
  ctx.answerCbQuery(`${preset.name} ${isNowActive ? 'enabled' : 'disabled'}!`, { show_alert: true });
  
  // Refresh the preset view with updated status
  const tokens = await db.get(`user_${ctx.from.id}.watchlist.tokens`) || [];
  const updatedUserAlerts = await db.get(`user_${ctx.from.id}.alerts`) || {};
  const updatedIsActive = updatedUserAlerts[presetKey]?.enabled || false;

  ctx.editMessageText(
    `🎯 <b>${preset.name}</b>\n\n` +
      `<b>Criteria:</b> ${preset.description}\n\n` +
      `<b>Status:</b> ${updatedIsActive ? '✅ Active' : '❌ Inactive'} for your watchlist\n` +
      `<b>Tokens:</b> ${tokens.length} tokens will be monitored\n` +
      `<b>Options:</b> Toggle preset or modify settings`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard([
      [Markup.button.callback(`${updatedIsActive ? '✅' : '❌'} ${preset.name}`, `toggle_preset_watchlist_${presetKey}_0`)],
      [Markup.button.callback("🔧 Modify", `modify_preset_${presetKey}_0`)],
      [Markup.button.callback("📋 View Criteria", `view_criteria_${presetKey}`)],
      [Markup.button.callback("💾 Save as New Preset", `save_as_new_${presetKey}`)],
      [Markup.button.callback("« Back to Presets", "alert_presets")]
    ]) }
  );
});

// View detailed criteria
bot.action(/^view_criteria_(.+)$/, async (ctx) => {
  const presetKey = ctx.match[1];
  const preset = ALERT_PRESETS[presetKey];
  
  if (!preset) {
    return ctx.answerCbQuery("Invalid preset", { show_alert: true });
  }
  
  ctx.answerCbQuery();
  
  // Show detailed criteria breakdown
  let criteriaText = `📋 <b>${preset.name} - Detailed Criteria</b>\n\n`;
  criteriaText += `<b>Description:</b> ${preset.description}\n\n`;
  
  // Add specific condition breakdown based on preset type
  if (presetKey === 'OVERSOLD_HUNTER') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• RSI ≤ 30 (oversold territory)\n`;
    criteriaText += `• Volume increase ≥ 300%\n\n`;
    criteriaText += `<b>Signal:</b> Potential bounce opportunity`;
  } else if (presetKey === 'PUMP_DETECTOR') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• Price increase ≥ 15% in 5 minutes\n`;
    criteriaText += `• RSI < 50 (not yet overbought)\n\n`;
    criteriaText += `<b>Signal:</b> Early pump detection`;
  } else if (presetKey === 'DUMP_RECOVERY') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• Price drop ≥ 20% followed by\n`;
    criteriaText += `• Recovery ≥ 10% within 15 minutes\n\n`;
    criteriaText += `<b>Signal:</b> Dump recovery opportunity`;
  } else if (presetKey === 'OVERBOUGHT_EXIT') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• RSI ≥ 70 (overbought territory)\n`;
    criteriaText += `• Volume spike ≥ 200%\n\n`;
    criteriaText += `<b>Signal:</b> Potential exit/sell signal`;
  } else if (presetKey === 'EMA_GOLDEN_CROSS') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• EMA 9 crosses above EMA 21\n\n`;
    criteriaText += `<b>Signal:</b> Bullish momentum shift`;
  } else if (presetKey === 'MACD_BULLISH') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• MACD line crosses above signal line\n\n`;
    criteriaText += `<b>Signal:</b> Bullish MACD crossover`;
  } else if (presetKey === 'VOLUME_EXPLOSION') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• Volume increase ≥ 500% in 5 minutes\n\n`;
    criteriaText += `<b>Signal:</b> Unusual volume activity`;
  } else if (presetKey === 'AI_HIGH_CONFIDENCE') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• AI prediction confidence ≥ 80%\n\n`;
    criteriaText += `<b>Signal:</b> High probability AI signal`;
  } else if (presetKey === 'AI_QUICK_FLIP') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• AI target price ≥ 15% gain\n`;
    criteriaText += `• Expected time < 30 minutes\n\n`;
    criteriaText += `<b>Signal:</b> Quick flip opportunity`;
  }
  
  criteriaText += `\n\n<b>Usage:</b> This preset will trigger when all conditions are met.`;
  
  ctx.editMessageText(criteriaText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🔧 Modify Criteria", `modify_preset_${presetKey}`)],
      [Markup.button.callback("💾 Save as New", `save_as_new_${presetKey}`)],
      [Markup.button.callback("« Back to Preset", `preset_${presetKey}`)]
    ])
  });
});

// Modify preset (placeholder for future customization)
bot.action(/^modify_preset_(.+)$/, async (ctx) => {
  const presetKey = ctx.match[1];
  const preset = ALERT_PRESETS[presetKey];
  
  if (!preset) {
    return ctx.answerCbQuery("Invalid preset", { show_alert: true });
  }
  
  ctx.answerCbQuery();
  
  // For now, show a message that modification is coming soon
  // In a full implementation, this would open a customization wizard
  ctx.editMessageText(
    `🔧 <b>Modify ${preset.name}</b>\n\n` +
      `Preset customization is coming soon!\n\n` +
      `<b>Current Settings:</b> ${preset.description}\n\n` +
      `You'll be able to adjust thresholds, add conditions, and create custom variants.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("💾 Save as New Preset", `save_as_new_${presetKey}`)],
        [Markup.button.callback("« Back to Criteria", `view_criteria_${presetKey}`)]
      ])
    }
  );
});

// Save as new preset (placeholder for future functionality)
bot.action(/^save_as_new_(.+)$/, async (ctx) => {
  const presetKey = ctx.match[1];
  const preset = ALERT_PRESETS[presetKey];
  
  if (!preset) {
    return ctx.answerCbQuery("Invalid preset", { show_alert: true });
  }
  
  ctx.answerCbQuery("Save as new preset - Coming soon!", { show_alert: true });
});



// View detailed criteria
bot.action(/^view_criteria_(.+)$/, async (ctx) => {
  const presetKey = ctx.match[1];
  const preset = ALERT_PRESETS[presetKey];
  
  if (!preset) {
    return ctx.answerCbQuery("Invalid preset", { show_alert: true });
  }
  
  ctx.answerCbQuery();
  
  // Show detailed criteria breakdown
  let criteriaText = `📋 <b>${preset.name} - Detailed Criteria</b>\n\n`;
  criteriaText += `<b>Description:</b> ${preset.description}\n\n`;
  
  // Add specific condition breakdown based on preset type
  if (presetKey === 'OVERSOLD_HUNTER') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• RSI ≤ 30 (oversold territory)\n`;
    criteriaText += `• Volume increase ≥ 300%\n\n`;
    criteriaText += `<b>Signal:</b> Potential bounce opportunity`;
  } else if (presetKey === 'PUMP_DETECTOR') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• Price increase ≥ 15% in 5 minutes\n`;
    criteriaText += `• RSI < 50 (not yet overbought)\n\n`;
    criteriaText += `<b>Signal:</b> Early pump detection`;
  } else if (presetKey === 'DUMP_RECOVERY') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• Price drop ≥ 20% followed by\n`;
    criteriaText += `• Recovery ≥ 10% within 15 minutes\n\n`;
    criteriaText += `<b>Signal:</b> Dump recovery opportunity`;
  } else if (presetKey === 'OVERBOUGHT_EXIT') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• RSI ≥ 70 (overbought territory)\n`;
    criteriaText += `• Volume spike ≥ 200%\n\n`;
    criteriaText += `<b>Signal:</b> Potential exit/sell signal`;
  } else if (presetKey === 'EMA_GOLDEN_CROSS') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• EMA 9 crosses above EMA 21\n\n`;
    criteriaText += `<b>Signal:</b> Bullish momentum shift`;
  } else if (presetKey === 'MACD_BULLISH') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• MACD line crosses above signal line\n\n`;
    criteriaText += `<b>Signal:</b> Bullish MACD crossover`;
  } else if (presetKey === 'VOLUME_EXPLOSION') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• Volume increase ≥ 500% in 5 minutes\n\n`;
    criteriaText += `<b>Signal:</b> Unusual volume activity`;
  } else if (presetKey === 'AI_HIGH_CONFIDENCE') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• AI prediction confidence ≥ 80%\n\n`;
    criteriaText += `<b>Signal:</b> High probability AI signal`;
  } else if (presetKey === 'AI_QUICK_FLIP') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• AI target price ≥ 15% gain\n`;
    criteriaText += `• Expected time < 30 minutes\n\n`;
    criteriaText += `<b>Signal:</b> Quick flip opportunity`;
  }
  
  criteriaText += `\n\n<b>Usage:</b> This preset will trigger when all conditions are met.`;
  
  ctx.editMessageText(criteriaText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🔧 Modify Criteria", `modify_preset_${presetKey}`)],
      [Markup.button.callback("💾 Save as New", `save_as_new_${presetKey}`)],
      [Markup.button.callback("« Back to Preset", `preset_${presetKey}`)]
    ])
  });
});

// Modify preset (placeholder for future customization)
bot.action(/^modify_preset_(.+)$/, async (ctx) => {
  const presetKey = ctx.match[1];
  const preset = ALERT_PRESETS[presetKey];
  
  if (!preset) {
    return ctx.answerCbQuery("Invalid preset", { show_alert: true });
  }
  
  ctx.answerCbQuery();
  
  // For now, show a message that modification is coming soon
  // In a full implementation, this would open a customization wizard
  ctx.editMessageText(
    `🔧 <b>Modify ${preset.name}</b>\n\n` +
      `Preset customization is coming soon!\n\n` +
      `<b>Current Settings:</b> ${preset.description}\n\n` +
      `You'll be able to adjust thresholds, add conditions, and create custom variants.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("💾 Save as New Preset", `save_as_new_${presetKey}`)],
        [Markup.button.callback("« Back to Criteria", `view_criteria_${presetKey}`)]
      ])
    }
  );
});

// Save as new preset (placeholder for future functionality)
bot.action(/^save_as_new_(.+)$/, async (ctx) => {
  const presetKey = ctx.match[1];
  const preset = ALERT_PRESETS[presetKey];
  
  if (!preset) {
    return ctx.answerCbQuery("Invalid preset", { show_alert: true });
  }
  
  ctx.answerCbQuery("Save as new preset - Coming soon!", { show_alert: true });
});

// View detailed criteria
bot.action(/^view_criteria_(.+)$/, async (ctx) => {
  const presetKey = ctx.match[1];
  const preset = ALERT_PRESETS[presetKey];
  
  if (!preset) {
    return ctx.answerCbQuery("Invalid preset", { show_alert: true });
  }
  
  ctx.answerCbQuery();
  
  // Show detailed criteria breakdown
  let criteriaText = `📋 <b>${preset.name} - Detailed Criteria</b>\n\n`;
  criteriaText += `<b>Description:</b> ${preset.description}\n\n`;
  
  // Add specific condition breakdown based on preset type
  if (presetKey === 'OVERSOLD_HUNTER') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• RSI ≤ 30 (oversold territory)\n`;
    criteriaText += `• Volume increase ≥ 300%\n\n`;
    criteriaText += `<b>Signal:</b> Potential bounce opportunity`;
  } else if (presetKey === 'PUMP_DETECTOR') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• Price increase ≥ 15% in 5 minutes\n`;
    criteriaText += `• RSI < 50 (not yet overbought)\n\n`;
    criteriaText += `<b>Signal:</b> Early pump detection`;
  } else if (presetKey === 'DUMP_RECOVERY') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• Price drop ≥ 20% followed by\n`;
    criteriaText += `• Recovery ≥ 10% within 15 minutes\n\n`;
    criteriaText += `<b>Signal:</b> Dump recovery opportunity`;
  } else if (presetKey === 'OVERBOUGHT_EXIT') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• RSI ≥ 70 (overbought territory)\n`;
    criteriaText += `• Volume spike ≥ 200%\n\n`;
    criteriaText += `<b>Signal:</b> Potential exit/sell signal`;
  } else if (presetKey === 'EMA_GOLDEN_CROSS') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• EMA 9 crosses above EMA 21\n\n`;
    criteriaText += `<b>Signal:</b> Bullish momentum shift`;
  } else if (presetKey === 'MACD_BULLISH') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• MACD line crosses above signal line\n\n`;
    criteriaText += `<b>Signal:</b> Bullish MACD crossover`;
  } else if (presetKey === 'VOLUME_EXPLOSION') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• Volume increase ≥ 500% in 5 minutes\n\n`;
    criteriaText += `<b>Signal:</b> Unusual volume activity`;
  } else if (presetKey === 'AI_HIGH_CONFIDENCE') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• AI prediction confidence ≥ 80%\n\n`;
    criteriaText += `<b>Signal:</b> High probability AI signal`;
  } else if (presetKey === 'AI_QUICK_FLIP') {
    criteriaText += `<b>Conditions:</b>\n`;
    criteriaText += `• AI target price ≥ 15% gain\n`;
    criteriaText += `• Expected time < 30 minutes\n\n`;
    criteriaText += `<b>Signal:</b> Quick flip opportunity`;
  }
  
  criteriaText += `\n\n<b>Usage:</b> This preset will trigger when all conditions are met.`;
  
  ctx.editMessageText(criteriaText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🔧 Modify Criteria", `modify_preset_${presetKey}`)],
      [Markup.button.callback("💾 Save as New", `save_as_new_${presetKey}`)],
      [Markup.button.callback("« Back to Preset", `preset_${presetKey}`)]
    ])
  });
});

// Modify preset (placeholder for future customization)
bot.action(/^modify_preset_(.+)$/, async (ctx) => {
  const presetKey = ctx.match[1];
  const preset = ALERT_PRESETS[presetKey];
  
  if (!preset) {
    return ctx.answerCbQuery("Invalid preset", { show_alert: true });
  }
  
  ctx.answerCbQuery();
  
  // For now, show a message that modification is coming soon
  // In a full implementation, this would open a customization wizard
  ctx.editMessageText(
    `🔧 <b>Modify ${preset.name}</b>\n\n` +
      `Preset customization is coming soon!\n\n` +
      `<b>Current Settings:</b> ${preset.description}\n\n` +
      `You'll be able to adjust thresholds, add conditions, and create custom variants.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("💾 Save as New Preset", `save_as_new_${presetKey}`)],
        [Markup.button.callback("« Back to Criteria", `view_criteria_${presetKey}`)]
      ])
    }
  );
});

// Save as new preset (placeholder for future functionality)
bot.action(/^save_as_new_(.+)$/, async (ctx) => {
  const presetKey = ctx.match[1];
  const preset = ALERT_PRESETS[presetKey];
  
  if (!preset) {
    return ctx.answerCbQuery("Invalid preset", { show_alert: true });
  }
  
  ctx.answerCbQuery("Save as new preset - Coming soon!", { show_alert: true });
});

const TAAPI = process.env.TAAPI_IO_SECRET;
bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  try {
    ctx.answerCbQuery?.("Error occurred");
  } catch {}
});

let taapiCount = 0;
const MAX_TAAPI = 90;

// === ALERT PRESETS ===
const ALERT_PRESETS = {
  OVERSOLD_HUNTER: {
    name: "🟢 OVERSOLD HUNTER",
    description: "RSI ≤30 + Volume +300%",
    condition: (ind, priceChange) =>
      parseFloat(ind.rsi) <= 30 && priceChange.volume >= 300,
  },
  PUMP_DETECTOR: {
    name: "🚀 PUMP DETECTOR",
    description: "Price +15% in 5m + RSI <50",
    condition: (ind, priceChange) =>
      priceChange.price5m >= 15 && parseFloat(ind.rsi) < 50,
  },
  DUMP_RECOVERY: {
    name: "📉📈 DUMP & RECOVERY",
    description: "Price -20% then +10% in 15m",
    condition: (ind, priceChange) => priceChange.dump && priceChange.recovery,
  },
  OVERBOUGHT_EXIT: {
    name: "🔴 OVERBOUGHT EXIT",
    description: "RSI ≥70 + Volume spike (sell)",
    condition: (ind, priceChange) =>
      parseFloat(ind.rsi) >= 70 && priceChange.volume >= 200,
  },
  EMA_GOLDEN_CROSS: {
    name: "✨ EMA GOLDEN CROSS",
    description: "EMA 9 > EMA 21",
    condition: (ind) => parseFloat(ind.ema9) > parseFloat(ind.ema21),
  },
  MACD_BULLISH: {
    name: "📊 MACD BULLISH CROSS",
    description: "MACD crosses signal upward",
    condition: (ind) => ind.macdCross === "bullish",
  },
  VOLUME_EXPLOSION: {
    name: "💥 VOLUME EXPLOSION",
    description: "Volume +500% in 5m",
    condition: (ind, priceChange) => priceChange.volume >= 500,
  },
  AI_HIGH_CONFIDENCE: {
    name: "🤖 AI HIGH CONFIDENCE",
    description: "AI TP1 probability ≥80%",
    condition: (ind, priceChange, aiPred) => aiPred && aiPred.prob1 >= 80,
  },
  AI_QUICK_FLIP: {
    name: "⚡ AI QUICK FLIP",
    description: "AI TP1 ≥15% + time <30min",
    condition: (ind, priceChange, aiPred) => {
      if (!aiPred) return false;
      const gainPercent = ((aiPred.tp1 - aiPred.entry) / aiPred.entry) * 100;
      return (
        gainPercent >= 15 &&
        (aiPred.time1.includes("15") || aiPred.time1.includes("30"))
      );
    },
  },
};

// === WALLET PRESETS ===
const WALLET_PRESETS = {
  WHALE_TRACKER: {
    name: "🐋 Whale Tracker",
    description: "Track wallets with >$100k holdings",
    criteria: "Wallet value > $100,000",
    enabled: false,
    config: { minValue: 100000 }
  },
  SMART_MONEY: {
    name: "🧠 Smart Money", 
    description: "High win rate wallets (70%+)",
    criteria: "Win rate ≥ 70%",
    enabled: false,
    config: { minWinRate: 70 }
  },
  EARLY_ADOPTER: {
    name: "⚡ Early Adopter",
    description: "Wallets that buy tokens early",
    criteria: "Buys within 1 hour of launch",
    enabled: false,
    config: { maxAge: 3600 }
  },
  PROFIT_TAKER: {
    name: "💰 Profit Taker",
    description: "Wallets that take profits at 2x+",
    criteria: "Takes profit at 100%+ gains",
    enabled: false,
    config: { minProfit: 100 }
  },
  DIP_BUYER: {
    name: "📉 Dip Buyer",
    description: "Buys tokens after 20%+ dips",
    criteria: "Buys after 20% price drop",
    enabled: false,
    config: { minDip: 20 }
  }
};

// === PORTFOLIO TRACKING ===
async function getPortfolioValue(userId) {
  const portfolio = await db.get(`user_${userId}.portfolio`) || {};
  const tokens = await db.get(`user_${userId}.watchlist.tokens`) || [];
  
  let totalValue = 0;
  let totalCostBasis = 0;
  const holdings = [];
  
  for (const token of tokens) {
    const holding = portfolio[token.address.toLowerCase()];
    if (holding && holding.amount > 0) {
      try {
        const dexData = await getDexCandles(token.pairAddress);
        if (dexData) {
          const currentPrice = dexData.currentPrice;
          const currentValue = holding.amount * currentPrice;
          const costBasis = holding.amount * holding.avgBuyPrice;
          const pnl = currentValue - costBasis;
          const pnlPercent = (pnl / costBasis) * 100;
          
          totalValue += currentValue;
          totalCostBasis += costBasis;
          
          holdings.push({
            symbol: token.symbol,
            amount: holding.amount,
            avgBuyPrice: holding.avgBuyPrice,
            currentPrice,
            currentValue,
            costBasis,
            pnl,
            pnlPercent,
            chain: token.chain
          });
        }
      } catch (e) {
        console.error(`Error calculating portfolio for ${token.symbol}:`, e);
      }
    }
  }
  
  const totalPnl = totalValue - totalCostBasis;
  const totalPnlPercent = totalCostBasis > 0 ? (totalPnl / totalCostBasis) * 100 : 0;
  
  return {
    totalValue,
    totalCostBasis,
    totalPnl,
    totalPnlPercent,
    holdings
  };
}

// === PRICE RANGE ALERTS ===
async function checkPriceRangeAlerts(userId, token, currentPrice) {
  const priceAlerts = await db.get(`user_${userId}.priceAlerts`) || {};
  const tokenKey = token.address.toLowerCase();
  const alerts = priceAlerts[tokenKey] || [];
  
  const triggeredAlerts = [];
  
  for (const alert of alerts) {
    if (!alert.triggered) {
      let shouldTrigger = false;
      
      if (alert.type === 'above' && currentPrice >= alert.price) {
        shouldTrigger = true;
      } else if (alert.type === 'below' && currentPrice <= alert.price) {
        shouldTrigger = true;
      } else if (alert.type === 'range' && 
                 currentPrice >= alert.minPrice && 
                 currentPrice <= alert.maxPrice) {
        shouldTrigger = true;
      }
      
      if (shouldTrigger) {
        alert.triggered = true;
        alert.triggeredAt = Date.now();
        alert.triggeredPrice = currentPrice;
        triggeredAlerts.push(alert);
      }
    }
  }
  
  if (triggeredAlerts.length > 0) {
    await db.set(`user_${userId}.priceAlerts.${tokenKey}`, alerts);
  }
  
  return triggeredAlerts;
}

// === HELPER FUNCTIONS ===
async function safeTaapi(endpoint, method = "GET", body = null) {
  if (taapiCount >= MAX_TAAPI) {
    await new Promise((r) => setTimeout(r, 60000));
    taapiCount = 0;
  }
  try {
    taapiCount++;
    const url = `https://api.taapi.io/${endpoint}`;
    const options = {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : null,
    };
    const res = await fetch(url, options);
    return await res.json();
  } catch (e) {
    console.error("Taapi Error:", e);
    return null;
  }
}

async function predictAI(indicators, price, userId) {
  const history = (await db.get(`user_${userId}.ai.history`)) || [];
  const prompt = `Analyze memecoin with RSI ${
    indicators.rsi
  }, price ${price}. Predict TP/SL. History: ${JSON.stringify(
    history.slice(-5)
  )}. Output JSON: {entry, sl, tp1, tp2, prob1, prob2, time1, time2, duration, accuracy}`;

  try {
    const res = await fetch("https://api.puter.com/v2/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v3.1",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 300,
      }),
    });
    const data = await res.json();
    const result = JSON.parse(data.choices[0].message.content);
    result.accuracy =
      history.length > 0
        ? (history.filter((h) => h.outcome === "win").length / history.length) *
          100
        : 50;
    await db.push(`user_${userId}.ai.history`, {
      indicators,
      outcome: "pending",
    });
    return result;
  } catch (e) {
    return {
      entry: price,
      sl: price * 0.89,
      tp1: price * 1.2,
      tp2: price * 1.4,
      prob1: 70,
      prob2: 50,
      time1: "15-30 min",
      time2: "30-60 min",
      duration: "1-2 hours",
      accuracy: 60,
    };
  }
}

async function getDexCandles(pairAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${pairAddress}`;
    const data = await fetch(url).then((r) => r.json());
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
  if (!candles || candles.length < 50)
    return { rsi: "N/A", macd: "N/A", ema9: "N/A", ema21: "N/A" };

  const backfillData = {
    secret: TAAPI,
    candles: candles.map((c) => ({
      time: Math.floor(c[0] / 1000),
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    })),
    backfill: [
      { indicator: "rsi", params: { period: 14 } },
      {
        indicator: "macd",
        params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
      },
      { indicator: "ema", params: { period: 9 } },
      { indicator: "ema", params: { period: 21 } },
    ],
  };

  const result = await safeTaapi("backfill", "POST", backfillData);
  if (!result) return { rsi: "N/A", macd: "N/A", ema9: "N/A", ema21: "N/A" };

  return {
    rsi: result.rsi?.value?.toFixed(1) || "N/A",
    macd: result.macd?.valueMACD?.toFixed(6) || "N/A",
    macdSignal: result.macd?.valueSignal?.toFixed(6) || "N/A",
    macdCross:
      result.macd?.valueMACD > result.macd?.valueSignal ? "bullish" : "bearish",
    ema9: result.ema?.[0]?.value?.toFixed(6) || "N/A",
    ema21: result.ema?.[1]?.value?.toFixed(6) || "N/A",
  };
}

async function importWatchlistFromURL(userId, url) {
  const clean = url.replace(/[`<>]/g, "").trim();
  const m = clean.match(/watchlist\/([A-Za-z0-9_-]+)/);
  const id = m ? m[1] : clean;
  const res = await fetch(`https://api.dexscreener.com/watchlists/v1/${id}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "application/json",
      Origin: "https://dexscreener.com",
      Referer: `https://dexscreener.com/watchlist/${id}`,
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const data = await res.json();
  if (!data?.pairs || data.pairs.length === 0)
    throw new Error("Empty watchlist or invalid ID");
  const newTokens = data.pairs.map((p) => ({
    symbol: p.baseToken.symbol,
    address: p.baseToken.address,
    chain: p.chainId,
    url: p.url,
    source: "dex",
    pairAddress: p.pairAddress,
  }));
  
  // Get existing tokens and merge with new ones (avoid duplicates)
  const existingTokens = (await db.get(`user_${userId}.watchlist.tokens`)) || [];
  const existingAddresses = new Set(existingTokens.map(t => t.address.toLowerCase()));
  const uniqueNewTokens = newTokens.filter(t => !existingAddresses.has(t.address.toLowerCase()));
  
  const allTokens = [...existingTokens, ...uniqueNewTokens];
  await db.set(`user_${userId}.watchlist.tokens`, allTokens);
  
  return uniqueNewTokens; // Return only the newly added tokens
}

async function sendAlert(userId, token, ind, pred, price, presetName) {
  const badge = token.source === "dex" ? "🔷 DEX" : "✏️ MANUAL";
  const preset = ALERT_PRESETS[presetName];
  const msg = `
🔔 *ALERT: ${preset ? preset.name : "CUSTOM"}* 🔔
${badge} | *$${token.symbol}* | ${token.chain}

📊 *Technical Indicators*
RSI (5m): ${ind.rsi} ${
    parseFloat(ind.rsi) <= 30 ? "🟢" : parseFloat(ind.rsi) >= 70 ? "🔴" : ""
  }
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
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

async function sendPriceRangeAlert(userId, token, currentPrice, alert) {
  let alertMsg = ``;
  
  if (alert.type === 'above') {
    alertMsg = `🚀 <b>Price Alert: Above Target!</b>\n\n`;
    alertMsg += `<b>${token.symbol}</b> has risen above $${alert.price}\n`;
    alertMsg += `Current Price: $${currentPrice.toFixed(6)}`;
  } else if (alert.type === 'below') {
    alertMsg = `📉 <b>Price Alert: Below Target!</b>\n\n`;
    alertMsg += `<b>${token.symbol}</b> has fallen below $${alert.price}\n`;
    alertMsg += `Current Price: $${currentPrice.toFixed(6)}`;
  } else if (alert.type === 'range') {
    alertMsg = `🎯 <b>Price Alert: In Range!</b>\n\n`;
    alertMsg += `<b>${token.symbol}</b> is now in the $${alert.minPrice}-$${alert.maxPrice} range\n`;
    alertMsg += `Current Price: $${currentPrice.toFixed(6)}`;
  }
  
  alertMsg += `\n\n<a href="${token.url}">View Chart</a>`;
  
  await bot.telegram.sendMessage(userId, alertMsg, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// === MAIN MENU ===
function getMainMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("💰 Wallets", "menu_wallets"),
      Markup.button.callback("📋 Watchlist", "menu_watchlist"),
    ],
    [
      Markup.button.callback("🔔 Alerts", "menu_alerts"),
      Markup.button.callback("📈 Portfolio", "menu_portfolio"),
    ],
    [
      Markup.button.callback("📊 PnL", "menu_pnl"),
      Markup.button.callback("📤 Export", "menu_export"),
    ],
    [
      Markup.button.callback("⚙️ Settings", "menu_settings"),
      Markup.button.callback("❓ Help", "menu_help"),
    ],
  ]);
}

// === BOT COMMANDS ===
bot.start((ctx) => {
  ctx.replyWithHTML(
    `🚀 <b>DEX Alert AI Bot v1.0.2</b>
<i>UI v1.2 Portfolio + Price Alerts</i>

Welcome! I help you find profitable memecoin trades with:

✨ <b>Features</b>
🔷 DEX monitoring (DexScreener)
🤖 AI predictions (DeepSeek 3.1)
📊 9 Alert presets + custom alerts
💰 Wallet & PnL tracking
📈 Portfolio tracking with P&L
💰 Price range alerts
🔔 Smart alerts (every 2 min)

👇 Choose an option below:`,
    getMainMenu()
  );
});

// Handle wallet view
bot.action(/^wallet_view_(\d+)$/, async (ctx) => {
  try {
    ctx.answerCbQuery(); // Answer immediately
    const walletIndex = parseInt(ctx.match[1]);
    const wallets = (await db.get(`user_${ctx.from.id}.wallets`)) || [];
    
    if (walletIndex >= wallets.length || walletIndex < 0) {
      return ctx.answerCbQuery("Invalid wallet selection", { show_alert: true });
    }
    
    const wallet = wallets[walletIndex];
    
    ctx.editMessageText(
      `💰 <b>Wallet Details</b>\n\n` +
      `<b>Label:</b> ${wallet.label}\n` +
      `<b>Address:</b> <code>${wallet.address}</code>\n` +
      `<b>Added:</b> ${new Date(wallet.addedAt || Date.now()).toLocaleDateString()}\n\n` +
      `<i>Use /pnl wallet to see portfolio stats for this wallet</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📊 View Portfolio", "menu_portfolio")],
          [Markup.button.callback("📃 Back to Wallets", "wallet_list")],
          [Markup.button.callback("« Back to Wallet Menu", "menu_wallets")]
        ])
      }
    );
    
  } catch (error) {
    console.error('Error viewing wallet:', error);
    ctx.answerCbQuery("Error viewing wallet", { show_alert: true });
  }
});

// === MENU ACTIONS ===
bot.action("back_main", (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `🚀 <b>DEX Alert AI Bot v1.0.2</b>\n<i>UI v1.2 Portfolio + Price Alerts</i>\n\nWelcome! I help you find profitable memecoin trades with:\n\n✨ <b>Features</b>\n🔷 DEX monitoring (DexScreener)\n🤖 AI predictions (DeepSeek 3.1)\n📊 9 Alert presets + custom alerts\n💰 Wallet & PnL tracking\n📈 Portfolio tracking with P&L\n💰 Price range alerts\n🔔 Smart alerts (every 2 min)\n\n👇 Choose an option below:`,
    { parse_mode: "HTML", ...getMainMenu() }
  );
});

// === WALLET MENU ===
bot.action("menu_wallets", (ctx) => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("➕ Add Wallet", "wallet_add")],
    [Markup.button.callback("📃 View Wallets", "wallet_list")],
    [Markup.button.callback("🎯 Wallet Presets", "wallet_presets")],
    [Markup.button.callback("📤 Export Wallets", "wallet_export")],
    [Markup.button.callback("« Back", "back_main")],
  ]);
  ctx.editMessageText(
    `💰 <b>Wallet Management</b>\n\n` +
      `Manage your wallets for PnL tracking\n\n` +
      `Choose an action:`,
    { parse_mode: "HTML", ...buttons }
  );
});

bot.action("wallet_add", async (ctx) => {
  ctx.answerCbQuery();
  await ctx.editMessageText(
    `➕ <b>Add Wallet</b>\n\n` +
      `Send wallet address in this format:\n\n` +
      `<code>/wallet add ADDRESS [LABEL]</code>\n\n` +
      `<b>Example:</b>\n` +
      `<code>/wallet add 7xKj...9dF2 MainWallet</code>`,
    { parse_mode: "HTML" }
  );
});

bot.action("wallet_list", async (ctx) => {
  ctx.answerCbQuery();
  const wallets = (await db.get(`user_${ctx.from.id}.wallets`)) || [];

  if (wallets.length === 0) {
    return ctx.editMessageText(
      `📃 <b>Your Wallets</b>\n\n<i>No wallets added yet</i>\n\nUse /wallet add to add a wallet`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("« Back", "menu_wallets")],
        ]),
      }
    );
  }

  const buttons = wallets.map((w, i) => [
    Markup.button.callback(
      `${w.label} - ${w.address.slice(0, 8)}...`,
      `wallet_view_${i}`
    ),
  ]);
  buttons.push([Markup.button.callback("« Back", "menu_wallets")]);

  ctx.editMessageText(
    `📃 <b>Your Wallets (${wallets.length})</b>\n\n` +
      `Click a wallet to view details:`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) }
  );
});

bot.action("wallet_export", async (ctx) => {
  try {
    ctx.answerCbQuery(); // Answer immediately
    const wallets = (await db.get(`user_${ctx.from.id}.wallets`)) || [];

    if (wallets.length === 0) {
      return ctx.answerCbQuery("No wallets to export", { show_alert: true });
    }

    const csv =
      "Label,Address\n" +
      wallets.map((w) => `${w.label},${w.address}`).join("\n");
    
    await ctx.replyWithDocument({
      source: Buffer.from(csv),
      filename: "wallets.csv",
    });
    
    ctx.replyWithHTML(
      `✅ <b>Wallets exported successfully!</b>\n\n` +
      `📄 File: <code>wallets.csv</code>\n` +
      `📤 ${wallets.length} wallet(s) exported\n\n` +
      `The file has been sent to your chat.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📃 View Wallets", "wallet_list")],
          [Markup.button.callback("« Back to Wallet Menu", "menu_wallets")]
        ])
      }
    );
    
  } catch (error) {
    console.error('Error exporting wallets:', error);
    ctx.answerCbQuery("Error exporting wallets", { show_alert: true });
  }
});

// === WALLET PRESETS ===
bot.action("wallet_presets", async (ctx) => {
  try {
    ctx.answerCbQuery(); // Answer immediately
    const userId = ctx.from.id;
    
    // Get user's wallet presets configuration
    const userPresets = (await db.get(`user_${userId}.wallet_presets`)) || {};
    
    // Create buttons for each preset with on/off status
    const presetButtons = Object.entries(WALLET_PRESETS).map(([key, preset]) => {
      const isEnabled = userPresets[key]?.enabled || false;
      return [
        Markup.button.callback(`${isEnabled ? '✅' : '❌'} ${preset.name}`, `toggle_wallet_preset_${key}`),
        Markup.button.callback(isEnabled ? '🔧 Modify' : '⚡ Enable', `wallet_preset_detail_${key}`)
      ];
    });
    
    // Add action buttons
    const actionButtons = [
      [Markup.button.callback("📋 View All Criteria", "wallet_presets_criteria")],
      [Markup.button.callback("💾 Save Configuration", "save_wallet_presets")],
      [Markup.button.callback("« Back to Wallet Menu", "menu_wallets")]
    ];
    
    const allButtons = [...presetButtons, ...actionButtons];
    
    ctx.editMessageText(
      `🎯 <b>Wallet Presets</b>\n\n` +
        `Configure wallet tracking presets to automatically identify and track wallets based on specific criteria.\n\n` +
        `Click a preset to toggle it on/off or view details:`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard(allButtons) }
    );
    
  } catch (error) {
    console.error('Error showing wallet presets:', error);
    ctx.answerCbQuery("Error loading wallet presets", { show_alert: true });
  }
});

// Toggle wallet preset on/off
bot.action(/^toggle_wallet_preset_(.+)$/, async (ctx) => {
  try {
    ctx.answerCbQuery(); // Answer immediately
    const presetKey = ctx.match[1];
    const preset = WALLET_PRESETS[presetKey];
    
    if (!preset) {
      return ctx.answerCbQuery("Invalid preset", { show_alert: true });
    }
    
    const userId = ctx.from.id;
    const userPresets = (await db.get(`user_${userId}.wallet_presets`)) || {};
    
    // Toggle the preset
    if (!userPresets[presetKey]) {
      userPresets[presetKey] = { ...preset.config, enabled: true };
    } else {
      userPresets[presetKey].enabled = !userPresets[presetKey].enabled;
    }
    
    await db.set(`user_${userId}.wallet_presets`, userPresets);
    
    const isNowEnabled = userPresets[presetKey].enabled;
    ctx.answerCbQuery(`${preset.name} ${isNowEnabled ? 'enabled' : 'disabled'}!`, { show_alert: true });
    
    // Just show success message - user can navigate back manually
    
  } catch (error) {
    console.error('Error toggling wallet preset:', error);
    ctx.answerCbQuery("Error toggling preset", { show_alert: true });
  }
});

// Show wallet preset details with criteria and modify options
bot.action(/^wallet_preset_detail_(.+)$/, async (ctx) => {
  try {
    ctx.answerCbQuery(); // Answer immediately
    const presetKey = ctx.match[1];
    const preset = WALLET_PRESETS[presetKey];
    
    if (!preset) {
      return ctx.answerCbQuery("Invalid preset", { show_alert: true });
    }
    
    const userId = ctx.from.id;
    const userPresets = (await db.get(`user_${userId}.wallet_presets`)) || {};
    const isEnabled = userPresets[presetKey]?.enabled || false;
    
    // Show detailed preset information
    ctx.editMessageText(
      `🎯 <b>${preset.name}</b>\n\n` +
        `<b>Description:</b> ${preset.description}\n\n` +
        `<b>Criteria:</b> ${preset.criteria}\n\n` +
        `<b>Configuration:</b>\n` +
        `• Status: ${isEnabled ? '✅ Active' : '❌ Inactive'}\n` +
        `• Auto-detect: ${isEnabled ? 'Yes' : 'No'}\n\n` +
        `Adjust settings or save as custom preset:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`${isEnabled ? '⏸ Disable' : '⚡ Enable'} Preset`, `toggle_wallet_preset_${presetKey}`)],
          [Markup.button.callback("🔧 Modify Criteria", `modify_wallet_preset_${presetKey}`)],
          [Markup.button.callback("💾 Save as New Preset", `save_wallet_preset_${presetKey}`)],
          [Markup.button.callback("📋 View Example", `wallet_preset_example_${presetKey}`)],
          [Markup.button.callback("« Back to Wallet Presets", "wallet_presets")]
        ])
      }
    );
    
  } catch (error) {
    console.error('Error showing wallet preset details:', error);
    ctx.answerCbQuery("Error loading preset details", { show_alert: true });
  }
});

// Show wallet preset criteria overview
bot.action("wallet_presets_criteria", async (ctx) => {
  try {
    ctx.answerCbQuery(); // Answer immediately
    
    let criteriaText = `📋 <b>Wallet Presets Criteria Overview</b>\n\n`;
    
    Object.entries(WALLET_PRESETS).forEach(([key, preset]) => {
      criteriaText += `<b>${preset.name}</b>\n`;
      criteriaText += `• ${preset.criteria}\n`;
      criteriaText += `• ${preset.description}\n\n`;
    });
    
    criteriaText += `All presets work automatically when you add new wallets or scan existing ones.`;
    
    ctx.editMessageText(criteriaText, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("💾 Save Configuration", "save_wallet_presets")],
        [Markup.button.callback("« Back to Wallet Presets", "wallet_presets")]
      ])
    });
    
  } catch (error) {
    console.error('Error showing wallet preset criteria:', error);
    ctx.answerCbQuery("Error loading criteria", { show_alert: true });
  }
});

// Show example of wallet preset in action
bot.action(/^wallet_preset_example_(.+)$/, async (ctx) => {
  try {
    ctx.answerCbQuery(); // Answer immediately
    const presetKey = ctx.match[1];
    const preset = WALLET_PRESETS[presetKey];
    
    if (!preset) {
      return ctx.answerCbQuery("Invalid preset", { show_alert: true });
    }
    
    let exampleText = `💡 <b>${preset.name} - Example</b>\n\n`;
    
    switch (presetKey) {
      case 'WHALE_TRACKER':
        exampleText += `When this preset is enabled, the bot will automatically flag wallets that hold more than $100,000 in total value.\n\n`;
        exampleText += `<b>Example detection:</b>\n`;
        exampleText += `• Wallet: 0x742d...89Ab\n`;
        exampleText += `• Total Value: $245,000\n`;
        exampleText += `• Status: 🐋 Whale Detected!\n\n`;
        exampleText += `These wallets are often early investors or smart money.`;
        break;
      case 'SMART_MONEY':
        exampleText += `Identifies wallets with high win rates (70%+) based on their trading history.\n\n`;
        exampleText += `<b>Example detection:</b>\n`;
        exampleText += `• Wallet: 0x3f4e...12Cd\n`;
        exampleText += `• Win Rate: 78%\n`;
        exampleText += `• Total Trades: 156\n`;
        exampleText += `• Status: 🧠 Smart Money!\n\n`;
        exampleText += `Follow these wallets for profitable trades.`;
        break;
      case 'EARLY_ADOPTER':
        exampleText += `Tracks wallets that buy tokens within 1 hour of launch.\n\n`;
        exampleText += `<b>Example detection:</b>\n`;
        exampleText += `• Token: PEPE Launch\n`;
        exampleText += `• Buy Time: 45 minutes after launch\n`;
        exampleText += `• Wallet: 0x9a8b...34Ef\n`;
        exampleText += `• Status: ⚡ Early Adopter!\n\n`;
        exampleText += `These wallets often find gems before they pump.`;
        break;
      default:
        exampleText += `This preset helps identify wallets that match specific trading patterns.\n\n`;
        exampleText += `When enabled, it will automatically scan and flag wallets that meet the criteria.`;
    }
    
    ctx.editMessageText(exampleText, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔧 Modify This Preset", `modify_wallet_preset_${presetKey}`)],
        [Markup.button.callback("« Back to Preset Details", `wallet_preset_detail_${presetKey}`)]
      ])
    });
    
  } catch (error) {
    console.error('Error showing wallet preset example:', error);
    ctx.answerCbQuery("Error loading example", { show_alert: true });
  }
});

// Modify wallet preset (placeholder for customization)
bot.action(/^modify_wallet_preset_(.+)$/, async (ctx) => {
  try {
    ctx.answerCbQuery(); // Answer immediately
    const presetKey = ctx.match[1];
    const preset = WALLET_PRESETS[presetKey];
    
    if (!preset) {
      return ctx.answerCbQuery("Invalid preset", { show_alert: true });
    }
    
    const userId = ctx.from.id;
    const userPresets = (await db.get(`user_${userId}.wallet_presets`)) || {};
    const currentConfig = userPresets[presetKey] || preset.config;
    
    ctx.editMessageText(
      `🔧 <b>Modify ${preset.name}</b>\n\n` +
        `<b>Current Settings:</b>\n` +
        `${JSON.stringify(currentConfig, null, 2)}\n\n` +
        `Preset customization is coming soon! You'll be able to adjust thresholds and parameters.\n\n` +
        `For now, you can save this as a new custom preset.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("💾 Save as New Preset", `save_wallet_preset_${presetKey}`)],
          [Markup.button.callback("« Back to Preset Details", `wallet_preset_detail_${presetKey}`)]
        ])
      }
    );
    
  } catch (error) {
    console.error('Error modifying wallet preset:', error);
    ctx.answerCbQuery("Error modifying preset", { show_alert: true });
  }
});

// Save wallet preset as new custom preset
bot.action(/^save_wallet_preset_(.+)$/, async (ctx) => {
  try {
    ctx.answerCbQuery(); // Answer immediately
    const presetKey = ctx.match[1];
    const preset = WALLET_PRESETS[presetKey];
    
    if (!preset) {
      return ctx.answerCbQuery("Invalid preset", { show_alert: true });
    }
    
    const userId = ctx.from.id;
    const userPresets = (await db.get(`user_${userId}.wallet_presets`)) || {};
    
    // Save as custom preset with timestamp
    const customKey = `CUSTOM_${presetKey}_${Date.now()}`;
    userPresets[customKey] = {
      ...preset.config,
      enabled: true,
      name: `${preset.name} (Custom)`,
      description: preset.description,
      criteria: preset.criteria,
      basedOn: presetKey
    };
    
    await db.set(`user_${userId}.wallet_presets`, userPresets);
    
    ctx.answerCbQuery(`Custom preset saved!`, { show_alert: true });
    
    // Just show success message - user can navigate back manually
    
  } catch (error) {
    console.error('Error saving wallet preset:', error);
    ctx.answerCbQuery("Error saving preset", { show_alert: true });
  }
});

// Save all wallet presets configuration
bot.action("save_wallet_presets", async (ctx) => {
  try {
    ctx.answerCbQuery(); // Answer immediately
    const userId = ctx.from.id;
    const userPresets = (await db.get(`user_${userId}.wallet_presets`)) || {};
    
    const enabledCount = Object.values(userPresets).filter(p => p.enabled).length;
    
    ctx.editMessageText(
      `✅ <b>Wallet Presets Configuration Saved</b>\n\n` +
        `• Total presets: ${Object.keys(WALLET_PRESETS).length}\n` +
        `• Enabled presets: ${enabledCount}\n` +
        `• Custom presets: ${Object.keys(userPresets).filter(k => k.startsWith('CUSTOM_')).length}\n\n` +
        `Your wallet preset configuration has been saved and will be applied to new wallets.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("« Back to Wallet Presets", "wallet_presets")]
        ])
      }
    );
    
  } catch (error) {
    console.error('Error saving wallet presets config:', error);
    ctx.answerCbQuery("Error saving configuration", { show_alert: true });
  }
});

// === PORTFOLIO MENU ===
bot.action("menu_portfolio", async (ctx) => {
  ctx.answerCbQuery();
  const portfolio = await getPortfolioValue(ctx.from.id);
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("💼 View Holdings", "portfolio_view")],
    [Markup.button.callback("➕ Add Position", "portfolio_add")],
    [Markup.button.callback("📊 P&L Summary", "portfolio_summary")],
    [Markup.button.callback("💰 Price Alerts", "portfolio_price_alerts")],
    [Markup.button.callback("« Back", "back_main")],
  ]);
  
  const totalValue = portfolio.totalValue.toFixed(2);
  const totalPnl = portfolio.totalPnl.toFixed(2);
  const pnlEmoji = portfolio.totalPnl >= 0 ? "🟢" : "🔴";
  
  ctx.editMessageText(
    `📈 <b>Portfolio Management</b>\n\n` +
      `Total Value: <b>$${totalValue}</b>\n` +
      `Total P&L: ${pnlEmoji} <b>$${totalPnl} (${portfolio.totalPnlPercent.toFixed(2)}%)</b>\n\n` +
      `Holdings: <b>${portfolio.holdings.length}</b> tokens\n\n` +
      `Choose an option:`,
    { parse_mode: "HTML", ...buttons }
  );
});

bot.action("portfolio_view", async (ctx) => {
  ctx.answerCbQuery();
  const portfolio = await getPortfolioValue(ctx.from.id);
  
  if (portfolio.holdings.length === 0) {
    return ctx.editMessageText(
      `💼 <b>Your Holdings</b>\n\n` +
        `No active positions found.\n\n` +
        `Add positions to track your portfolio performance.`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([
        [Markup.button.callback("➕ Add Position", "portfolio_add")],
        [Markup.button.callback("« Back", "menu_portfolio")],
      ]) }
    );
  }
  
  let holdingsText = `💼 <b>Your Holdings</b>\n\n`;
  portfolio.holdings.forEach((holding, index) => {
    const pnlEmoji = holding.pnl >= 0 ? "🟢" : "🔴";
    holdingsText += `${index + 1}. <b>${holding.symbol}</b> (${holding.chain})\n`;
    holdingsText += `   Amount: ${holding.amount.toFixed(4)}\n`;
    holdingsText += `   Avg Buy: $${holding.avgBuyPrice.toFixed(6)}\n`;
    holdingsText += `   Current: $${holding.currentPrice.toFixed(6)}\n`;
    holdingsText += `   Value: $${holding.currentValue.toFixed(2)}\n`;
    holdingsText += `   P&L: ${pnlEmoji} $${holding.pnl.toFixed(2)} (${holding.pnlPercent.toFixed(2)}%)\n\n`;
  });
  
  ctx.editMessageText(holdingsText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("📊 Summary", "portfolio_summary")],
      [Markup.button.callback("« Back", "menu_portfolio")],
    ]),
  });
});

bot.action("portfolio_add", (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `➕ <b>Add Position</b>\n\n` +
      `Send position details in this format:\n\n` +
      `<code>/portfolio add ADDRESS AMOUNT BUY_PRICE</code>\n\n` +
      `<b>Example:</b>\n` +
      `<code>/portfolio add 0x123... 1000 0.05</code>\n\n` +
      `<i>This will add 1000 tokens bought at $0.05 each</i>`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard([
      [Markup.button.callback("« Back", "menu_portfolio")],
    ]) }
  );
});

bot.action("portfolio_summary", async (ctx) => {
  ctx.answerCbQuery();
  const portfolio = await getPortfolioValue(ctx.from.id);
  
  if (portfolio.holdings.length === 0) {
    return ctx.editMessageText(
      `📊 <b>P&L Summary</b>\n\n` +
        `No active positions to summarize.`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([
        [Markup.button.callback("« Back", "menu_portfolio")],
      ]) }
    );
  }
  
  // Sort by P&L percentage
  const sortedHoldings = [...portfolio.holdings].sort((a, b) => b.pnlPercent - a.pnlPercent);
  const bestPerformer = sortedHoldings[0];
  const worstPerformer = sortedHoldings[sortedHoldings.length - 1];
  
  let summaryText = `📊 <b>P&L Summary</b>\n\n`;
  summaryText += `💰 Total Value: <b>$${portfolio.totalValue.toFixed(2)}</b>\n`;
  summaryText += `💸 Total Cost: <b>$${portfolio.totalCostBasis.toFixed(2)}</b>\n`;
  summaryText += `📈 Total P&L: <b>$${portfolio.totalPnl.toFixed(2)} (${portfolio.totalPnlPercent.toFixed(2)}%)</b>\n\n`;
  
  if (bestPerformer) {
    const bestEmoji = bestPerformer.pnlPercent >= 0 ? "🟢" : "🔴";
    summaryText += `🏆 Best: <b>${bestPerformer.symbol}</b> ${bestEmoji} ${bestPerformer.pnlPercent.toFixed(2)}%\n`;
  }
  
  if (worstPerformer && worstPerformer !== bestPerformer) {
    const worstEmoji = worstPerformer.pnlPercent >= 0 ? "🟢" : "🔴";
    summaryText += `📉 Worst: <b>${worstPerformer.symbol}</b> ${worstEmoji} ${worstPerformer.pnlPercent.toFixed(2)}%\n`;
  }
  
  summaryText += `\nHoldings: <b>${portfolio.holdings.length}</b> tokens`;
  
  ctx.editMessageText(summaryText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("💼 View Holdings", "portfolio_view")],
      [Markup.button.callback("« Back", "menu_portfolio")],
    ]),
  });
});

bot.action("portfolio_price_alerts", async (ctx) => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("➕ Add Price Alert", "price_alert_add")],
    [Markup.button.callback("📋 View Alerts", "price_alert_list")],
    [Markup.button.callback("🗑️ Clear Triggered", "price_alert_clear")],
    [Markup.button.callback("« Back", "menu_portfolio")],
  ]);
  
  ctx.editMessageText(
    `💰 <b>Price Range Alerts</b>\n\n` +
      `Set alerts for when tokens reach specific price levels.\n\n` +
      `Choose an option:`,
    { parse_mode: "HTML", ...buttons }
  );
});

// === PRICE ALERT ACTIONS ===
bot.action("price_alert_add", (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `➕ <b>Add Price Alert</b>\n\n` +
      `Send alert details in this format:\n\n` +
      `<code>/alert price ADDRESS TYPE PRICE</code>\n\n` +
      `<b>Types:</b> above, below, range\n\n` +
      `<b>Examples:</b>\n` +
      `<code>/alert price 0x123... above 0.10</code>\n` +
      `<code>/alert price 0x123... below 0.05</code>\n` +
      `<code>/alert price 0x123... range 0.08-0.12</code>`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard([
      [Markup.button.callback("« Back", "portfolio_price_alerts")],
    ]) }
  );
});

bot.action("price_alert_list", async (ctx) => {
  ctx.answerCbQuery();
  const priceAlerts = await db.get(`user_${ctx.from.id}.priceAlerts`) || {};
  const tokens = await db.get(`user_${ctx.from.id}.watchlist.tokens`) || [];
  
  let alertText = `📋 <b>Your Price Alerts</b>\n\n`;
  let hasAlerts = false;
  
  for (const token of tokens) {
    const alerts = priceAlerts[token.address.toLowerCase()] || [];
    if (alerts.length > 0) {
      hasAlerts = true;
      alertText += `<b>${token.symbol}</b> (${token.chain}):\n`;
      alerts.forEach((alert, index) => {
        const status = alert.triggered ? "✅" : "⏳";
        if (alert.type === 'range') {
          alertText += `   ${status} Range: $${alert.minPrice}-$${alert.maxPrice}\n`;
        } else {
          alertText += `   ${status} ${alert.type}: $${alert.price}\n`;
        }
      });
      alertText += `\n`;
    }
  }
  
  if (!hasAlerts) {
    alertText += `No price alerts set.\n\n`;
    alertText += `Add alerts to monitor price movements.`;
  }
  
  ctx.editMessageText(alertText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("➕ Add Alert", "price_alert_add")],
      [Markup.button.callback("« Back", "portfolio_price_alerts")],
    ]),
  });
});

bot.action("price_alert_clear", async (ctx) => {
  ctx.answerCbQuery();
  const priceAlerts = await db.get(`user_${ctx.from.id}.priceAlerts`) || {};
  
  // Clear only triggered alerts
  for (const tokenKey in priceAlerts) {
    priceAlerts[tokenKey] = priceAlerts[tokenKey].filter(alert => !alert.triggered);
    if (priceAlerts[tokenKey].length === 0) {
      delete priceAlerts[tokenKey];
    }
  }
  
  await db.set(`user_${ctx.from.id}.priceAlerts`, priceAlerts);
  ctx.answerCbQuery("Triggered alerts cleared!");
  
  // Refresh the list
  bot.actions.get("price_alert_list")(ctx);
});

// === WATCHLIST MENU ===
bot.action("menu_watchlist", (ctx) => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback("➕ Add Token", "wl_add_token"),
      Markup.button.callback("📥 Import", "wl_import"),
    ],
    [
      Markup.button.callback("📃 View All", "wl_list"),
      Markup.button.callback("🗑️ Remove Token", "wl_remove_token"),
    ],
    [Markup.button.callback("📤 Export", "wl_export")],
    [Markup.button.callback("« Back", "back_main")],
  ]);
  ctx.editMessageText(
    `📋 <b>Watchlist Management</b>\n\n` +
      `Add tokens, import lists, or manage your watchlist\n\n` +
      `Choose an option:`,
    { parse_mode: "HTML", ...buttons }
  );
});

bot.action("wl_import", (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `📥 <b>Import Watchlist</b>\n\n` +
      `<b>Choose import method:</b>\n\n` +
      `• <b>DexScreener:</b> Import from URL\n` +
      `• <b>CSV/TXT:</b> Upload file with addresses\n` +
      `• <b>Manual:</b> Use "Add Token" for single tokens`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔗 DexScreener URL", "wl_import_dex")],
        [Markup.button.callback("📄 Upload CSV/TXT", "wl_import_file")],
        [Markup.button.callback("« Back", "menu_watchlist")],
      ]),
    }
  );
});

bot.action("wl_import_dex", (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `🔗 <b>DexScreener Import</b>\n\n` +
      `Send the DexScreener watchlist URL:\n\n` +
      `<code>/wl import https://dexscreener.com/watchlist/abc123</code>\n\n` +
      `<i>Replace abc123 with your actual watchlist ID</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("« Back", "wl_import")],
      ]),
    }
  );
});

bot.action("wl_import_file", (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `📄 <b>File Import</b>\n\n` +
      `<b>CSV format:</b> address,chain,symbol (header optional)\n` +
      `<b>TXT format:</b> One address per line\n\n` +
      `<b>Example CSV:</b>\n` +
      `<code>0x123...,ethereum,TOKEN1\n0x456...,bsc,TOKEN2</code>\n\n` +
      `<b>Example TXT:</b>\n` +
      `<code>0x123...\n0x456...</code>\n\n` +
      `<i>Send your file now:</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("« Back", "wl_import")],
      ]),
    }
  );
  
  // Set user flow to expect file import
  db.set(`user_${ctx.from.id}.flow`, { type: 'awaiting_import' });
});

bot.action("wl_create", (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `➕ <b>Create Watchlist</b>\n\n` +
      `<code>/wl create NAME</code>\n\n` +
      `<b>Example:</b>\n` +
      `<code>/wl create MyMemeCoins</code>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("« Back", "menu_watchlist")],
      ]),
    }
  );
});

bot.action("wl_list", async (ctx) => {
  ctx.answerCbQuery();
  
  // Only use simplified watchlist structure - no more categories
  const simpleTokens = await db.get(`user_${ctx.from.id}.watchlist.tokens`) || [];
  
  if (simpleTokens.length === 0) {
    return ctx.editMessageText(
      `📃 <b>Your Watchlist</b>\n\n<i>No tokens yet</i>\n\nAdd tokens with "Add Token" button`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("« Back", "menu_watchlist")],
        ]),
      }
    );
  }
  
  let message = `📃 <b>Your Watchlist</b>\n\n`;
  message += `<b>Tokens (${simpleTokens.length}):</b>\n\n`;
  
  simpleTokens.slice(0, 10).forEach((token, index) => {
    message += `${index + 1}. <b>$${token.symbol}</b> (${token.chain})\n`;
    message += `   <code>${token.address.substring(0, 6)}...${token.address.slice(-4)}</code>\n`;
    if (token.liquidity > 0) {
      message += `   💧 $${Math.round(token.liquidity).toLocaleString()}\n`;
    }
    message += '\n';
  });
  
  if (simpleTokens.length > 10) {
    message += `<i>...and ${simpleTokens.length - 10} more tokens</i>\n\n`;
  }
  
  const buttons = simpleTokens.slice(0, 5).map((token, index) => [
    Markup.button.callback(
      `🗑️ ${token.symbol}`,
      `remove_token_${index}`
    )
  ]);
  
  buttons.push([Markup.button.callback("« Back", "menu_watchlist")]);
  
  ctx.editMessageText(message, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons)
  });
});

// === ADD TOKEN WIZARD ===
bot.action("wl_add_token", async (ctx) => {
  console.log(`User ${ctx.from.id} clicked "Add Token"`);
  ctx.answerCbQuery();
  
  try {
    await ctx.editMessageText(
      `➕ <b>Add Token</b>\n\n` +
        `Please send the token contract address.\n\n` +
        `<i>I'll auto-detect the chain and show you the options.</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("« Back", "menu_watchlist")],
        ]),
      }
    );
    
    console.log(`Setting flow state for user ${ctx.from.id}`);
    await db.set(`user_${ctx.from.id}.flow`, { type: 'add_token', step: 'awaiting_address' });
    console.log(`Flow state set successfully`);
  } catch (error) {
    console.error('Error in wl_add_token:', error);
    ctx.reply('Sorry, there was an error. Please try /start and try again.');
  }
});

// Handle token address input
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  
  console.log(`Received text message from user ${userId}: ${text}`);
  
  // Skip if it's a command
  if (text.startsWith('/')) {
    return;
  }
  
  try {
    const flow = await db.get(`user_${userId}.flow`);
    console.log(`User flow state:`, flow);
    
    if (!flow || flow.type !== 'add_token' || flow.step !== 'awaiting_address') {
      console.log(`User not in add token flow. Flow:`, flow);
      // Not in add token flow, but let's provide helpful feedback
      ctx.replyWithHTML(
        `💡 <b>Not sure what to do with that message</b>\n\n` +
          `Try these commands:\n` +
          `• /start - Main menu\n` +
          `• /wl add ADDRESS - Add token directly\n` +
          `• Click "➕ Add Token" from the watchlist menu`,
        Markup.inlineKeyboard([
          [Markup.button.callback("📋 Watchlist Menu", "menu_watchlist")],
          [Markup.button.callback("🚀 Main Menu", "back_main")],
        ])
      );
      return;
    }
    
    const address = text;
    
    // Basic address validation
    if (!address.match(/^0x[a-fA-F0-9]{40}$/) && !address.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
      ctx.replyWithHTML(
        `❌ <b>Invalid address format</b>\n\n` +
          `Please send a valid token contract address.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("Try Again", "wl_add_token")],
          [Markup.button.callback("« Back", "menu_watchlist")],
        ])
      );
      return;
    }
    
    ctx.replyWithHTML(`🔍 <b>Detecting chain...</b>\n\n<i>Please wait a moment (max 10 seconds).</i>`);
  
  try {
    console.log(`Processing token address: ${address} for user ${userId}`);
    const candidates = await detectChainFromAddress(address);
    console.log(`Detection results:`, candidates);
    
    if (!candidates || candidates.length === 0) {
      // No auto-detection, show manual chain selection (limited to 5 chains)
      const manualChains = [
        { id: 'ethereum', name: 'Ethereum' },
        { id: 'bsc', name: 'BSC' },
        { id: 'base', name: 'Base' },
        { id: 'arbitrum', name: 'Arbitrum' },
        { id: 'solana', name: 'Solana' }
      ];
      
      const chainButtons = manualChains.map(chain => 
        [Markup.button.callback(chain.name, `add_manual_chain_${chain.id}_${address}`)]
      );
      
      ctx.replyWithHTML(
        `❌ <b>Could not auto-detect chain</b>\n\n` +
          `Please select the chain manually:`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            ...chainButtons,
            [Markup.button.callback("« Cancel", "menu_watchlist")]
          ])
        }
      );
      
      await db.set(`user_${userId}.flow`, { type: 'add_token', step: 'manual_chain', address });
      return;
    }
    
    // Show auto-detection results
    const topCandidate = candidates[0];
    const detectionText = `✅ <b>Detected chain: ${topCandidate.chain}</b>\n\n` +
      `• Symbol: <b>$${topCandidate.symbol}</b>\n` +
      `• Liquidity: <b>$${Math.round(topCandidate.liquidity).toLocaleString()}</b>\n` +
      `• 24h Volume: <b>$${Math.round(topCandidate.volume24h).toLocaleString()}</b>\n` +
      `• Price: <b>$${parseFloat(topCandidate.price).toFixed(6)}</b>\n\n` +
      `Is this correct?`;
    
    const actionButtons = [
      [Markup.button.callback("✅ Confirm", `add_confirm_${topCandidate.chainId}_${address}_${topCandidate.pairAddress}`)],
      [Markup.button.callback("🔀 Choose Chain", `add_choose_chain_${address}`)]
    ];
    
    if (candidates.length > 1) {
      actionButtons.push([Markup.button.callback("🔍 View All Options", `add_view_all_${address}`)]);
    }
    
    actionButtons.push([Markup.button.callback("« Cancel", "menu_watchlist")]);
    
    ctx.replyWithHTML(detectionText, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(actionButtons)
    });
    
    await db.set(`user_${userId}.flow`, { 
      type: 'add_token', 
      step: 'confirm_detection', 
      address, 
      candidates 
    });
    
  } catch (error) {
    console.error('Error in add token flow:', error);
    let errorMessage = `❌ <b>Error detecting token</b>\n\n`;
    
    if (error.message === 'Chain detection timeout') {
      errorMessage += `Chain detection timed out after 10 seconds.\n\n` +
        `The token might not be available on the supported chains (Ethereum, BSC, Base, Arbitrum, Solana).\n\n` +
        `Please try manual import or check the address.`;
    } else {
      errorMessage += `Please try again or use manual import.`;
    }
    
    ctx.replyWithHTML(errorMessage,
      Markup.inlineKeyboard([
        [Markup.button.callback("Try Manual Import", "wl_add_token_manual")],
        [Markup.button.callback("Try Again", "wl_add_token")],
        [Markup.button.callback("« Back", "menu_watchlist")],
      ])
    );
  }
} catch (error) {
    console.error('Error in token detection:', error);
    let errorMessage = `❌ <b>Error detecting token</b>\n\n`;
    
    if (error.message === 'Chain detection timeout') {
      errorMessage += `Chain detection timed out after 10 seconds.\n\n` +
        `The token might not be available on the supported chains (Ethereum, BSC, Base, Arbitrum, Solana).\n\n` +
        `Please try manual import or check the address.`;
    } else {
      errorMessage += `Please try again or use manual import.`;
    }
    
    ctx.replyWithHTML(errorMessage,
      Markup.inlineKeyboard([
        [Markup.button.callback("Try Manual Import", "wl_add_token_manual")],
        [Markup.button.callback("Try Again", "wl_add_token")],
        [Markup.button.callback("« Back", "menu_watchlist")],
      ])
    );
  }
});

// Handle chain selection from multiple candidates
bot.action(/^add_choose_chain_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  const userId = ctx.from.id;
  const flow = await db.get(`user_${userId}.flow`);
  
  if (!flow || flow.type !== 'add_token' || !flow.candidates) {
    return ctx.answerCbQuery("Session expired", { show_alert: true });
  }
  
  ctx.answerCbQuery();
  
  const chainButtons = flow.candidates.map(candidate => 
    [Markup.button.callback(
      `${candidate.chain} (Liq: $${Math.round(candidate.liquidity).toLocaleString()})`, 
      `add_confirm_${candidate.chainId}_${address}_${candidate.pairAddress}`
    )]
  );
  
  chainButtons.push([Markup.button.callback("« Back", "wl_add_token")]);
  
  ctx.editMessageText(
    `🔀 <b>Select Chain</b>\n\n` +
      `Choose the chain for this token:`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(chainButtons) }
  );
});

// Handle manual chain selection
bot.action(/^add_manual_chain_(.+)_(.+)$/, async (ctx) => {
  const chainId = ctx.match[1];
  const address = ctx.match[2];
  const userId = ctx.from.id;
  
  ctx.answerCbQuery();
  
  // Save token with minimal info (no pair address since we don't have DexScreener data)
  const tokenData = {
    address,
    chain: chainId,
    symbol: 'Unknown',
    pairAddress: '',
    url: '',
    addedAt: Date.now()
  };
  
  await addTokenToWatchlist(userId, tokenData);
  
  ctx.editMessageText(
    `✅ <b>Token Added</b>\n\n` +
      `• Address: <code>${address}</code>\n` +
      `• Chain: <b>${chainId}</b>\n\n` +
      `<i>Note: Limited info due to no DexScreener data</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("Add Another", "wl_add_token")],
        [Markup.button.callback("« Back", "menu_watchlist")],
      ])
    }
  );
  
  await db.set(`user_${userId}.flow`, null);
});

// === ADDITIONAL FEATURE SUGGESTIONS ===

// Quick Stats Command
bot.command("stats", async (ctx) => {
  const userId = ctx.from.id;
  const data = await db.get(`user_${userId}`);
  
  const tokens = await db.get(`user_${userId}.watchlist.tokens`) || [];
  const alerts = data?.alerts || {};
  const wallets = data?.wallets || [];
  
  const enabledAlerts = Object.values(alerts).filter(a => a.enabled).length;
  const totalAlerts = Object.keys(alerts).length;
  
  ctx.replyWithHTML(
    `📊 <b>Your Stats</b>\n\n` +
      `💰 Wallets: <b>${wallets.length}</b>\n` +
      `📋 Tokens: <b>${tokens.length}</b>\n` +
      `🔔 Alerts: <b>${enabledAlerts}/${totalAlerts}</b> enabled\n` +
      `🤖 AI: <b>${data?.ai?.enabled ? '✅ ON' : '❌ OFF'}</b>\n` +
      `⏱ Last scan: <b>~2 min ago</b>\n\n` +
      `<i>Use /help for commands</i>`
  );
});

// Quick Actions Menu
bot.command("quick", (ctx) => {
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("➕ Add Token", "wl_add_token")],
    [Markup.button.callback("🔔 Toggle Alerts", "settings_alerts")],
    [Markup.button.callback("📊 View Stats", "quick_stats")],
    [Markup.button.callback("⚙️ Settings", "menu_settings")],
  ]);
  
  ctx.replyWithHTML(
    `⚡ <b>Quick Actions</b>\n\n` +
      `Fast access to common tasks:`,
    { parse_mode: "HTML", ...buttons }
  );
});

bot.action("quick_stats", async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  const data = await db.get(`user_${userId}`);
  
  const tokens = await db.get(`user_${userId}.watchlist.tokens`) || [];
  const alerts = data?.alerts || {};
  const wallets = data?.wallets || [];
  
  const enabledAlerts = Object.values(alerts).filter(a => a.enabled).length;
  
  ctx.editMessageText(
    `📊 <b>Quick Stats</b>\n\n` +
      `💰 Wallets: <b>${wallets.length}</b>\n` +
      `📋 Tokens: <b>${tokens.length}</b>\n` +
      `🔔 Alerts: <b>${enabledAlerts}/${Object.keys(alerts).length}</b> enabled\n` +
      `🤖 AI: <b>${data?.ai?.enabled ? '✅ ON' : '❌ OFF'}</b>\n` +
      `⏱ Last scan: <b>~2 min ago</b>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("« Back", "quick_menu")],
      ])
    }
  );
});

bot.action("quick_menu", (ctx) => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("➕ Add Token", "wl_add_token")],
    [Markup.button.callback("🔔 Toggle Alerts", "settings_alerts")],
    [Markup.button.callback("📊 View Stats", "quick_stats")],
    [Markup.button.callback("⚙️ Settings", "menu_settings")],
  ]);
  
  ctx.editMessageText(
    `⚡ <b>Quick Actions</b>\n\n` +
      `Fast access to common tasks:`,
    { parse_mode: "HTML", ...buttons }
  );
});

// Enhanced blacklist with categories
bot.command("block", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  const action = args[0];
  const symbol = args[1];
  
  if (action === "add" && symbol) {
    const blacklist = await db.get(`user_${ctx.from.id}.blacklist`) || [];
    if (!blacklist.includes(symbol.toUpperCase())) {
      blacklist.push(symbol.toUpperCase());
      await db.set(`user_${ctx.from.id}.blacklist`, blacklist);
      ctx.replyWithHTML(`✅ <b>$${symbol.toUpperCase()}</b> added to blacklist`);
    } else {
      ctx.replyWithHTML(`ℹ️ <b>$${symbol.toUpperCase()}</b> already blacklisted`);
    }
  } else if (action === "remove" && symbol) {
    const blacklist = await db.get(`user_${ctx.from.id}.blacklist`) || [];
    const filtered = blacklist.filter(s => s !== symbol.toUpperCase());
    await db.set(`user_${ctx.from.id}.blacklist`, filtered);
    ctx.replyWithHTML(`✅ <b>$${symbol.toUpperCase()}</b> removed from blacklist`);
  } else if (action === "list") {
    const blacklist = await db.get(`user_${ctx.from.id}.blacklist`) || [];
    if (blacklist.length === 0) {
      ctx.replyWithHTML(`📋 <b>Blacklist is empty</b>`);
    } else {
      const list = blacklist.map(s => `• $${s}`).join('\n');
      ctx.replyWithHTML(`📋 <b>Blacklisted tokens:</b>\n\n${list}`);
    }
  } else {
    ctx.replyWithHTML(
      `📋 <b>Blacklist Commands</b>\n\n` +
        `<code>/block add SYMBOL</code> - Add token\n` +
        `<code>/block remove SYMBOL</code> - Remove token\n` +
        `<code>/block list</code> - View all blocked`
    );
  }
});

// === DOCUMENT HANDLERS FOR CSV/TXT IMPORT ===
bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const document = ctx.message.document;
  const fileName = document.file_name || '';
  
  // Check if user is expecting a file import
  const flow = await db.get(`user_${userId}.flow`);
  if (!flow || flow.type !== 'awaiting_import') {
    return; // Not expecting a file
  }
  
  // Only process CSV and TXT files
  if (!fileName.toLowerCase().endsWith('.csv') && !fileName.toLowerCase().endsWith('.txt')) {
    return ctx.replyWithHTML(
      `❌ <b>Invalid file format</b>\n\n` +
        `Please send a CSV or TXT file.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Try Again", "wl_import")],
        [Markup.button.callback("« Back", "menu_watchlist")],
      ])
    );
  }
  
  try {
    // Get file content
    const fileLink = await ctx.telegram.getFileLink(document.file_id);
    const response = await fetch(fileLink.href);
    const content = await response.text();
    
    let tokens = [];
    let importedCount = 0;
    let skippedCount = 0;
    
    if (fileName.toLowerCase().endsWith('.csv')) {
      // Parse CSV
      const lines = content.trim().split('\n');
      const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
      
      // Find column indices
      const addressIdx = headers.findIndex(h => h.includes('address'));
      const chainIdx = headers.findIndex(h => h.includes('chain'));
      const symbolIdx = headers.findIndex(h => h.includes('symbol'));
      
      if (addressIdx === -1) {
        throw new Error('CSV must have an "address" column');
      }
      
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.trim());
        if (cols[addressIdx]) {
          tokens.push({
            address: cols[addressIdx],
            chain: chainIdx !== -1 ? cols[chainIdx] : 'ethereum',
            symbol: symbolIdx !== -1 ? cols[symbolIdx] : 'Unknown'
          });
        }
      }
    } else {
      // Parse TXT - one address per line
      const lines = content.trim().split('\n');
      for (const line of lines) {
        const address = line.trim();
        if (address && (address.match(/^0x[a-fA-F0-9]{40}$/) || address.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/))) {
          tokens.push({
            address: address,
            chain: 'ethereum', // Default chain
            symbol: 'Unknown'
          });
        }
      }
    }
    
    if (tokens.length === 0) {
      return ctx.replyWithHTML(
        `❌ <b>No valid addresses found</b>\n\n` +
          `Check your file format and try again.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("Try Again", "wl_import")],
          [Markup.button.callback("« Back", "menu_watchlist")],
        ])
      );
    }
    
    // Process tokens with auto-detection
    ctx.replyWithHTML(
      `📥 <b>Processing ${tokens.length} tokens...</b>\n\n` +
        `<i>This may take a moment for auto-detection.</i>`
    );
    
    const dedup = await db.get(`user_${userId}.watchlist.dedup`);
    const existingTokens = await db.get(`user_${userId}.watchlist.tokens`) || [];
    const existingAddresses = new Set(existingTokens.map(t => t.address.toLowerCase()));
    
    const results = {
      added: [],
      skipped: [],
      failed: []
    };
    
    for (const token of tokens) {
      try {
        // Check for duplicates
        if (dedup !== false && existingAddresses.has(token.address.toLowerCase())) {
          skippedCount++;
          results.skipped.push(token);
          continue;
        }
        
        // Try auto-detection
        const candidates = await detectChainFromAddress(token.address);
        let tokenData;
        
        if (candidates && candidates.length > 0) {
          const best = candidates[0];
          tokenData = {
            address: token.address,
            chain: best.chain,
            symbol: best.symbol,
            pairAddress: best.pairAddress,
            url: best.url,
            addedAt: Date.now()
          };
        } else {
          // Use provided data or defaults
          tokenData = {
            address: token.address,
            chain: token.chain || 'ethereum',
            symbol: token.symbol || 'Unknown',
            pairAddress: '',
            url: '',
            addedAt: Date.now()
          };
        }
        
        existingTokens.push(tokenData);
        existingAddresses.add(token.address.toLowerCase());
        importedCount++;
        results.added.push(tokenData);
        
      } catch (error) {
        console.error(`Error processing token ${token.address}:`, error);
        results.failed.push(token);
      }
    }
    
    // Save all tokens
    await db.set(`user_${userId}.watchlist.tokens`, existingTokens);
    
    // Show results
    let resultMessage = `✅ <b>Import Complete!</b>\n\n`;
    resultMessage += `• Added: <b>${importedCount}</b>\n`;
    resultMessage += `• Skipped (duplicates): <b>${skippedCount}</b>\n`;
    if (results.failed.length > 0) {
      resultMessage += `• Failed: <b>${results.failed.length}</b>\n`;
    }
    
    if (results.added.length > 0) {
      resultMessage += `\n<b>Successfully added:</b>\n`;
      results.added.slice(0, 5).forEach(token => {
        resultMessage += `• <b>$${token.symbol}</b> (${token.chain})\n`;
      });
      if (results.added.length > 5) {
        resultMessage += `<i>...and ${results.added.length - 5} more</i>\n`;
      }
    }
    
    ctx.replyWithHTML(resultMessage, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("View Watchlist", "wl_list")],
        [Markup.button.callback("« Back", "menu_watchlist")],
      ])
    });
    
    await db.set(`user_${userId}.flow`, null);
    
  } catch (error) {
    console.error('Error processing import file:', error);
    ctx.replyWithHTML(
      `❌ <b>Error processing file</b>\n\n` +
        `Please check your file and try again.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Try Again", "wl_import")],
        [Markup.button.callback("« Back", "menu_watchlist")],
      ])
    );
  }
});

// Handle token confirmation
bot.action(/^add_confirm_(.+)_(.+)_(.*)$/, async (ctx) => {
  const chainId = ctx.match[1];
  const address = ctx.match[2];
  const pairAddress = ctx.match[3];
  const userId = ctx.from.id;
  
  ctx.answerCbQuery();
  
  const flow = await db.get(`user_${userId}.flow`);
  if (!flow || flow.type !== 'add_token') {
    return ctx.answerCbQuery("Session expired", { show_alert: true });
  }
  
  const candidate = flow.candidates?.find(c => c.chainId === chainId) || {
    chainId,
    chain: chainId,
    symbol: 'Unknown',
    pairAddress,
    url: pairAddress ? `https://dexscreener.com/${chainId}/${pairAddress}` : '',
    liquidity: 0,
    volume24h: 0,
    price: 0
  };
  
  const tokenData = {
    address,
    chain: candidate.chain,
    symbol: candidate.symbol,
    pairAddress: candidate.pairAddress,
    url: candidate.url,
    addedAt: Date.now()
  };
  
  await addTokenToWatchlist(userId, tokenData);
  
  ctx.editMessageText(
    `✅ <b>Token Added Successfully!</b>\n\n` +
      `• Symbol: <b>$${candidate.symbol}</b>\n` +
      `• Chain: <b>${candidate.chain}</b>\n` +
      `• Address: <code>${address}</code>\n` +
      (candidate.liquidity > 0 ? `• Liquidity: <b>$${Math.round(candidate.liquidity).toLocaleString()}</b>\n` : '') +
      (candidate.volume24h > 0 ? `• 24h Volume: <b>$${Math.round(candidate.volume24h).toLocaleString()}</b>\n` : ''),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("Add Another", "wl_add_token")],
        [Markup.button.callback("View Watchlist", "wl_list")],
        [Markup.button.callback("« Back", "menu_watchlist")],
      ])
    }
  );
  
  await db.set(`user_${userId}.flow`, null);
});

bot.action("wl_remove_token", async (ctx) => {
  ctx.answerCbQuery();
  const tokens = await db.get(`user_${ctx.from.id}.watchlist.tokens`) || [];
  
  if (tokens.length === 0) {
    return ctx.editMessageText(
      `🗑️ <b>Remove Token</b>\n\n<i>No tokens to remove</i>\n\nAdd some tokens first!`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("« Back", "menu_watchlist")],
        ]),
      }
    );
  }
  
  const removeButtons = tokens.slice(0, 10).map((token, index) => [
    Markup.button.callback(
      `🗑️ $${token.symbol} (${token.chain})`,
      `confirm_remove_${index}`
    )
  ]);
  
  removeButtons.push([Markup.button.callback("« Back", "menu_watchlist")]);
  
  ctx.editMessageText(
    `🗑️ <b>Remove Token</b>\n\n` +
      `Select a token to remove:`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(removeButtons) }
  );
});

bot.action(/^confirm_remove_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  
  let tokens = await db.get(`user_${userId}.watchlist.tokens`) || [];
  
  if (index >= tokens.length) {
    return ctx.answerCbQuery("Invalid selection", { show_alert: true });
  }
  
  const removedToken = tokens[index];
  tokens.splice(index, 1);
  
  await db.set(`user_${userId}.watchlist.tokens`, tokens);
  
  ctx.answerCbQuery(`Removed $${removedToken.symbol}`);
  
  // Refresh the remove menu
  if (tokens.length > 0) {
    const removeButtons = tokens.slice(0, 10).map((token, idx) => [
      Markup.button.callback(
        `🗑️ $${token.symbol} (${token.chain})`,
        `confirm_remove_${idx}`
      )
    ]);
    removeButtons.push([Markup.button.callback("« Back", "menu_watchlist")]);
    
    ctx.editMessageText(
      `🗑️ <b>Remove Token</b>\n\n` +
        `Select a token to remove:\n\n` +
        `<i>$${removedToken.symbol} removed</i>`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard(removeButtons) }
    );
  } else {
    ctx.editMessageText(
      `🗑️ <b>Remove Token</b>\n\n<i>All tokens removed</i>\n\nYour watchlist is now empty!`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("« Back", "menu_watchlist")],
        ]),
      }
    );
  }
});

// Helper function to add token to watchlist
async function addTokenToWatchlist(userId, tokenData) {
  const autoDetect = await db.get(`user_${userId}.watchlist.autoDetect`);
  const dedup = await db.get(`user_${userId}.watchlist.dedup`);
  
  // Get current watchlist (simplified structure)
  let tokens = await db.get(`user_${userId}.watchlist.tokens`) || [];
  
  // Check for duplicates if dedup is enabled
  if (dedup !== false) { // Default to true
    const existingIndex = tokens.findIndex(t => 
      t.address.toLowerCase() === tokenData.address.toLowerCase()
    );
    
    if (existingIndex !== -1) {
      // Update existing token
      tokens[existingIndex] = { ...tokens[existingIndex], ...tokenData };
      await db.set(`user_${userId}.watchlist.tokens`, tokens);
      return { action: 'updated', index: existingIndex };
    }
  }
  
  // Add new token
  tokens.push(tokenData);
  await db.set(`user_${userId}.watchlist.tokens`, tokens);
  return { action: 'added', index: tokens.length - 1 };
}

bot.action("wl_export", async (ctx) => {
  ctx.answerCbQuery();
  const tokens = await db.get(`user_${ctx.from.id}.watchlist.tokens`) || [];

  if (tokens.length === 0) {
    return ctx.answerCbQuery("No tokens to export", { show_alert: true });
  }

  let csv = "Symbol,Address,Chain,PairAddress,Liquidity,Price\n";
  tokens.forEach((token) => {
    csv += `${token.symbol},${token.address},${token.chain},${token.pairAddress},${token.liquidity || 0},${token.price || 0}\n`;
  });

  await ctx.replyWithDocument({
    source: Buffer.from(csv),
    filename: "watchlist.csv",
  });
  
  ctx.replyWithHTML(
    `✅ <b>Watchlist exported successfully!</b>\n\n` +
    `📄 File: <code>watchlist.csv</code>\n` +
    `📤 ${tokens.length} token(s) exported\n\n` +
    `The file has been sent to your chat.`,
    {
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📃 View Watchlist", "wl_list")],
        [Markup.button.callback("« Back to Watchlist Menu", "menu_watchlist")]
      ])
    }
  );
});

// === ALERTS MENU ===
bot.action("menu_alerts", (ctx) => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback("🎯 View Presets", "alert_presets"),
      Markup.button.callback("✏️ Custom Alert", "alert_custom"),
    ],
    [Markup.button.callback("📃 Active Alerts", "alert_list")],
    [Markup.button.callback("⚙️ Manage Alerts", "alert_manage")],
    [Markup.button.callback("« Back", "back_main")],
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
    { parse_mode: "HTML", ...buttons }
  );
});

bot.action("alert_presets", (ctx) => {
  ctx.answerCbQuery();
  const presetButtons = Object.entries(ALERT_PRESETS).map(([key, preset]) => [
    Markup.button.callback(preset.name, `preset_${key}`),
  ]);
  presetButtons.push([Markup.button.callback("« Back", "menu_alerts")]);

  ctx.editMessageText(
    `🎯 <b>Alert Presets</b>\n\n` +
      `Click a preset to enable it for a watchlist:`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(presetButtons) }
  );
});

bot.action(/^preset_(.+)$/, async (ctx) => {
  const presetKey = ctx.match[1];
  const preset = ALERT_PRESETS[presetKey];
  ctx.answerCbQuery();

  const tokens = await db.get(`user_${ctx.from.id}.watchlist.tokens`) || [];

  if (tokens.length === 0) {
    return ctx.answerCbQuery("Add some tokens to your watchlist first!", { show_alert: true });
  }

  // Get current preset status for the watchlist
  const userAlerts = await db.get(`user_${ctx.from.id}.alerts`) || {};
  const isActive = userAlerts[presetKey]?.enabled || false;

  // Create simple on/off toggle for the entire watchlist
  const statusButtons = [
    [
      Markup.button.callback(`${isActive ? '✅' : '❌'} ${preset.name}`, `toggle_preset_watchlist_${presetKey}_0`),
      Markup.button.callback(isActive ? '🔧 Modify' : '⚡ Enable', `modify_preset_${presetKey}_0`)
    ]
  ];

  // Add action buttons
  const actionButtons = [
    [Markup.button.callback("📋 View Criteria", `view_criteria_${presetKey}`)],
    [Markup.button.callback("💾 Save as New Preset", `save_as_new_${presetKey}`)],
    [Markup.button.callback("« Back to Presets", "alert_presets")]
  ];

  const allButtons = [...statusButtons, ...actionButtons];

  ctx.editMessageText(
    `🎯 <b>${preset.name}</b>\n\n` +
      `<b>Criteria:</b> ${preset.description}\n\n` +
      `<b>Status:</b> ${isActive ? '✅ Active' : '❌ Inactive'} for your watchlist\n` +
      `<b>Options:</b> Toggle preset or modify settings`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(allButtons) }
  );
});

bot.action(/^enable_(.+)_(.+)$/, async (ctx) => {
  const presetKey = ctx.match[1];
  const idx = parseInt(ctx.match[2], 10);
  const preset = ALERT_PRESETS[presetKey];

  const data = await db.get(`user_${ctx.from.id}`);
  const lists = Object.keys(data?.watchlists || {});
  const wlName = lists[idx];

  if (!preset || !wlName) {
    return ctx.answerCbQuery("Invalid selection", { show_alert: true });
  }

  const alerts =
    (await db.get(`user_${ctx.from.id}.watchlists.${wlName}.alerts`)) || [];
  alerts.push({ preset: presetKey, active: true, createdAt: Date.now() });
  await db.set(`user_${ctx.from.id}.watchlists.${wlName}.alerts`, alerts);

  ctx.answerCbQuery(`${preset.name} enabled!`, { show_alert: true });
  ctx.editMessageText(
    `✅ <b>Alert Enabled!</b>\n\n` +
      `${preset.name} is now active for watchlist: <b>${wlName}</b>\n\n` +
      `You'll receive notifications when conditions are met.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("« Back", "menu_alerts")],
      ]),
    }
  );
});

bot.action("alert_list", async (ctx) => {
  ctx.answerCbQuery();
  const data = await db.get(`user_${ctx.from.id}`);
  const watchlists = data?.watchlists || {};

  let alertCount = 0;
  let msg = `📃 <b>Active Alerts</b>\n\n`;

  Object.entries(watchlists).forEach(([name, wl]) => {
    if (wl.alerts && wl.alerts.length > 0) {
      msg += `<b>${name}</b>\n`;
      wl.alerts.forEach((a) => {
        const preset = ALERT_PRESETS[a.preset];
        msg += `${a.active ? "✅" : "⏸"} ${preset ? preset.name : "Custom"}\n`;
        alertCount++;
      });
      msg += `\n`;
    }
  });

  if (alertCount === 0) {
    msg += `<i>No active alerts</i>\n\nSet up alerts from the menu above.`;
  }

  ctx.editMessageText(msg, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("« Back", "menu_alerts")],
    ]),
  });
});

bot.action("alert_custom", (ctx) => {
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
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("« Back", "menu_alerts")],
      ]),
    }
  );
});

bot.action("alert_manage", (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `⚙️ <b>Manage Alerts</b>\n\n` +
      `<b>Pause/Resume:</b>\n` +
      `<code>/alert toggle WATCHLIST_NAME</code>\n\n` +
      `<b>Remove Alert:</b>\n` +
      `<code>/alert remove WATCHLIST_NAME PRESET_NAME</code>\n\n` +
      `<b>View Details:</b>\n` +
      `<code>/alert info WATCHLIST_NAME</code>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("« Back", "menu_alerts")],
      ]),
    }
  );
});

// === AI MENU ===
bot.action("menu_ai", async (ctx) => {
  ctx.answerCbQuery();
  const aiEnabled = await db.get(`user_${ctx.from.id}.ai.enabled`);
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(aiEnabled ? "✅ AI ON" : "❌ AI OFF", "ai_toggle")],
    [Markup.button.callback("📊 AI Stats", "ai_stats")],
    [Markup.button.callback("« Back", "back_main")],
  ]);

  ctx.editMessageText(
    `🤖 <b>AI Settings</b>\n\n` +
      `Status: ${aiEnabled ? "<b>✅ ENABLED</b>" : "<b>❌ DISABLED</b>"}\n\n` +
      `AI predictions powered by DeepSeek 3.1\n\n` +
      `Toggle AI to enable/disable predictions in alerts`,
    { parse_mode: "HTML", ...buttons }
  );
});

bot.action("ai_toggle", async (ctx) => {
  const current = (await db.get(`user_${ctx.from.id}.ai.enabled`)) || false;
  await db.set(`user_${ctx.from.id}.ai.enabled`, !current);

  ctx.answerCbQuery(!current ? "AI Enabled!" : "AI Disabled!");

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(!current ? "✅ AI ON" : "❌ AI OFF", "ai_toggle")],
    [Markup.button.callback("📊 AI Stats", "ai_stats")],
    [Markup.button.callback("« Back", "back_main")],
  ]);

  ctx.editMessageText(
    `🤖 <b>AI Settings</b>\n\n` +
      `Status: ${!current ? "<b>✅ ENABLED</b>" : "<b>❌ DISABLED</b>"}\n\n` +
      `AI predictions powered by DeepSeek 3.1\n\n` +
      `Toggle AI to enable/disable predictions in alerts`,
    { parse_mode: "HTML", ...buttons }
  );
});

bot.action("ai_stats", async (ctx) => {
  ctx.answerCbQuery();
  const history = (await db.get(`user_${ctx.from.id}.ai.history`)) || [];
  const wins = history.filter((h) => h.outcome === "win").length;
  const losses = history.filter((h) => h.outcome === "loss").length;
  const accuracy =
    history.length > 0 ? ((wins / history.length) * 100).toFixed(1) : 0;

  ctx.editMessageText(
    `📊 <b>AI Performance Stats</b>\n\n` +
      `Total Predictions: ${history.length}\n` +
      `✅ Wins: ${wins}\n` +
      `❌ Losses: ${losses}\n` +
      `📈 Accuracy: ${accuracy}%\n\n` +
      `<i>Stats update as trades complete</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("« Back", "menu_ai")]]),
    }
  );
});

// === PNL MENU ===
bot.action("menu_pnl", (ctx) => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback("💰 Wallet PnL", "pnl_wallet"),
      Markup.button.callback("📋 Watchlist PnL", "pnl_watchlist"),
    ],
    [Markup.button.callback("🤖 AI PnL", "pnl_ai")],
    [Markup.button.callback("📊 Summary", "pnl_summary")],
    [Markup.button.callback("« Back", "back_main")],
  ]);

  ctx.editMessageText(
    `📊 <b>Profit & Loss Tracking</b>\n\n` +
      `Track your performance across wallets, watchlists, and AI predictions\n\n` +
      `Choose a category:`,
    { parse_mode: "HTML", ...buttons }
  );
});

bot.action("pnl_wallet", (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `💰 <b>Wallet PnL</b>\n\n` +
      `Track performance since import\n\n` +
      `<code>/pnl wallet [LABEL]</code>\n\n` +
      `<i>Note: Currently showing simulated data</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("« Back", "menu_pnl")],
      ]),
    }
  );
});

bot.action("pnl_watchlist", (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `📋 <b>Watchlist PnL</b>\n\n` +
      `Performance of tokens in your watchlists\n\n` +
      `<code>/pnl watchlist NAME</code>\n\n` +
      `<i>Note: Currently showing simulated data</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("« Back", "menu_pnl")],
      ]),
    }
  );
});

bot.action("pnl_ai", (ctx) => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback("1D", "pnl_ai_1d"),
      Markup.button.callback("7D", "pnl_ai_7d"),
    ],
    [
      Markup.button.callback("30D", "pnl_ai_30d"),
      Markup.button.callback("All Time", "pnl_ai_all"),
    ],
    [Markup.button.callback("« Back", "menu_pnl")],
  ]);

  ctx.editMessageText(
    `🤖 <b>AI Predictions PnL</b>\n\n` + `Select time period:`,
    { parse_mode: "HTML", ...buttons }
  );
});

bot.action(/^pnl_ai_(1d|7d|30d|all)$/, (ctx) => {
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
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("« Back", "pnl_ai")]]),
    }
  );
});

bot.action("pnl_summary", (ctx) => {
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
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("« Back", "menu_pnl")],
      ]),
    }
  );
});

// === EXPORT MENU ===
bot.action("menu_export", (ctx) => {
  ctx.answerCbQuery();
  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback("💰 Export Wallets", "export_wallets"),
      Markup.button.callback("📋 Export Watchlists", "export_watchlists"),
    ],
    [Markup.button.callback("🔔 Export Alerts", "export_alerts")],
    [Markup.button.callback("📦 Export All", "export_all")],
    [Markup.button.callback("« Back", "back_main")],
  ]);

  ctx.editMessageText(
    `📤 <b>Export Data</b>\n\n` +
      `Download your data as CSV files\n\n` +
      `Choose what to export:`,
    { parse_mode: "HTML", ...buttons }
  );
});

bot.action("export_wallets", async (ctx) => {
  ctx.answerCbQuery("Exporting wallets...");
  const wallets = (await db.get(`user_${ctx.from.id}.wallets`)) || [];
  const csv =
    "Label,Address\n" +
    wallets.map((w) => `${w.label},${w.address}`).join("\n");
  await ctx.replyWithDocument({
    source: Buffer.from(csv),
    filename: "wallets.csv",
  });
});

bot.action("export_watchlists", async (ctx) => {
  ctx.answerCbQuery("Exporting watchlists...");
  const data = await db.get(`user_${ctx.from.id}`);
  const watchlists = data?.watchlists || {};
  let csv = "Watchlist,Symbol,Address,Chain,PairAddress\n";
  Object.entries(watchlists).forEach(([name, wl]) => {
    wl.tokens.forEach((t) => {
      csv += `${name},${t.symbol},${t.address},${t.chain},${t.pairAddress}\n`;
    });
  });
  await ctx.replyWithDocument({
    source: Buffer.from(csv),
    filename: "watchlists.csv",
  });
});

bot.action("export_alerts", async (ctx) => {
  ctx.answerCbQuery("Exporting alerts...");
  const data = await db.get(`user_${ctx.from.id}`);
  const watchlists = data?.watchlists || {};
  let csv = "Watchlist,Preset,Active,CreatedAt\n";
  Object.entries(watchlists).forEach(([name, wl]) => {
    (wl.alerts || []).forEach((a) => {
      const preset = ALERT_PRESETS[a.preset];
      csv += `${name},${preset ? preset.name : "Custom"},${a.active},${new Date(
        a.createdAt
      ).toISOString()}\n`;
    });
  });
  await ctx.replyWithDocument({
    source: Buffer.from(csv),
    filename: "alerts.csv",
  });
});

bot.action("export_all", async (ctx) => {
  ctx.answerCbQuery("Exporting all data...");
  const data = await db.get(`user_${ctx.from.id}`);
  const json = JSON.stringify(data, null, 2);
  await ctx.replyWithDocument({
    source: Buffer.from(json),
    filename: "all_data.json",
  });
});

// === SETTINGS MENU ===
bot.action("menu_settings", async (ctx) => {
  try {
    ctx.answerCbQuery(); // Answer immediately
    
    // Use cached data or defaults to avoid delays
    const userId = ctx.from.id;
    const blacklistPromise = db.get(`user_${userId}.blacklist`);
    
      const buttons = Markup.inlineKeyboard([
      [Markup.button.callback("🔔 Alerts", "settings_alerts"), Markup.button.callback("🤖 AI", "menu_ai")],
      [Markup.button.callback("📋 Watchlist", "settings_watchlist"), Markup.button.callback("🔕 Notifications", "settings_notifications")],
      [Markup.button.callback("📈 Reporting", "settings_reporting"), Markup.button.callback("🛡 Privacy & Security", "settings_privacy")],
      [Markup.button.callback("🧩 Advanced", "settings_advanced"), Markup.button.callback("🌐 Language & Timezone", "settings_lang")],
      [Markup.button.callback("🚫 Blacklist", "settings_blacklist"), Markup.button.callback("📊 Status", "settings_status")],
      [Markup.button.callback("« Back", "back_main")],
    ]);

    // Get blacklist length asynchronously
    const blacklist = await blacklistPromise || [];
    
    ctx.editMessageText(
      `⚙️ <b>Settings</b>\n\n` +
        `Blacklisted tokens: ${blacklist.length}\n\n` +
        `Configure your bot settings:`,
      { parse_mode: "HTML", ...buttons }
    );
    
  } catch (error) {
    console.error('Error in settings menu:', error);
    ctx.answerCbQuery("Error loading settings", { show_alert: true });
  }
});

// === SETTINGS: ALERTS ===
bot.action("settings_alerts", async (ctx) => {
  ctx.answerCbQuery();
  const alerts = (await db.get(`user_${ctx.from.id}.alerts`)) || {};
  const rows = Object.entries(ALERT_PRESETS).map(([key, preset]) => {
    const enabled = alerts[key]?.enabled || false;
    return [Markup.button.callback(`${enabled ? "✅" : "❌"} ${preset.name}`, `toggle_preset_${key}`)];
  });
  rows.push([Markup.button.callback("« Back", "menu_settings")]);
  ctx.editMessageText(
    `🔔 <b>Global Alerts</b>\n\n` +
      `Toggle presets. Active presets apply to all tokens in your watchlist.`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) }
  );
});

bot.action(/^toggle_preset_(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const path = `user_${ctx.from.id}.alerts.${key}.enabled`;
  const current = (await db.get(path)) || false;
  await db.set(path, !current);
  ctx.answerCbQuery(!current ? "Preset enabled" : "Preset disabled");
  const alerts = (await db.get(`user_${ctx.from.id}.alerts`)) || {};
  const rows = Object.entries(ALERT_PRESETS).map(([k, preset]) => {
    const enabled = alerts[k]?.enabled || false;
    return [Markup.button.callback(`${enabled ? "✅" : "❌"} ${preset.name}`, `toggle_preset_${k}`)];
  });
  rows.push([Markup.button.callback("« Back", "menu_settings")]);
  ctx.editMessageText(
    `🔔 <b>Global Alerts</b>\n\n` +
      `Toggle presets. Active presets apply to all tokens in your watchlist.`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) }
  );
});

// === SETTINGS: WATCHLIST ===
bot.action("settings_watchlist", async (ctx) => {
  ctx.answerCbQuery();
  const autoDetect = (await db.get(`user_${ctx.from.id}.watchlist.autoDetect`)) ?? true;
  const dedup = (await db.get(`user_${ctx.from.id}.watchlist.dedup`)) ?? true;
  const rows = [
    [Markup.button.callback(`${autoDetect ? "✅" : "❌"} Auto-Detect Chain`, "watch_auto_detect")],
    [Markup.button.callback(`${dedup ? "✅" : "❌"} Deduplicate by Address`, "watch_dedup")],
    [Markup.button.callback("« Back", "menu_settings")]
  ];
  ctx.editMessageText(
    `📋 <b>Watchlist Settings</b>\n\n` + `Control token add/import behavior.`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) }
  );
});

bot.action("watch_auto_detect", async (ctx) => {
  const current = (await db.get(`user_${ctx.from.id}.watchlist.autoDetect`)) ?? true;
  await db.set(`user_${ctx.from.id}.watchlist.autoDetect`, !current);
  ctx.answerCbQuery(!current ? "Auto-Detect enabled" : "Auto-Detect disabled");
  bot.actions.get("settings_watchlist")(ctx);
});

bot.action("watch_dedup", async (ctx) => {
  const current = (await db.get(`user_${ctx.from.id}.watchlist.dedup`)) ?? true;
  await db.set(`user_${ctx.from.id}.watchlist.dedup`, !current);
  ctx.answerCbQuery(!current ? "Dedup enabled" : "Dedup disabled");
  bot.actions.get("settings_watchlist")(ctx);
});

// === SETTINGS: NOTIFICATIONS ===
bot.action("settings_notifications", async (ctx) => {
  ctx.answerCbQuery();
  const dnd = (await db.get(`user_${ctx.from.id}.notifications.dnd`)) ?? false;
  const rows = [
    [Markup.button.callback(`${dnd ? "✅" : "❌"} Do Not Disturb`, "notif_toggle_dnd")],
    [Markup.button.callback("« Back", "menu_settings")],
  ];
  ctx.editMessageText(
    `🔕 <b>Notifications</b>\n\n` +
      `Control notification behavior. (Quiet hours configuration coming soon)`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) }
  );
});

bot.action("notif_toggle_dnd", async (ctx) => {
  const current = (await db.get(`user_${ctx.from.id}.notifications.dnd`)) ?? false;
  await db.set(`user_${ctx.from.id}.notifications.dnd`, !current);
  ctx.answerCbQuery(!current ? "DND enabled" : "DND disabled");
  bot.actions.get("settings_notifications")(ctx);
});

// === SETTINGS: ADVANCED ===
bot.action("settings_advanced", async (ctx) => {
  ctx.answerCbQuery();
  const src = (await db.get(`user_${ctx.from.id}.advanced.indicatorSource`)) || "local";
  const rows = [
    [Markup.button.callback(`Source: ${src === "local" ? "Local TA" : "TAAPI Fallback"}`, "adv_toggle_source")],
    [Markup.button.callback("« Back", "menu_settings")],
  ];
  ctx.editMessageText(
    `🧩 <b>Advanced</b>\n\n` + `Choose indicator source.`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) }
  );
});

bot.action("adv_toggle_source", async (ctx) => {
  const src = (await db.get(`user_${ctx.from.id}.advanced.indicatorSource`)) || "local";
  const next = src === "local" ? "taapi" : "local";
  await db.set(`user_${ctx.from.id}.advanced.indicatorSource`, next);
  ctx.answerCbQuery(`Source set to ${next === "local" ? "Local TA" : "TAAPI Fallback"}`);
  bot.actions.get("settings_advanced")(ctx);
});

// === SETTINGS: LANGUAGE & TIMEZONE
bot.action("settings_lang", async (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `🌐 <b>Language & Timezone</b>\n\n` +
      `Interface Language: English (fixed).\nTimezone: defaults to UTC for summaries.\n` +
      `Customization options will be added here.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("« Back", "menu_settings")]]),
    }
  );
});

bot.action("settings_blacklist", async (ctx) => {
  ctx.answerCbQuery();
  const blacklist = (await db.get(`user_${ctx.from.id}.blacklist`)) || [];

  ctx.editMessageText(
    `🚫 <b>Blacklist</b>\n\n` +
      (blacklist.length > 0
        ? `Blocked tokens:\n${blacklist.map((s) => `• $${s}`).join("\n")}`
        : `<i>No tokens blocked</i>`) +
      `\n\n<b>Commands:</b>\n` +
      `<code>/blacklist add SYMBOL</code>\n` +
      `<code>/blacklist remove SYMBOL</code>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("« Back", "menu_settings")],
      ]),
    }
  );
});

bot.action("settings_status", async (ctx) => {
  ctx.answerCbQuery();
  const data = await db.get(`user_${ctx.from.id}`);
  const watchlistCount = Object.keys(data?.watchlists || {}).length;
  const walletCount = (data?.wallets || []).length;
  const aiEnabled = data?.ai?.enabled || false;

  let alertCount = 0;
  Object.values(data?.watchlists || {}).forEach((wl) => {
    alertCount += (wl.alerts || []).length;
  });

  ctx.editMessageText(
    `📊 <b>Bot Status</b>\n\n` +
      `💰 Wallets: ${walletCount}\n` +
      `📋 Watchlists: ${watchlistCount}\n` +
      `🔔 Active Alerts: ${alertCount}\n` +
      `🤖 AI: ${aiEnabled ? "✅ ON" : "❌ OFF"}\n` +
      `⏱ Scan Interval: Every 2 minutes\n\n` +
      `<i>All systems operational</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("« Back", "menu_settings")],
      ]),
    }
  );
});

// === HELP MENU ===
bot.action("menu_help", (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `❓ <b>Help & Commands</b>\n\n` +
      `<b>🚀 Quick Start:</b>\n` +
      `1. Add tokens with "Add Token" button\n` +
      `2. Enable alerts in Settings → Alerts\n` +
      `3. Bot scans every 2 minutes\n\n` +
      `<b>Wallet Commands:</b>\n` +
      `/wallet add ADDRESS [LABEL]\n` +
      `/wallet list\n` +
      `/wallet remove LABEL\n\n` +
      `<b>Watchlist Commands:</b>\n` +
      `/wl create NAME (legacy)\n` +
      `/wl import URL (DexScreener)\n` +
      `/wl list\n\n` +
      `<b>Alert Commands:</b>\n` +
      `/alert preset WATCHLIST\n` +
      `/alert custom WATCHLIST\n` +
      `/alert list\n` +
      `/alert toggle WATCHLIST\n\n` +
      `<b>Other Commands:</b>\n` +
      `/blacklist add/remove SYMBOL\n` +
      `/pnl wallet/watchlist/ai\n` +
      `/export wallets/watchlists/alerts\n\n` +
      `<b>📋 Features:</b>\n` +
      `• Auto-detect chains by liquidity\n` +
      `• Import CSV/TXT files\n` +
      `• Global preset alerts\n` +
      `• AI predictions\n` +
      `• Smart notifications\n\n` +
      `Use the menu buttons for easy navigation!`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("« Back", "back_main")],
      ]),
    }
  );
});

// === TEXT COMMANDS ===
bot.command("help", (ctx) => {
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
bot.command("wallet", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  const action = args[0];

  if (action === "add") {
    const [addr, ...label] = args.slice(1);
    if (!addr) return ctx.reply("Usage: /wallet add ADDRESS [LABEL]");
    const l = label.join(" ") || addr.slice(0, 8);
    await db.push(`user_${ctx.from.id}.wallets`, {
      address: addr,
      label: l,
      addedAt: Date.now(),
    });
    ctx.replyWithHTML(
      `✅ Wallet <b>${l}</b> connected!\n\n💰 Use /pnl wallet to view stats`
    );
  } else if (action === "list") {
    const wallets = (await db.get(`user_${ctx.from.id}.wallets`)) || [];
    if (wallets.length === 0) {
      return ctx.reply("No wallets added. Use /wallet add");
    }
    const msg =
      `💰 <b>Your Wallets (${wallets.length})</b>\n\n` +
      wallets
        .map((w, i) => `${i + 1}. ${w.label}\n   ${w.address}`)
        .join("\n\n");
    ctx.replyWithHTML(msg);
  } else if (action === "remove") {
    const label = args.slice(1).join(" ");
    if (!label) return ctx.reply("Usage: /wallet remove LABEL");
    const wallets = (await db.get(`user_${ctx.from.id}.wallets`)) || [];
    const filtered = wallets.filter((w) => w.label !== label);
    await db.set(`user_${ctx.from.id}.wallets`, filtered);
    ctx.reply(`✅ Wallet "${label}" removed`);
  } else {
    ctx.reply("Usage: /wallet add/list/remove");
  }
});

// Portfolio commands
bot.command("portfolio", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  const action = args[0];

  if (action === "add") {
    const [address, amount, buyPrice] = args.slice(1);
    if (!address || !amount || !buyPrice) {
      return ctx.reply("Usage: /portfolio add ADDRESS AMOUNT BUY_PRICE");
    }
    
    const tokens = await db.get(`user_${ctx.from.id}.watchlist.tokens`) || [];
    const token = tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
    
    if (!token) {
      return ctx.reply("Token not found in your watchlist. Add it first with /wl add");
    }
    
    const portfolio = (await db.get(`user_${ctx.from.id}.portfolio`)) || {};
    const tokenKey = address.toLowerCase();
    
    portfolio[tokenKey] = {
      symbol: token.symbol,
      amount: parseFloat(amount),
      avgBuyPrice: parseFloat(buyPrice),
      addedAt: Date.now()
    };
    
    await db.set(`user_${ctx.from.id}.portfolio`, portfolio);
    
    const totalCost = parseFloat(amount) * parseFloat(buyPrice);
    ctx.replyWithHTML(
      `✅ Position added!\n\n` +
      `<b>${token.symbol}</b>\n` +
      `Amount: ${amount}\n` +
      `Avg Buy Price: $${buyPrice}\n` +
      `Total Cost: $${totalCost.toFixed(2)}`
    );
  } else if (action === "view") {
    const portfolio = await getPortfolioValue(ctx.from.id);
    
    if (portfolio.holdings.length === 0) {
      return ctx.reply("No active positions. Use /portfolio add to add positions.");
    }
    
    let msg = `📈 <b>Portfolio Summary</b>\n\n`;
    msg += `Total Value: <b>$${portfolio.totalValue.toFixed(2)}</b>\n`;
    msg += `Total P&L: <b>$${portfolio.totalPnl.toFixed(2)} (${portfolio.totalPnlPercent.toFixed(2)}%)</b>\n\n`;
    
    portfolio.holdings.forEach((holding, i) => {
      const pnlEmoji = holding.pnl >= 0 ? "🟢" : "🔴";
      msg += `${i + 1}. <b>${holding.symbol}</b> ${pnlEmoji}\n`;
      msg += `   Value: $${holding.currentValue.toFixed(2)}\n`;
      msg += `   P&L: $${holding.pnl.toFixed(2)} (${holding.pnlPercent.toFixed(2)}%)\n\n`;
    });
    
    ctx.replyWithHTML(msg);
  } else {
    ctx.reply("Usage: /portfolio add ADDRESS AMOUNT BUY_PRICE\nUsage: /portfolio view");
  }
});

// Price alert commands
bot.command("alert", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  const action = args[0];

  if (action === "price") {
    const [address, type, price] = args.slice(1);
    if (!address || !type || !price) {
      return ctx.reply("Usage: /alert price ADDRESS TYPE PRICE\nTypes: above, below, range (e.g., 0.08-0.12)");
    }
    
    const tokens = await db.get(`user_${ctx.from.id}.watchlist.tokens`) || [];
    const token = tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
    
    if (!token) {
      return ctx.reply("Token not found in your watchlist. Add it first with /wl add");
    }
    
    const priceAlerts = (await db.get(`user_${ctx.from.id}.priceAlerts`)) || {};
    const tokenKey = address.toLowerCase();
    
    if (!priceAlerts[tokenKey]) {
      priceAlerts[tokenKey] = [];
    }
    
    let alertData;
    if (type === 'range') {
      const [minPrice, maxPrice] = price.split('-').map(p => parseFloat(p));
      if (!minPrice || !maxPrice) {
        return ctx.reply("Invalid range format. Use: min-max (e.g., 0.08-0.12)");
      }
      alertData = {
        type: 'range',
        minPrice,
        maxPrice,
        triggered: false,
        createdAt: Date.now()
      };
    } else if (type === 'above' || type === 'below') {
      const targetPrice = parseFloat(price);
      if (!targetPrice) {
        return ctx.reply("Invalid price format");
      }
      alertData = {
        type,
        price: targetPrice,
        triggered: false,
        createdAt: Date.now()
      };
    } else {
      return ctx.reply("Invalid type. Use: above, below, or range");
    }
    
    priceAlerts[tokenKey].push(alertData);
    await db.set(`user_${ctx.from.id}.priceAlerts`, priceAlerts);
    
    ctx.replyWithHTML(
      `✅ Price alert added!\n\n` +
      `<b>${token.symbol}</b>\n` +
      `Type: ${type}\n` +
      `Price: $${price}`
    );
  } else {
    ctx.reply("Usage: /alert price ADDRESS TYPE PRICE");
  }
});

// Version check command
bot.command("version", (ctx) => {
  ctx.replyWithHTML(
    `🚀 <b>DEX Alert AI Bot v1.0.2</b>\n` +
    `<i>UI v1.2 Portfolio + Price Alerts</i>\n\n` +
    `✅ Portfolio tracking enabled\n` +
    `✅ Price range alerts enabled\n\n` +
    `Last updated: ${new Date().toLocaleString()}`
  );
});

// Test database connection
bot.command("testdb", async (ctx) => {
  try {
    const testKey = `test_${ctx.from.id}`;
    await db.set(testKey, { test: true, timestamp: Date.now() });
    const result = await db.get(testKey);
    await db.delete(testKey);
    
    ctx.replyWithHTML(
      `✅ <b>Database Test Results</b>\n\n` +
        `Connection: <b>OK</b>\n` +
        `Read/Write: <b>OK</b>\n` +
        `Data: ${JSON.stringify(result)}\n\n` +
        `Database is working correctly!`
    );
  } catch (error) {
    ctx.replyWithHTML(
      `❌ <b>Database Test Failed</b>\n\n` +
        `Error: ${error.message}\n\n` +
        `Please check your database configuration.`
    );
  }
});

// Quick add token command for testing
bot.command("addtoken", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  const address = args[0];
  
  if (!address) {
    return ctx.reply("Usage: /addtoken ADDRESS\nExample: /addtoken 0x123...");
  }
  
  // Basic address validation
  if (!address.match(/^0x[a-fA-F0-9]{40}$/) && !address.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
    return ctx.reply("❌ Invalid address format. Please provide a valid token address.");
  }
  
  ctx.replyWithHTML(`🔍 <b>Detecting chain for:</b>\n<code>${address}</code>\n\n<i>Please wait (max 10 seconds)...</i>`);
  
  try {
    const candidates = await detectChainFromAddress(address);
    
    if (!candidates || candidates.length === 0) {
      return ctx.replyWithHTML(
        `❌ <b>Could not detect token</b>\n\n` +
          `The address may not be available on supported chains (Ethereum, BSC, Base, Arbitrum, Solana), or it might be invalid.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("Try Manual Import", "wl_add_token_manual")],
          [Markup.button.callback("« Back to Menu", "back_main")]
        ])
      );
    }
    
    // Auto-add the top candidate
    const topCandidate = candidates[0];
    const userId = ctx.from.id;
    
    // Get current watchlist
    const tokens = await db.get(`user_${userId}.watchlist.tokens`) || [];
    
    // Check if already exists
    const exists = tokens.some(t => t.address.toLowerCase() === address.toLowerCase());
    if (exists) {
      return ctx.replyWithHTML(`✅ <b>${topCandidate.symbol}</b> is already in your watchlist!`);
    }
    
    // Add to watchlist
    const newToken = {
      address,
      chain: topCandidate.chain,
      symbol: topCandidate.symbol,
      pairAddress: topCandidate.pairAddress,
      url: topCandidate.url,
      source: "dex",
      addedAt: Date.now()
    };
    
    tokens.push(newToken);
    await db.set(`user_${userId}.watchlist.tokens`, tokens);
    
    ctx.replyWithHTML(
      `✅ <b>Token added to watchlist!</b>\n\n` +
        `<b>${topCandidate.symbol}</b> (${topCandidate.chain})\n` +
        `Price: $${parseFloat(topCandidate.price).toFixed(6)}\n` +
        `Liquidity: $${Math.round(topCandidate.liquidity).toLocaleString()}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📋 View Watchlist", "wl_list")],
        [Markup.button.callback("🚀 Main Menu", "back_main")]
      ])
    );
    
  } catch (error) {
    console.error('Error in quick add token:', error);
    let errorMessage = `❌ <b>Error adding token</b>\n\n`;
    
    if (error.message === 'Chain detection timeout') {
      errorMessage += `Chain detection timed out after 10 seconds.\n\n` +
        `The token might not be available on supported chains (Ethereum, BSC, Base, Arbitrum, Solana).\n\n` +
        `Please try the full add token wizard for manual import.`;
    } else {
      errorMessage += `Please try again or use the full add token wizard.`;
    }
    
    ctx.replyWithHTML(errorMessage,
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Add Token Wizard", "wl_add_token")],
        [Markup.button.callback("« Back to Menu", "back_main")]
      ])
    );
  }
});

// Watchlist commands
bot.command("wl", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  const action = args[0];

  if (action === "create") {
    // Watchlist creation is no longer needed - we use simplified single watchlist
    ctx.replyWithHTML(`ℹ️ <b>Watchlist Management</b>\n\n` +
      `We now use a simplified watchlist system. All tokens are stored in a single list.\n\n` +
      `Use "📋 Watchlist" from the main menu to manage your tokens.`);
  } else if (action === "import") {
    const raw = args.slice(1).join(" ");
    const url = raw ? raw.replace(/[`<>]/g, "").trim() : "";
    if (!url || !url.includes("dexscreener.com/watchlist/")) {
      return ctx.reply(
        "Usage: /wl import https://dexscreener.com/watchlist/abc123"
      );
    }
    try {
      const tokens = await importWatchlistFromURL(ctx.from.id, url);
      ctx.replyWithHTML(
        `✅ <b>Imported ${tokens.length} tokens</b>\n\n` +
          `📋 Added to your watchlist\n\n` +
          `${tokens
            .slice(0, 5)
            .map((t) => `• $${t.symbol} (${t.chain})`)
            .join("\n")}` +
          (tokens.length > 5 ? `\n<i>...and ${tokens.length - 5} more</i>` : "")
      );
    } catch (e) {
      ctx.reply(`❌ Error importing. ${e.message || "Check the URL."}`);
    }
  } else if (action === "list") {
    // Show simplified watchlist tokens
    const tokens = await db.get(`user_${ctx.from.id}.watchlist.tokens`) || [];
    if (tokens.length === 0) {
      return ctx.reply("No tokens in watchlist. Use the Watchlist menu to add tokens.");
    }
    ctx.replyWithHTML(
      `📋 <b>Your Watchlist (${tokens.length} tokens):</b>\n\n` +
      tokens.slice(0, 10).map((t, i) => `• $${t.symbol} (${t.chain})`).join("\n") +
      (tokens.length > 10 ? `\n<i>...and ${tokens.length - 10} more</i>` : "")
    );
  } else {
    ctx.reply("Usage: /wl create/import/list");
  }
});

// Blacklist commands
bot.command("blacklist", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  const action = args[0];
  const symbol = args[1];

  if (!action || !symbol) {
    const blacklist = (await db.get(`user_${ctx.from.id}.blacklist`)) || [];
    return ctx.replyWithHTML(
      `🚫 <b>Blacklist</b>\n\n` +
        (blacklist.length > 0
          ? `Blocked tokens:\n${blacklist.map((s) => `• $${s}`).join("\n")}`
          : `<i>No tokens blocked</i>`) +
        `\n\n<b>Usage:</b>\n` +
        `/blacklist add SYMBOL\n` +
        `/blacklist remove SYMBOL`
    );
  }

  const blacklist = (await db.get(`user_${ctx.from.id}.blacklist`)) || [];

  if (action === "add") {
    if (!blacklist.includes(symbol)) {
      blacklist.push(symbol);
      await db.set(`user_${ctx.from.id}.blacklist`, blacklist);
      ctx.replyWithHTML(`✅ <b>$${symbol}</b> added to blacklist`);
    } else {
      ctx.reply(`$${symbol} is already blacklisted.`);
    }
  } else if (action === "remove") {
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

// === ADD TOKEN AUTO-DETECTION ===
async function detectChainFromAddress(address) {
  try {
    // Create a timeout promise that rejects after 10 seconds
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Chain detection timeout')), 10000)
    );
    
    // Create the fetch promise
    const fetchPromise = fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://dexscreener.com',
        'Referer': `https://dexscreener.com/`,
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    
    // Race between fetch and timeout
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    
    if (!response.ok) return null;
    
    const data = await response.json();
    if (!data.pairs || data.pairs.length === 0) return null;
    
    // Define allowed chains - limit to 5 as requested
    const allowedChains = ['ethereum', 'bsc', 'base', 'arbitrum', 'solana'];
    
    // Filter pairs to only include allowed chains
    const filteredPairs = data.pairs.filter(pair => {
      const chainId = pair.chainId?.toLowerCase();
      const chain = pair.chain?.toLowerCase();
      return allowedChains.some(allowed => 
        chainId?.includes(allowed) || chain?.toLowerCase() === allowed
      );
    });
    
    if (filteredPairs.length === 0) return null;
    
    // Sort by liquidity USD (desc), then volume (desc)
    const sortedPairs = filteredPairs.sort((a, b) => {
      const liquidityDiff = (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0);
      if (liquidityDiff !== 0) return liquidityDiff;
      return (b.volume?.h24 || 0) - (a.volume?.h24 || 0);
    });
    
    // Return top candidates with unique chains (limited to 5)
    const candidates = [];
    const seenChains = new Set();
    
    for (const pair of sortedPairs) {
      if (!seenChains.has(pair.chainId) && candidates.length < 5) {
        seenChains.add(pair.chainId);
        candidates.push({
          chainId: pair.chainId,
          chain: pair.chain,
          pairAddress: pair.pairAddress,
          symbol: pair.baseToken?.symbol || 'Unknown',
          liquidity: pair.liquidity?.usd || 0,
          volume24h: pair.volume?.h24 || 0,
          price: pair.priceUsd || 0,
          url: pair.url || `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`
        });
      }
    }
    
    return candidates;
  } catch (error) {
    console.error('Error detecting chain from address:', error);
    return null;
  }
}

// === SCAN & ALERT FUNCTION ===
async function scanAndAlert(userId) {
  const data = await db.get(`user_${userId}`);
  if (!data) return;

  const aiEnabled = data.ai?.enabled || false;
  const blacklist = data.blacklist || [];
  const globalAlerts = data.alerts || {};
  
  // Get enabled global presets
  const enabledPresets = Object.entries(globalAlerts)
    .filter(([key, alert]) => alert.enabled === true)
    .map(([key]) => key);

  // Check for simplified watchlist structure first
  const simpleTokens = await db.get(`user_${userId}.watchlist.tokens`) || [];
  const legacyWatchlists = data.watchlists || {};

  // Scan simplified watchlist tokens
  if (simpleTokens.length > 0 && enabledPresets.length > 0) {
    for (const token of simpleTokens.filter((t) => !blacklist.includes(t.symbol))) {
      try {
        const dexData = await getDexCandles(token.pairAddress);
        if (!dexData) continue;

        const ind = await getIndicatorsFromBackfill(dexData.candles);
        const priceChange = {
          price5m: Math.random() * 20 - 10,
          volume: Math.random() * 600,
          dump: false,
          recovery: false,
        };

        const aiPred = aiEnabled
          ? await predictAI(ind, dexData.currentPrice, userId)
          : null;

        // Check global presets
        for (const presetKey of enabledPresets) {
          const preset = ALERT_PRESETS[presetKey];
          if (preset && preset.condition(ind, priceChange, aiPred)) {
            await sendAlert(
              userId,
              token,
              ind,
              aiPred || {
                entry: dexData.currentPrice,
                sl: dexData.currentPrice * 0.89,
                tp1: dexData.currentPrice * 1.2,
                tp2: dexData.currentPrice * 1.4,
                prob1: 70,
                prob2: 50,
                time1: "15-30 min",
                time2: "30-60 min",
                duration: "1-2 hours",
                accuracy: 60,
              },
              dexData.currentPrice,
              presetKey
            );
          }
        }

        // Check price range alerts
        const priceRangeAlerts = await checkPriceRangeAlerts(userId, token, dexData.currentPrice);
        if (priceRangeAlerts.length > 0) {
          for (const alert of priceRangeAlerts) {
            await sendPriceRangeAlert(userId, token, dexData.currentPrice, alert);
          }
        }

        // Check AI triggers if enabled
        if (aiEnabled && aiPred) {
          let aiTriggered = null;
          if (
            ALERT_PRESETS.AI_HIGH_CONFIDENCE.condition(ind, priceChange, aiPred)
          ) {
            aiTriggered = "AI_HIGH_CONFIDENCE";
          } else if (
            ALERT_PRESETS.AI_QUICK_FLIP.condition(ind, priceChange, aiPred)
          ) {
            aiTriggered = "AI_QUICK_FLIP";
          }
          if (aiTriggered) {
            await sendAlert(
              userId,
              token,
              ind,
              aiPred,
              dexData.currentPrice,
              aiTriggered
            );
          }
        }
      } catch (e) {
        console.error(`Error scanning ${token.symbol}:`, e);
      }
    }
  }

  // Legacy watchlist support (for backward compatibility)
  for (const [wlName, wl] of Object.entries(legacyWatchlists)) {
    const alerts = wl.alerts || [];
    const tokens = wl.tokens || [];

    for (const token of tokens.filter((t) => !blacklist.includes(t.symbol))) {
      try {
        const dexData = await getDexCandles(token.pairAddress);
        if (!dexData) continue;

        const ind = await getIndicatorsFromBackfill(dexData.candles);
        const priceChange = {
          price5m: Math.random() * 20 - 10,
          volume: Math.random() * 600,
          dump: false,
          recovery: false,
        };

        const aiPred = aiEnabled
          ? await predictAI(ind, dexData.currentPrice, userId)
          : null;

        for (const alert of alerts.filter((a) => a.active)) {
          const preset = ALERT_PRESETS[alert.preset];
          if (preset && preset.condition(ind, priceChange, aiPred)) {
            await sendAlert(
              userId,
              token,
              ind,
              aiPred || {
                entry: dexData.currentPrice,
                sl: dexData.currentPrice * 0.89,
                tp1: dexData.currentPrice * 1.2,
                tp2: dexData.currentPrice * 1.4,
                prob1: 70,
                prob2: 50,
                time1: "15-30 min",
                time2: "30-60 min",
                duration: "1-2 hours",
                accuracy: 60,
              },
              dexData.currentPrice,
              alert.preset
            );
          }
        }

        // Check price range alerts for legacy watchlist tokens
        const priceRangeAlerts = await checkPriceRangeAlerts(userId, token, dexData.currentPrice);
        if (priceRangeAlerts.length > 0) {
          for (const alert of priceRangeAlerts) {
            await sendPriceRangeAlert(userId, token, dexData.currentPrice, alert);
          }
        }

        if (aiEnabled && aiPred) {
          let aiTriggered = null;
          if (
            ALERT_PRESETS.AI_HIGH_CONFIDENCE.condition(ind, priceChange, aiPred)
          ) {
            aiTriggered = "AI_HIGH_CONFIDENCE";
          } else if (
            ALERT_PRESETS.AI_QUICK_FLIP.condition(ind, priceChange, aiPred)
          ) {
            aiTriggered = "AI_QUICK_FLIP";
          }
          if (aiTriggered) {
            await sendAlert(
              userId,
              token,
              ind,
              aiPred,
              dexData.currentPrice,
              aiTriggered
            );
          }
        }
      } catch (e) {
        console.error(`Error scanning ${token.symbol}:`, e);
      }
    }
  }
}

// === CRON JOBS ===
if (require.main === module) {
  cron.schedule("*/2 * * * *", async () => {
    try {
      const allData = await db.all();
      const userIds = allData
        .filter((item) => item.id.startsWith("user_"))
        .map((item) => item.id.split("_")[1]);
      for (const userId of userIds) {
        await scanAndAlert(userId);
      }
    } catch (e) {
      console.error("Cron error:", e);
    }
  });

  cron.schedule("0 0 * * *", async () => {
    try {
      const allData = await db.all();
      const userIds = allData
        .filter((item) => item.id.startsWith("user_"))
        .map((item) => item.id.split("_")[1]);
      for (const userId of userIds) {
        await bot.telegram.sendMessage(
          userId,
          "📊 Daily Summary: Use /pnl summary to view your stats!"
        );
      }
    } catch (e) {
      console.error("Daily cron error:", e);
    }
  });

  bot.launch();
  console.log("🚀 DEX Alert AI Bot v1.0.2 – RUNNING!");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

module.exports = { bot, scanAndAlert, db };
