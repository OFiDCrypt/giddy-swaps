import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { wallet, getBalances, ultraSwap, USDC_MINT, GIDDY_MINT } from './bot.js';
import { queryGemma } from './gemma.js';
import { coinMap, getCoinInfo, getCoinsWithContracts, getCommunityCoins, isValidSolanaAddress } from './coins.js';
import { companyData } from './companyData.js';

dotenv.config({ quiet: true });

// In-memory storage for user data (userId -> data; supports groups/DMs per-user)
const userNames = new Map(); // userId -> first_name
const namePrefixEnabled = new Map(); // userId -> true/false
const nicknames = new Map(); // userId -> nickname
const useNickname = new Map(); // userId -> boolean (use nick in greetings)
const awaitingNicknameToggle = new Map(); // userId -> boolean (awaiting yes/no)

// Load user data from userData.json on startup
async function loadUserData() {
  try {
    const data = await fs.readFile('userData.json', 'utf8');
    const userData = JSON.parse(data);
    for (const [userId, { firstName, nickname, useNick, prefixEnabled }] of Object.entries(userData)) {
      userNames.set(Number(userId), firstName);
      if (nickname) nicknames.set(Number(userId), nickname);
      useNickname.set(Number(userId), useNick ?? false);
      namePrefixEnabled.set(Number(userId), prefixEnabled ?? true);
    }
    console.log(`✅ Loaded user data for ${Object.keys(userData).length} users`);
  } catch (err) {
    console.error(`❌ Failed to load userData.json: ${err.message}`);
  }
}

// Save user data to userData.json
async function saveUserData(userId) {
  try {
    const userData = JSON.parse(await fs.readFile('userData.json', 'utf8') || '{}');
    userData[userId] = {
      firstName: userNames.get(userId) || 'friend',
      nickname: nicknames.get(userId) || null,
      useNick: useNickname.get(userId) ?? false,
      prefixEnabled: namePrefixEnabled.get(userId) ?? true,
    };
    await fs.writeFile('userData.json', JSON.stringify(userData, null, 2));
    console.log(`💾 Saved user data for user ${userId}`);
  } catch (err) {
    console.error(`❌ Failed to save userData.json: ${err.message}`);
  }
}

// Leverage Telegram's chat object for session-based caching
function getCachedUserData(msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'friend';
  // Update in-memory cache from Telegram's chat object
  if (!userNames.has(userId)) {
    userNames.set(userId, firstName);
    saveUserData(userId); // Persist immediately
  }
  return { userId, firstName, chatId };
}

// Get personalized greeting with format: 💬 Replying to *name*:\n\n 
function getGreeting(userId, isConversational = false, firstName = 'friend') {
  const enabled = namePrefixEnabled.get(userId) ?? isConversational;
  if (!enabled) return '';

  const nick = useNickname.get(userId) ? nicknames.get(userId) : null;
  const name = nick || userNames.get(userId) || firstName;
  // Escape all MarkdownV2 reserved characters
  const escapedName = name.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1');
  const prefix = `💬 Replying to *${escapedName}*:\n\n`;
  return prefix;
}

// Strip greeting prefix (e.g., 💬 Replying to *name*:\n\n) from message
function stripLeadingGreeting(message, userId, isConversational = false, firstName = 'friend') {
  const prefix = getGreeting(userId, isConversational, firstName);
  if (prefix && message.startsWith(prefix)) {
    return message.slice(prefix.length).trim();
  }
  return message;
}

// Extract nickname from message text, supporting @nickname and clearing
function extractNickname(text) {
  const lowerText = text.toLowerCase();
  const patterns = [
    /^call me @?(.+)$/,
    /^my nickname is @?(.+)$/,
    /call me @?(.+?)(?=\.|!|\?|$)/,
    /i'm going by @?(.+?)(?=\.|!|\?|$)/
  ];
  // Check for nickname clearing
  if (lowerText.match(/^clear my nickname$|^reset my nickname$/)) {
    return 'CLEAR_NICKNAME';
  }
  for (const pattern of patterns) {
    const match = lowerText.match(pattern);
    if (match) {
      let nick = match[1].trim().replace(/^@/, '');
      nick = nick.replace(/[^\w\s\- \u{1F600}-\u{1F64F}]/gu, '');
      const emojiCount = (nick.match(/[\u{1F600}-\u{1F64F}]/gu) || []).length;
      if (emojiCount > 2) nick = nick.replace(/[\u{1F600}-\u{1F64F}]/gu, '');
      if (nick.length > 0 && nick.length <= 50 && !isProfane(nick)) {
        return nick.replace(/\b\w+/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
      }
    }
  }
  return null;
}

// Simple profanity filter
function isProfane(text) {
  const badWords = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'dick', 'piss', 'bastard', 'slut', 'whore'];
  return badWords.some(word => text.toLowerCase().includes(word));
}

// Detect name complaints
function isNameComplaint(text) {
  const lowerText = text.toLowerCase();
  const complaints = [
    "that's not my name",
    "wrong name",
    "stop calling me",
    "not my nickname",
    "hey that's not"
  ];
  return complaints.some(phrase => lowerText.includes(phrase));
}

// Cache startup and refresh
(async () => {
  await loadUserData();
  await loadCoinCache();
  await loadDexCache();
  setInterval(async () => {
    console.log('🔄 Refreshing caches...');
    await loadCoinCache();
    await loadDexCache();
    for (const userId of userNames.keys()) {
      await saveUserData(userId);
    }
  }, 21600000); // 6 hours
})();

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: { interval: 2000, autoStart: true } });

// Polling error handler
let pollingRetries = 0;
const maxPollingRetries = 3;

bot.on('polling_error', (error) => {
  console.error(`❌ Polling error: ${JSON.stringify(error)}`);
  pollingRetries++;
  if (pollingRetries < maxPollingRetries) {
    console.log(`🔄 Attempting to restart polling... (Attempt ${pollingRetries}/${maxPollingRetries})`);
    setTimeout(() => {
      bot.stopPolling();
      bot.startPolling({ restart: true });
    }, 5000);
  } else {
    console.error(`❌ Max polling retries exceeded. Stopping bot.`);
    process.exit(1);
  }
});

const connection = new Connection(process.env.RPC_URL, 'confirmed');

let isSwapping = false;
let currentPhase = process.env.INITIAL_DIRECTION === 'backward' ? 'sell' : 'buy';
const DECIMALS = 1_000_000;

const menu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "💸 Deposit", callback_data: "deposit" }],
      [{ text: "📊 Balance", callback_data: "balance" }],
      [{ text: "🔁 Start Swap", callback_data: "start" }],
      [{ text: "⛔ Stop Swap", callback_data: "stop" }],
      [{ text: "🌀 Clear Nickname", callback_data: "clear_nickname" }],
      [{ text: "📜 Community Contracts", callback_data: "contracts" }],
    ]
  }
};

let swapLog = [];
let trackedGiddyDelta = 0;
let lastSwapOutAmount = 0;

const pendingQueries = new Map();

let coinCache = null;

async function loadCoinCache() {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/coins/list', { timeout: 10000 });
    coinCache = response.data;
    console.log(`✅ Loaded ${coinCache.length} coins into cache`);
  } catch (err) {
    console.error(`❌ Failed to load coin cache: ${err.message}. Using manual map only.`);
    coinCache = null;
  }
}

let dexCache = null;

async function loadDexCache() {
  try {
    const response = await axios.get('https://api.dexscreener.com/latest/dex/search/?q=solana', { timeout: 10000 });
    dexCache = response.data.pairs || [];
    console.log(`✅ Loaded ${dexCache.length} Dex pairs into cache`);
  } catch (err) {
    console.error(`❌ Failed to load Dex cache: ${err.message}. Skipping Dex fallback.`);
    dexCache = [];
  }
}

function searchDexCache(query) {
  if (!dexCache || !query) return [];
  const lowerQuery = query.toLowerCase();
  return dexCache.filter(pair =>
    pair.baseToken.symbol.toLowerCase().includes(lowerQuery) ||
    pair.baseToken.name.toLowerCase().includes(lowerQuery)
  );
}

function getDexTokenInfo(pair) {
  if (!pair) return null;
  return {
    ticker: pair.baseToken.symbol.toUpperCase(),
    name: pair.baseToken.name,
    contractAddress: pair.baseToken.address,
    price: pair.priceUsd || 0
  };
}

async function decodeSwap(txid, chatId) {
  try {
    await new Promise(r => setTimeout(r, 2000));
    const tx = await connection.getParsedTransaction(txid, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx) {
      await bot.sendMessage(chatId, `${getGreeting('unknown', false)}⚠️ Transaction ${txid} not found yet—check later.`, { parse_mode: 'Markdown' });
      return;
    }

    const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : 'Unknown';
    const fee = tx.meta?.fee || 0;
    const logs = tx.meta?.logMessages?.slice(-5).join('\n') || 'No logs';

    const message = `\
✅ *Swap Confirmed*
📅 Time: ${blockTime}
💸 Fee: ${(fee / 1_000_000_000).toFixed(6)} SOL
🪵 Logs:
\`\`\`
${logs}
\`\`\`
`.trim();

    await bot.sendMessage(chatId, message, { parse_mode: "Markdown", disable_web_page_preview: true });
    console.log("📨 Telegram post-swap decode sent.");
  } catch (err) {
    await bot.sendMessage(chatId, `${getGreeting('unknown', false)}⚠️ Could not decode transaction: ${err.message}`, { parse_mode: 'Markdown' });
    console.error("❌ Decode error:", err.message);
  }
}

async function waitForBalanceChange(mint, preBalance, direction, chatId, quote) {
  let postBalance = preBalance;
  const maxAttempts = 5;
  let attempts = 0;
  const tokenLabel = mint.equals(GIDDY_MINT) ? 'GIDDY' : 'USDC';
  while (postBalance === preBalance && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 4000));
    const balances = await getBalances();
    postBalance = mint.equals(GIDDY_MINT) ? balances.giddy : balances.usdc;
    attempts++;
    console.log(`Attempt ${attempts}: Waiting for ${tokenLabel} balance change after ${direction.label}... Current: ${postBalance.toFixed(6)}`);
  }
  const stopMessage = `⏳ Swaps in progress ♻️`;
  if (postBalance === preBalance) {
    const outAmount = (quote.outAmount || quote.totalOutputAmount || 0) / DECIMALS;
    console.log(`⚠️ ${tokenLabel} balance did not change after ${direction.label} swap after ${maxAttempts} attempts. Using quote amount: ${outAmount.toFixed(6)}`);
    console.log(stopMessage);
    await bot.sendMessage(chatId, `${getGreeting('unknown', false)}${stopMessage}`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "Stop", callback_data: "stop" }],
          [{ text: "Main Menu", callback_data: "menu" }]
        ],
      },
    });
    return outAmount;
  }
  console.log(stopMessage);
  await bot.sendMessage(chatId, `${getGreeting('unknown', false)}${stopMessage}`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: "Stop", callback_data: "stop" }],
        [{ text: "Main Menu", callback_data: "menu" }]
      ],
    },
  });
  return postBalance;
}

