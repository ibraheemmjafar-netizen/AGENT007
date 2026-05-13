/**
 * AGENT BUYBOT
 * Tracks buys across Cetus, Bluefin & Turbos on Sui mainnet
 * Sends Telegram notifications with rich buy cards
 *
 * Commands:
 *   /start            — Welcome + setup
 *   /addtoken <addr> <symbol> [decimals] — Track a token
 *   /removetoken <symbol>  — Stop tracking
 *   /tokens            — List tracked tokens
 *   /setmin <symbol> <usd> — Set minimum buy alert threshold
 *   /stats             — Bot stats
 *   /pause             — Pause alerts in this group
 *   /resume            — Resume alerts
 *   /help              — Command list
 */

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');
const BOT_VERSION  = '1.0.0';
const POLL_INTERVAL_MS  = 4000;   // How often to check for new events
const EVENT_LOOKBACK    = 50;     // Events per query
const DEDUP_TTL_MS      = 600000; // 10 min dedup window
const DEFAULT_MIN_USD   = 1;      // Default minimum buy USD

// Sui RPC endpoints (tried in order, first reachable wins)
const SUI_RPC_ENDPOINTS = [
  'https://sui-mainnet.public.blastapi.io',
  'https://mainnet.suiet.app',
  'https://sui-mainnet-rpc.allthatnode.com',
  'https://rpc-mainnet.suiscan.xyz',
];

// Coingecko SUI price
const SUI_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd';

// ─── DEX EVENT TYPES ─────────────────────────────────────────────────────────
// These are the actual on-chain event module::type strings
const DEX_CONFIGS = {
  cetus: {
    name: 'Cetus',
    emoji: '🐋',
    swapEventType: '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent',
    chartUrl: (pool) => `https://app.cetus.zone/liquidity/position?poolAddress=${pool}`,
  },
  turbos: {
    name: 'Turbos',
    emoji: '🌀',
    swapEventType: '0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool::SwapEvent',
    chartUrl: (pool) => `https://app.turbos.finance/#/trade`,
  },
  bluefin: {
    name: 'Bluefin',
    emoji: '🐬',
    swapEventType: '0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::spot_dex::OrderFilled',
    chartUrl: (pool) => `https://trade.bluefin.io`,
  },
};

// ─── STATE ───────────────────────────────────────────────────────────────────
let config = loadConfig();
let suiPrice = 1.0;
let startTime = Date.now();
let totalBuysDetected = 0;
let activeRpc = null;

// In-memory dedup: txHash -> timestamp
const seenTxs = new Map();

// Per-token buy count (for "Buyer #N" feature)
const buyerCounts = new Map(); // tokenSymbol -> count

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch (e) { console.error('[Config] Parse error, using defaults'); }
  }
  return { tokens: [], groups: {}, version: BOT_VERSION };
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function isDuplicate(txHash) {
  if (seenTxs.has(txHash)) return true;
  seenTxs.set(txHash, Date.now());
  // Prune old entries
  for (const [k, v] of seenTxs) {
    if (Date.now() - v > DEDUP_TTL_MS) seenTxs.delete(k);
  }
  return false;
}

