import fs from 'node:fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { Connection, Keypair, PublicKey, VersionedTransaction, ComputeBudgetProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createJupiterApiClient } from '@jup-ag/api';
import { dlmmSwap } from './dlmm.js'; // Optional fallback
import { getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import fetch from 'node-fetch';
import TelegramBot from 'node-telegram-bot-api';

dotenv.config();

const secretKey = Uint8Array.from(JSON.parse(await fs.readFile(process.env.KEYPAIR_PATH, 'utf8')));
export const wallet = Keypair.fromSecretKey(secretKey);
export const connection = new Connection(process.env.RPC_URL, 'confirmed');
export const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const GIDDY_MINT = new PublicKey('8kQzvMELBQGSiFmrXqLuDSpYVLKkNoXE4bUQCC14wj3Z');
const DECIMALS = 1_000_000; // Both USDC & GIDDY have 6 decimals

let cachedBalances = { usdc: 0, giddy: 0, sol: 0 };
let lastBalanceCheck = 0;

async function getTokenBalance(mint) {
  try {
    const accounts = await connection.getTokenAccountsByOwner(wallet.publicKey, { mint });
    if (accounts.value.length === 0) return 0;
    const tokenProgram = mint.equals(GIDDY_MINT) ? TOKEN_2022_PROGRAM_ID : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const balance = await getAccount(connection, accounts.value[0].pubkey, 'confirmed', tokenProgram);
    return Number(balance.amount);
  } catch (err) {
    console.error(`Balance fetch error for ${mint.toBase58()}: ${err.message}`);
    return 0;
  }
}

export async function getBalances() {
  const now = Date.now();
  if (now - lastBalanceCheck < 30000) return { ...cachedBalances, usdc: cachedBalances.usdc / DECIMALS, giddy: cachedBalances.giddy / DECIMALS, sol: cachedBalances.sol / LAMPORTS_PER_SOL };

  cachedBalances = {
    usdc: await getTokenBalance(USDC_MINT),
    giddy: await getTokenBalance(GIDDY_MINT),
    sol: await connection.getBalance(wallet.publicKey),
  };
  lastBalanceCheck = now;
  return { ...cachedBalances, usdc: cachedBalances.usdc / DECIMALS, giddy: cachedBalances.giddy / DECIMALS, sol: cachedBalances.sol / LAMPORTS_PER_SOL };
}

async function ensureATAs(inputMint, outputMint, chatId) {
  const tokenProgramIn = inputMint.equals(GIDDY_MINT) ? TOKEN_2022_PROGRAM_ID : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const tokenProgramOut = outputMint.equals(GIDDY_MINT) ? TOKEN_2022_PROGRAM_ID : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

  for (const [mint, program] of [[inputMint, tokenProgramIn], [outputMint, tokenProgramOut]]) {
    let ataAttempts = 0;
    const maxAtaAttempts = 3;
    while (ataAttempts < maxAtaAttempts) {
      try {
        const ata = await getOrCreateAssociatedTokenAccount(
          connection,
          wallet,
          mint,
          wallet.publicKey,
          false,
          'confirmed',
          undefined,
          program
        );
        console.log(`✅ ATA ensured for ${mint.toBase58()}: ${ata.address.toBase58()}`);
        break;
      } catch (err) {
        ataAttempts++;
        if (ataAttempts === maxAtaAttempts) throw new Error(`Failed to ensure ATA for ${mint.toBase58()}: ${err.message}`);
        await new Promise(r => setTimeout(r, Math.pow(2, ataAttempts) * 1000));
      }
    }
  }
  if (chatId) await bot.sendMessage(chatId, `✅ ATAs ready for swap`);
}

async function logSwap({ timestamp, inputMint, outputMint, amountIn, amountOut = null, txid = null, error = null, route = null, fallback = false, dlmm = false }) {
  const logData = { timestamp, inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(), amountIn, amountOut, txid, error, route, fallback, dlmm };
  const logPath = path.join('swaps', `swap_${timestamp}.json`);
  await fs.writeFile(logPath, JSON.stringify(logData, null, 2));
  console.log(`📝 Logged to ${logPath}`);
  return logPath;
}

async function sendTelegram(chatId, message, txid = null) {
  const fullMsg = txid ? `${message}\n🔗 https://solscan.io/tx/${txid}` : message;
  await bot.sendMessage(chatId, fullMsg);
}

async function getUltraQuote(inputMint, outputMint, amountIn, timestamp, chatId) {
  const params = new URLSearchParams({
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    amount: amountIn.toString(),
    taker: wallet.publicKey.toBase58(),
  });
  const url = `https://lite-api.jup.ag/ultra/v1/order?${params}`;
  const logPath = path.join('swaps', `ultra_quote_${timestamp}.json`);

  try {
    const res = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const quote = await res.json();
    if (quote.error) throw new Error(JSON.stringify(quote.error));

    console.log(`📊 Ultra quote: ${amountIn / DECIMALS} → ~${quote.outAmount / DECIMALS} ${outputMint.equals(GIDDY_MINT) ? 'GIDDY' : 'USDC'}`);
    console.log(`🔀 Router: ${quote.router || 'Unknown'}`);
    await fs.writeFile(logPath, JSON.stringify(quote, null, 2));

    const routeMsg = quote.router ? `via ${quote.router}` : 'Direct';
    if (chatId) await sendTelegram(chatId, `📊 Ultra quote ready: ${amountIn / DECIMALS} ${inputMint.equals(USDC_MINT) ? 'USDC' : 'GIDDY'} → ~${quote.outAmount / DECIMALS} ${outputMint.equals(USDC_MINT) ? 'USDC' : 'GIDDY'}\n🔀 ${routeMsg}`);

    return quote;
  } catch (err) {
    console.error(`❌ Ultra quote failed: ${err.message}`);
    await fs.writeFile(logPath, JSON.stringify({ error: err.message }, null, 2));
    throw err;
  }
}

async function executeUltra(quote, inputMint, outputMint, amountIn, timestamp, chatId) {
  const txBuffer = Buffer.from(quote.transaction, 'base64');
  const vtx = VersionedTransaction.deserialize(txBuffer);
  vtx.sign([wallet]);
  const signedTx = Buffer.from(vtx.serialize()).toString('base64');

  const executeRes = await fetch('https://lite-api.jup.ag/ultra/v1/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedTransaction: signedTx, requestId: quote.requestId }),
  });

  if (!executeRes.ok) {
    const errBody = await executeRes.text();
    throw new Error(`Ultra execute failed: ${executeRes.status} ${errBody}`);
  }

  const result = await executeRes.json();
  const txid = result.signature;
  console.log(`✅ Ultra executed: ${txid}`);
  if (chatId) await sendTelegram(chatId, `✅ Ultra swap success: ${amountIn / DECIMALS} ${inputMint.equals(USDC_MINT) ? 'USDC' : 'GIDDY'} → ${quote.outAmount / DECIMALS} ${outputMint.equals(USDC_MINT) ? 'USDC' : 'GIDDY'}`, txid);

  await logSwap({ timestamp, inputMint, outputMint, amountIn, amountOut: quote.outAmount, txid, route: quote.router, fallback: false });
  return { txid, quote, error: null, timestamp, fallback: false };
}

