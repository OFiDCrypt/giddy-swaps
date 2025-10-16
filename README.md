# GIDDY Swaps Bot

**Version**: 1.0.0  
**Author**: OFiDCrypt ([@OFiDCrypt](https://github.com/OFiDCrypt))  
**Telegram Bot Handle**: [@Giddy_Swap_Bot](https://t.me/Giddy_Swap_Bot)  
**Repository**: [Public - Contributors Contact @OFiDCrypt for support](https://github.com/OFiDCrypt/giddy-swaps)  
**License**: MIT (with attribution to OFiDCrypt)  
**Date**: October 15, 2025

## Overview

GIDDY Swaps is an automated volume generation bot for Solana-based token projects, designed by OFiDCrypt. It simulates organic trading activity by executing buy-sell cycles between USDC (stablecoin) and GIDDY (an SPL Token-2022 standard token) via Meteora's Single-Sided Dynamic Liquidity Market Maker (DLMM) pools, using Jupiter's Ultra API for efficient, low-slippage swaps. The bot integrates with Telegram for user-friendly control and real-time notifications.

### Key Features
- **Automated Looping**: Alternates USDC → GIDDY buys (capped at 10 USDC) and GIDDY → USDC sells (exact amount from prior buy, post-fees).
- **Gasless Execution**: Leverages Jupiter's just-in-time fee payer for swaps >~$10, deducting fees from input tokens (minimal SOL usage).
- **Telegram Integration**: Control via [@Giddy_Swap_Bot](https://t.me/Giddy_Swap_Bot) with commands for swaps, balance checks, and loop control.
- **Resilient Routing**: Prioritizes Jupiter Ultra API for Meteora DLMM; falls back to standard Jupiter API or direct DLMM SDK.
- **Logging & Monitoring**: Per-swap JSON logs (`swaps/` directory) and session summaries with loss tracking.

### Purpose
GIDDY Swaps generates controlled trading volume for the GIDDY token paired with USDC on Solana. It boosts liquidity visibility, simulates user activity, and tests tokenomics under real-world conditions. It’s the first bot to handle SPL Token-2022 swaps in single-sided DLMM pools via Jupiter, enabling efficient volume farming without custom program deployments.

### Future Vision
- **Multi-Token Support**: Expand to arbitrary SPL tokens (Token-2022/legacy) via configurable pools/AMMs (e.g., Raydium, Orca).
- **Custom Strategies**: Dynamic caps based on TVL/liquidity, MEV protection, and cross-chain bridging.
- **Analytics Dashboard**: Real-time fee/loss metrics, volume reports, and ROI simulations.
- **Stablecoin Focus**: Support peg-stability tests, arbitrage loops, and yield farming for DeFi resilience.

## Prerequisites
- **Node.js**: Version 20+ (ESM support). Install from [nodejs.org](https://nodejs.org/).
- **Solana Wallet**: Keypair JSON with ≥10 USDC (start threshold) and ≥0.02 SOL (fee buffer).
- **Telegram Bot Token**: Obtain from [@BotFather](https://t.me/BotFather).
- **Solana RPC Endpoint**: Use a reliable RPC (e.g., Helius, QuickNode, or `https://api.mainnet-beta.solana.com`).

## Setup
1. **Clone the Repository**:
   ```bash
   git clone https://github.com/OFiDCrypt/giddy-swaps.git
   cd giddy-swaps
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment**:
   - Copy `.env.example` to `.env`:
     ```bash
     cp .env.example .env
     ```
   - Edit `.env` with your credentials (see `.env.example` for template):
     ```
     TELEGRAM_TOKEN=your_bot_token
     KEYPAIR_PATH=/path/to/your-keypair.json
     RPC_URL=https://api.mainnet-beta.solana.com
     USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
     GIDDY_MINT=8kQzvMELBQGSiFmrXqLuDSpYVLKkNoXE4bUQCC14wj3Z
     SWAP_INTERVAL=300
     SLIPPAGE_BPS=200
     INITIAL_AMOUNT=10
     MIN_SWAP_AMOUNT=0.01
     MAX_BUY_USDC=10
     INITIAL_DIRECTION=forward
     USE_DLMM_FALLBACK=false
     TELEGRAM_CHAT_ID=your_chat_id
     ```
   - **Note**: Keep `.env` private; it’s ignored by `.gitignore`.

4. **Fund Wallet**:
   - Transfer ≥10 USDC to your wallet’s USDC ATA (derive via `spl-token` CLI or Phantom).
   - Ensure ≥0.02 SOL for transaction fees (gasless swaps minimize SOL usage).

5. **Run the Bot**:
   ```bash
   node telegram.js
   ```

## Usage
Interact with the bot via Telegram (@Giddy_Swap_Bot). The bot starts polling on `node telegram.js` and responds to commands/buttons.

### Commands
- **/start**: Displays the main menu (deposit, balance, start/stop swaps).
- **/swap**: Executes a one-off swap (buy/sell based on current phase; toggles phase).
- **/status**: Shows wallet balances (USDC/GIDDY to 2 decimals, SOL to 4 decimals).
- **/help**: Lists available commands.

### Inline Buttons (Menu)
- **Deposit**: Instructions: "Send ≥$10 USDC to [wallet PK]. ATA auto-created."
- **Balance**: Displays USDC, GIDDY, and SOL balances.
- **Start Swaps**: Launches the swap loop (requires ≥10 USDC, ≥0.02 SOL).
- **Stop Swaps**: Halts the loop and saves session log.

### Swap Loop Behavior
- **Round 1 (Buy)**: Swaps up to 10 USDC → GIDDY; tracks delta (received GIDDY).
- **Round 2 (Sell)**: Swaps exact delta GIDDY → USDC (post-fees); resets delta.
- **Timing**: 5-minute wait on success; 5-10s retry (up to 3x) on failure.
- **Notifications**: Sends quotes (amounts to 2 decimals, route), transaction IDs, and Solscan links.
- **Stop Conditions**: Post-sell USDC <0.01 (dust threshold) or SOL <0.02.
- **Isolation**: Uses only cycle-specific amounts (ignores mid-run deposits).

### Example Telegram Flow
1. Send `/start` → Menu appears.
2. Click "Start Swaps" → "Loop started: USDC → GIDDY".
3. Round 1: "Buying... Quote: 10.00 USDC → ~13.87 GIDDY Route: iris" → "Txid: [Solscan link]".
4. 5-minute wait → Round 2: "Selling... Quote: 13.87 GIDDY → ~9.99 USDC" → Decode.
5. Repeats until "Stopped: USDC below 0.01".

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
- **Telegram Bot**: `node-telegram-bot-api` (v0.66) for polling and async notifications.
- **Utilities**: `dotenv` for env, `node-fetch` for APIs, `fs/promises` for JSON logs.

### Swap Flow
1. **Pre-Checks**: Ensure SOL >0.02, sufficient input balance, ATAs created (with retries).
2. **Quote**: Fetch via Ultra API GET (slippage=200bps).
3. **Sign/Execute**: Deserialize, partial sign, POST to Ultra API /execute.
4. **Fallback Chain**: Ultra → Jupiter → DLMM (if enabled).
5. **Post-Swap**: Confirm transaction, compute delta/loss, log to `swaps/swap_<timestamp>.json`, send Telegram notification with Solscan link.

### Error Handling
- **Retries**: Exponential backoff (up to 3x per attempt).
- **Logs**: Per-swap (`swaps/swap_*.json`), session (`swap_session_*.json` with loss/rounds).
- **Fallbacks**: API errors trigger fallback chain; ATA failures retry 3x.

## Project Structure
```
giddy_swap_bot/
├── bot.js              # Core swap engine (Ultra/Jupiter/DLMM)
├── telegram.js         # Telegram UI, loop, and commands
├── dlmm.js             # Direct DLMM fallback logic
├── package.json        # Dependencies and scripts
├── .env                # Environment variables (local, ignored)
├── .env.example        # Template for .env
├── .gitignore          # Excludes node_modules/, swaps/, .env
├── swaps/              # Swap logs (auto-created, ignored)
└── README.md           # This file
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
  - Never share `KEYPAIR_PATH` or `TELEGRAM_TOKEN`.
  - Run on a secure node (e.g., VPS); audit `swaps/` logs for anomalies.
  - Ensure `.env` and `swaps/` are ignored by `.gitignore`.
- **Limits**: Max 10 USDC per buy; stops at <0.01 USDC or <0.02 SOL to prevent dust transactions.
- **Customization**: Adjust `SWAP_INTERVAL`, `SLIPPAGE_BPS`, or token mints in `.env`.

## Troubleshooting
- **No ATAs**: Bot auto-creates ATAs; check `swaps/` logs if fails.
- **Quote Fails**: Increase `SLIPPAGE_BPS` or verify pool liquidity on Solscan.
- **Low SOL**: Top up ≥0.02 SOL; gasless swaps minimize drain.
- **Logs**: Check `swaps/` for errors; session JSON for loss totals.
- **Debug**: Add `(async () => { await ultraSwap(...); })();` in `bot.js` for console tests.
- **Errors**: Share error logs with `@OFiDCrypt` for support.

## Contributing
This is a public project:
- Fork the repo, submit contributions.
- Focus areas: Multi-token support, analytics dashboard, cross-chain volume.
- Contact `@OFiDCrypt` on Telegram or X for support.

Happy swapping!