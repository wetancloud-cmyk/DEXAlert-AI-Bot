# DEX Alert AI Bot v1.0.2

## Overview
A Telegram bot that monitors decentralized exchange (DEX) tokens and sends AI-powered trading alerts based on technical indicators. Features a complete menu system with nested navigation and 9 preset alert types.

## Key Features
- **DEX Monitoring**: Tracks tokens on decentralized exchanges via DexScreener API
- **AI Predictions**: Uses DeepSeek 3.1 (via PUTER) to predict Take Profit (TP) and Stop Loss (SL) levels
- **Technical Analysis**: Fetches RSI, MACD, and EMA indicators using TAAPI.io
- **Watchlist Management**: Import watchlists from DexScreener or create custom ones
- **Automated Alerts**: Sends alerts when RSI drops below 30 (oversold conditions)
- **Wallet Tracking**: Connect wallets for PnL tracking
- **Scheduled Tasks**: 
  - Scans watchlists every 2 minutes
  - Daily PnL summaries at midnight

## Navigation Menu Structure
The bot uses an interactive button menu system (accessible via `/start`):

**Main Menu:**
- 💰 Wallets → Add, List, Export
- 📋 Watchlist → Import, Create, List, Export
- 🔔 Alerts → Presets, Custom, Active, Manage
- 🤖 AI Settings → Toggle, Stats
- 📊 PnL → Wallet, Watchlist, AI (1d/7d/30d/all), Summary
- 📤 Export → Wallets, Watchlists, Alerts, All
- ⚙️ Settings → Blacklist, Status
- ❓ Help → Command reference

## Alert Presets
1. **🟢 OVERSOLD HUNTER** - RSI ≤30 + Volume +300%
2. **🚀 PUMP DETECTOR** - Price +15% in 5m + RSI <50
3. **📉📈 DUMP & RECOVERY** - Price -20% then +10% in 15m
4. **🔴 OVERBOUGHT EXIT** - RSI ≥70 + Volume spike (sell signal)
5. **✨ EMA GOLDEN CROSS** - EMA 9 > EMA 21
6. **📊 MACD BULLISH CROSS** - MACD crosses signal upward
7. **💥 VOLUME EXPLOSION** - Volume +500% in 5m
8. **🤖 AI HIGH CONFIDENCE** - AI TP1 probability ≥80%
9. **⚡ AI QUICK FLIP** - AI TP1 ≥15% + time <30min

## Available Commands

### Wallet Commands
- `/wallet add ADDRESS [LABEL]` - Add a wallet for PnL tracking
- `/wallet list` - View all connected wallets
- `/wallet remove LABEL` - Remove a wallet

### Watchlist Commands
- `/wl create NAME` - Create a new watchlist
- `/wl import URL` - Import from DexScreener
- `/wl list` - View all watchlists

### Alert Commands
- `/alert preset WATCHLIST` - Enable preset alert for a watchlist
- `/alert custom WATCHLIST` - Create custom alert conditions
- `/alert list` - View all active alerts
- `/alert toggle WATCHLIST` - Pause/resume alerts

### Other Commands
- `/blacklist add SYMBOL` - Block token from alerts
- `/blacklist remove SYMBOL` - Unblock token
- `/pnl wallet/watchlist/ai` - View PnL stats
- `/export` - Access export menu
- `/help` - Show command reference

## Technology Stack
- **Runtime**: Node.js
- **Bot Framework**: Telegraf
- **Database**: QuickDB (SQLite)
- **Scheduling**: node-cron
- **APIs**:
  - DexScreener (token data)
  - TAAPI.io (technical indicators)
  - PUTER AI (DeepSeek predictions)

## Configuration
Required environment variables in `.env`:
- `TELEGRAM_BOT_TOKEN` - Your Telegram bot token
- `TAAPI_IO_SECRET` - TAAPI.io API key

## Current Status
Bot is running and monitoring for alerts. Users can interact via Telegram.

## UX Features
- 🎨 Emoji-rich interface for better readability
- 🎯 Interactive button menu on /start
- 📖 Detailed examples for all commands
- ✅ Status indicators (ON/OFF, success/error)
- 🔔 Clear alert formatting with emojis
- 📋 Smart defaults (commands without args show help/status)

## Recent Changes
- 2025-11-14: Complete rebuild with v1.0 features:
  - Interactive nested menu system with 8 main categories
  - 9 alert presets (OVERSOLD HUNTER, PUMP DETECTOR, DUMP & RECOVERY, OVERBOUGHT EXIT, EMA GOLDEN CROSS, MACD BULLISH CROSS, VOLUME EXPLOSION, AI HIGH CONFIDENCE, AI QUICK FLIP)
  - Wallet management (add/list/remove/export)
  - Watchlist management (import from URL or CSV, create, modify, export)
  - Alert system (preset and custom alerts per watchlist)
  - PnL tracking (wallet, watchlist, AI with time filters)
  - Export system (CSV for all data types)
  - Settings (blacklist, status dashboard)
  - Fixed HTML parsing bug in button callbacks
  - Fixed AI_QUICK_FLIP preset logic error (operator precedence)
- 2025-11-14: Initial bot deployment with basic features
