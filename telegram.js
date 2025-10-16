import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  wallet,
  getBalances,
  ultraSwap,
  USDC_MINT,
  GIDDY_MINT,
} from './bot.js';

dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: { interval: 2000, autoStart: true } });

// Handle polling errors to prevent crashes
bot.on('polling_error', (error) => {
  console.error(`❌ Polling error: ${JSON.stringify(error)}`);
  // Attempt to restart polling after a delay
  setTimeout(() => {
    console.log('🔄 Attempting to restart polling...');
    bot.startPolling({ restart: true });
  }, 5000);
});

const connection = new Connection(process.env.RPC_URL, 'confirmed');

let isSwapping = false;
let currentPhase = process.env.INITIAL_DIRECTION === 'backward' ? 'sell' : 'buy';
const DECIMALS = 1_000_000; // Align with bot.js

const menu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "💰 Deposit", callback_data: "deposit" }],
      [{ text: "📊 Balance", callback_data: "balance" }],
      [{ text: "🔁 Start Swaps", callback_data: "start" }],
      [{ text: "⛔ Stop Swaps", callback_data: "stop" }],
    ],
  },
};

let swapLog = [];
let trackedGiddyDelta = 0;
let lastSwapOutAmount = 0; // Track the last swap's output amount

async function decodeSwap(txid, chatId) {
  try {
    await new Promise(r => setTimeout(r, 2000));
    const tx = await connection.getParsedTransaction(txid, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx) {
      await bot.sendMessage(chatId, `⚠️ Transaction ${txid} not found yet—check later.`);
      return;
    }

    const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : 'Unknown';
    const fee = tx.meta?.fee || 0;
    const logs = tx.meta?.logMessages?.slice(-5).join('\n') || 'No logs';

    const message = `
🧾 *Swap Confirmed*
🔑 Txid: \`${txid}\`
📅 Time: ${blockTime}
💸 Fee: ${(fee / 1_000_000_000).toFixed(6)} SOL
🪵 Logs:
\`\`\`
${logs}
\`\`\`
🔗 [View on Solscan](https://solscan.io/tx/${txid})
`;

    await bot.sendMessage(chatId, message, { parse_mode: "Markdown", disable_web_page_preview: true });
    console.log("📨 Telegram post-swap decode sent.");
  } catch (err) {
    await bot.sendMessage(chatId, `⚠️ Could not decode transaction: ${err.message}`);
    console.error("❌ Decode error:", err.message);
  }
}

async function waitForBalanceChange(mint, preBalance, direction, chatId, quote) {
  let postBalance = preBalance;
  const maxAttempts = 10; // 20 seconds
  let attempts = 0;
  const tokenLabel = mint.equals(GIDDY_MINT) ? 'GIDDY' : 'USDC';
  while (postBalance === preBalance && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 2000));
    const balances = await getBalances();
    postBalance = mint.equals(GIDDY_MINT) ? balances.giddy : balances.usdc;
    attempts++;
    console.log(`Attempt ${attempts}: Waiting for ${tokenLabel} balance change after ${direction.label}... Current: ${postBalance.toFixed(2)}`);
  }
  const stopMessage = `🔄 Swaps in progress ♻️`;
  if (postBalance === preBalance) {
    const outAmount = (quote.outAmount || quote.totalOutputAmount || 0) / DECIMALS;
    console.log(`⚠️ ${tokenLabel} balance did not change after ${direction.label} swap after ${maxAttempts} attempts. Using quote amount: ${outAmount.toFixed(2)}`);
    console.log(stopMessage);
    await bot.sendMessage(chatId, stopMessage, {
      reply_markup: {
        inline_keyboard: [[{ text: "Stop", callback_data: "stop" }]],
      },
    });
    return outAmount; // Fallback to quote
  }
  console.log(stopMessage);
  await bot.sendMessage(chatId, stopMessage, {
    reply_markup: {
      inline_keyboard: [[{ text: "Stop", callback_data: "stop" }]],
    },
  });
  return postBalance;
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Welcome to GIDDY_SWAP_BOT. Choose an action:", menu);
});