export async function ultraSwap(inputMint, outputMint, amountIn, chatId) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let retryCount = 0;
  const maxRetries = 3;

  // Pre-checks
  const balances = await getBalances();
  if (balances.sol < 0.005) throw new Error(`Insufficient SOL: ${balances.sol} (need 0.005)`);
  const inputBal = inputMint.equals(USDC_MINT) ? balances.usdc : balances.giddy;
  if (inputBal < amountIn / DECIMALS) throw new Error(`Insufficient input: ${inputBal} (need ${amountIn / DECIMALS})`);

  await ensureATAs(inputMint, outputMint, chatId);

  while (retryCount < maxRetries) {
    try {
      const quote = await getUltraQuote(inputMint, outputMint, amountIn, timestamp, chatId);
      return await executeUltra(quote, inputMint, outputMint, amountIn, timestamp, chatId);
    } catch (err) {
      retryCount++;
      console.error(`Ultra retry ${retryCount}/${maxRetries}: ${err.message}`);
      if (retryCount === maxRetries) break;
      await new Promise(r => setTimeout(r, Math.pow(2, retryCount) * 1000));
    }
  }

  // Fallback to Jupiter
  if (chatId) await sendTelegram(chatId, '⚠️ Ultra failed—trying Jupiter...');
  const jupiterResult = await jupiterSwap(inputMint, outputMint, amountIn, timestamp, chatId);
  if (jupiterResult.txid) return jupiterResult;

  // Optional DLMM Fallback (set USE_DLMM_FALLBACK=true in .env to enable)
  if (process.env.USE_DLMM_FALLBACK === 'true') {
    if (chatId) await sendTelegram(chatId, '⚠️ Jupiter failed—trying direct DLMM...');
    const dlmmResult = await dlmmSwap(wallet, connection, inputMint, outputMint, amountIn.toString());
    if (dlmmResult?.txid) {
      console.log(`✅ DLMM fallback executed: ${dlmmResult.txid}`);
      if (chatId) await sendTelegram(chatId, `✅ DLMM swap success: ${amountIn / DECIMALS} ${inputMint.equals(USDC_MINT) ? 'USDC' : 'GIDDY'} → ${Number(dlmmResult.amountOut) / DECIMALS} ${outputMint.equals(USDC_MINT) ? 'USDC' : 'GIDDY'}`, dlmmResult.txid);
      await logSwap({ timestamp, inputMint, outputMint, amountIn, amountOut: dlmmResult.amountOut, txid: dlmmResult.txid, route: 'Direct DLMM', fallback: true, dlmm: true });
      return { txid: dlmmResult.txid, quote: null, error: null, timestamp, fallback: true, dlmm: true };
    }
  }

  const error = 'All fallbacks failed';
  await logSwap({ timestamp, inputMint, outputMint, amountIn, error });
  if (chatId) await sendTelegram(chatId, `❌ ${error}`);
  return { txid: null, quote: null, error, timestamp, fallback: false };
}

