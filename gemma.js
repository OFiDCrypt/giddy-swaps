import { HfInference } from '@huggingface/inference';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getBalances } from './bot.js';
import { extractSearchTerm } from './telegram.js';
import { companyData } from './companyData.js';  // FIXED: Relative path (./), lowercase as you set

dotenv.config();

const hf = new HfInference(process.env.HF_TOKEN);
const PRIMARY_MODEL = 'google/gemma-3-27b-it';
const FALLBACK_MODEL = 'google/gemma-2-2b-it';
const ULTIMATE_FALLBACK_MODEL = 'gpt2';
const MAX_TOKENS = 200;  // Increased to reduce truncation issues
const MAX_HISTORY = 10;
const CHATS_DIR = 'chats';
const SWAP_LOG_PATH = 'swaps/last_session.json';
const INACTIVITY_BUFFER_MS = 5 * 60 * 1000;  // 5 minutes buffer before showing menu again

// Ensure chats dir
(async () => {
  try { await fs.mkdir(CHATS_DIR, { recursive: true }); } catch { }
})();

async function loadChatHistory(chatId) {
  const filePath = path.join(CHATS_DIR, `${chatId}.json`);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    const chatData = JSON.parse(data);
    const history = chatData.history || [];
    if (history.length > MAX_HISTORY * 2) history.splice(0, history.length - MAX_HISTORY * 2);
    const lastResponse = chatData.lastResponse || 0;
    return { history, lastResponse };
  } catch {
    return { history: [], lastResponse: 0 };
  }
}

async function saveChatHistory(chatId, history, lastResponse) {
  const filePath = path.join(CHATS_DIR, `${chatId}.json`);
  const chatData = { history, lastResponse };
  await fs.writeFile(filePath, JSON.stringify(chatData, null, 2));
}

async function getPnlContext() {
  try {
    const data = await fs.readFile(SWAP_LOG_PATH, 'utf8');
    const log = JSON.parse(data);
    const totalLoss = log.reduce((sum, s) => sum + parseFloat(s.loss), 0);
    return `Recent PnL: ${totalLoss.toFixed(2)} USDC (from ${log.length} swaps).`;
  } catch {
    return '';
  }
}

// New: Build alternating messages (fixes Nebius role error)
function buildAlternatingMessages(systemMsg, chatHistory) {
  let messages = [...chatHistory]; // Start with loaded history

  // Clean: Skip consecutive same roles, merge system to first user
  const cleaned = [];
  let lastRole = null;
  for (let msg of messages) {
    if (msg.role === lastRole) continue; // Skip duplicates (e.g., consecutive user)
    if (msg.role === 'system' && cleaned.length > 0) {
      // Merge system to first user
      if (cleaned[0].role === 'user') {
        cleaned[0].content = `${msg.content}\n\n${cleaned[0].content}`;
      }
      continue;
    }
    cleaned.push(msg);
    lastRole = msg.role;
  }

  // Prepend cleaned system if no merge happened
  if (systemMsg && (cleaned.length === 0 || cleaned[0]?.role !== 'user')) {
    cleaned.unshift({ role: 'user', content: systemMsg.content }); // Treat system as initial user prompt
  } else if (systemMsg) {
    cleaned[0].content = `${systemMsg.content}\n\n${cleaned[0].content}`;
  }

  return cleaned;
}

// Unified context menu (only appended after inactivity buffer)
const unifiedMenu = {
  inline_keyboard: [
    [{ text: "🌟 Explore GIDDY 🌟", callback_data: "explore_giddy" }],
    [{ text: "🎲", callback_data: "chat" }],
  ],
};