bot.onText(/\/swap/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, "Manual swap triggered.");
  const balances = await getBalances();
  const minSol = 0.02;

  if (balances.sol < minSol) {
    await bot.sendMessage(chatId, `🛑 Insufficient SOL balance: ${balances.sol.toFixed(6)} SOL (min ${minSol} SOL)`);
    return;
  }

  const direction = currentPhase === "buy"
    ? { from: USDC_MINT, to: GIDDY_MINT, label: "USDC → GIDDY" }
    : { from: GIDDY_MINT, to: USDC_MINT, label: "GIDDY → USDC" };

  const inputBal = direction.from.equals(USDC_MINT) ? balances.usdc : balances.giddy;
  let amount;
  let preBalance = balances.giddy;
  if (direction.from.equals(USDC_MINT)) {
    const maxBuy = Number(process.env.MAX_BUY_USDC || 10) * DECIMALS;
    amount = lastSwapOutAmount > 0 ? Math.min(lastSwapOutAmount * DECIMALS, maxBuy) : Math.min(inputBal * DECIMALS, maxBuy);
    if (amount < Number(process.env.MIN_SWAP_AMOUNT) * DECIMALS) {
      await bot.sendMessage(chatId, `🛑 Insufficient USDC for buy: ${inputBal.toFixed(2)} (min ${process.env.MIN_SWAP_AMOUNT})`);
      return;
    }
  } else {
    if (trackedGiddyDelta <= 0) {
      await bot.sendMessage(chatId, `⚠️ No tracked GIDDY to sell (run buy first or invalid delta: ${trackedGiddyDelta.toFixed(2)})`);
      return;
    }
    amount = Math.round(trackedGiddyDelta * DECIMALS); // Round to avoid invalid amounts
    if (inputBal < trackedGiddyDelta) {
      await bot.sendMessage(chatId, `⚠️ Tracked GIDDY (${trackedGiddyDelta.toFixed(2)}) > current balance (${inputBal.toFixed(2)})`);
      return;
    }
  }

  const { txid, quote, error, fallback, dlmm } = await ultraSwap(direction.from, direction.to, amount, chatId);

  if (quote) {
    const outAmount = quote.outAmount || quote.totalOutputAmount || 'N/A';
    const route = quote.router || (quote.routePlan?.map(step => step.swapInfo?.label || 'Unknown').join(' → ') || 'Unknown');
    const inTicker = direction.from.equals(USDC_MINT) ? 'USDC' : 'GIDDY';
    const outTicker = direction.to.equals(USDC_MINT) ? 'USDC' : 'GIDDY';
    await bot.sendMessage(chatId, `📊 Quote: ${(amount / DECIMALS).toFixed(2)} ${inTicker} → ~${(outAmount / DECIMALS).toFixed(2)} ${outTicker}\n🔀 Route: ${route}`);
    console.log(`📊 Quote: ${(amount / DECIMALS).toFixed(2)} ${inTicker} → ${(outAmount / DECIMALS).toFixed(2)} ${outTicker}`);
    console.log("🔀 Route:", route);
  }

  if (txid) {
    const method = dlmm ? ' (DLMM)' : fallback ? ' (Fallback)' : '';
    await bot.sendMessage(chatId, `🚀 Swap submitted${method}.\nTxid: \`${txid}\``, { parse_mode: "Markdown" });
    console.log("✅ Txid:", txid);
    await decodeSwap(txid, chatId);

    const mintToCheck = direction.from.equals(USDC_MINT) ? GIDDY_MINT : USDC_MINT;
    const postBalance = await waitForBalanceChange(mintToCheck, preBalance, direction, chatId, quote);
    const delta = postBalance - preBalance;
    if (direction.from.equals(USDC_MINT)) {
      trackedGiddyDelta = delta > 0 ? delta : (quote ? (quote.outAmount || quote.totalOutputAmount || 0) / DECIMALS : 0);
      trackedGiddyDelta = Number(trackedGiddyDelta.toFixed(6)); // Allow 6 decimals for precision
      lastSwapOutAmount = quote ? (quote.outAmount || quote.totalOutputAmount || 0) / DECIMALS : 0;
      console.log(`Tracked GIDDY delta from buy: ${trackedGiddyDelta.toFixed(2)}`);
    } else {
      trackedGiddyDelta = 0;
      lastSwapOutAmount = quote ? (quote.outAmount || quote.totalOutputAmount || 0) / DECIMALS : 0;
    }

    currentPhase = currentPhase === "buy" ? "sell" : "buy";
  } else {
    await bot.sendMessage(chatId, `❌ Swap failed: ${error || "Unknown error."}`);
  }
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  if (action === "deposit") {
    await bot.sendMessage(chatId, `Send Minimum $10 USDC to:\n\n\`${wallet.publicKey.toBase58()}\`\n\nATA: Check your wallet for USDC ATA.`, {
      parse_mode: "Markdown",
    });
  }

  if (action === "balance") {
    const balances = await getBalances();
    await bot.sendMessage(chatId, `Current Balances:\n💵 USDC: ${balances.usdc.toFixed(2)}\n🎢 GIDDY: ${balances.giddy.toFixed(2)}\n☀️ SOL: ${balances.sol.toFixed(6)}`);
    console.log("📊 Balances:", balances.usdc.toFixed(2), "USDC,", balances.giddy.toFixed(2), "GIDDY,", balances.sol.toFixed(6), "SOL");
  }

  if (action === "start") {
    if (isSwapping) {
      await bot.sendMessage(chatId, "Swap loop is already running.");
      return;
    }

    const balances = await getBalances();
    const minAmount = Number(process.env.INITIAL_AMOUNT) || 10;
    const minSol = 0.02;
    if (balances.sol < minSol) {
      await bot.sendMessage(chatId, `🛑 Insufficient SOL balance: ${balances.sol.toFixed(6)} SOL (min ${minSol} SOL)`);
      return;
    }
    if (Number(balances.usdc.toFixed(2)) < minAmount) {
      await bot.sendMessage(chatId, `🛑 Minimum ${minAmount} USDC required.\nUSDC: ${balances.usdc.toFixed(2)}`);
      return;
    }

    isSwapping = true;
    currentPhase = process.env.INITIAL_DIRECTION === 'backward' ? 'sell' : 'buy';
    swapLog = [];
    trackedGiddyDelta = 0;
    lastSwapOutAmount = 0;
    await bot.sendMessage(chatId, `🔁 Swap loop started. Starting with: ${currentPhase === 'buy' ? 'USDC → GIDDY' : 'GIDDY → USDC'}`);
    console.log("🔁 Swap loop started. Phase:", currentPhase);

    let retryCount = 0;
    const maxRetries = 3;
    let round = 0;

    while (isSwapping) {
      round++;
      const balances = await getBalances();
      const minThreshold = Number(process.env.MIN_SWAP_AMOUNT) || 0.01;
      const minSol = 0.02;

      if (balances.sol < minSol) {
        const reason = `SOL balance below threshold: ${balances.sol.toFixed(6)} SOL (min ${minSol} SOL)`;
        await bot.sendMessage(chatId, `🛑 Swap loop stopped. ${reason}`);
        console.log("🛑 Swap loop stopped. SOL:", balances.sol.toFixed(6));
        isSwapping = false;
        break;
      }

      if (currentPhase === 'buy' && balances.usdc < minThreshold) {
        const reason = `USDC balance below threshold before buy: ${balances.usdc.toFixed(2)} (min ${minThreshold})`;
        await bot.sendMessage(chatId, `🛑 Swap loop stopped. ${reason}`);
        console.log("🛑 Swap loop stopped. USDC pre-buy:", balances.usdc.toFixed(2));
        isSwapping = false;
        break;
      }

      const direction = currentPhase === "buy"
        ? { from: USDC_MINT, to: GIDDY_MINT, label: "💸 Buying GIDDY with USDC..." }
        : { from: GIDDY_MINT, to: USDC_MINT, label: "💱 Selling GIDDY back to USDC..." };

      const inputBalance = direction.from.equals(USDC_MINT) ? balances.usdc : balances.giddy;
      let amount;
      let preBalance = direction.from.equals(USDC_MINT) ? balances.giddy : balances.usdc;
      let skipReason = null;
      if (direction.from.equals(USDC_MINT)) {
        const maxBuy = Number(process.env.MAX_BUY_USDC || 10) * DECIMALS;
        amount = lastSwapOutAmount > 0 ? Math.min(lastSwapOutAmount * DECIMALS, maxBuy) : Math.min(inputBalance * DECIMALS, maxBuy);
        if (amount < minThreshold * DECIMALS) {
          skipReason = `Insufficient USDC for buy: ${(amount / DECIMALS).toFixed(2)} (min ${minThreshold})`;
        }
      } else {
        if (trackedGiddyDelta <= 0) {
          skipReason = `No tracked GIDDY to sell (run buy first or invalid delta: ${trackedGiddyDelta.toFixed(2)})`;
        } else {
          amount = Math.round(trackedGiddyDelta * DECIMALS); // Round to avoid invalid amounts
          if (inputBalance < trackedGiddyDelta) {
            skipReason = `Tracked GIDDY (${trackedGiddyDelta.toFixed(2)}) > current balance (${inputBal.toFixed(2)})`;
          }
        }
      }

      if (skipReason) {
        await bot.sendMessage(chatId, `⚠️ Skipping round ${round}: ${skipReason}`);
        console.log(`⚠️ Skipping round ${round} ${direction.label}: ${skipReason}`);
        currentPhase = currentPhase === "buy" ? "sell" : "buy";
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }

      await bot.sendMessage(chatId, `🔁 Round ${round}: ${direction.label}\n⏳ ${new Date().toLocaleTimeString()}`);
      console.log(`🔁 Round ${round}: ${direction.label} (${(amount / DECIMALS).toFixed(2)})`);

      const prevAmount = inputBalance * DECIMALS;
      const { txid, quote, error, fallback, dlmm } = await ultraSwap(direction.from, direction.to, amount, chatId);

      if (quote) {
        const outAmount = quote.outAmount || quote.totalOutputAmount || 'N/A';
        const route = quote.router || (quote.routePlan?.map(step => step.swapInfo?.label || 'Unknown').join(' → ') || 'Unknown');
        const inTicker = direction.from.equals(USDC_MINT) ? 'USDC' : 'GIDDY';
        const outTicker = direction.to.equals(USDC_MINT) ? 'USDC' : 'GIDDY';
        await bot.sendMessage(chatId, `📊 Quote: ${(amount / DECIMALS).toFixed(2)} ${inTicker} → ~${(outAmount / DECIMALS).toFixed(2)} ${outTicker}\n🔀 Route: ${route}`);
        console.log(`📊 Quote: ${(amount / DECIMALS).toFixed(2)} ${inTicker} → ${(outAmount / DECIMALS).toFixed(2)} ${outTicker}`);
        console.log("🔀 Route:", route);
      }

      if (txid) {
        const method = dlmm ? ' (DLMM)' : fallback ? ' (Fallback)' : '';
        await bot.sendMessage(chatId, `🚀 Swap submitted${method}.\nTxid: \`${txid}\``, { parse_mode: "Markdown" });
        console.log(`✅ Round ${round} Txid:`, txid);
        await decodeSwap(txid, chatId);

        const mintToCheck = direction.from.equals(USDC_MINT) ? GIDDY_MINT : USDC_MINT;
        const postBalance = await waitForBalanceChange(mintToCheck, preBalance, direction, chatId, quote);
        const delta = postBalance - preBalance;
        if (direction.from.equals(USDC_MINT)) {
          trackedGiddyDelta = delta > 0 ? delta : (quote ? (quote.outAmount || quote.totalOutputAmount || 0) / DECIMALS : 0);
          trackedGiddyDelta = Number(trackedGiddyDelta.toFixed(6)); // Allow 6 decimals for precision
          lastSwapOutAmount = quote ? (quote.outAmount || quote.totalOutputAmount || 0) / DECIMALS : 0;
          console.log(`Tracked GIDDY delta from buy: ${trackedGiddyDelta.toFixed(2)}`);
        } else {
          trackedGiddyDelta = 0;
          lastSwapOutAmount = quote ? (quote.outAmount || quote.totalOutputAmount || 0) / DECIMALS : 0;
        }

        const outAmount = quote ? (quote.outAmount || quote.totalOutputAmount || 0) : 0;
        const loss = prevAmount - outAmount;
        swapLog.push({
          round,
          direction: currentPhase,
          amountIn: (amount / DECIMALS).toFixed(2),
          amountOut: (outAmount / DECIMALS).toFixed(2),
          loss: (loss / DECIMALS).toFixed(6),
          txid
        });
        currentPhase = currentPhase === "buy" ? "sell" : "buy";
        retryCount = 0;
        const interval = Number(process.env.SWAP_INTERVAL) * 1000 || 300_000;
        await new Promise(r => setTimeout(r, interval));
      } else {
        if (retryCount < maxRetries) {
          retryCount++;
          await bot.sendMessage(chatId, `⚠️ Round ${round} failed, retrying (${retryCount}/${maxRetries})...\nError: ${error || 'Unknown'}`);
          console.log(`⚠️ Round ${round} Retry ${retryCount}/${maxRetries}: ${error}`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        await bot.sendMessage(chatId, `⛔ Swap loop stopped due to repeated failures`);
        console.log(`⛔ Swap loop stopped after ${maxRetries} retries: ${error}`);
        isSwapping = false;
        break;
      }
    }

    const logPath = `swaps/swap_session_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    await fs.writeFile(logPath, JSON.stringify(swapLog, null, 2));
    await bot.sendMessage(chatId, `📝 Session log saved: ${logPath} (${swapLog.length} rounds)`);
  }

  if (action === "stop") {
    if (!isSwapping) {
      await bot.sendMessage(chatId, "Swap loop is not running.");
      return;
    }

    isSwapping = false;
    await bot.sendMessage(chatId, "⛔ Swap loop stopped.");
    console.log("⛔ Swap loop stopped.");
  }
});