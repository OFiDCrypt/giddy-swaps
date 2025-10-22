# GIDDY Swaps Bot

**Version**: 1.1.0  
**Author**: OFiDCrypt ([@OFiDCrypt](https://github.com/OFiDCrypt))  
**Telegram Bot Handle**: [@Giddy_Swap_Bot](https://t.me/Giddy_Swap_Bot)  
**Repository**: Public - OFiDCrypt[/giddy-swaps](https://github.com/OFiDCrypt/giddy-swaps)  
**License**: MIT (with attribution to OFiDCrypt)  
**Date**: October 21, 2025

## Overview

GIDDY Swaps is an automated volume generation bot for Solana-based token projects, designed by OFiDCrypt. It simulates organic trading activity by executing buy-sell cycles between USDC (stablecoin) and GIDDY (an SPL Token-2022 standard token) via Meteora's Single-Sided Dynamic Liquidity Market Maker (DLMM) pools, using Jupiter's Ultra API for efficient, low-slippage swaps. The bot integrates with Telegram for user-friendly control, real-time notifications, and now features a conversational AI assistant (Gemma) for dynamic, engaging interactions.

### Key Features
- **Automated Looping**: Alternates USDC → GIDDY buys (capped at 10 USDC) and GIDDY → USDC sells (exact amount from prior buy, post-fees).
- **Gasless Execution**: Leverages Jupiter's just-in-time fee payer for swaps >~$10, deducting fees from input tokens (minimal SOL usage).
- **Telegram Integration**: Control via [@Giddy_Swap_Bot](https://t.me/Giddy_Swap_Bot) with commands, inline buttons, and MarkdownV2-formatted responses for bold, links, and code blocks.
- **AI Assistant (Gemma)**: Provides dynamic hints, personalized responses, and randomized themes for engaging user interactions via Hugging Face or Nebius APIs.
- **Nickname Handling**: Extracts and toggles per-user nicknames from Telegram messages, with a clear button for privacy.
- **Resilient Routing**: Prioritizes Jupiter Ultra API for Meteora DLMM; falls back to standard Jupiter API or direct DLMM SDK.
- **Enhanced Logging**: Improved swap logs with transaction decoding, balance change tracking, fees, routes, and deltas in `swaps/` directory.

### Purpose
GIDDY Swaps generates controlled trading volume for the GIDDY token paired with USDC on Solana. It boosts liquidity visibility, simulates user activity, and tests tokenomics under real-world conditions. It’s the first bot to handle SPL Token-2022 swaps in single-sided DLMM pools via Jupiter, now enhanced with AI-driven interactions and robust Telegram formatting.

### Future Vision
🌀 **GIDDY_SWAP_BOT: Ritualized Liquidity, Transparent Rewards**

GIDDY Swaps aims to evolve into a community-powered platform for seamless token onboarding, transparent volume creation, and emotionally resonant reward flows. It will operate in both DMs and group chats, transforming deposits into visible rituals—where every swap is a story, and every reward is a celebration.

#### Roadmap
- **Multi-Token Support**: Expand to arbitrary SPL tokens (Token-2022/legacy) via configurable pools/AMMs (e.g., Raydium, Orca) with dynamic deposit handling for any Solana token with liquidity.
- **Custom Strategies**: Implement dynamic caps based on TVL/liquidity, MEV protection, and cross-chain bridging for broader DeFi integration.
- **Analytics Dashboard**: Real-time fee/loss metrics, volume reports, and ROI simulations, accessible via Telegram or a web interface.
- **Stablecoin Focus**: Support peg-stability tests, arbitrage loops, and yield farming for DeFi resilience.
- **Community Rewards**: Introduce a reward token (BOUNCY) alongside GIDDY, with 50% of deposits converted to GIDDY as platform revenue and 50% swapped to generate volume, rewarding users with GIDDY + BOUNCY proportional to volume created.
- **Social Engagement**: Enhance AI (Gemma) for community-driven storytelling, gamified swap rituals, and personalized user interactions in group chats.

## Prerequisites
- **Node.js**: Version 20+ (ESM support). Install from [nodejs.org](https://nodejs.org/).
- **Solana Wallet**: Keypair JSON with ≥10 USDC (start threshold) and ≥0.02 SOL (fee buffer).
- **Telegram Bot Token**: Obtain from [@BotFather](https://t.me/BotFather).
- **Solana RPC Endpoint**: Use a reliable RPC (e.g., Helius, QuickNode, or `https://api.mainnet-beta.solana.com`).
- **Hugging Face/Nebius API (Optional)**: For Gemma AI integration, obtain tokens from [huggingface.co](https://huggingface.co/settings/tokens) or [nebius.ai](https://nebius.ai).

## Setup
1. **Clone the Repository**:
   ```bash
   git clone https://github.com/OFiDCrypt/giddy-swaps.git
   cd giddy-swaps
   ```

2. **Verify Project Structure**:
   - Check the project structure in WSL:
     ```bash
     ls -a
     ```
     - For a detailed tree view (if `tree` is installed):
       ```bash
       tree -a
       ```
     - Expected structure is listed in the **Project Structure** section below.

3. **Install Dependencies**:
   ```bash
   npm install
   ```
   - Verify dependencies in `package.json`:
     ```bash
     cat package.json
     ```
     - Or extract dependencies with `jq` (if installed):
       ```bash
       jq '.dependencies' package.json
       ```

4. **Configure Environment**:
   - Copy `.env.example` to `.env`:
     ```bash
     cp .env.example .env
     ```
   - Edit `.env` with your credentials (see `.env.example` for template):
     ```
     # 🔐 Wallet
     KEYPAIR_PATH=/path/to/your/mint-authority.json
     # 🪙 Token mints
     USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
     GIDDY_MINT=8kQzvMELBQGSiFmrXqLuDSpYVLKkNoXE4bUQCC14wj3Z
     # 🌐 RPC configuration
     RPC_URL=https://api.mainnet-beta.solana.com
     RPC_RETRIES=5
     RPC_TIMEOUT=30000
     # 🔄 Swap parameters
     SWAP_AMOUNT=100000
     SLIPPAGE_BPS=200
     MIN_OUT_AMOUNT=0
     SWAP_INTERVAL=300
     INITIAL_AMOUNT=10
     MIN_SWAP_AMOUNT=0.01
     MAX_BUY_USDC=10
     INITIAL_DIRECTION=forward
     # ⚙️ DLMM Fallback
     USE_DLMM_FALLBACK=false
     # 📡 Telegram Alerts
     TELEGRAM_TOKEN=your_telegram_token_here
     TELEGRAM_CHAT_ID=your_chat_id_here
     # 🤖 GEMMA 3 AI Assistant
     HF_TOKEN=your_hf_token_here
     NEBIUS_API_KEY=your_nebius_api_key_here
     ```
   - **Note**: Keep `.env` private; it’s ignored by `.gitignore`. Emojis added for visual flair.

5. **Configure Company Data**:
   - Copy `companyData.example.js` to `companyData.js`:
     ```bash
     cp companyData.example.js companyData.js
     ```
   - Edit `companyData.js` with your project details. Below is the template from `companyData.example.js`:
     ```javascript
     // companyData.example.js: Custom docs and data for YOUR_COMPANY, TOKEN1, TOKEN2, BOT_NAME, and SHOP_NAME
     // Copy this to companyData.js and fill in your real details!
     export const companyData = {
       about: {
         bio: "YOUR_COMPANY is the innovative force behind TOKEN1 (your go-to blockchain swap token) and TOKEN2 (the fun, dynamic token for DeFi users). We're all about making crypto accessible, witty, and rewarding—because who said trading can't be a party? 🚀😎",
         mission: "YOUR_MISSION_STATEMENT_HERE—e.g., 'Empowering blockchain users with seamless swaps and community rewards.'",
         founders: "Founded by YOUR_FOUNDER_NAME—equal parts code wizards and meme lords.",
       },
       services: {
         TOKEN1: {
           description: "TOKEN1 is your stablecoin/token for low-fee swaps on DEX1/DEX2. Perfect for TOKEN↔TOKEN1 flips! 💖🪙",
           howItWorks: [
             "Connect to YOUR_DEX1 or YOUR_DEX2.",
             "Swap any supported token for TOKEN1 with minimal slippage.",
             "Boost volume and earn rewards through liquidity pools.",
           ],
           faqs: [
             { q: "What's TOKEN1?", a: "YOUR_DESCRIPTION_HERE—e.g., 'A stabletoken for low-fee swaps on Solana.'" },
             { q: "How do I swap with TOKEN1?", a: "YOUR_ANSWER_HERE—e.g., 'Use a compatible wallet on YOUR_DEX.'" },
             { q: "Is TOKEN1 backed?", a: "YOUR_ANSWER_HERE—e.g., 'Pegged for reliability; always DYOR.'" },
           ],
           notes: ["YOUR_NOTE_HERE—e.g., 'Inspired by a fun cultural reference!'"],
         },
         TOKEN2: {
           description: "TOKEN2 is the fun, dynamic token for DeFi adventurers. Expect surprises in YOUR_SHOP! 📱🎾",
           howItWorks: [
             "Visit YOUR_WEBSITE_URL to learn more.",
             "Acquire from supported wallets/providers.",
             "Integrate with TOKEN1 swaps for rewards.",
           ],
           faqs: [
             { q: "How do I get TOKEN2?", a: "YOUR_ANSWER_HERE—e.g., 'Visit YOUR_SITE for details.'" },
             { q: "What makes TOKEN2 special?", a: "YOUR_ANSWER_HERE—e.g., 'Dynamic utilities and community perks.'" },
             { q: "Can I use TOKEN2 in swaps?", a: "YOUR_ANSWER_HERE—e.g., 'Pair with TOKEN1 for low-fee flips.'" },
           ],
           notes: ["YOUR_NOTE_HERE—e.g., 'Fun fact: TOKEN2 has real-world utility!'"],
         },
         YOUR_BOT_NAME: {
           description: "YOUR_BOT_DESCRIPTION—e.g., 'A bot for seamless token swaps and rewards.'",
           howItWorks: [
             "Connect your wallet via DM or group mention.",
             "Deposit tokens to generate volume.",
             "Receive rewards in TOKEN1 + TOKEN2.",
           ],
           faqs: [
             { q: "How do I start?", a: "YOUR_ANSWER_HERE." },
             { q: "What happens to deposits?", a: "YOUR_ANSWER_HERE." },
             { q: "Is it secure?", a: "YOUR_ANSWER_HERE." },
           ],
           notes: ["YOUR_NOTE_HERE—e.g., 'Deposits fuel volume; rewards are yield-based.'"],
         },
         YOUR_SHOP_NAME: {
           description: "YOUR_SHOP_DESCRIPTION—e.g., 'Where crypto meets creativity, powered by TOKEN2.'",
           howItWorks: [
             "Browse products from creators.",
             "Pay with TOKEN2 for discounts and gifts in TOKEN1.",
             "Every purchase supports the ecosystem.",
           ],
           faqs: [
             { q: "What is TOKEN1 in the shop?", a: "YOUR_ANSWER_HERE." },
             { q: "Why use TOKEN2?", a: "YOUR_ANSWER_HERE." },
           ],
           notes: ["YOUR_NOTE_HERE—e.g., 'Build #MicroEconomies with every sale!'"],
         },
       },
       generalFaqs: [
         { q: "Is YOUR_COMPANY safe?", a: "YOUR_ANSWER_HERE—e.g., 'We prioritize audits and transparency.'" },
       ],
       funFacts: [
         "YOUR_FACT_1—e.g., 'TOKEN1 is inspired by a cultural icon!'",
         "YOUR_FACT_2—e.g., 'TOKEN2 brings surprises to the shop!'",
         "YOUR_FACT_3—e.g., 'Our first swap taught us: Set slippage or blame the memes!'",
         "YOUR_FACT_4—e.g., 'Every deposit sparks a community story!'",
       ],
       redirects: {
         memecoin: "YOUR_REDIRECT_HERE—e.g., 'DYOR on volatiles—stick to TOKEN1 for stability!'",
         offTopic: "YOUR_REDIRECT_HERE—e.g., 'Fun chat! Back to swaps—TOKEN1 awaits!'",
       },
     };
     ```

6. **Fund Wallet**:
   - Transfer ≥10 USDC to your wallet’s USDC ATA (derive via `spl-token` CLI or Phantom).
   - Ensure ≥0.02 SOL for transaction fees (gasless swaps minimize SOL usage).

7. **Run the Bot**:
   ```bash
   node telegram.js
   ```

## Usage
Interact with the bot via Telegram (@Giddy_Swap_Bot). The bot starts polling on `node telegram.js` and responds to commands/buttons with MarkdownV2 formatting for enhanced readability.

### Commands
- **/start**: Displays the main menu (deposit, balance, start/stop swaps, nickname settings).
- **/swap**: Executes a one-off swap (buy/sell based on current phase; toggles phase).
- **/status**: Shows wallet balances (USDC/GIDDY to 2 decimals, SOL to 4 decimals).
- **/nickname**: Set or clear a nickname for personalized interactions.
- **/help**: Lists available commands with dynamic AI hints.

### Inline Buttons (Menu)
- **Deposit**: Instructions: "Send ≥$10 USDC to [wallet PK]. ATA auto-created."
- **Balance**: Displays USDC, GIDDY, and SOL balances with visual formatting.
- **Start Swaps**: Launches the swap loop (requires ≥10 USDC, ≥0.02 SOL).
- **Stop Swaps**: Halts the loop, saves session log, and deletes the message silently.
- **Clear Nickname**: Removes stored nickname for privacy.

### Swap Loop Behavior
- **Round 1 (Buy)**: Swaps up to 10 USDC → GIDDY; tracks delta (received GIDDY).
- **Round 2 (Sell)**: Swaps exact delta GIDDY → USDC (post-fees); resets delta.
- **Timing**: 5-minute wait on success; 5-10s retry (up to 3x) on failure.
- **Notifications**: Sends quotes (amounts to 2 decimals, route), transaction IDs, Solscan links, and balance changes in MarkdownV2.
- **Stop Conditions**: Post-sell USDC <0.01 (dust threshold) or SOL <0.02.
- **Isolation**: Uses only cycle-specific amounts (ignores mid-run deposits).

### Example Telegram Flow
1. Send `/start` → Menu appears with randomized AI hint.
2. Set nickname via `/nickname CoolTrader` → "Hey CoolTrader, ready to swap?"
3. Click "Start Swaps" → "Loop started: USDC → GIDDY".
4. Round 1: "Buying... *Quote*: 10.00 USDC → ~13.87 GIDDY Route: iris" → "Txid: [Solscan link]".
5. 5-minute wait → Round 2: "Selling... *Quote*: 13.87 GIDDY → ~9.99 USDC" → Decode.
6. Repeats until "Stopped: USDC below 0.01". Click "Clear Nickname" to reset.

## Technical Architecture
### Core Components
- **Runtime**: Node.js (v20+, ESM modules).
- **Solana Integration**:
  - `@solana/web3.js` (v1.98+): Connections, transactions, keypairs.
  - `@solana/spl-token` (v0.4.14): ATA creation/handling for Token-2022 (GIDDY).
- **Swap Engine**:
  - **Primary**: Jupiter Ultra API (`lite-api.jup.ag/ultra/v1`) for Meteora DLMM routes.
  - **Fallback 1**: Standard Jupiter API (`@jup-ag/api` v6) for aggregation.
  - **Fallback 2**: `@meteora-ag/dlmm` SDK for direct pool swaps (if `USE_DLMM_FALLBACK=true`).
- **Telegram Bot**: `node-telegram-bot-api` (v0.66) with MarkdownV2 support for polling and async notifications.
- **AI Assistant**: Gemma integration via Hugging Face or Nebius APIs for dynamic hints and personalized responses.
- **Utilities**: `dotenv` for env, `node-fetch` for APIs, `fs/promises` for JSON logs.

### Swap Flow
1. **Pre-Checks**: Ensure SOL >0.02, sufficient input balance, ATAs created (with retries).
2. **Quote**: Fetch via Ultra API GET (slippage=200bps).
3. **Sign/Execute**: Deserialize, partial sign, POST to Ultra API /execute.
4. **Fallback Chain**: Ultra → Jupiter → DLMM (if enabled).
5. **Post-Swap**: Confirm transaction, compute delta/loss, log to `swaps/swap_<timestamp>.json` with fees/routes, send Telegram notification with Solscan link.

### Error Handling
- **Retries**: Exponential backoff (up to 3x per attempt, configurable via `RPC_RETRIES`).
- **Logs**: Per-swap (`swaps/swap_*.json`), session (`swap_session_*.json` with loss/rounds), enhanced with balance deltas and fees.
- **Fallbacks**: API errors trigger fallback chain; ATA failures retry 3x.

## Project Structure
```
giddy_swap_bot/
├── .env                # Environment variables (local, ignored)
├── .env.example        # Template for .env
├── .gitignore          # Excludes node_modules/, swaps/, chats/, .env, companyData.js
├── bot.js              # Core swap engine (Ultra/Jupiter/DLMM)
├── chats/              # Chat data storage (auto-created, ignored)
├── coins.js            # Token configuration and utilities
├── companyData.example.js # Template for companyData.js
├── companyData.js      # Custom bot settings (local, ignored)
├── dlmm.js             # Direct DLMM fallback logic
├── gemma.js            # Gemma AI assistant integration
├── node_modules/       # Dependencies (ignored)
├── package-lock.json   # Dependency lock file
├── package.json        # Dependencies and scripts
├── pdfHandler.js       # PDF generation/handling utilities
├── README.md           # This file
├── swaps/              # Swap logs (auto-created, ignored)
├── telegram.js         # Telegram UI, loop, commands, and AI integration
└── userData.json       # User data storage (e.g., nicknames)
```

## Dependencies
From `package.json`:
```json
{
  "dependencies": {
    "@coral-xyz/anchor": "^0.32.1",
    "@jup-ag/api": "^6.0.44",
    "@meteora-ag/dlmm": "^1.7.5",
    "@solana/spl-token": "^0.4.14",
    "@solana/web3.js": "^1.98.4",
    "dotenv": "^17.2.3",
    "node-telegram-bot-api": "^0.66.0",
    "node-fetch": "^3.3.2"
  }
}
```

## Rules & Best Practices
- **Risks**: Swaps incur fees/slippage (~0.01-0.3% per cycle). Monitor pool liquidity via Solscan.
- **Compliance**: For testing/volume generation only; not financial advice. Use mainnet RPC; avoid spam (rate limits on public RPC).
- **Security**:
  - Never share `KEYPAIR_PATH`, `TELEGRAM_TOKEN`, `HF_TOKEN`, `NEBIUS_API_KEY`, or `companyData.js`.
  - Run on a secure node (e.g., VPS); audit `swaps/` and `chats/` logs for anomalies.
  - Ensure `.env`, `companyData.js`, `swaps/`, and `chats/` are ignored by `.gitignore`.
- **Limits**: Max 10 USDC per buy; stops at <0.01 USDC or <0.02 SOL to prevent dust transactions.
- **Customization**: Adjust `SWAP_INTERVAL`, `SLIPPAGE_BPS`, `RPC_RETRIES`, `RPC_TIMEOUT`, or token mints in `.env`.

## Troubleshooting
- **No ATAs**: Bot auto-creates ATAs; check `swaps/` logs if fails.
- **Quote Fails**: Increase `SLIPPAGE_BPS` or verify pool liquidity on Solscan.
- **Low SOL**: Top up ≥0.02 SOL; gasless swaps minimize drain.
- **Logs**: Check `swaps/` for errors; session JSON for loss totals and balance changes.
- **Debug**: Add `(async () => { await ultraSwap(...); })();` in `bot.js` for console tests.
- **Errors**: Share error logs with `@OFiDCrypt` for support.

## Contributing
This is a public project:
- Fork the repo, submit contributions.
- Focus areas: Multi-token support, analytics dashboard, cross-chain volume, AI-driven community features.
- Contact `@OFiDCrypt` on Telegram or X for support.

Happy swapping!