export async function queryGemma(message, chatId, bot) {
  try {
    console.log(`📥 Received: ${message}`);
    const { history: chatHistory, lastResponse } = await loadChatHistory(chatId);
    chatHistory.push({ role: 'user', content: message });
    if (chatHistory.length > MAX_HISTORY * 2) chatHistory.splice(0, chatHistory.length - MAX_HISTORY * 2);

    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes('balance')) {
      const balances = await getBalances();
      console.log(`📊 Balances: USDC=${balances.usdc.toFixed(2)}, GIDDY=${balances.giddy.toFixed(2)}, SOL=${balances.sol.toFixed(2)}`);
      const response = `USDC: ${balances.usdc.toFixed(2)}, GIDDY: ${balances.giddy.toFixed(2)}, SOL: ${balances.sol.toFixed(2)}. Full details?`;
      chatHistory.push({ role: 'assistant', content: response });
      await saveChatHistory(chatId, chatHistory, Date.now());
      return {
        text: response,
        reply_markup: {
          inline_keyboard: [
            [{ text: "Show full balance", callback_data: "balance" }],
            [{ text: "Cancel", callback_data: "cancel" }],
          ],
        },
      };
    }

    if (lowerMessage.includes('deposit') || lowerMessage.includes('fund')) {
      console.log('💰 Deposit/fund triggered');
      const response = `Deposit USDC to your wallet? Show details?`;
      chatHistory.push({ role: 'assistant', content: response });
      await saveChatHistory(chatId, chatHistory, Date.now());
      return {
        text: response,
        reply_markup: {
          inline_keyboard: [
            [{ text: "Show Deposit Info", callback_data: "deposit" }],
            [{ text: "Cancel", callback_data: "cancel" }],
          ],
        },
      };
    }

    // NEW: Fallback guard for price/CA queries (prevent Gemma hallucinations, redirect to handler) – MOVED UP
    const { term: searchTerm, keyword } = extractSearchTerm(lowerMessage);
    const isPriceQuery = keyword === 'price' && searchTerm;
    const isContractQuery = ['ca', 'contract address', 'token contract'].includes(keyword) && searchTerm;  // Dropped standalone 'contract' – too noisy
    const hasContractContext = keyword === 'contract' && (lowerMessage.includes('address') || lowerMessage.includes('for') || lowerMessage.includes('of')) && searchTerm;  // Only trigger 'contract' with context
    const isPriceOrCaQuery = isPriceQuery || isContractQuery || hasContractContext;
    if (isPriceOrCaQuery) {
      console.log(`🔄 Price/CA fallback: "${searchTerm}" (keyword: "${keyword}") – Redirecting to handler`);
      const queryType = keyword === 'price' ? 'price' : 'contract address';
      const redirectText = `Got it! For the ${queryType} of ${searchTerm.toUpperCase()}, just say: "What's the ${queryType} of ${searchTerm}?" 🚀 I'll fetch fresh data from CoinGecko! Meanwhile, ready for GIDDY swaps? 💖`;
      chatHistory.push({ role: 'assistant', content: redirectText });
      await saveChatHistory(chatId, chatHistory, Date.now());
      return {
        text: redirectText,
        reply_markup: { inline_keyboard: unifiedMenu.inline_keyboard },  // Always show menu for redirect
      };
    }

    console.log(`🤖 Generating with HF ${PRIMARY_MODEL} on Nebius...`);
    const pnlContext = await getPnlContext();
    const systemMsg = {
      role: 'system',
      content: `You are a witty Solana AI community companion and assistant for GIDDY stabletoken swaps and BOUNCY gifts. You were developed by OFiDCrypt, creators of GIDDY and BOUNCY BALL. ${companyData.about.bio} Be concise (<50 words), fun, and helpful on balances, strategies, or DeFi tips. Incorporate: ${pnlContext}. General stories and off-topic conversations are encouraged, but subtly steer back to GIDDY swaps. Respond in plain text with emojis only. No Markdown formatting like *bold*, **bold**, or [links]. Start casual and light for greetings or chit-chat. Only dive into crypto knowledge and safety tips (like wallets, swaps, or strategies) if the user explicitly asks or mentions them. Keep it fun and emoji-friendly. Be cheeky and banter back playfully when the user jokes or teases—keep it light-hearted and never rude. You can discuss general Solana tokens and prices if asked (use CoinGecko data), but warn on high-risk memecoins like political ones: 'DYOR – this is volatile!' Never give out direct price info yourself—it's dated and can be hallucinated. Instead, redirect: 'Ask me for the price of [token]!' or 'Tell me the contract address query for [token]!' Always redirect back to GIDDY swaps.

CRITICAL RULES FOR PERSONALIZATION:
- Nicknames: Do NOT simulate, confirm, or contradict nickname changes. If asked about nicknames, names, or changing them, respond exactly: "Certainly! Just reply 'call me [desired name]' to set or update it—I'll remember! 😎" Then pivot to crypto/swaps/knowledge (e.g., "Wanna GIDDY-UP ✨ and roll the dice? 🎱").
- Greetings: Never start with "Hey/Hi/Hello [name]!" or any greeting opener—assume the bot handles intros. Jump straight into the reply body.
- No contradictions: Stick strictly to bot facts (e.g., the system remembers nicknames via manual triggers; do not say "I can't remember" or "you can’t change"). Keep responses compliant and seamless.`
    };

    // Build alternating messages (include FULL history with current user)
    const messages = buildAlternatingMessages(systemMsg, chatHistory);

    let responseText;
    // Primary: Nebius with Gemma-3-27B (chatCompletion)
    try {
      const result = await hf.chatCompletion({
        model: PRIMARY_MODEL,
        messages,
        provider: 'nebius',
        parameters: {
          max_tokens: MAX_TOKENS,
          temperature: 0.6,
          top_p: 0.9,
        },
      });
      responseText = result.choices[0]?.message?.content || '';
      console.log('✅ Nebius/Gemma-3-27B hit! ✨');
    } catch (primaryErr) {
      console.warn(`⚠️ Nebius failed: ${primaryErr.message}. Falling back to HF/Gemma-2-2b-it.`);
      // Fallback: HF with Gemma-2-2B (textGeneration, chat-formatted prompt)
      try {
        // Use full messages (includes current user)
        const formattedPrompt = messages.map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n') + '\nASSISTANT:';
        const fallbackResult = await hf.textGeneration({
          model: FALLBACK_MODEL,
          inputs: formattedPrompt,
          provider: 'hf-inference',
          parameters: {
            max_new_tokens: MAX_TOKENS,
            temperature: 0.6,
            top_p: 0.9,
            do_sample: true,
            repetition_penalty: 1.1,
            return_full_text: false,
          },
        });
        responseText = (fallbackResult.generated_text || '').trim();
        console.log('✅ HF/Gemma-2-2B hit!');
      } catch (fallbackErr) {
        console.warn(`⚠️ HF fallback failed: ${fallbackErr.message}. Ultimate GPT-2.`);
        // Ultimate: Text-gen GPT-2
        const ultResult = await hf.textGeneration({
          model: ULTIMATE_FALLBACK_MODEL,
          inputs: `${systemMsg.content}\nUser: ${message}\nAssistant:`,
          parameters: {
            max_new_tokens: 50,
            temperature: 0.7,
          },
        });
        responseText = (ultResult.generated_text || '').trim();
        console.log('✅ GPT-2 hit!');
      }
    }

    responseText = responseText.replace(/http[s]?:\/\/[^\s]+/g, '').trim();

    // New: Clean up any residual Markdown or orphan syntax to prevent Telegram parse errors
    responseText = responseText
      .replace(/\*\*(.*?)\*\*/g, '$1')  // Remove bold
      .replace(/\*(.*?)\*/g, '$1')      // Remove italics
      .replace(/__(.*?)__/g, '$1')      // Remove underline
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // Flatten links to text
      .replace(/\[([^\]]+)\]/g, '$1');  // Handle orphan brackets

    if (!responseText || responseText.length < 5) {
      if (lowerMessage.includes('joke')) {
        responseText = "Why did the SOL cross the ledger? To get to the other fork! 🚀 What's your next swap?";
      } else if (chatHistory.length < 3) {  // Detect "new" convo (low history) for greeting-style default
        responseText = "Hey! What's up? 😊 Tell me about your day—or if you're into crypto, spill the tea on Solana?";
      } else {
        responseText = "Got it—spill on your GIDDY strategy?";
      }
    }

    console.log(`✅ Response: ${responseText}`);
    chatHistory.push({ role: 'assistant', content: responseText });

    // Time buffer: Only add menu if >5 mins since last response
    const now = Date.now();
    const showMenu = (now - lastResponse) > INACTIVITY_BUFFER_MS;
    console.log(`⏱️ Time since last response: ${(now - lastResponse) / 1000 / 60} mins. Showing menu: ${showMenu}`);

    await saveChatHistory(chatId, chatHistory, now);
    return {
      text: responseText,
      reply_markup: showMenu ? { inline_keyboard: unifiedMenu.inline_keyboard } : undefined,
    };
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    return {
      text: 'Trading vibes? Ask about balances, swaps, or deposits!',
      reply_markup: undefined,  // No menu on error to avoid clutter
    };
  }
}