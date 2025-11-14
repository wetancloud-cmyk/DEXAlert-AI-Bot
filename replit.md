# DEX Alert AI Bot v0.1

## Overview
A Telegram bot that monitors decentralized exchange (DEX) tokens and sends AI-powered trading alerts based on technical indicators.

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

## Available Commands
- `/start` - Start the bot
- `/help` - Show help menu
- `/createwl Name` - Create a new watchlist
- `/usewl Name` - Switch to a watchlist
- `/import` - Import DexScreener watchlist
- `/addmanual $NAME ADDRESS PAIR_ADDRESS` - Add token manually
- `/connect 7xKj... [Label]` - Connect wallet
- `/ai on/off` - Enable/disable AI alerts
- `/pnl` - View profit/loss
- `/export` - Export trading history
- `/whitelist add BONK` - Add token to whitelist

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

## Recent Changes
- 2025-11-14: Initial bot deployment with all core features