async function fetchGeckoTerminalPrice(contractAddress) {
  try {
    const response = await axios.get(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${contractAddress}`, { timeout: 5000 });
    const data = response.data.data.attributes;
    if (!data || !data.price_usd) return null;

    const price = Number(data.price_usd);
    const change = data.price_usd_24h_change || 0;
    const changeEmoji = change > 0 ? '📈' : change < 0 ? '📉' : '➡️';
    let priceDisplay;
    if (price === 0) {
      priceDisplay = '$0.00';
    } else if (price < 0.01) {
      priceDisplay = `$${price.toFixed(8)}`;
    } else {
      priceDisplay = `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    const priceStr = `${priceDisplay} ${changeEmoji} (${change > 0 ? '+' : ''}${change.toFixed(2)}% 24h)`;
    return { priceStr, contract: contractAddress, chain: 'Solana', dex: 'Meteora' };
  } catch (err) {
    console.error(`❌ GeckoTerminal API error for ${contractAddress}: ${err.message}`);
    return null;
  }
}

async function fetchDexScreenerPrice(contractAddress) {
  try {
    const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`, { timeout: 5000 });
    const pairs = response.data.pairs;
    if (!pairs || pairs.length === 0) return null;

    const bestPair = pairs
      .filter(pair => pair.chainId === 'solana')
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!bestPair) return null;

    const price = Number(bestPair.priceUsd);
    const change = bestPair.priceChange?.h24 || 0;
    const changeEmoji = change > 0 ? '📈' : change < 0 ? '📉' : '➡️';
    let priceDisplay;
    if (price === 0) {
      priceDisplay = '$0.00';
    } else if (price < 0.01) {
      priceDisplay = `$${price.toFixed(8)}`;
    } else {
      priceDisplay = `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    const priceStr = `${priceDisplay} ${changeEmoji} (${change > 0 ? '+' : ''}${change.toFixed(2)}% 24h)`;
    return { priceStr, contract: contractAddress, chain: 'Solana', dex: bestPair.dexId };
  } catch (err) {
    console.error(`❌ DexScreener API error for ${contractAddress}: ${err.message}`);
    return null;
  }
}

async function fetchCoinPrice(coingeckoId, contractAddress = null) {
  try {
    const priceResponse = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd&include_24hr_change=true`, { timeout: 5000 });
    const priceData = priceResponse.data[coingeckoId];
    if (!priceData) return null;

    const change = priceData.usd_24h_change;
    const changeEmoji = change > 0 ? '📈' : change < 0 ? '📉' : '➡️';
    let priceDisplay;
    const usd = Number(priceData.usd);
    if (usd === 0) {
      priceDisplay = '$0.00';
    } else if (usd < 0.01) {
      priceDisplay = `$${usd.toFixed(8)}`;
    } else {
      priceDisplay = `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    const priceStr = `${priceDisplay} ${changeEmoji} (${change > 0 ? '+' : ''}${change.toFixed(2)}% 24h)`;

    let contract = contractAddress;
    let chain = contractAddress ? 'Solana' : null;
    if (!contract) {
      const coinResponse = await axios.get(`https://api.coingecko.com/api/v3/coins/${coingeckoId}`, { timeout: 5000 });
      const coinData = coinResponse.data;
      const platforms = coinData.platforms || {};
      if (platforms.solana) {
        contract = platforms.solana;
        chain = 'Solana';
      } else if (platforms.ethereum) {
        contract = platforms.ethereum;
        chain = 'Ethereum';
      }
    }

    return { priceStr, contract, chain, source: 'CoinGecko' };
  } catch (err) {
    console.error(`❌ CoinGecko API error for ${coingeckoId}: ${err.message}`);
    return null;
  }
}

async function fetchContractAddress(coingeckoId, contractAddress = null) {
  try {
    let contract = contractAddress;
    let chain = contractAddress ? 'Solana' : null;
    let source = 'Provided';

    if (!contract || !isValidSolanaAddress(contract)) {
      const coinResponse = await axios.get(`https://api.coingecko.com/api/v3/coins/${coingeckoId}`, { timeout: 5000 });
      const coinData = coinResponse.data;
      const platforms = coinData.platforms || {};
      console.log(`🔍 CoinGecko platforms for ${coingeckoId}: ${JSON.stringify(platforms)}`);
      if (platforms.solana && isValidSolanaAddress(platforms.solana)) {
        contract = platforms.solana;
        chain = 'Solana';
        source = 'CoinGecko';
      } else if (platforms.ethereum) {
        contract = platforms.ethereum;
        chain = 'Ethereum';
        source = 'CoinGecko';
      }
    }

    return { contract, chain, source };
  } catch (err) {
    console.error(`❌ CoinGecko contract fetch error for ${coingeckoId}: ${err.message}`);
    return null;
  }
}

async function fetchGeckoTerminalContract(input) {
  try {
    if (isValidSolanaAddress(input)) {
      const response = await axios.get(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${input}`, { timeout: 5000 });
      const data = response.data.data;
      if (data && data.attributes.address && isValidSolanaAddress(data.attributes.address)) {
        return { contract: data.attributes.address, chain: 'Solana', source: 'GeckoTerminal' };
      }
    }
    return null;
  } catch (err) {
    console.error(`❌ GeckoTerminal contract fetch error for ${input}: ${err.message}`);
    return null;
  }
}

async function fetchDexScreenerContract(input) {
  try {
    if (isValidSolanaAddress(input)) {
      const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${input}`, { timeout: 5000 });
      const pairs = response.data.pairs;
      if (!pairs || pairs.length === 0) return null;

      const bestPair = pairs
        .filter(pair => pair.chainId === 'solana' && isValidSolanaAddress(pair.baseToken.address))
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      if (!bestPair) return null;

      return { contract: bestPair.baseToken.address, chain: 'Solana', source: 'DexScreener' };
    }
    return null;
  } catch (err) {
    console.error(`❌ DexScreener contract fetch error for ${input}: ${err.message}`);
    return null;
  }
}

// Nickname Settings Command
bot.onText(/\/nicknamesettings/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const chatType = msg.chat.type;

  try {
    await bot.sendMessage(chatId, `${getGreeting(userId, true, chatType)}Make changes to your Trivia Nickname here\\!`, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [{ text: "Clear Nickname", callback_data: "clear_nickname" }],
          [{ text: "Cancel", callback_data: "cancel" }]
        ]
      }
    });
    console.log(`✅ Sent nickname settings menu to chat ${chatId}`);
  } catch (err) {
    console.error(`❌ Nickname settings error in chat ${chatId}:`, err.message);
    await bot.sendMessage(chatId, `${getGreeting(userId, true, chatType)}Oops, something went wrong\\. Try again or use /start\\.`, { parse_mode: 'MarkdownV2' });
  }
});