function shortWallet(addr) {
  if (!addr || addr.length < 12) return addr;
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function formatUSD(n) {
  return '$' + parseFloat(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  return parseFloat(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatPrice(p) {
  if (!p || p === 0) return 'N/A';
  if (p >= 0.01) return '$' + p.toFixed(4);
  // Subscript zero notation: $0.0₄5640
  const s = p.toFixed(20);
  const zeros = (s.match(/^0\.(0*)/) || ['', ''])[1].length;
  const sig = s.replace('0.', '').replace(/^0+/, '').slice(0, 4);
  // Unicode subscript digits
  const sub = zeros.toString().split('').map(d => '₀₁₂₃₄₅₆₇₈₉'[+d]).join('');
  return zeros > 2 ? `$0.0${sub}${sig}` : '$' + p.toFixed(8);
}

function fmtMcap(n) {
  if (!n || n <= 0) return 'N/A';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}

function getBuyBar(usd) {
  if (usd >= 5000) return '🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀';
  if (usd >= 1000) return '🔴🔴🔴🔴🔴🔴🔴🔴';
  if (usd >= 500)  return '🟠🟠🟠🟠🟠🟠🟠';
  if (usd >= 200)  return '🟡🟡🟡🟡🟡🟡';
  if (usd >= 50)   return '🟢🟢🟢🟢🟢';
  if (usd >= 10)   return '🟢🟢🟢';
  return '🟢';
}

function getUptimeStr() {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── SUI RPC ─────────────────────────────────────────────────────────────────

async function rpc(method, params) {
  const endpoints = activeRpc ? [activeRpc, ...SUI_RPC_ENDPOINTS] : SUI_RPC_ENDPOINTS;
  for (const url of endpoints) {
    try {
      const res = await axios.post(url, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 8000 });
      if (res.data?.result !== undefined) {
        activeRpc = url;
        return res.data.result;
      }
    } catch (_) {/* try next */}
  }
  throw new Error('All RPC endpoints failed');
}

async function fetchSuiEvents(eventType, cursor = null) {
  const params = [
    { MoveEventType: eventType },
    cursor,
    EVENT_LOOKBACK,
    false // descending = newest first
  ];
  return rpc('suix_queryEvents', params);
}

async function fetchSuiPrice() {
  try {
    const res = await axios.get(SUI_PRICE_URL, { timeout: 6000 });
    const price = res.data?.sui?.usd;
    if (price && price > 0) {
      suiPrice = price;
      log(`SUI price updated: $${suiPrice}`);
    }
  } catch (e) {
    log(`SUI price fetch failed: ${e.message}`);
  }
}

// ─── EVENT PARSING ────────────────────────────────────────────────────────────

function parseCetusSwap(event, token) {
  try {
    const d = event.parsedJson;
    // Cetus: amount_in = SUI (if a2b), amount_out = token
    // We only care about buys: SUI -> token direction
    const isBuy = d.a2b === true || d.atob === false;
    if (!isBuy) return null;

    const suiAmount = Number(d.amount_in) / 1e9;
    const tokenAmount = Number(d.amount_out) / Math.pow(10, token.decimals || 6);
    const usdAmount = suiAmount * suiPrice;
    const price = usdAmount / tokenAmount;

    return {
      suiAmount, tokenAmount, usdAmount, price,
      wallet: event.sender || event.id?.txDigest,
      txHash: event.id?.txDigest,
      pool: d.pool,
      dex: 'cetus',
    };
  } catch (e) { return null; }
}

function parseTurbosSwap(event, token) {
  try {
    const d = event.parsedJson;
    // Turbos: a_to_b means SUI(A) -> token(B)
    const isBuy = d.a_to_b === true;
    if (!isBuy) return null;

    const suiAmount = Number(d.amount_a) / 1e9;
    const tokenAmount = Number(d.amount_b) / Math.pow(10, token.decimals || 6);
    const usdAmount = suiAmount * suiPrice;
    const price = usdAmount / tokenAmount;

    return {
      suiAmount, tokenAmount, usdAmount, price,
      wallet: event.sender || event.id?.txDigest,
      txHash: event.id?.txDigest,
      pool: d.pool,
      dex: 'turbos',
    };
  } catch (e) { return null; }
}

function parseBluefinFill(event, token) {
  try {
    const d = event.parsedJson;
    // Bluefin order filled event
    const suiAmount = Number(d.base_quantity || d.quantity || 0) / 1e9;
    const tokenAmount = Number(d.quote_quantity || d.filled_quantity || 0) / Math.pow(10, token.decimals || 6);
    if (suiAmount <= 0 || tokenAmount <= 0) return null;
    const usdAmount = suiAmount * suiPrice;
    const price = usdAmount / tokenAmount;

    return {
      suiAmount, tokenAmount, usdAmount, price,
      wallet: event.sender || d.user,
      txHash: event.id?.txDigest,
      pool: d.market_id || d.pool_id,
      dex: 'bluefin',
    };
  } catch (e) { return null; }
}

const DEX_PARSERS = { cetus: parseCetusSwap, turbos: parseTurbosSwap, bluefin: parseBluefinFill };

// ─── TRACKING CURSORS ─────────────────────────────────────────────────────────
// Per dex event cursor: { cetus: lastCursor, turbos: lastCursor, bluefin: lastCursor }
const cursors = {};

async function checkDex(dexKey, token) {
  const dex = DEX_CONFIGS[dexKey];
  const cursorKey = `${dexKey}:${token.symbol}`;
  const parser = DEX_PARSERS[dexKey];
  if (!parser) return;

  try {
    const result = await fetchSuiEvents(dex.swapEventType, cursors[cursorKey] || null);
    if (!result?.data?.length) return;

    // Update cursor to latest
    if (result.nextCursor) cursors[cursorKey] = result.nextCursor;

    for (const event of result.data) {
      const txHash = event.id?.txDigest;
      if (!txHash || isDuplicate(`${dexKey}:${txHash}`)) continue;

      // Check if this event involves our token
      const eventStr = JSON.stringify(event.parsedJson || '');
      const tokenAddr = token.address.toLowerCase();
      if (!eventStr.toLowerCase().includes(tokenAddr.slice(2, 12))) {
        // Quick filter: skip events not mentioning our token address fragment
        // Full check done by pool address matching below
        const tokenPools = token.pools?.[dexKey] || [];
        const pool = event.parsedJson?.pool || event.parsedJson?.market_id || '';
        if (tokenPools.length > 0 && !tokenPools.some(p => pool.includes(p) || p.includes(pool))) continue;
      }

      const buy = parser(event, token);
      if (!buy) continue;
      if (buy.usdAmount < (token.minBuyUSD || DEFAULT_MIN_USD)) continue;

      log(`🟢 Buy detected: ${token.symbol} | $${buy.usdAmount.toFixed(2)} on ${dex.name}`);
      totalBuysDetected++;

      // Increment buyer count
      const countKey = token.symbol;
      const buyerNum = (buyerCounts.get(countKey) || 0) + 1;
      buyerCounts.set(countKey, buyerNum);

      // Detect new buyer (wallet never seen before, rough heuristic)
      const isNewBuyer = !seenTxs.has(`wallet:${buy.wallet}`);
      seenTxs.set(`wallet:${buy.wallet}`, Date.now());

      await notifyAllGroups(token, buy, buyerNum, isNewBuyer, dex);
    }
  } catch (e) {
    log(`[${dexKey}] Event fetch error: ${e.message}`);
  }
}

// ─── POLLING LOOP ─────────────────────────────────────────────────────────────

async function pollLoop() {
  for (const token of config.tokens) {
    for (const dexKey of ['cetus', 'turbos', 'bluefin']) {
      await checkDex(dexKey, token);
    }
  }
}

// ─── MESSAGE BUILDER ──────────────────────────────────────────────────────────

function buildBuyMessage(token, buy, buyerNum, isNewBuyer, dex) {
  const bar        = getBuyBar(buy.usdAmount);
  const walletShort = shortWallet(buy.wallet);
  const priceStr   = formatPrice(buy.price);
  const mcap       = token.totalSupply ? buy.price * token.totalSupply : null;
  const mcapStr    = fmtMcap(mcap);
  const dexLink    = dex.chartUrl(buy.pool || '');
  const suiscanTx  = `https://suiscan.xyz/mainnet/tx/${buy.txHash}`;
  const dexScreener = `https://dexscreener.com/sui/${token.address}`;
  const suiscanTkn  = `https://suiscan.xyz/mainnet/object/${token.address}`;
  const suiscanWallet = `https://suiscan.xyz/mainnet/account/${buy.wallet}`;

  const extras = [];
  if (isNewBuyer) extras.push('🆕 *New Buyer!*');
  if (buyerNum)   extras.push(`🏆 Buyer *#${buyerNum}*`);
  if (buy.usdAmount >= 1000) extras.push('🐳 *Whale Alert!*');
  if (buy.usdAmount >= 5000) extras.push('🦈 *MEGA WHALE!*');

  const extrasLine = extras.length ? '\n' + extras.join('  ') : '';

  return (
`🤖 *AGENT BUYBOT*
━━━━━━━━━━━━━━━━━━━
*${token.symbol}* Buy on *${dex.name}* ${dex.emoji}${extrasLine}

${bar}

💎 SUI: *$${suiPrice.toFixed(3)}*
💰 *${formatUSD(buy.usdAmount)}* \\(${buy.suiAmount.toFixed(4)} SUI\\)
🪙 ${fmtTokens(buy.tokenAmount)} *${token.symbol}*

📊 Price: *${priceStr}*
💹 MCap: *${mcapStr}*

👤 [${walletShort}](${suiscanWallet})
🔗 [TX](${suiscanTx}) \\| [Chart](${dexScreener}) \\| [Token](${suiscanTkn})

⚡ _AGENT BUYBOT v${BOT_VERSION}_`
  );
}

// ─── NOTIFICATION ─────────────────────────────────────────────────────────────

async function notifyAllGroups(token, buy, buyerNum, isNewBuyer, dex) {
  const msg = buildBuyMessage(token, buy, buyerNum, isNewBuyer, dex);

  for (const [chatId, groupCfg] of Object.entries(config.groups)) {
    if (groupCfg.paused) continue;

    // Per-group min buy override
    const minUSD = groupCfg.minBuyUSD?.[token.symbol] ?? token.minBuyUSD ?? DEFAULT_MIN_USD;
    if (buy.usdAmount < minUSD) continue;

    try {
      await bot.sendMessage(chatId, msg, {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      });
    } catch (e) {
      log(`[Notify] Failed to send to ${chatId}: ${e.message}`);
      // If bot was kicked from group, remove it
      if (e.message?.includes('bot was kicked') || e.message?.includes('chat not found')) {
        delete config.groups[chatId];
        saveConfig();
        log(`[Notify] Removed dead group: ${chatId}`);
      }
    }
  }
}

// ─── BOT SETUP ───────────────────────────────────────────────────────────────

if (!process.env.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

function ensureGroup(chatId) {
  if (!config.groups[chatId]) {
    config.groups[chatId] = { paused: false, minBuyUSD: {}, addedAt: Date.now() };
    saveConfig();
  }
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = String(msg.chat.id);
  ensureGroup(chatId);
  await bot.sendMessage(chatId,
`🤖 *AGENT BUYBOT* is live\\!
━━━━━━━━━━━━━━━━━━━━━
Track buys on *Cetus*, *Bluefin* & *Turbos* in real\\-time\\.

*Add a token to track:*
\`/addtoken <address> <SYMBOL> [decimals] [totalSupply]\`

*Example:*
\`/addtoken 0xtoken123 PEEKA 6 1000000000\`

Type /help to see all commands\\.

⚡ _Powered by AGENT BUYBOT_`,
    { parse_mode: 'MarkdownV2' }
  );
});

bot.onText(/\/help/, async (msg) => {
  const chatId = String(msg.chat.id);
  ensureGroup(chatId);
  await bot.sendMessage(chatId,
`🤖 *AGENT BUYBOT* — Commands
━━━━━━━━━━━━━━━━━━━━━
/addtoken \\<addr\\> \\<SYM\\> \\[dec\\] \\[supply\\] — Track token
/removetoken \\<SYM\\> — Stop tracking
/tokens — List tracked tokens
/setmin \\<SYM\\> \\<usd\\> — Min buy to alert \\(per group\\)
/stats — Bot statistics
/pause — Pause alerts here
/resume — Resume alerts here
/help — This menu

*DEXes tracked:*
🐋 Cetus \\| 🌀 Turbos \\| 🐬 Bluefin

⚡ _AGENT BUYBOT v${escMd(BOT_VERSION)}_`,
    { parse_mode: 'MarkdownV2' }
  );
});

bot.onText(/\/addtoken (.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  ensureGroup(chatId);
  const args = match[1].trim().split(/\s+/);
  if (args.length < 2) {
    return bot.sendMessage(chatId, '⚠️ Usage: /addtoken <address> <SYMBOL> [decimals] [totalSupply]');
  }
  const [address, symbol, decimalsRaw, supplyRaw] = args;
  const decimals = parseInt(decimalsRaw || '6', 10);
  const totalSupply = supplyRaw ? parseFloat(supplyRaw) : null;

  if (config.tokens.find(t => t.symbol.toUpperCase() === symbol.toUpperCase())) {
    return bot.sendMessage(chatId, `⚠️ *${symbol}* is already being tracked.`, { parse_mode: 'Markdown' });
  }

  config.tokens.push({ address, symbol: symbol.toUpperCase(), decimals, totalSupply, minBuyUSD: DEFAULT_MIN_USD, pools: { cetus: [], turbos: [], bluefin: [] }, addedAt: Date.now() });
  saveConfig();
  log(`Token added: ${symbol} (${address})`);
  await bot.sendMessage(chatId,
`✅ Now tracking *${symbol.toUpperCase()}*
📍 Address: \`${address}\`
🔢 Decimals: ${decimals}
💰 Min buy alert: $${DEFAULT_MIN_USD}
💧 DEXes: Cetus, Turbos, Bluefin

Use /setmin ${symbol.toUpperCase()} <usd> to change the minimum\\.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/removetoken (.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const sym = match[1].trim().toUpperCase();
  const before = config.tokens.length;
  config.tokens = config.tokens.filter(t => t.symbol !== sym);
  if (config.tokens.length === before) {
    return bot.sendMessage(chatId, `⚠️ Token *${sym}* not found.`, { parse_mode: 'Markdown' });
  }
  saveConfig();
  await bot.sendMessage(chatId, `🗑 Stopped tracking *${sym}*.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/tokens/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (config.tokens.length === 0) {
    return bot.sendMessage(chatId, '📭 No tokens tracked yet. Use /addtoken to add one.');
  }
  const lines = config.tokens.map((t, i) =>
    `${i + 1}\\. *${escMd(t.symbol)}* — \`${escMd(t.address.slice(0, 12))}\\.\\.\\.\`\n` +
    `   Min buy: $${escMd(String(t.minBuyUSD || DEFAULT_MIN_USD))} \\| Decimals: ${t.decimals}`
  );
  await bot.sendMessage(chatId,
    `🪙 *Tracked Tokens*\n━━━━━━━━━━━━━━━\n${lines.join('\n\n')}`,
    { parse_mode: 'MarkdownV2' }
  );
});

bot.onText(/\/setmin (.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const args = match[1].trim().split(/\s+/);
  if (args.length < 2) {
    return bot.sendMessage(chatId, '⚠️ Usage: /setmin <SYMBOL> <minUSD>');
  }
  const [sym, minRaw] = args;
  const minUSD = parseFloat(minRaw);
  if (isNaN(minUSD) || minUSD < 0) {
    return bot.sendMessage(chatId, '⚠️ Invalid amount. Example: /setmin PEEKA 10');
  }
  const token = config.tokens.find(t => t.symbol === sym.toUpperCase());
  if (!token) {
    return bot.sendMessage(chatId, `⚠️ Token *${sym.toUpperCase()}* not found.`, { parse_mode: 'Markdown' });
  }
  // Group-level override
  ensureGroup(chatId);
  config.groups[chatId].minBuyUSD = config.groups[chatId].minBuyUSD || {};
  config.groups[chatId].minBuyUSD[sym.toUpperCase()] = minUSD;
  saveConfig();
  await bot.sendMessage(chatId,
    `✅ Min buy for *${sym.toUpperCase()}* set to *$${minUSD}* in this group.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = String(msg.chat.id);
  const uptime = getUptimeStr();
  const rpcStatus = activeRpc ? `✅ ${activeRpc.split('/')[2]}` : '❌ None';
  const tokenList = config.tokens.map(t => `• *${t.symbol}*`).join('\n') || '_(none)_';
  await bot.sendMessage(chatId,
`📊 *AGENT BUYBOT Stats*
━━━━━━━━━━━━━━━━━━
✅ Total buys detected: *${totalBuysDetected}*
🪙 Tokens watched: *${config.tokens.length}*
🏠 Groups active: *${Object.keys(config.groups).length}*
⏱ Uptime: *${uptime}*
🌐 RPC: ${rpcStatus}
💎 SUI Price: *$${suiPrice.toFixed(3)}*
🔄 Poll interval: *${POLL_INTERVAL_MS / 1000}s*

*Tokens:*
${tokenList}

💧 *DEXes:* Cetus 🐋 Turbos 🌀 Bluefin 🐬

⚡ _AGENT BUYBOT v${BOT_VERSION}_`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/pause/, async (msg) => {
  const chatId = String(msg.chat.id);
  ensureGroup(chatId);
  config.groups[chatId].paused = true;
  saveConfig();
  await bot.sendMessage(chatId, '⏸ Buy alerts *paused* for this group. Use /resume to re\\-enable\\.', { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/resume/, async (msg) => {
  const chatId = String(msg.chat.id);
  ensureGroup(chatId);
  config.groups[chatId].paused = false;
  saveConfig();
  await bot.sendMessage(chatId, '▶️ Buy alerts *resumed*\\.', { parse_mode: 'MarkdownV2' });
});

// ─── UTILITY ─────────────────────────────────────────────────────────────────

// Escape special chars for MarkdownV2
function escMd(str) {
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// ─── ERROR HANDLING ───────────────────────────────────────────────────────────

bot.on('polling_error', (err) => {
  log(`[Polling error] ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log(`[Unhandled rejection] ${reason}`);
});

process.on('uncaughtException', (err) => {
  log(`[Uncaught exception] ${err.message}`);
});

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  log('🤖 AGENT BUYBOT starting up...');
  log(`📦 Version: ${BOT_VERSION}`);
  log(`🔄 Poll interval: ${POLL_INTERVAL_MS}ms`);

  // Initial price fetch
  await fetchSuiPrice();

  // Start price refresh (every 60s)
  setInterval(fetchSuiPrice, 60_000);

  // Start polling loop
  log('🚀 Starting event polling...');
  setInterval(async () => {
    try { await pollLoop(); }
    catch (e) { log(`[Poll loop error] ${e.message}`); }
  }, POLL_INTERVAL_MS);

  log('✅ AGENT BUYBOT is live! Send /start to your Telegram group.');
}

main().catch(console.error);