async function jupiterSwap(inputMint, outputMint, amountIn, timestamp, chatId) {
  const api = createJupiterApiClient({ basePath: 'https://quote-api.jup.ag' });
  let quote;
  let attempts = 0;
  const maxQuoteAttempts = 5;

  while (attempts < maxQuoteAttempts) {
    try {
      quote = await api.quoteGet({
        inputMint: inputMint.toBase58(),
        outputMint: outputMint.toBase58(),
        amount: amountIn,
        slippageBps: Number(process.env.SLIPPAGE_BPS) || 100,
        swapMode: 'ExactIn',
        onlyDirectRoutes: false,
      });
      if (quote?.outAmount) break;
    } catch (err) {
      console.error(`Jupiter quote attempt ${attempts + 1}: ${err.message}`);
    }
    attempts++;
    await new Promise(r => setTimeout(r, 500));
  }

  if (!quote?.outAmount) throw new Error('No Jupiter quote available');

  const routeLabels = quote.routePlan?.map(step => step.swapInfo?.label || 'Unknown').join(' → ') || 'Direct';
  console.log(`📊 Jupiter quote: ${amountIn / DECIMALS} → ~${quote.outAmount / DECIMALS} ${outputMint.equals(GIDDY_MINT) ? 'GIDDY' : 'USDC'}\n🔀 ${routeLabels}`);
  if (chatId) await sendTelegram(chatId, `📊 Jupiter quote: ${amountIn / DECIMALS} ${inputMint.equals(USDC_MINT) ? 'USDC' : 'GIDDY'} → ~${quote.outAmount / DECIMALS} ${outputMint.equals(USDC_MINT) ? 'USDC' : 'GIDDY'}\n🔀 ${routeLabels}`);

  try {
    const swapRes = await api.swapPost({
      swapRequest: {
        userPublicKey: wallet.publicKey.toBase58(),
        quoteResponse: quote,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      },
    });

    const txBuffer = Buffer.from(swapRes.swapTransaction, 'base64');
    const vtx = VersionedTransaction.deserialize(txBuffer);
    vtx.sign([wallet]);

    const txid = await connection.sendTransaction(vtx, { skipPreflight: false });
    await connection.confirmTransaction(txid, 'confirmed');

    console.log(`✅ Jupiter executed: ${txid}`);
    if (chatId) await sendTelegram(chatId, `✅ Jupiter swap success: ${amountIn / DECIMALS} ${inputMint.equals(USDC_MINT) ? 'USDC' : 'GIDDY'} → ${quote.outAmount / DECIMALS} ${outputMint.equals(USDC_MINT) ? 'USDC' : 'GIDDY'}\n🔀 ${routeLabels}`, txid);

    await logSwap({ timestamp, inputMint, outputMint, amountIn, amountOut: quote.outAmount, txid, route: routeLabels, fallback: true });
    return { txid, quote, error: null, timestamp, fallback: true };
  } catch (err) {
    const error = `Jupiter execution failed: ${err.message}`;
    console.error(error);
    await logSwap({ timestamp, inputMint, outputMint, amountIn, error, fallback: true });
    if (chatId) await sendTelegram(chatId, `❌ ${error}`);
    throw err;
  }
}

// Alias for backward compat
export async function swap(inputMint, outputMint, amountIn, chatId) {
  return ultraSwap(inputMint, outputMint, amountIn, chatId);
}

export { USDC_MINT, GIDDY_MINT };