bot.onText(/\/start/, (msg) => {
  const { userId, chatId } = getCachedUserData(msg);
  bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}Welcome to GIDDY_SWAP_BOT\\. Choose an action\\:`, { parse_mode: 'MarkdownV2', ...menu });
});

bot.onText(/\/contracts/, async (msg) => {
  const { userId, chatId } = getCachedUserData(msg);
  try {
    const { community, others } = getCoinsWithContracts();
    let message = '📜 *Solana Token Contracts*\n\n';

    if (community.length > 0) {
      message += '🤝 *Community Projects*\n\n';
      message += community
        .map((coin) => {
          let entry = `• ${coin.ticker} (${coin.name})\n  \`${coin.contractAddress}\`\n  🟣 [View on Solscan](https://solscan.io/token/${coin.contractAddress})`;
          if (coin.coingeckoId) {
            entry += `\n  🦎 [View on CoinGecko](https://www.coingecko.com/en/coins/${coin.coingeckoId})`;
          }
          return entry;
        })
        .join('\n\n');
    }

    if (others.length > 0) {
      message += '\n\n📜 *Other Tokens*\n\n';
      message += others
        .map((coin) => {
          let entry = `• ${coin.ticker} (${coin.name})\n  \`${coin.contractAddress}\`\n  🟣 [View on Solscan](https://solscan.io/token/${coin.contractAddress})`;
          if (coin.coingeckoId) {
            entry += `\n  🦎 [View on CoinGecko](https://www.coingecko.com/en/coins/${coin.coingeckoId})`;
          }
          return entry;
        })
        .join('\n\n');
    }

    if (community.length === 0 && others.length === 0) {
      message = 'No coins with Solana contract addresses found.';
    }

    await bot.sendMessage(chatId, `${getGreeting(userId, false, msg.chat.type)}${message}`, { parse_mode: 'Markdown', disable_web_page_preview: true });
    console.log(`✅ Sent /contracts list with ${community.length} community and ${others.length} other tokens`);
  } catch (err) {
    console.error(`❌ /contracts error: ${err.message}`);
    await bot.sendMessage(chatId, `${getGreeting(userId, false, msg.chat.type)}⚠️ Error fetching contract addresses: ${err.message}`, { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/name on/, (msg) => {
  const { userId, chatId } = getCachedUserData(msg);
  namePrefixEnabled.set(userId, true);
  saveUserData(userId);
  bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}Name prefix enabled\\! I'll greet you personally in chats\\.`, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/name off/, (msg) => {
  const { userId, chatId } = getCachedUserData(msg);
  namePrefixEnabled.set(userId, false);
  saveUserData(userId);
  bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}Name prefix disabled—responses will be more direct\\. Use /name on to re-enable\\.`, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/forget name/, (msg) => {
  const { userId, chatId } = getCachedUserData(msg);
  userNames.delete(userId);
  namePrefixEnabled.delete(userId);
  nicknames.delete(userId);
  useNickname.delete(userId);
  saveUserData(userId);
  bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}Forgot your name and nickname\\! Tag me again to set a new one\\.`, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/clearnick/, (msg) => {
  const { userId, chatId, firstName } = getCachedUserData(msg);
  nicknames.delete(userId);
  useNickname.delete(userId);
  saveUserData(userId);
  bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}Nickname cleared\\! Using *${firstName.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}* now\\. Set a new one with "call me [new name]" \\! 😊`, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/togglernick/, (msg) => {
  const { userId, chatId } = getCachedUserData(msg);
  const current = useNickname.get(userId) ?? false;
  useNickname.set(userId, !current);
  saveUserData(userId);
  const nick = nicknames.get(userId);
  const status = !current ? 'enabled' : 'disabled';
  const msgText = nick
    ? `Nickname usage *${status}*\\! I'll ${!current ? '' : 'stop '}using *${nick.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}*\\. Set with "call me [new name]"\\.`
    : `No nickname set yet\\. Set one with "call me [new name]" first\\.`;
  bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}${msgText}`, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/swap/, async (msg) => {
  const { userId, chatId } = getCachedUserData(msg);
  await bot.sendMessage(chatId, `${getGreeting(userId, false, msg.chat.type)}Manual swap triggered.`, { parse_mode: 'Markdown' });
  const balances = await getBalances();
  const minSol = 0.02;

  if (balances.sol < minSol) {
    await bot.sendMessage(chatId, `
🔴 *Insufficient Balance*
• SOL: ${balances.sol.toFixed(6)} (Minimum: ${minSol.toFixed(6)} SOL)
    `, { parse_mode: "Markdown" });
    return;
  }

  const direction = currentPhase === "buy"
    ? { from: USDC_MINT, to: GIDDY_MINT, label: "USDC → GIDDY" }
    : { from: GIDDY_MINT, to: USDC_MINT, label: "GIDDY → USDC" };

  let preBalance = direction.to.equals(GIDDY_MINT) ? balances.giddy : balances.usdc;

  const inputBalance = direction.from.equals(USDC_MINT) ? balances.usdc : balances.giddy;
  let amount;
  if (direction.from.equals(USDC_MINT)) {
    const maxBuy = Number(process.env.MAX_BUY_USDC || 10) * DECIMALS;
    amount = lastSwapOutAmount > 0 ? Math.min(lastSwapOutAmount * DECIMALS, maxBuy) : Math.min(inputBalance * DECIMALS, maxBuy);
    if (amount < Number(process.env.MIN_SWAP_AMOUNT) * DECIMALS) {
      await bot.sendMessage(chatId, `
🔴 *Insufficient Balance*
• USDC: ${inputBalance.toFixed(2)} (Minimum: ${Number(process.env.MIN_SWAP_AMOUNT).toFixed(2)} USDC)
      `, { parse_mode: "Markdown" });
      return;
    }
  } else {
    if (trackedGiddyDelta <= 0) {
      await bot.sendMessage(chatId, `⚠️ No tracked GIDDY to sell (run buy first or invalid delta: ${trackedGiddyDelta.toFixed(6)})`, { parse_mode: 'Markdown' });
      return;
    }
    console.log(`Sell phase - Input balance: ${inputBalance.toFixed(6)}, Tracked GIDDY delta: ${trackedGiddyDelta.toFixed(6)}`);
    amount = Math.round(trackedGiddyDelta * DECIMALS);
    if (inputBalance < trackedGiddyDelta) {
      await bot.sendMessage(chatId, `
🔴 *Insufficient Balance*
• GIDDY: ${inputBalance.toFixed(2)} (Required: ${trackedGiddyDelta.toFixed(2)} GIDDY)
      `, { parse_mode: "Markdown" });
      return;
    }
  }

  let txid, quote, error, fallback, dlmm;
  try {
    ({ txid, quote, error, fallback, dlmm } = await ultraSwap(direction.from, direction.to, amount, chatId));
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Swap failed: Failed to fetch quote from alternate routes: ${err.message}`, { parse_mode: 'Markdown' });
    console.log(`❌ Swap failed: ${err.message}`);
    return;
  }

  if (quote) {
    const outAmount = quote.outAmount || quote.totalOutputAmount || 'N/A';
    const route = quote.router || (quote.routePlan?.map(step => step.swapInfo?.label || 'Unknown').join(' → ') || 'Unknown');
    const inTicker = direction.from.equals(USDC_MINT) ? 'USDC' : 'GIDDY';
    const outTicker = direction.to.equals(USDC_MINT) ? 'USDC' : 'GIDDY';
    await bot.sendMessage(chatId, `📊 Quote: ${(amount / DECIMALS).toFixed(6)} ${inTicker} → ~${(outAmount / DECIMALS).toFixed(6)} ${outTicker}\n🔀 Route: ${route}`, { parse_mode: 'Markdown' });
    console.log(`📊 Quote: ${(amount / DECIMALS).toFixed(6)} ${inTicker} → ${(outAmount / DECIMALS).toFixed(6)} ${outTicker}`);
    console.log("🔀 Route:", route);
  }

  if (txid) {
    const method = dlmm ? ' (DLMM)' : fallback ? ' (Fallback)' : '';
    await bot.sendMessage(
      chatId,
      `🧾 Swap submitted${method}.\n🔑 Txid: \`${txid}\`\n🔗 [View on Solscan](https://solscan.io/tx/${txid})`,
      { parse_mode: "Markdown" }
    );
    console.log("✅ Txid:", txid);
    await decodeSwap(txid, chatId);

    const mintToCheck = direction.to;
    const postBalance = await waitForBalanceChange(mintToCheck, preBalance, direction, chatId, quote);
    const delta = postBalance - preBalance;
    if (direction.from.equals(USDC_MINT)) {
      console.log(`Pre-buy trackedGiddyDelta: ${trackedGiddyDelta.toFixed(6)}`);
      trackedGiddyDelta = delta > 0 ? delta : (quote ? (quote.outAmount || quote.totalOutputAmount || 0) / DECIMALS : 0);
      console.log(`Post-buy trackedGiddyDelta: ${trackedGiddyDelta.toFixed(6)}`);
      trackedGiddyDelta = Number(trackedGiddyDelta.toFixed(6));
      lastSwapOutAmount = quote ? (quote.outAmount || quote.totalOutputAmount || 0) / DECIMALS : 0;
      console.log(`Tracked GIDDY delta from buy: ${trackedGiddyDelta.toFixed(2)}`);
    } else {
      console.log(`Pre-sell trackedGiddyDelta: ${trackedGiddyDelta.toFixed(6)}`);
      trackedGiddyDelta = 0;
      lastSwapOutAmount = quote ? (quote.outAmount || quote.totalOutputAmount || 0) / DECIMALS : 0;
      console.log(`Post-sell trackedGiddyDelta: ${trackedGiddyDelta.toFixed(6)}`);
    }

    currentPhase = currentPhase === "buy" ? "sell" : "buy";
  } else {
    await bot.sendMessage(chatId, `❌ Swap failed: ${error || "Unknown error."}`, { parse_mode: 'Markdown' });
  }
});

// HALF-WAY POINT: BOT.ON CALLBACK - For REFERENCE (END OF FIRST PART)

// HALF-WAY POINT: BOT.ON CALLBACK - For REFERENCE (START OF SECOND PART)


