import axios from 'axios';
import { PublicKey, Connection } from '@solana/web3.js';

// Full names
export const coinMap = {
  // Full names
  'solana': { ticker: 'SOL', id: 'solana', contract: 'So11111111111111111111111111111111111111111' },
  'bitcoin': { ticker: 'BTC', id: 'bitcoin' },
  'ethereum': { ticker: 'ETH', id: 'ethereum' },
  'binancecoin': { ticker: 'BNB', id: 'binancecoin' },
  'ripple': { ticker: 'XRP', id: 'ripple' },
  'cardano': { ticker: 'ADA', id: 'cardano' },
  'dogecoin': { ticker: 'DOGE', id: 'dogecoin' },
  'tron': { ticker: 'TRX', id: 'tron' },
  'avalanche': { ticker: 'AVAX', id: 'avalanche-2', contract: 'AUrMpCDYYcPuHhyNX8gEEqbmDPFUpBpHrNW3vPeCFn5Z' },
  'chainlink': { ticker: 'LINK', id: 'chainlink', contract: 'GUGDPw1HHmprN8c4qg65Ezoyq6HQjUHPX4dYVKVf31Xd' },
  'polkadot': { ticker: 'DOT', id: 'polkadot' },
  'litecoin': { ticker: 'LTC', id: 'litecoin' },
  'polygon': { ticker: 'MATIC', id: 'polygon' },
  'shiba': { ticker: 'SHIB', id: 'shiba-inu' },
  'internetcomputer': { ticker: 'ICP', id: 'internet-computer' },
  'dai': { ticker: 'DAI', id: 'dai', contract: 'FYpdBuyAHSbdaAyD1sKkxyLWbAP8uUW9h6uvdhK74ij1' },
  'wrappedbitcoin': { ticker: 'WBTC', id: 'wrapped-bitcoin', contract: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh' },
  'uniswap': { ticker: 'UNI', id: 'uniswap', contract: '5p2zsrxcLiGTqBvpSHPj7E8JfQPn9Fs3RgPnTTLWMULv' },
  // Community Tokens
  'bouncyball': { ticker: 'EXPB', id: 'bouncy-ball-of-ofid-fun', contract: 'GsKuLQsKCEnfQxuk4icTEQjc11Av8WiqW31CxZqZpump', isCommunity: true },
  'bouncy ball': { ticker: 'EXPB', id: 'bouncy-ball-of-ofid-fun', contract: 'GsKuLQsKCEnfQxuk4icTEQjc11Av8WiqW31CxZqZpump', isCommunity: true },
  'expb': { distance: 1, ticker: 'EXPB', id: 'bouncy-ball-of-ofid-fun', contract: 'GsKuLQsKCEnfQxuk4icTEQjc11Av8WiqW31CxZqZpump', isCommunity: true },
  'e𝕏pb': { distance: 2, ticker: 'E𝕏PB', id: 'bouncy-ball-of-ofid-fun', contract: 'GsKuLQsKCEnfQxuk4icTEQjc11Av8WiqW31CxZqZpump', isCommunity: true },
  'giddy': { ticker: 'GIDDY', id: null, contract: '8kQzvMELBQGSiFmrXqLuDSpYVLKkNoXE4bUQCC14wj3Z', isCommunity: true },
  'usdc': { ticker: 'USDC', id: 'usd-coin', contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  'dobby': { ticker: 'DOBBY', id: null, contract: 'CPcf58MNikQw2G23kTVWQevRDeFDpdxMH7KkR7Lhpump', isCommunity: true },
  'captn trench': { ticker: 'CPT', id: null, contract: '2umQqRyexgfHcndkULDKStmJJ8xgDz7oBL3EfDJNmoon', isCommunity: true },
  'mylocat': { ticker: 'MYLO', id: null, contract: 'G37R1ppRgRiMAhk5a3YMRpcfyLNs5mgJij5j7JJ4Yshn', isCommunity: true },
  'kin': { ticker: 'KIN', id: 'kin', contract: 'kinXdEcpDQeHPEuQnqmUgtYykqKGVFq6CeVX5iAHJq6', isCommunity: true },
  'sock inu': { ticker: 'SINU', id: null, contract: 'DXi3Uu7TC2tzJYmnFAgDKnU3p8t6qSafPcLgGaQipump', isCommunity: true },
  'duno': { ticker: 'DUNO', id: null, contract: '7F8oGQ565GYgV4XtaMVG5NP9vevcKQhsRCaHHPNpvg4e', isCommunity: true },
  'one': { ticker: 'ONE', id: null, contract: '9Fdne837tZp97nDZTUqxv9t8Gwp2BwRf8EF7PGAAfoNe', isCommunity: true },
  // Lowercase ticker aliases
  'sol': { ticker: 'SOL', id: 'solana', contract: 'So11111111111111111111111111111111111111111' },
  'btc': { ticker: 'BTC', id: 'bitcoin' },
  'eth': { ticker: 'ETH', id: 'ethereum' },
  'bnb': { ticker: 'BNB', id: 'binancecoin' },
  'xrp': { ticker: 'XRP', id: 'ripple' },
  'ada': { ticker: 'ADA', id: 'cardano' },
  'doge': { ticker: 'DOGE', id: 'dogecoin' },
  'trx': { ticker: 'TRX', id: 'tron' },
  'avax': { ticker: 'AVAX', id: 'avalanche-2', contract: 'AUrMpCDYYcPuHhyNX8gEEqbmDPFUpBpHrNW3vPeCFn5Z' },
  'link': { ticker: 'LINK', id: 'chainlink', contract: 'GUGDPw1HHmprN8c4qg65Ezoyq6HQjUHPX4dYVKVf31Xd' },
  'dot': { ticker: 'DOT', id: 'polkadot' },
  'ltc': { ticker: 'LTC', id: 'litecoin' },
  'matic': { ticker: 'MATIC', id: 'polygon' },
  'shib': { ticker: 'SHIB', id: 'shiba-inu' },
  'icp': { ticker: 'ICP', id: 'internet-computer' },
  'dai': { ticker: 'DAI', id: 'dai', contract: 'FYpdBuyAHSbdaAyD1sKkxyLWbAP8uUW9h6uvdhK74ij1' },
  'wbtc': { ticker: 'WBTC', id: 'wrapped-bitcoin', contract: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh' },
  'uni': { ticker: 'UNI', id: 'uniswap', contract: '5p2zsrxcLiGTqBvpSHPj7E8JfQPn9Fs3RgPnTTLWMULv' },
  // Community Tokens
  'expb': { distance: 1, ticker: 'EXPB', id: 'bouncy-ball-of-ofid-fun', contract: 'GsKuLQsKCEnfQxuk4icTEQjc11Av8WiqW31CxZqZpump', isCommunity: true },
  'giddy': { ticker: 'GIDDY', id: null, contract: '8kQzvMELBQGSiFmrXqLuDSpYVLKkNoXE4bUQCC14wj3Z', isCommunity: true },
  'usdc': { ticker: 'USDC', id: 'usd-coin', contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  'dobby': { ticker: 'DOBBY', id: null, contract: 'CPcf58MNikQw2G23kTVWQevRDeFDpdxMH7KkR7Lhpump', isCommunity: true },
  'cpt': { ticker: 'CPT', id: null, contract: '2umQqRyexgfHcndkULDKStmJJ8xgDz7oBL3EfDJNmoon', isCommunity: true },
  'mylo': { ticker: 'MYLO', id: null, contract: 'G37R1ppRgRiMAhk5a3YMRpcfyLNs5mgJij5j7JJ4Yshn', isCommunity: true },
  'kin': { ticker: 'KIN', id: 'kin', contract: 'kinXdEcpDQeHPEuQnqmUgtYykqKGVFq6CeVX5iAHJq6', isCommunity: true },
  'sinu': { ticker: 'SINU', id: null, contract: 'DXi3Uu7TC2tzJYmnFAgDKnU3p8t6qSafPcLgGaQipump', isCommunity: true },
  'duno': { ticker: 'DUNO', id: null, contract: '7F8oGQ565GYgV4XtaMVG5NP9vevcKQhsRCaHHPNpvg4e', isCommunity: true },
  'one': { ticker: 'ONE', id: null, contract: '9Fdne837tZp97nDZTUqxv9t8Gwp2BwRf8EF7PGAAfoNe', isCommunity: true },
};

// Validate Solana address format
export function isValidSolanaAddress(address) {
  try {
    if (address === 'native') return false;
    new PublicKey(address);
    return true;
  } catch (error) {
    return false;
  }
}

// Get coins with valid Solana contract addresses, grouped by community and others
export function getCoinsWithContracts() {
  const seenContracts = new Set();
  const preferredEntries = {
    'bouncy-ball-of-ofid-fun': 'bouncy ball',
    'captn-trench': 'captn trench',
    'mylocat': 'mylocat',
    'sock-inu': 'sock inu',
    'giddy': 'giddy',
    'dobby': 'dobby',
    'kin': 'kin',
    'duno': 'duno',
    'one': 'one',
    'usdc': 'usdc',
  };

  const community = [];
  const others = [];

  for (const [key, coin] of Object.entries(coinMap)) {
    if (isValidSolanaAddress(coin.contract)) {
      // Skip if not the preferred entry for this id or key, or if contract already seen
      if (coin.id && preferredEntries[coin.id] && key !== preferredEntries[coin.id]) {
        continue;
      }
      if (preferredEntries[key] && key !== preferredEntries[key]) {
        continue;
      }
      if (seenContracts.has(coin.contract)) {
        continue;
      }
      seenContracts.add(coin.contract);
      const name = key
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      const coinData = {
        ticker: coin.ticker,
        name: name,
        contractAddress: coin.contract,
        coingeckoId: coin.id,
      };
      if (coin.isCommunity) {
        community.push(coinData);
      } else {
        others.push(coinData);
      }
    }
  }

  // Sort community tokens: EXPB and GIDDY first, then alphabetically by ticker
  community.sort((a, b) => {
    if (a.ticker === 'EXPB') return -1;
    if (b.ticker === 'EXPB') return 1;
    if (a.ticker === 'GIDDY') return -1;
    if (b.ticker === 'GIDDY') return 1;
    return a.ticker.localeCompare(b.ticker);
  });

  // Sort other tokens alphabetically by ticker
  others.sort((a, b) => a.ticker.localeCompare(b.ticker));

  return { community, others };
}

// Get only community coins with valid Solana contract addresses
export function getCommunityCoins() {
  const seenContracts = new Set();
  const preferredEntries = {
    'bouncy-ball-of-ofid-fun': 'bouncy ball',
    'captn-trench': 'captn trench',
    'mylocat': 'mylocat',
    'sock-inu': 'sock inu',
    'giddy': 'giddy',
    'dobby': 'dobby',
    'kin': 'kin',
    'duno': 'duno',
    'one': 'one',
    'usdc': 'usdc',
  };

  const community = [];
  for (const [key, coin] of Object.entries(coinMap)) {
    if (isValidSolanaAddress(coin.contract) && coin.isCommunity) {
      // Skip if not the preferred entry for this id or key, or if contract already seen
      if (coin.id && preferredEntries[coin.id] && key !== preferredEntries[coin.id]) {
        continue;
      }
      if (preferredEntries[key] && key !== preferredEntries[key]) {
        continue;
      }
      if (seenContracts.has(coin.contract)) {
        continue;
      }
      seenContracts.add(coin.contract);
      const name = key
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      community.push({
        ticker: coin.ticker,
        name: name,
        contractAddress: coin.contract,
        coingeckoId: coin.id,
      });
    }
  }

  // Sort: EXPB and GIDDY first, then alphabetically by ticker
  return community.sort((a, b) => {
    if (a.ticker === 'EXPB') return -1;
    if (b.ticker === 'EXPB') return 1;
    if (a.ticker === 'GIDDY') return -1;
    if (b.ticker === 'GIDDY') return 1;
    return a.ticker.localeCompare(b.ticker);
  });
}

// Enhanced getCoinInfo with contract-only option
export function getCoinInfo(key, contractOnly = false) {
  // Normalize Unicode characters (e.g., 𝕏 to x)
  const normalizedKey = key.toLowerCase().replace(/[\u{1D400}-\u{1D7FF}]/gu, c =>
    String.fromCharCode(c.charCodeAt(0) - 0x1D400 + 0x0041)
  );
  const info = coinMap[normalizedKey];
  if (!info) return null;
  if (contractOnly && !isValidSolanaAddress(info.contract)) return null;
  return {
    ticker: info.ticker,
    id: info.id,
    contractAddress: info.contract,
  };
}

// EXPORTS: Validate contract address on-chain
export async function validateContractOnChain(address, rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com') {
  try {
    if (!isValidSolanaAddress(address)) return false;
    const connection = new Connection(rpcUrl, 'confirmed');
    const publicKey = new PublicKey(address);
    const accountInfo = await connection.getAccountInfo(publicKey);
    return !!accountInfo && accountInfo.data.length > 0;
  } catch (error) {
    console.error(`❌ On-chain validation failed for ${address}: ${error.message}`);
        return false;
    }
}

// NEW: DexScreener cache for meme/new tokens
let dexCache = null;

export async function loadDexCache() {
  try {
    const response = await axios.get('https://api.dexscreener.com/latest/dex/search/?q=solana', { timeout: 10000 });  // Top Solana pairs
    dexCache = response.data.pairs || [];
    console.log(`✅ Loaded ${dexCache.length} DexScreener pairs into cache`);
  } catch (err) {
    console.error(`❌ Failed to load DexScreener cache: ${err.message}. Skipping meme fallback.`);
    dexCache = [];
  }
}

// NEW: Search DexScreener cache (fuzzy name/symbol)
export function searchDexCache(query) {
  if (!dexCache) return [];
  const lowerQuery = query.toLowerCase();
  return dexCache
    .filter(pair => 
      pair.baseToken.name.toLowerCase().includes(lowerQuery) || 
      pair.baseToken.symbol.toLowerCase().includes(lowerQuery)
    )
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))  // Liquidity sort
    .slice(0, 5);  // Top 5
}

// NEW: Get token info from Dex pair
export function getDexTokenInfo(pair) {
  return {
    ticker: pair.baseToken.symbol.toUpperCase(),
    name: pair.baseToken.name,
    contractAddress: pair.baseToken.address,
    chain: 'Solana',
    source: 'DexScreener'
  };
}

// Startup load (call in telegram.js)
export async function initCaches() {
  await loadCoinCache();  // Existing CoinGecko
  await loadDexCache();   // NEW: DexScreener
  setInterval(loadDexCache, 3600000);  // Refresh hourly
}