// HALF-WAY POINT: BOT.ON CALLBACK - For REFERENCE (START OF SECOND PART)

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const action = query.data;
  const chatType = query.message.chat.type;

  try {
    await bot.answerCallbackQuery(query.id);
    console.log(`📩 Callback received: action="${action}" in chat ${chatId}`);
  } catch (err) {
    if (err.message.includes('query is too old')) {
      console.log(`⚠️ Ignored stale callback query ${query.id} for action "${action}"`);
      return;
    }
    console.error(`❌ Error acknowledging callback ${query.id}:`, err.message);
    throw err;
  }

  try {
    if (action.startsWith('price_select:') || action.startsWith('contract_select:')) {
      const isPriceSelect = action.startsWith('price_select:');
      const selectedId = action.split(':')[1];
      console.log(`${isPriceSelect ? '💰 Fetching price' : '📜 Fetching contract'} for ${selectedId} in chat ${chatId}`);
      try {
        await bot.answerCallbackQuery(query.id, { text: isPriceSelect ? 'Fetching price...' : 'Fetching contract...' });
        if (isPriceSelect) {
          const priceInfo = await fetchCoinPrice(selectedId);
          if (priceInfo) {
            const cacheMatch = coinCache.find(c => c.id === selectedId);
            const coinInfo = cacheMatch
              ? { ticker: cacheMatch.symbol.toUpperCase(), id: cacheMatch.id }
              : { ticker: selectedId.toUpperCase(), id: selectedId };
            let response = `Got it\\! ${coinInfo.ticker} is at ${priceInfo.priceStr.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')} 🚀 \\(Source: ${priceInfo.source}\\)`;
            response += `\n🔗 [View on CoinGecko](https://www.coingecko.com/en/coins/${coinInfo.id})`;
            if (isValidSolanaAddress(coinInfo.contractAddress)) {
              response += `\n🔗 [View on Solscan](https://solscan.io/token/${coinInfo.contractAddress})`;
            }
            response += `\n\nWant to swap some GIDDY\\? 💱`;
            await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}${response}`, {
              parse_mode: "MarkdownV2",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]
                ]
              }
            });
            console.log(`✅ Sent price for ${coinInfo.ticker}: ${priceInfo.priceStr}`);
          } else {
            let response = `Couldn't fetch price for this coin\\. Try searching on CoinGecko:\n🔗 [CoinGecko Search](https://www.coingecko.com/en/search?q=${selectedId})`;
            response += `\n\nWant to swap some GIDDY\\? 💱`;
            await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}${response}`, {
              parse_mode: 'MarkdownV2',
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]
                ]
              }
            });
            console.log(`❌ No price data for ${selectedId}`);
          }
        } else {
          const coinInfo = Object.values(coinMap).find(coin => coin.id === selectedId) || { ticker: selectedId.toUpperCase(), contractAddress: null };
          let contractInfo = await fetchContractAddress(selectedId, coinInfo.contractAddress);
          let response;
          if (contractInfo && isValidSolanaAddress(contractInfo.contract)) {
            response = `Contract details for ${coinInfo.ticker}:\n\`${contractInfo.contract}\` \\(${contractInfo.chain}\\)\\n🔗 [View on Solscan](https://solscan.io/token/${contractInfo.contract})\\n\\nWant to swap some GIDDY\\? 💱`;
            console.log(`✅ Contract fetched for ${coinInfo.ticker}: ${contractInfo.contract} (${contractInfo.source})`);
          } else {
            response = `Contract details for ${coinInfo.ticker}:\nNo Solana contract found\\.`;
            if (coinInfo.id) {
              response += `\n🔗 [View on CoinGecko](https://www.coingecko.com/en/coins/${coinInfo.id})`;
            } else {
              response += `\n🔗 [CoinGecko Search](https://www.coingecko.com/en/search?q=${coinInfo.ticker})`;
            }
            response += `\n\\nWant to swap some GIDDY\\? 💱`;
            console.log(`❌ No Solana contract for ${coinInfo.ticker}, sent CoinGecko link`);
          }
          await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}${response}`, {
            parse_mode: 'MarkdownV2',
            reply_markup: {
              inline_keyboard: [
                [{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]
              ]
            }
          });
        }
        pendingQueries.delete(chatId);
      } catch (err) {
        console.error(`❌ Selection error for ${selectedId}:`, err.message);
        await bot.answerCallbackQuery(query.id, { text: `Error fetching ${isPriceSelect ? 'price' : 'contract'}. Try again.` });
      }
      return;
    }

    if (action === "contracts") {
      console.log(`📜 Handling contracts callback in chat ${chatId}`);
      try {
        const coins = getCommunityCoins();
        if (coins.length === 0) {
          await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}No community project tokens found.`, { parse_mode: 'Markdown' });
          console.log(`✅ Sent empty community contracts response`);
          return;
        }

        const message = `🤝 *Community Projects*\n\n` + coins
          .map((coin) => {
            let entry = `• ${coin.ticker} (${coin.name})\n  \`${coin.contractAddress}\`\n  🟣 [View on Solscan](https://solscan.io/token/${coin.contractAddress})`;
            if (coin.coingeckoId) {
              entry += `\n  🦎 [View on CoinGecko](https://www.coingecko.com/en/coins/${coin.coingeckoId})`;
            }
            return entry;
          })
          .join('\n\n');
        await bot.sendMessage(
          chatId,
          `${getGreeting(userId, false, chatType)}${message}`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
        console.log(`✅ Sent community contracts list with ${coins.length} tokens`);
      } catch (err) {
        console.error(`❌ Contracts callback error: ${err.message}`);
        await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}⚠️ Error fetching community project tokens: ${err.message}`, { parse_mode: 'Markdown' });
      }
      return;
    }

    if (action === "explore_giddy") {
      console.log(`🌟 Handling explore_giddy callback in chat ${chatId}`);
      await bot.sendMessage(chatId, `${getGreeting(userId, true, chatType)}🚀 *Let's GO!*\n\nDive into GIDDY swaps! Start chatting privately: [t.me/GIDDY_Swap_Bot](https://t.me/GIDDY_Swap_Bot)\n\nAlready in my DMs? No worries - Visit https://giddys.ca`, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      return;
    }

    if (action === "cancel") {
      console.log(`🚪 Handling cancel callback in chat ${chatId}`);
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (err) {
        console.error(`❌ Delete cancel message error: ${err.message}`);
      }
      return;
    }

    if (action === "nickname_settings") {
      console.log(`🔧 Opening nickname settings in chat ${chatId}`);
      await bot.sendMessage(chatId, `${getGreeting(userId, true, chatType)}Make changes to your Trivia Nickname here\\!`, {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [{ text: "Clear Nickname", callback_data: "clear_nickname" }]
          ]
        }
      });
      if (chatType !== 'private') {
        try {
          await bot.deleteMessage(chatId, messageId);
        } catch (err) {
          console.error(`❌ Delete previous message error: ${err.message}`);
          await bot.editMessageText("Nickname settings opened. 👋", {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown'
          });
        }
      }
      return;
    }

    if (action === "chat") {
      console.log(`💬 Handling chat callback in chat ${chatId}`);
      try {
        // Rotate themes randomly for varied output
        const themes = [
          "GIDDY stabletoken swaps",
          "BOUNCY gifts on Solana",
          "Online shopping with GIDDY",
          "GIDDY community trivia",
          "Crypro and tech facts",
        ];
        const themeIndex = Math.floor(Math.random() * themes.length);
        const theme = themes[themeIndex];
        const prompt = `What's the hint of the day? Focus on randomized ${theme} for varied output with a fun, engaging tone and emojis. Keep it under 50 words.`;
        const response = await queryGemma(prompt, chatId, bot);
        await bot.sendMessage(chatId, `${getGreeting(userId, true, chatType)}${response.text.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}`, {
          parse_mode: 'MarkdownV2',
          reply_markup: response.reply_markup || {
            inline_keyboard: [[{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]]
          }
        });
      } catch (err) {
        console.error('Hint generation error:', err);
        // Customizable fallback hints
        const hints = [
          'Check slippage before big Solana swaps—low fees, high speed! DYOR! 🔍',
          'Diversify, but keep GIDDY as your core Solana play! 📊',
          'Protect GIDDY gains with a stop-loss on volatile trades! 🛡️',
          'Monitor Solana’s mempool for faster tx confirmations! ⚡',
          'Join the GIDDY crew for Solana knowledge and trivia! 🤝'
        ];
        // Random selection
        const hintIndex = Math.floor(Math.random() * hints.length);
        let hint = hints[hintIndex];
        // Personalize with user data
        const { firstName } = getCachedUserData({ from: { id: userId, first_name: query.from.first_name } });
        const nick = nicknames.get(userId);
        const useNick = useNickname.get(userId) ?? false;
        const userName = nick && useNick ? nick : firstName || 'User';
        // Add balance-based hint if available
        try {
          const balances = await getBalances();
          if (balances.giddy < 0.1) {
            hints.push(`Low on GIDDY (${balances.giddy.toFixed(2)})? Swap some USDC to join the fun! 💸`);
          } else if (balances.sol < 0.02) {
            hints.push(`SOL balance (${balances.sol.toFixed(6)}) is low—top up for smooth GIDDY swaps! ☀️`);
          }
          // Randomly select from extended hints if applicable
          if (hints.length > 5) {
            hint = hints[Math.floor(Math.random() * hints.length)];
          }
        } catch (balanceErr) {
          console.error('Failed to fetch balances for hint:', balanceErr);
        }
        hint = `Yo ${userName}, here’s a tip: ${hint}`;
        await bot.sendMessage(chatId, `${getGreeting(userId, true, chatType)}💡 Hint of the Day\n\n${hint.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}`, {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [[{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]]
          }
        });
      }
      return;
    }

    if (action === "deposit") {
      console.log(`💰 Handling deposit callback in chat ${chatId}`);
      await bot.sendMessage(chatId, `
${getGreeting(userId, false, chatType)}💸 *Balance Required*
• Minimum: 10.00 USDC
• Send to: \`${wallet.publicKey.toBase58()}\`
• Check your wallet for USDC ATA
🔗 [View on Solscan](https://solscan.io/account/${wallet.publicKey.toBase58()}#portfolio)
      `, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: "Check Balance", callback_data: "balance" }]
          ],
        },
      });
      return;
    }

    if (action === "balance") {
      console.log(`📊 Handling balance callback in chat ${chatId}`);
      const balances = await getBalances();
      await bot.sendMessage(chatId, `
${getGreeting(userId, false, chatType)}📊 *Current Balances*
• 💵 USDC: ${balances.usdc.toFixed(2)}
• 🎢 GIDDY: ${balances.giddy.toFixed(2)}
• ☀️ SOL: ${balances.sol.toFixed(6)}
      `, { parse_mode: "Markdown" });
      console.log("📊 Balances:", balances.usdc.toFixed(6), "USDC,", balances.giddy.toFixed(6), "GIDDY,", balances.sol.toFixed(6), "SOL");
      return;
    }

    if (action === "menu") {
      console.log(`📋 Handling menu callback in chat ${chatId}`);
      await bot.sendMessage(chatId, `${getGreeting(userId, true, chatType)}Welcome to GIDDY_SWAP_BOT 👋 Choose an action:`, { parse_mode: 'Markdown', ...menu });
      return;
    }

    if (action === "start") {
      console.log(`🔁 Handling start callback in chat ${chatId}`);
      if (isSwapping) {
        await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}ℹ️ Swap loop is already running.`, { parse_mode: 'Markdown' });
        return;
      }

      const balances = await getBalances();
      const minAmount = Number(process.env.INITIAL_AMOUNT) || 10;
      const minSol = 0.02;
      const insufficientBalances = [];

      if (balances.sol < minSol) {
        insufficientBalances.push(`• SOL: ${balances.sol.toFixed(6)} (Minimum: ${minSol.toFixed(6)} SOL)`);
      }
      if (Number(balances.usdc.toFixed(2)) < minAmount) {
        insufficientBalances.push(`• USDC: ${balances.usdc.toFixed(2)} (Minimum: ${minAmount.toFixed(2)} USDC)`);
      }

      if (insufficientBalances.length > 0) {
        await bot.sendMessage(chatId, `
${getGreeting(userId, false, chatType)}🔴 *Insufficient Balance*
${insufficientBalances.join('\n')}
        `, { parse_mode: "Markdown" });
        console.log(`🛑 Swap loop cannot start: ${insufficientBalances.join(', ')}`);
        return;
      }

      isSwapping = true;
      currentPhase = process.env.INITIAL_DIRECTION === 'backward' ? 'sell' : 'buy';
      swapLog = [];
      trackedGiddyDelta = 0;
      lastSwapOutAmount = 0;
      await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}🔁 Swap loop started. Starting with: ${currentPhase === 'buy' ? 'USDC → GIDDY' : 'GIDDY → USDC'}`, { parse_mode: 'Markdown' });
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
          await bot.sendMessage(chatId, `
${getGreeting(userId, false, chatType)}🔴 *Insufficient Balance*
• SOL: ${balances.sol.toFixed(6)} (Minimum: ${minSol.toFixed(6)} SOL)
          `, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "💰 Deposit", callback_data: "deposit" }],
                [{ text: "Main Menu", callback_data: "menu" }]
              ],
            },
          });
          console.log("⛔ Swap loop stopped. SOL:", balances.sol.toFixed(6));
          isSwapping = false;
          break;
        }

        if (currentPhase === 'buy' && balances.usdc < minThreshold) {
          await bot.sendMessage(chatId, `
${getGreeting(userId, false, chatType)}🔴 *Insufficient Balance*
• USDC: ${balances.usdc.toFixed(2)} (Minimum: ${minThreshold.toFixed(2)} USDC)
          `, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "💰 Deposit", callback_data: "deposit" }],
                [{ text: "Main Menu", callback_data: "menu" }]
              ],
            },
          });
          console.log("⛔ Swap loop stopped. USDC pre-buy:", balances.usdc.toFixed(6));
          isSwapping = false;
          break;
        }

        const direction = currentPhase === "buy"
          ? { from: USDC_MINT, to: GIDDY_MINT, label: "💸 Buying GIDDY with USDC..." }
          : { from: GIDDY_MINT, to: USDC_MINT, label: "💱 Selling GIDDY back to USDC..." };

        const inputBalance = direction.from.equals(USDC_MINT) ? balances.usdc : balances.giddy;
        let amount;
        let preBalance = direction.to.equals(GIDDY_MINT) ? balances.giddy : balances.usdc;
        let skipReason = null;
        if (direction.from.equals(USDC_MINT)) {
          const maxBuy = Number(process.env.MAX_BUY_USDC || 10) * DECIMALS;
          amount = lastSwapOutAmount > 0 ? Math.min(lastSwapOutAmount * DECIMALS, maxBuy) : Math.min(inputBalance * DECIMALS, maxBuy);
          if (amount < minThreshold * DECIMALS) {
            skipReason = `Insufficient USDC for buy: ${inputBalance.toFixed(6)} (min ${minThreshold})`;
          }
        } else {
          if (trackedGiddyDelta <= 0) {
            skipReason = `No tracked GIDDY to sell (run buy first or invalid delta: ${trackedGiddyDelta.toFixed(6)})`;
          } else {
            console.log(`Sell phase - Input balance: ${inputBalance.toFixed(6)}, Tracked GIDDY delta: ${trackedGiddyDelta.toFixed(6)}`);
            amount = Math.round(trackedGiddyDelta * DECIMALS);
            if (inputBalance < trackedGiddyDelta) {
              skipReason = `Insufficient GIDDY balance: ${inputBalance.toFixed(6)} < ${trackedGiddyDelta.toFixed(6)}`;
            }
          }
        }

        if (skipReason) {
          await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}⚠️ Skipping round ${round}: ${skipReason}`, { parse_mode: 'Markdown' });
          console.log(`⚠️ Skipping round ${round} ${direction.label}: ${skipReason}`);
          currentPhase = currentPhase === "buy" ? "sell" : "buy";
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }

        await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}🔁 Round ${round}: ${direction.label}\n⏳ ${new Date().toLocaleTimeString()}`, { parse_mode: 'Markdown' });
        console.log(`🔁 Round ${round}: ${direction.label} (${(amount / DECIMALS).toFixed(6)})`);

        const prevAmount = inputBalance * DECIMALS;
        let txid, quote, error, fallback, dlmm;
        try {
          ({ txid, quote, error, fallback, dlmm } = await ultraSwap(direction.from, direction.to, amount, chatId));
        } catch (err) {
          if (err.message.includes('Insufficient input')) {
            const match = err.message.match(/Insufficient input: (\d+\.\d+) \(need (\d+\.\d+)\)/);
            const currentBalance = match ? parseFloat(match[1]) : inputBalance;
            const requiredBalance = match ? parseFloat(match[2]) : amount / DECIMALS;
            await bot.sendMessage(chatId, `
${getGreeting(userId, false, chatType)}🔴 *Insufficient Balance*
• USDC: ${currentBalance.toFixed(2)} (Minimum: ${requiredBalance.toFixed(2)} USDC)
• Balance reduction occurred during swap cycle
            `, {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "💰 Deposit", callback_data: "deposit" }],
                  [{ text: "Main Menu", callback_data: "menu" }]
                ],
              },
            });
            console.log(`⛔ Swap loop stopped. USDC: ${currentBalance.toFixed(6)} (need ${requiredBalance.toFixed(6)})`);
            isSwapping = false;
            break;
          }
          await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}❌ Swap failed: Failed to fetch quote from alternate routes: ${err.message}`, { parse_mode: 'Markdown' });
          console.log(`❌ Swap failed: ${err.message}`);
          isSwapping = false;
          break;
        }

        if (quote) {
          const outAmount = quote.outAmount || quote.totalOutputAmount || 'N/A';
          const route = quote.router || (quote.routePlan?.map(step => step.swapInfo?.label || 'Unknown').join(' → ') || 'Unknown');
          const inTicker = direction.from.equals(USDC_MINT) ? 'USDC' : 'GIDDY';
          const outTicker = direction.to.equals(USDC_MINT) ? 'USDC' : 'GIDDY';
          await bot.sendMessage(chatId, `📊 Quote: ${(amount / DECIMALS).toFixed(6)} ${inTicker} → ~${(outAmount / DECIMALS).toFixed(6)} ${outTicker}\n🔀 Route: ${route}`, { parse_mode: 'Markdown' });
          console.log(`📊 Quote: ${(amount / DECIMALS).toFixed(6)} ${inTicker} → ${(outAmount / DECIMALS).toFixed(6)} ${outTicker}`);
          console.log("🔀 Route:", route);
        }

        if (txid) {
          const method = dlmm ? ' (DLMM)' : fallback ? ' (Fallback)' : '';
          await bot.sendMessage(
            chatId,
            `🧾 Swap submitted${method}.\n🔑 Txid: \`${txid}\`\n🔗 [View on Solscan](https://solscan.io/tx/${txid})`,
            { parse_mode: "Markdown" }
          );
          console.log(`✅ Round ${round} Txid:`, txid);
          await decodeSwap(txid, chatId);

          const mintToCheck = direction.to;
          const postBalance = await waitForBalanceChange(mintToCheck, preBalance, direction, chatId, quote);
          const delta = postBalance - preBalance;
          if (direction.from.equals(USDC_MINT)) {
            console.log(`Pre-buy trackedGiddyDelta: ${trackedGiddyDelta.toFixed(6)}`);
            trackedGiddyDelta = delta > 0 ? delta : (quote ? (quote.outAmount || quote.totalOutputAmount || 0) / DECIMALS : 0);
            console.log(`Post-buy trackedGiddyDelta: ${trackedGiddyDelta.toFixed(6)}`);
            trackedGiddyDelta = Number(trackedGiddyDelta.toFixed(6));
            lastSwapOutAmount = quote ? (quote.outAmount || quote.totalOutputAmount || 0) / DECIMALS : 0;
            console.log(`Tracked GIDDY delta from buy: ${trackedGiddyDelta.toFixed(2)}`);
          } else {
            console.log(`Pre-sell trackedGiddyDelta: ${trackedGiddyDelta.toFixed(6)}`);
            trackedGiddyDelta = 0;
            lastSwapOutAmount = quote ? (quote.outAmount || quote.totalOutputAmount || 0) / DECIMALS : 0;
            console.log(`Post-sell trackedGiddyDelta: ${trackedGiddyDelta.toFixed(6)}`);
          }

          const outAmount = quote ? (quote.outAmount || quote.totalOutputAmount || 0) : 0;
          const loss = prevAmount - outAmount;
          swapLog.push({
            round,
            direction: currentPhase,
            amountIn: (amount / DECIMALS).toFixed(6),
            amountOut: (outAmount / DECIMALS).toFixed(6),
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
            await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}⚠️ Round ${round} failed, retrying (${retryCount}/${maxRetries})...\nError: Failed to fetch quote from alternate routes: ${error || 'Unknown'}`, { parse_mode: 'Markdown' });
            console.log(`⚠️ Round ${round} Retry ${retryCount}/${maxRetries}: ${error}`);
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }
          await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}⛔ Swap loop stopped due to repeated failures: Failed to fetch quote from alternate routes`, { parse_mode: 'Markdown' });
          console.log(`⛔ Swap loop stopped after ${maxRetries} retries: ${error}`);
          isSwapping = false;
          break;
        }
      }

      const logPath = `swaps/swap_session_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      await fs.writeFile(logPath, JSON.stringify(swapLog, null, 2));
      await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}📝 Session log saved: ${logPath} (${swapLog.length} rounds)`, { parse_mode: 'Markdown' });
      return;
    }

    if (action === "stop") {
      console.log(`⛔ Handling stop callback in chat ${chatId}`);
      if (!isSwapping) {
        await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}ℹ️ Swap loop is not running.`, { parse_mode: 'Markdown' });
        return;
      }

      isSwapping = false;
      await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}⛔ Swap loop stopped.`, { parse_mode: 'Markdown' });
      console.log("⛔ Swap loop stopped.");
      return;
    }

    // Nickname Settings Handler
    if (action === "nickname_settings") {
      console.log(`🔧 Opening nickname settings in chat ${chatId}`);
      await bot.sendMessage(chatId, `${getGreeting(userId, true, chatType)}Make changes to your Trivia Nickname here\\!`, {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [{ text: "Clear Nickname", callback_data: "clear_nickname" }],
            [{ text: "Cancel", callback_data: "cancel" }]
          ]
        }
      });
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (err) {
        console.error(`❌ Delete previous message error: ${err.message}`);
        await bot.editMessageText("Nickname settings opened. 👋", {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        });
      }
      return;
    }

    if (action === "clear_nickname") {
      console.log(`🗑️ Handling clear_nickname callback in chat ${chatId}`);
      nicknames.delete(userId);
      useNickname.delete(userId);
      awaitingNicknameToggle.delete(userId);
      await saveUserData(userId);
      await bot.sendMessage(chatId, `${getGreeting(userId, true, chatType)}Your nickname has been cleared\\! I'll use *${(query.from.first_name || "User").replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}* now\\ 😊`, {
        parse_mode: 'MarkdownV2'
      });
      if (chatType !== 'private') {
        try {
          await bot.deleteMessage(chatId, messageId);
        } catch (err) {
          console.error(`❌ Delete clear_nickname message error: ${err.message}`);
          await bot.editMessageText("Nickname cleared. 👋", {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown'
          });
        }
      }
      return;
    }
    console.error(`❌ Unhandled callback action "${action}" in chat ${chatId}`);
    await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}⚠️ Action "${action}" not recognized—try again or /start.`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error(`❌ Callback handler error for action "${action}" in chat ${chatId}:`, err.message);
    if (!err.message.includes('query is too old')) {
      await bot.sendMessage(chatId, `${getGreeting(userId, false, chatType)}⚠️ Action "${action}" failed—try again or /start.`, { parse_mode: 'Markdown' });
    }
  }
});

// Export extractSearchTerm for gemma.js
export function extractSearchTerm(lowerText) {
  const stopWords = new Set(['the', 'for', 'of', 'a', 'an', 'in', 'on', 'to', 'with', 'by', 'and', 'or', 'but', 'is', 'are', 'can', 'you', 'find', 'what', 'how', 'do', 'does', 'today', 'check', 'what’s', 'whats', 'what is', 'perfect', 'awesome', 'great', 'right', 'tag', 'paying', 'worth', 'hard', 'tired', 'worked', 'now']);
  const botUsername = '@giddy_swap_bot';
  const botUsernameNoAt = 'giddy_swap_bot';

  const keywords = [
    { term: 'contract address', length: 15 },
    { term: 'token contract', length: 13 },
    { term: 'ca', length: 2 },
    { term: 'contract', length: 8 },
    { term: 'price', length: 5 },
    { term: 'coingecko', length: 9 },
  ];

  let cleanedText = lowerText
    .replace(/['’]/g, '')
    .replace(new RegExp(`\\s*\\b${botUsername}\\b\\s*|\\s*\\b${botUsernameNoAt}\\b\\s*|\\s*@\\s*`, 'gi'), ' ')
    .replace(/@\w+$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  console.log(`🔍 Cleaned text after mention removal: "${cleanedText}"`);

  const normalizedText = cleanedText.replace(/[\u{1D400}-\u{1D7FF}]/gu, c =>
    String.fromCharCode(c.charCodeAt(0) - 0x1D400 + 0x0041)
  );

  let keywordIndex = Infinity;
  let keywordLength = 0;
  let matchedKeyword = '';
  const caRegex = /\bca\b|\bca$/;
  for (const keyword of keywords) {
    let index;
    if (keyword.term === 'ca') {
      const match = normalizedText.match(caRegex);
      index = match ? match.index : -1;
    } else if (keyword.term === 'price') {
      const priceRegex = /pric[e]?/i;
      const match = normalizedText.match(priceRegex);
      index = match ? match.index : -1;
      if (index !== -1) keywordLength = match[0].length;
    } else {
      index = normalizedText.indexOf(keyword.term);
    }
    if (index !== -1 && index < keywordIndex) {
      keywordIndex = index;
      keywordLength = keyword.term.length;
      matchedKeyword = keyword.term;
    }
  }

  let candidateText = '';
  let isLikelyIdiomatic = false;
  if (keywordIndex === Infinity) {
    const words = normalizedText.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '').toLowerCase()).filter(w => w && !stopWords.has(w));
    return { term: words.slice(-2).join(' ') || '', keyword: '', isLikelyIdiomatic: false };
  }

  if (keywordIndex + keywordLength < normalizedText.length) {
    const after = normalizedText.substring(keywordIndex + keywordLength).trim();
    const afterWords = after.split(/\s+/).slice(0, 3).map(w => w.replace(/[^a-z0-9]/g, '').toLowerCase()).filter(w => w.length > 2);
    candidateText = afterWords.slice(0, 2).join(' ');
    candidateText = candidateText.split(/\s+/).filter(w => !stopWords.has(w)).join(' ');
  }

  if (!candidateText) {
    const before = normalizedText.substring(0, keywordIndex).trim();
    const beforeWords = before.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '').toLowerCase()).filter(w => w && !stopWords.has(w) && w.length > 2);
    candidateText = beforeWords.slice(-3).join(' ');
  }

  if (matchedKeyword === 'price') {
    const idiomaticPhrases = [
      'paying the', 'at a', 'worth the', 'high price', 'low price', 'price tag', 'is right', 'the right', 'too high', 'a steep',
      'cut the', 'raise the', 'set the', 'name your', 'pay the', 'worked hard', 'very tired'
    ];
    isLikelyIdiomatic = idiomaticPhrases.some(phrase => normalizedText.includes(phrase));

    const commonEnglishTerms = new Set(['tag', 'cut', 'high', 'low', 'steep', 'name', 'hard', 'tired']);
    if (candidateText.length < 6 && commonEnglishTerms.has(candidateText.split(' ')[0]) && !candidateText.match(/^[A-Z]+$/)) {
      isLikelyIdiomatic = true;
    }

    if (normalizedText.includes('paying') && normalizedText.includes('price') && Math.abs(normalizedText.indexOf('paying') - keywordIndex) < 20) {
      isLikelyIdiomatic = true;
    }

    const tickerRegex = /\b[A-Z]{3,5}\b/g;
    const contextAround = normalizedText.substring(Math.max(0, keywordIndex - 15), keywordIndex + 15);
    const tickersNear = contextAround.match(tickerRegex);
    if (tickersNear && tickersNear.length > 0) {
      isLikelyIdiomatic = false;
      console.log(`🔍 Ticker override: Found "${tickersNear.join(', ')}" near "price" – treating as query`);
    }

    if (isLikelyIdiomatic) {
      console.log(`🔍 Detected idiomatic "price" context in full text: "${normalizedText.substring(0, 50)}..." – treating as conversation`);
      matchedKeyword = '';
      candidateText = '';
    }
  }

  if (matchedKeyword === 'ca') {
    const wordsBeforeCa = normalizedText.substring(0, normalizedText.lastIndexOf('ca')).trim().split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '').toLowerCase()).filter(w => w && !stopWords.has(w));
    if (wordsBeforeCa.length > 0) {
      candidateText = wordsBeforeCa.slice(-2).join(' ');
    }
  }

  console.log(`🔍 Extracted term: "${candidateText}" (keyword: "${matchedKeyword}", idiomatic: ${isLikelyIdiomatic})`);

  return { term: candidateText || '', keyword: matchedKeyword, isLikelyIdiomatic };
}

bot.on('message', async (msg) => {
  if (!msg.text) return;
  const { userId, firstName, chatId } = getCachedUserData(msg);
  const text = msg.text.trim();
  if (text.startsWith('/')) return;

  const lowerText = text.toLowerCase();
  const potentialNick = extractNickname(text);
  if (potentialNick && !awaitingNicknameToggle.get(userId)) {
    if (potentialNick === 'CLEAR_NICKNAME') {
      nicknames.delete(userId);
      useNickname.delete(userId);
      awaitingNicknameToggle.delete(userId);
      await saveUserData(userId);
      return bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}Your nickname has been cleared\\! I'll use *${firstName.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}* now\\. 😊`, {
        parse_mode: 'MarkdownV2'
      });
    }
    if (isProfane(potentialNick)) {
      return bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}Sorry, that nickname has some spicy words\\! 🌶 Let's keep it clean\\! Try another\\. 😊`, {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [{ text: "Clear Nickname", callback_data: "clear_nickname" }]
          ]
        }
      });
    }
    nicknames.set(userId, potentialNick);
    await saveUserData(userId);
    awaitingNicknameToggle.set(userId, true);
    return bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}Got it, *${potentialNick.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}*\\! Want me to use this nickname in chats\\? Reply 'yes' or 'no'\\! 😊`, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [{ text: "Clear Nickname", callback_data: "clear_nickname" }]
        ]
      }
    });
  }

  if (awaitingNicknameToggle.get(userId)) {
    const lowerReply = text.toLowerCase().trim();
    const cleanedReply = lowerReply.replace(/!$/, '');
    const yesVariants = ['yes', 'y', 'yeah', 'yup', 'yep', 'sure', 'ok', 'okay', 'aye'];
    const noVariants = ['no', 'n', 'nah', 'nope', 'negative', 'nay'];

    if (yesVariants.includes(cleanedReply)) {
      useNickname.set(userId, true);
      await saveUserData(userId);
      const nick = nicknames.get(userId);
      bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}Awesome\\! I'll use *${nick.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}* from now on\\! ✨ Say "call me [new name]" to update\\ 🚀`, {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [{ text: "Clear Nickname", callback_data: "clear_nickname" }]
          ]
        }
      });
    } else if (noVariants.includes(cleanedReply)) {
      useNickname.set(userId, false);
      await saveUserData(userId);
      bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}No worries—I'll stick with *${firstName.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}*\\! Change it later with "call me [new name]" \\! 🤩`, {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [{ text: "Clear Nickname", callback_data: "clear_nickname" }]
          ]
        }
      });
    } else {
      bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}🤔 Just reply with 'yes' or 'no' \\(or yeah/nah DEGEN vibes\\)\\!`, {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [{ text: "Clear Nickname", callback_data: "clear_nickname" }]
          ]
        }
      });
      return;
    }
    awaitingNicknameToggle.delete(userId);
    return;
  }

  if (isNameComplaint(text)) {
    nicknames.delete(userId);
    useNickname.delete(userId);
    awaitingNicknameToggle.delete(userId);
    await saveUserData(userId);
    return bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}Oops, my bad\\! Nickname cleared\\. Back to *${firstName.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}*—or set a new one with "call me [new name]"\\! 🎉`, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [{ text: "Clear Nickname", callback_data: "clear_nickname" }]
        ]
      }
    });
  }

  // UPDATED: Handle "recall name" queries (per-user, natural/single-use)
  if (lowerText.includes('my name') || lowerText.includes('recall name') || lowerText.includes('whats my name')) {
    const nick = nicknames.get(userId);
    const useIt = useNickname.get(userId) ?? false;
    let recallMsg;
    if (nick && useIt) {
      recallMsg = `You're going by *${nick.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}* right now\\! 😎 To update: Just say "call me [new name]"\\.`;
    } else if (nick) {
      recallMsg = `Your Telegram name is *${firstName.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}*, but you've set *${nick.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}* 😎 To update: Just say "call me [new name]"\\ 🚀`;
    } else {
      recallMsg = `Your name is *${firstName.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}*\\ ! Set a nickname with "call me [new name]"\\! 🚀`;
    }
    recallMsg += ` Wanna swap some GIDDY\\? 🚀`;
    await bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}${recallMsg}`, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [{ text: "Clear Nickname", callback_data: "clear_nickname" }]
        ]
      }
    });
    return;
  }

  let hasMention = false;
  let isReplyToBot = false;
  let isTaggingOtherUser = false;

  // Check for bot mention and reply status in group chats
  if (msg.chat.type !== 'private') {
    const botUsername = '@GIDDY_Swap_Bot';
    hasMention = msg.entities && msg.entities.some(entity =>
      entity.type === 'mention' && entity.text && entity.text.toLowerCase() === botUsername.toLowerCase()
    );
    if (!hasMention) {
      hasMention = text.toLowerCase().includes(botUsername.toLowerCase());
    }
    isReplyToBot = msg.reply_to_message && msg.reply_to_message.from &&
      msg.reply_to_message.from.is_bot && msg.reply_to_message.from.username &&
      msg.reply_to_message.from.username.toLowerCase() === 'giddy_swap_bot';

    if (isReplyToBot) {
      isTaggingOtherUser = msg.entities && msg.entities.some(entity =>
        entity.type === 'mention' && entity.text && !entity.text.toLowerCase().includes('giddy_swap_bot')
      );
      if (!isTaggingOtherUser) {
        const otherMentions = text.match(/@[a-zA-Z0-9_]+/g) || [];
        isTaggingOtherUser = otherMentions.some(mention =>
          mention.toLowerCase() !== botUsername.toLowerCase()
        );
      }
    }

    // Check for @nickname or @username mentions
    const mentions = text.match(/@[a-zA-Z0-9_]+/g) || [];
    if (mentions.length > 0) {
      const userNick = nicknames.get(userId);
      const userName = userNames.get(userId) || firstName;
      const usernameMatch = mentions.some(mention => mention.toLowerCase() === `@${userName.toLowerCase()}`);
      const nicknameMatch = userNick && mentions.some(mention => mention.toLowerCase() === `@${userNick.toLowerCase()}`);
      if (usernameMatch || nicknameMatch) {
        hasMention = true;
        console.log(`🔍 Detected @nickname or @username mention for user ${userId}: ${usernameMatch ? '@username' : '@nickname'}`);
      }
    }

    if (!hasMention && !(isReplyToBot && !isTaggingOtherUser)) {
      console.log(`👥 Ignored group message (no mention/reply-to-bot-or-tagging-other): "${text.substring(0, 50)}..."`);
      return;
    }
  }

  // Log the original message for debugging
  console.log(`📥 Received: "${text}" in chat ${chatId}`);

  // Extract search term and keyword after cleaning
  const { term: searchTerm, keyword, isLikelyIdiomatic } = extractSearchTerm(lowerText);

  const isPriceQuery = keyword === 'price' && !isLikelyIdiomatic;
  const isContractQuery = ['contract address', 'token contract', 'ca'].includes(keyword);
  const isCoinGeckoQuery = keyword === 'coingecko';
  let queryHandled = false;

  console.log(`🔍 If debug: isPrice=${isPriceQuery}, isContract=${isContractQuery}, term="${searchTerm}", idiomatic=${isLikelyIdiomatic}, pending=${pendingQueries.has(chatId)}`);

  // Process price, contract, or coingecko queries
  if ((isPriceQuery || isContractQuery || isCoinGeckoQuery) && searchTerm && !pendingQueries.has(chatId)) {
    console.log(`${isPriceQuery ? '💰 Price' : isContractQuery ? '📜 Contract' : '🔗 CoinGecko'} keyword detected in chat ${chatId}: "${text}"`);

    let coinInfo = null;
    let multipleMatches = [];

    // Route 1: Local (coinMap) exact/alias match
    coinInfo = getCoinInfo(searchTerm.toLowerCase());
    if (coinInfo) {
      console.log(`🗺️ Local-matched "${searchTerm}" to coin: ${JSON.stringify(coinInfo)}`);
    } else {
      // Route 2: Phrase Lookup in CoinGecko Cache
      const phraseWords = searchTerm.split(/\s+/).filter(w => w.length > 1);
      let phraseMatches = [];
      if (phraseWords.length > 1) {
        phraseMatches = coinCache.filter(c =>
          c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          c.symbol.toLowerCase().includes(searchTerm.toLowerCase())
        );
        if (phraseMatches.length === 0) {
          phraseMatches = coinCache.filter(c =>
            phraseWords.every(word => c.name.toLowerCase().includes(word) || c.symbol.toLowerCase().includes(word))
          );
        }
      }
      if (phraseMatches.length > 0) {
        const topMatch = phraseMatches.sort((a, b) => (b.market_cap_rank || 9999) - (a.market_cap_rank || 9999))[0];
        coinInfo = { ticker: topMatch.symbol.toUpperCase(), id: topMatch.id, name: topMatch.name };
        console.log(`🔍 Phrase-matched "${searchTerm}" (via ${phraseWords.length} words) to ${topMatch.name} (${topMatch.symbol}/${topMatch.id})`);
        if (phraseMatches.length > 1) multipleMatches = phraseMatches.slice(0, 3);
      } else if (coinCache && searchTerm) {
        // Route 3: Single-word Cache
        const lowerSearch = searchTerm.toLowerCase();
        const upperSearch = searchTerm.toUpperCase();
        let matches = coinCache.filter(c => c.symbol.toLowerCase() === lowerSearch || c.symbol === upperSearch || c.id === lowerSearch);
        if (matches.length === 0) {
          matches = coinCache.filter(c => c.name.toLowerCase().includes(lowerSearch));
        }
        if (matches.length === 1) {
          const match = matches[0];
          coinInfo = { ticker: match.symbol.toUpperCase(), id: match.id, name: match.name };
          console.log(`🔍 Single-matched "${searchTerm}" to ${match.name} (${match.symbol}/${match.id})`);
        } else if (matches.length > 1) {
          multipleMatches = matches.sort((a, b) => (b.market_cap_rank || 9999) - (a.market_cap_rank || 9999)).slice(0, 3);
        }
      }

      // Step 1: CoinGecko cache for non-coins.js matches
      if (!coinInfo && coinCache && searchTerm) {
        const lowerSearch = searchTerm.toLowerCase();
        const upperSearch = searchTerm.toUpperCase();
        let matches = coinCache.filter(c => c.symbol.toLowerCase() === lowerSearch || c.symbol === upperSearch || c.id === lowerSearch);
        console.log(`🔍 Cache exact matches for "${lowerSearch}": ${matches.length}`);
        if (matches.length === 0) {
          matches = coinCache.filter(c => c.name.toLowerCase().includes(lowerSearch));
          console.log(`🔍 Cache name matches for "${lowerSearch}": ${matches.length}`);
        }

        // Dynamic preferred logic for all terms
        const getPreferredId = (search) => {
          const knownOfficials = {
            'TRUMP': 'official-trump',
            'PUMP': 'pump-fun',
            'JUP': 'jupiter',
          };
          return knownOfficials[search.toUpperCase()] || null;
        };

        if (matches.length > 0 && matches.length <= 3) {
          const preferredId = getPreferredId(upperSearch);
          const officialMatch = preferredId ? matches.find(c => c.id === preferredId) : null;
          const match = officialMatch || matches.sort((a, b) => (b.market_cap_rank || 9999) - (a.market_cap_rank || 9999))[0];
          coinInfo = { ticker: match.symbol.toUpperCase(), id: match.id, name: match.name };
          console.log(`🔍 Auto-matched top result for "${searchTerm}" to ${match.name} (${match.symbol}/${match.id})`);
        } else if (matches.length > 3) {
          const preferredId = getPreferredId(upperSearch);
          let topMatches = matches.sort((a, b) => (b.market_cap_rank || 9999) - (a.market_cap_rank || 9999)).slice(0, 3);
          if (preferredId) {
            const preferredMatch = matches.find(c => c.id === preferredId);
            if (preferredMatch) {
              topMatches = [preferredMatch, ...topMatches.filter(m => m.id !== preferredId).slice(0, 2)];
              console.log(`🔍 Preferred override: Inserted "${preferredId}" as #1 for "${upperSearch}"`);
            }
          }
          multipleMatches = topMatches;
        }
      }

      // Step 2: Handle multiple matches
      if (multipleMatches.length > 0) {
        const options = multipleMatches.map((match) => [
          {
            text: `${(match.symbol || match.ticker || 'UNKNOWN').toUpperCase()} - ${match.name || match.symbol || match.id || 'No Name'}${match.id === 'jupiter' ? ' (Official DEX)' : ''}`,
            callback_data: `${isPriceQuery ? 'price_select' : 'contract_select'}:${match.id || match.contractAddress || match.address}`
          }
        ]);
        options.push([{ text: "Cancel", callback_data: "cancel" }]);
        await bot.sendMessage(chatId, `${getGreeting(userId, false, msg.chat.type)}Multiple coins match "${searchTerm}"\\! Which one\\? \\(Top Picks\\)`, {
          parse_mode: "MarkdownV2",
          reply_markup: { inline_keyboard: options }
        });
        pendingQueries.set(chatId, { timestamp: Date.now(), type: isPriceQuery ? 'price_selection' : 'contract_selection' });
        setTimeout(() => pendingQueries.delete(chatId), 30000);
        console.log(`🔍 Prompted selection for ${multipleMatches.length} matches on "${searchTerm}"`);
        queryHandled = true;
        return;
      }
    }

    // Step 3: Handle CoinGecko link query
    if (coinInfo && isCoinGeckoQuery) {
      try {
        let response = `🔗 [View on CoinGecko](https://www.coingecko.com/en/coins/${coinInfo.id})\\n\\nWant to swap some GIDDY\\? 💱`;
        if (!coinInfo.id) {
          response = `No CoinGecko link available for ${coinInfo.ticker}\\. Try searching:\\n🔗 [CoinGecko Search](https://www.coingecko.com/en/search?q=${coinInfo.ticker})\\n\\nWant to swap some GIDDY\\? 💱`;
        }
        await bot.sendMessage(chatId, `${getGreeting(userId, false, msg.chat.type)}${response}`, {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]
            ]
          }
        });
        console.log(`✅ Sent CoinGecko link for ${coinInfo.ticker}: ${coinInfo.id ? `https://www.coingecko.com/en/coins/${coinInfo.id}` : 'search link'}`);
        pendingQueries.set(chatId, { timestamp: Date.now(), type: 'coingecko' });
        setTimeout(() => pendingQueries.delete(chatId), 10000);
        queryHandled = true;
        return;
      } catch (err) {
        console.error(`❌ CoinGecko link error for ${coinInfo.ticker}: ${err.message}`);
        let response = `Oops, couldn't generate CoinGecko link for ${coinInfo.ticker}\\. Try:\\n🔗 [CoinGecko Search](https://www.coingecko.com/en/search?q=${coinInfo.ticker})\\n\\nWant to swap some GIDDY\\? 💱`;
        await bot.sendMessage(chatId, `${getGreeting(userId, false, msg.chat.type)}${response}`, {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]
            ]
          }
        });
        queryHandled = true;
        return;
      }
    }

    // Step 4: Handle price or contract query
    if (coinInfo) {
      try {
        if (isPriceQuery) {
          console.log(`💰 Fetching price for ${coinInfo.id || coinInfo.ticker}...`);
          let priceInfo = await fetchCoinPrice(coinInfo.id, coinInfo.contractAddress);
          let source = 'CoinGecko';

          if (!priceInfo && coinInfo.contractAddress && isValidSolanaAddress(coinInfo.contractAddress)) {
            priceInfo = await fetchGeckoTerminalPrice(coinInfo.contractAddress);
            source = priceInfo ? 'GeckoTerminal' : source;
          }
          if (!priceInfo && coinInfo.contractAddress && isValidSolanaAddress(coinInfo.contractAddress)) {
            priceInfo = await fetchDexScreenerPrice(coinInfo.contractAddress);
            source = priceInfo ? 'DexScreener' : source;
          }

          if (priceInfo) {
            let response = `Price for ${coinInfo.ticker}: ${priceInfo.priceStr.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')} \\(Source: ${source}\\)`;
            if (coinInfo.id) {
              response += `\n🔗 [View on CoinGecko](https://www.coingecko.com/en/coins/${coinInfo.id})`;
            }
            if (isValidSolanaAddress(coinInfo.contractAddress)) {
              response += `\n🔗 [View on Solscan](https://solscan.io/token/${coinInfo.contractAddress})`;
            }
            response += `\n\nWant to swap some GIDDY\\? 💱`;
            response += `\n\n✨ Fun fact from OFiDCrypt\\! ${companyData.funFacts[0].replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')} 😏`;
            await bot.sendMessage(chatId, `${getGreeting(userId, false, msg.chat.type)}${response}`, {
              parse_mode: 'MarkdownV2',
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]
                ]
              }
            });
          } else {
            let response = `Couldn't fetch price for ${coinInfo.ticker}\\. Try searching on CoinGecko.`;
            if (coinInfo.id) {
              response += `\n🔗 [View on CoinGecko](https://www.coingecko.com/en/coins/${coinInfo.id})`;
            } else if (isValidSolanaAddress(coinInfo.contractAddress)) {
              response += `\n🔗 [View on GeckoTerminal](https://www.geckoterminal.com/solana/tokens/${coinInfo.contractAddress})`;
            } else {
              response += `\n🔗 [CoinGecko Search](https://www.coingecko.com/en/search?q=${coinInfo.ticker})`;
            }
            response += `\n\nWant to swap some GIDDY\\? 💱`;
            await bot.sendMessage(chatId, `${getGreeting(userId, false, msg.chat.type)}${response}`, {
              parse_mode: 'MarkdownV2',
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]
                ]
              }
            });
            console.log(`❌ Price fetch failed for ${coinInfo.ticker}, sent CoinGecko/GeckoTerminal info`);
            queryHandled = true;
          }
        } else if (isContractQuery) {
          console.log(`📜 Fetching contract for ${coinInfo.id || coinInfo.ticker}...`);
          let contractInfo = await fetchContractAddress(coinInfo.id, coinInfo.contractAddress);
          let source = contractInfo ? contractInfo.source : 'None';

          if (!contractInfo || !isValidSolanaAddress(contractInfo.contract)) {
            contractInfo = await fetchGeckoTerminalContract(coinInfo.id || coinInfo.ticker);
            source = contractInfo ? 'GeckoTerminal' : source;
          }
          if (!contractInfo || !isValidSolanaAddress(contractInfo.contract)) {
            contractInfo = await fetchDexScreenerContract(coinInfo.id || coinInfo.ticker);
            source = contractInfo ? 'DexScreener' : source;
          }

          let response;
          if (contractInfo && isValidSolanaAddress(contractInfo.contract)) {
            response = `Contract details for ${coinInfo.ticker}:\n\`${contractInfo.contract}\` \\(${contractInfo.chain}\\)\\n🔗 [View on Solscan](https://solscan.io/token/${contractInfo.contract})\\n\\nWant to swap some GIDDY\\? 💱`;
            response += `\n\n✨ Fun fact from OFiDCrypt\\! ${companyData.funFacts[1].replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')} 😏`;
            console.log(`✅ Contract fetched for ${coinInfo.ticker}: ${contractInfo.contract} (${source})`);
          } else {
            response = `Contract details for ${coinInfo.ticker}:\nNo Solana contract found\\.`;
            if (coinInfo.id) {
              response += `\n🔗 [View on CoinGecko](https://www.coingecko.com/en/coins/${coinInfo.id})`;
            } else {
              response += `\n🔗 [CoinGecko Search](https://www.coingecko.com/en/search?q=${coinInfo.ticker})`;
            }
            response += `\n\\nWant to swap some GIDDY\\? 💱`;
            console.log(`❌ No Solana contract for ${coinInfo.ticker}, sent CoinGecko link`);
          }
          await bot.sendMessage(chatId, `${getGreeting(userId, false, msg.chat.type)}${response}`, {
            parse_mode: 'MarkdownV2',
            reply_markup: {
              inline_keyboard: [
                [{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]
              ]
            }
          });
          queryHandled = true;
        }
        pendingQueries.set(chatId, { timestamp: Date.now(), type: isPriceQuery ? 'price' : 'contract' });
        setTimeout(() => pendingQueries.delete(chatId), 10000);
        return;
      } catch (err) {
        console.error(`❌ ${isPriceQuery ? 'Price' : 'Contract'} handling error for ${coinInfo.ticker}: ${err.message}`);
        let response = `Oops, couldn't grab ${coinInfo.ticker} ${isPriceQuery ? 'price' : 'contract'} right now\\.`;
        if (coinInfo.id) {
          response += `\n🔗 [View on CoinGecko](https://www.coingecko.com/en/coins/${coinInfo.id})`;
        } else if (isValidSolanaAddress(coinInfo.contractAddress)) {
          response += `\n🔗 [View on Solscan](https://solscan.io/token/${coinInfo.contractAddress})`;
        } else {
          response += `\n🔗 [CoinGecko Search](https://www.coingecko.com/en/search?q=${coinInfo.ticker})`;
        }
        response += `\n\nWant to swap some GIDDY\\? 💱`;
        await bot.sendMessage(chatId, `${getGreeting(userId, false, msg.chat.type)}${response}`, {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]
            ]
          }
        });
        console.log(`❌ Sent fallback response for ${coinInfo.ticker}`);
        pendingQueries.set(chatId, { timestamp: Date.now(), type: isPriceQuery ? 'price' : 'contract' });
        setTimeout(() => pendingQueries.delete(chatId), 10000);
        queryHandled = true;
        return;
      }
    } else {
      // Handle contract address directly in price or contract query
      const contractMatch = text.replace(/@giddy_swap_bot/gi, '').trim().match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
      if (contractMatch && isValidSolanaAddress(contractMatch[0])) {
        try {
          if (isPriceQuery) {
            let priceInfo = await fetchGeckoTerminalPrice(contractMatch[0]);
            let source = 'GeckoTerminal';
            if (!priceInfo) {
              priceInfo = await fetchDexScreenerPrice(contractMatch[0]);
              source = 'DexScreener';
            }
            if (priceInfo) {
              let response = `Price for token at \`${contractMatch[0]}\` \\(Solana\\): ${priceInfo.priceStr.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')} \\(Source: ${source}\\)\\n🔗 [View on Solscan](https://solscan.io/token/${contractMatch[0]})\\n\\nWant to swap some GIDDY\\? 💱`;
              response += `\n\n✨ Fun fact from OFiDCrypt\\! ${companyData.funFacts[2].replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1')} 😏`;
              await bot.sendMessage(chatId, `${getGreeting(userId, false, msg.chat.type)}${response}`, {
                parse_mode: 'MarkdownV2',
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]
                  ]
                }
              });
              console.log(`✅ Price fetched for contract ${contractMatch[0]} via ${source}`);
              pendingQueries.set(chatId, { timestamp: Date.now(), type: 'price' });
              setTimeout(() => pendingQueries.delete(chatId), 10000);
              queryHandled = true;
              return;
            }
          } else if (isContractQuery) {
            let contractInfo = await fetchGeckoTerminalContract(contractMatch[0]);
            let source = 'GeckoTerminal';
            if (!contractInfo) {
              contractInfo = await fetchDexScreenerContract(contractMatch[0]);
              source = 'DexScreener';
            }
            if (contractInfo) {
              let response = `Contract details for token at \`${contractInfo.contract}\` \\(Solana\\):\\n\`${contractInfo.contract}\` \\(${contractInfo.chain}\\)\\n🔗 [View on Solscan](https://solscan.io/token/${contractInfo.contract})\\n\\nWant to swap some GIDDY\\? 💱`;
              await bot.sendMessage(chatId, `${getGreeting(userId, false, msg.chat.type)}${response}`, {
                parse_mode: 'MarkdownV2',
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]
                  ]
                }
              });
              console.log(`✅ Contract fetched for ${contractMatch[0]} via ${source}`);
              pendingQueries.set(chatId, { timestamp: Date.now(), type: 'contract' });
              setTimeout(() => pendingQueries.delete(chatId), 10000);
              queryHandled = true;
              return;
            }
          }
        } catch (err) {
          console.error(`❌ Fallback ${isPriceQuery ? 'price' : 'contract'} error for ${contractMatch[0]}: ${err.message}`);
        }
      }

      // Only send fallback if no valid coin or contract address was found
      if ((isPriceQuery || isContractQuery) && searchTerm) {
        console.log(`❌ No valid coin extracted for ${isPriceQuery ? 'price' : 'contract'} query in chat ${chatId}`);
        let response = `Token "${searchTerm}" not found\\. Try searching on these platforms:\\n🔗 [CoinGecko Search](https://www.coingecko.com/en/search?q=${encodeURIComponent(searchTerm)})\\n🔗 [GeckoTerminal](https://www.geckoterminal.com/solana/tokens/${encodeURIComponent(searchTerm)})\\n\\nWant to swap some GIDDY\\? 💱`;
        await bot.sendMessage(chatId, `${getGreeting(userId, false, msg.chat.type)}${response}`, {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]
            ]
          }
        });
        console.log(`📥 Non-price/contract/coingecko query: "${text}" in chat ${chatId}, sent fallback response`);
        queryHandled = true;
        return;
      }
    }
  }

  // Handle conversational queries with Gemma
  if (!queryHandled) {
    console.log(`📥 Non-price/contract/coingecko query: "${text}" in chat ${chatId}, sending to Gemma`);
    try {
      const isNicknameQuery = lowerText.includes('nickname') || lowerText.includes('name change') || lowerText.includes('call me');
      const response = await queryGemma(text, chatId, bot);
      let safeText = response.text.trim();
      if (safeText.length > 4000) {
        const lastPunct = safeText.lastIndexOf('.') > safeText.lastIndexOf('?') ? safeText.lastIndexOf('.') : safeText.lastIndexOf('?');
        if (lastPunct > 2000) {
          safeText = safeText.substring(0, lastPunct + 1).trim() + '\\n\\n\\(Continued response truncated—ask for more\\!\\)';
        } else {
          safeText = safeText.substring(0, 4000) + '\\n\\n... \\(response shortened for brevity\\)';
        }
        console.log(`🔧 Truncated Gemma response from ${response.text.length} to ${safeText.length} chars`);
      }

      safeText = safeText
        .replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1');

      if (isLikelyIdiomatic) {
        safeText += '\\n\\n\\(Detected casual chat—reply "SOL price" for real-time info\\! 🚀\\)';
      }

      const prefix = getGreeting(userId, true, msg.chat.type);
      if (prefix) {
        const strippedText = stripLeadingGreeting(safeText, isNicknameQuery);
        safeText = strippedText !== null ? strippedText : safeText;
        console.log(`🔧 Greeting stripped: "${safeText.substring(0, 50)}..." (original: "${response.text.substring(0, 50)}...")`);
      }

      await bot.sendMessage(chatId, `${prefix}${safeText}`, {
        parse_mode: 'MarkdownV2',
        reply_markup: response.reply_markup || {
          inline_keyboard: [[{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }]]
        }
      });
      console.log(`✅ Gemma response sent for "${text}" (menu attached: true)`);
    } catch (err) {
      console.error(`❌ Gemma query error: ${err.message}`);
      await bot.sendMessage(chatId, `${getGreeting(userId, true, msg.chat.type)}Oops, I couldn't process "${text}"\\. Try again or use /start to see options\\.`, { parse_mode: 'MarkdownV2', ...menu });
    }
  }
});