// ════════════════════════════════════════════════════════════════════
// Agent 007 Buy Bot — Sui blockchain buy alert bot for Telegram
//
// Setup:
//   1. Create a bot via @BotFather, copy the token
//   2. Set TG_BUYBOT_TOKEN=<token> in your .env (or environment)
//   3. Add the bot as admin to your channel/group
//   4. Send /addca <coinType> in the channel/group to start tracking
//
// Supports:
//   • AGENT MemeLand tokens (TOKEN/AGENT Cetus pool — 2-hop route)
//   • Any other Sui token (TOKEN/SUI Cetus pool — 1-hop route)
//   Auto-detected from the coinType provided.
//
// Commands:
//   /addca <coinType>    — track a token's buys in this chat
//   /removeca <coinType> — stop tracking
//   /listca              — list tracked tokens
//   /status              — bot health
// ════════════════════════════════════════════════════════════════════

import TelegramBot from 'node-telegram-bot-api';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ── Config ────────────────────────────────────────────────────────────
const TG_TOKEN   = process.env.TG_BUYBOT_TOKEN   || '';
const SUI_RPC    = process.env.SUI_RPC_URL        || getFullnodeUrl('mainnet');
const DB_FILE    = './buybot_db.json';
const POLL_MS    = 12_000;

const SUI_T   = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const AGENT_T = '0x5613a7e1f4f8fc7b896781aaba9b52944763e14421458d14c829223541d77c1c::agent::AGENT';

// Cetus CLMM mainnet — swap event type
const CETUS_PKG    = '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb';
const SWAP_EVENT_T = `${CETUS_PKG}::pool::SwapEvent`;

const SUISCAN     = 'https://suiscan.xyz/mainnet/tx/';
const SUISCAN_ACC = 'https://suiscan.xyz/mainnet/account/';
const GECKO       = 'https://api.geckoterminal.com/api/v2';
const AGENT_API   = process.env.AGENT_LAUNCHPAD_URL || 'https://backend-production-d4c4b.up.railway.app';

if (!TG_TOKEN) {
  console.error('❌  TG_BUYBOT_TOKEN is not set. Add it to your .env file.');
  process.exit(1);
}

// ── Suppress verbose TLS/socket dumps that blow Railway's log rate limit ──
// node-telegram-bot-api prints full request objects on network errors; we
// intercept unhandled rejections and uncaught exceptions to log only the
// message string, never the giant socket/TLS object.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (!msg.includes('ETELEGRAM') && !msg.includes('EFATAL')) return; // ignore TG noise
  console.error('Unhandled rejection:', msg);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message || err);
});

const sui = new SuiClient({ url: SUI_RPC });
// request timeout keeps connections from hanging and producing socket dump logs
const bot = new TelegramBot(TG_TOKEN, {
  polling: { timeout: 20, limit: 100 },
  request: { timeout: 30000 },
});

// ── Database ──────────────────────────────────────────────────────────
// Schema: { channels: { [chatId]: { tokens: TokenConfig[] } } }
let DB = { channels: {} };

function loadDB() {
  try {
    if (existsSync(DB_FILE)) DB = JSON.parse(readFileSync(DB_FILE, 'utf8'));
  } catch(e) { console.error('loadDB:', e.message); }
}

function saveDB() {
  try { writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); }
  catch(e) { console.error('saveDB:', e.message); }
}

function getTokens(chatId) {
  const id = String(chatId);
  if (!DB.channels[id]) DB.channels[id] = { tokens: [] };
  return DB.channels[id].tokens;
}

loadDB();

// ── HTTP helper ───────────────────────────────────────────────────────
async function jget(url, ms = 8000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ── Sui helpers ───────────────────────────────────────────────────────
// Normalise address to 0x + 64 hex chars for safe comparison
function normAddr(s) {
  if (!s) return '';
  const hex = s.toLowerCase().replace(/^0x/, '');
  return '0x' + hex.padStart(64, '0');
}

const _metaCache = new Map();
async function getMeta(coinType) {
  if (_metaCache.has(coinType)) return _metaCache.get(coinType);
  try {
    const r = await sui.getCoinMetadata({ coinType });
    const m = { sym: r?.symbol || '?', name: r?.name || '?', dec: r?.decimals ?? 9 };
    _metaCache.set(coinType, m);
    return m;
  } catch { return { sym: '?', name: '?', dec: 9 }; }
}

async function getPoolCoins(poolId) {
  try {
    const o    = await sui.getObject({ id: poolId, options: { showType: true } });
    const args = o.data?.type?.match(/<(.+)>$/)?.[1]?.split(/,\s*/).map(s => s.trim());
    if (args?.length >= 2) return { coinA: args[0], coinB: args[1] };
  } catch {}
  return null;
}

// ── Pool finder (3-source fallback) ──────────────────────────────────
async function findPool(coinType) {
  const SUI_N   = normAddr(SUI_T.split('::')[0]);
  const AGENT_N = normAddr(AGENT_T.split('::')[0]);
  const ct_N    = normAddr(coinType.split('::')[0]);

  function classifyPair(coinA, coinB) {
    const a = (coinA || '').toLowerCase(), b = (coinB || '').toLowerCase();
    const aN = normAddr(a.split('::')[0]), bN = normAddr(b.split('::')[0]);
    const aIsSui  = aN === SUI_N   || a.endsWith('::sui::sui');
    const bIsSui  = bN === SUI_N   || b.endsWith('::sui::sui');
    const aIsAgt  = aN === AGENT_N;
    const bIsAgt  = bN === AGENT_N;
    if (aIsSui || bIsSui)  return 'SUI';
    if (aIsAgt || bIsAgt)  return 'AGENT';
    return null;
  }

  const pkg = coinType.split('::')[0];

  // ── Source 1: GeckoTerminal
  for (const q of [coinType, pkg]) {
    let data = [];
    try {
      const r = await jget(`${GECKO}/networks/sui-network/tokens/${encodeURIComponent(q)}/pools?limit=10`);
      data = r?.data || [];
    } catch { continue; }

    for (const p of data) {
      const addr = p.attributes?.address;
      if (!addr) continue;
      const coins = await getPoolCoins(addr).catch(() => null);
      if (!coins) continue;
      const pairType = classifyPair(coins.coinA, coins.coinB);
      if (pairType) return { poolId: addr, ...coins, pairType };
    }
  }

  // ── Source 2: Cetus API
  try {
    const r = await jget(
      `https://api-sui.cetus.zone/v2/sui/pools_info?coin_type=${encodeURIComponent(coinType)}&limit=10&order_by=tvl&order=desc`
    );
    for (const p of r?.data?.list || []) {
      const pairType = classifyPair(p.coin_type_a, p.coin_type_b);
      if (pairType) {
        return {
          poolId:   p.pool_address || p.id,
          coinA:    p.coin_type_a,
          coinB:    p.coin_type_b,
          pairType,
        };
      }
    }
  } catch {}

  // ── Source 3: AGENT MemeLand Railway backend (authoritative for MemeLand tokens)
  try {
    const j   = await jget(`${AGENT_API}/memeland/tokens`);
    const arr = Array.isArray(j?.tokens) ? j.tokens : [];
    const t   = arr.find(x => (x.coinType || '').toLowerCase() === coinType.toLowerCase());
    if (t?.poolId) {
      const coins = await getPoolCoins(t.poolId);
      if (coins) {
        const pairType = classifyPair(coins.coinA, coins.coinB) || 'AGENT';
        return { poolId: t.poolId, ...coins, pairType };
      }
    }
  } catch {}

  return null;
}

// ── Buy detection ─────────────────────────────────────────────────────
// Returns true if the Cetus SwapEvent represents a BUY of the tracked token.
// A buy = the pair coin (SUI or AGENT) is flowing IN, token is flowing OUT.
//
// Cetus SwapEvent fields:
//   pool       — pool address
//   a2b        — true = CoinA→CoinB direction; false = CoinB→CoinA
//   amount_in  — raw input amount (the coin going IN)
//   amount_out — raw output amount (the coin coming OUT)
//
// Logic:
//   token = CoinA → buy direction is CoinB→CoinA = a2b:false
//   token = CoinB → buy direction is CoinA→CoinB = a2b:true
function isBuy(ev, tok) {
  const j = ev.parsedJson;
  if (!j) return false;
  const evPool = normAddr(j.pool || j.pool_address || '');
  const myPool = normAddr(tok.poolId);
  if (!evPool || !myPool || evPool !== myPool) return false;

  const a2b      = j.a2b === true || j.a2b === 'true';
  const tokenIsA = (tok.coinA || '').toLowerCase() === tok.coinType.toLowerCase();

  return tokenIsA ? !a2b : a2b;
}

// ── Reference prices ──────────────────────────────────────────────────
let _agentPriceSui = 0.005; // AGENT/SUI — fallback
let _suiUsd        = 2.50;  // SUI/USD   — fallback

async function refreshPrices() {
  try {
    // AGENT price in SUI
    const d = await jget(`${GECKO}/networks/sui-network/tokens/${encodeURIComponent(AGENT_T)}`);
    const p = parseFloat(d?.data?.attributes?.price_in_native_currency || 0);
    if (p > 0) _agentPriceSui = p;
    // SUI/USD from same call (native = SUI so price_usd / price_native = SUI/USD)
    const pUsd = parseFloat(d?.data?.attributes?.price_usd || 0);
    const pNat = parseFloat(d?.data?.attributes?.price_in_native_currency || 0);
    if (pUsd > 0 && pNat > 0) _suiUsd = pUsd / pNat;
  } catch {}
  // Direct SUI/USD fallback via CoinGecko simple price
  if (_suiUsd <= 0) {
    try {
      const g = await jget(`https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd`, 5000);
      if (g?.sui?.usd) _suiUsd = g.sui.usd;
    } catch {}
  }
}
setInterval(refreshPrices, 120_000);
refreshPrices();

// ── Market data fetcher (per-token, 30s TTL cache) ────────────────────
// Returns: { priceUsd, priceSui, mcapUsd, vol24Usd, liqUsd, holders, progress }
const _mktCache = new Map();
const MKT_TTL   = 30_000;

async function fetchMarketData(tok) {
  const key = tok.coinType;
  const cached = _mktCache.get(key);
  if (cached && Date.now() - cached.ts < MKT_TTL) return cached.data;

  const data = {
    priceUsd: 0, priceSui: 0,
    mcapUsd: 0, vol24Usd: 0, liqUsd: 0,
    holders: null,
  };

  // ── GeckoTerminal token endpoint
  try {
    const r = await jget(`${GECKO}/networks/sui-network/tokens/${encodeURIComponent(tok.coinType)}`, 5000);
    const a = r?.data?.attributes || {};
    data.priceUsd = parseFloat(a.price_usd || 0);
    data.priceSui = parseFloat(a.price_in_native_currency || 0);
    data.mcapUsd  = parseFloat(a.market_cap_usd || a.fdv_usd || 0);
    data.vol24Usd = parseFloat(a.volume_usd?.h24 || 0);
  } catch {}

  // ── GeckoTerminal pool endpoint (liquidity)
  if (tok.poolId) {
    try {
      const r = await jget(`${GECKO}/networks/sui-network/pools/${encodeURIComponent(tok.poolId)}`, 5000);
      const a = r?.data?.attributes || {};
      if (!data.vol24Usd) data.vol24Usd = parseFloat(a.volume_usd?.h24 || 0);
      data.liqUsd = parseFloat(a.reserve_in_usd || 0);
      if (!data.priceUsd) data.priceUsd = parseFloat(a.base_token_price_usd || 0);
      if (!data.priceSui) data.priceSui = parseFloat(a.base_token_price_native_currency || 0);
      if (!data.mcapUsd)  data.mcapUsd  = parseFloat(a.market_cap_usd || a.fdv_usd || 0);
    } catch {}
  }

  // ── AGENT MemeLand backend (holders, progress, and price override)
  if (tok.pairType === 'AGENT') {
    try {
      const j   = await jget(`${AGENT_API}/memeland/tokens`, 6000);
      const arr = Array.isArray(j?.tokens) ? j.tokens : [];
      const t   = arr.find(x => (x.coinType || '').toLowerCase() === tok.coinType.toLowerCase());
      if (t) {
        if (t.holders != null)    data.holders  = t.holders;
        if (!data.priceUsd && t.priceUsd) data.priceUsd = parseFloat(t.priceUsd);
        if (!data.priceSui && t.priceSui) data.priceSui = parseFloat(t.priceSui);
        if (!data.mcapUsd && (t.marketCap || t.marketCapUsd))
          data.mcapUsd = parseFloat(t.marketCap || t.marketCapUsd || 0);
      }
    } catch {}
  }

  // Derive missing values
  if (data.priceSui > 0 && !data.priceUsd) data.priceUsd = data.priceSui * _suiUsd;
  if (data.priceUsd > 0 && !data.priceSui) data.priceSui = data.priceUsd / _suiUsd;

  _mktCache.set(key, { ts: Date.now(), data });
  return data;
}

// ── Alert formatter ───────────────────────────────────────────────────
function buyTier(suiVal) {
  if (suiVal >= 50) return { badge: '🐳 MEGA WHALE',  glow: '💎🚀💎' };
  if (suiVal >= 20) return { badge: '🐋 WHALE BUY',   glow: '🚀🚀'   };
  if (suiVal >= 5)  return { badge: '🐬 BIG BUY',     glow: '💰💰'   };
  if (suiVal >= 1)  return { badge: '🐟 BUY',         glow: '💸'     };
  return                   { badge: '🦐 BUY',         glow: ''       };
}

function buyBar(suiVal) {
  const steps = [0.1, 0.5, 1, 2, 5, 10, 20, 50];
  const filled = steps.filter(s => suiVal >= s).length;
  return '🟩'.repeat(filled) + '⬜'.repeat(steps.length - filled);
}


function fmtAmt(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(2)     + 'M';
  if (n >= 1_000)         return (n / 1_000).toFixed(2)         + 'K';
  return n.toFixed(4);
}

function fmtUsd(n) {
  if (!n || n <= 0) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}K`;
  if (n >= 1)         return `$${n.toFixed(2)}`;
  if (n >= 0.01)      return `$${n.toFixed(4)}`;
  return `$${n.toExponential(3)}`;
}

function fmtPrice(sui, usd) {
  const parts = [];
  if (sui  > 0) parts.push(`${sui < 0.001 ? sui.toExponential(3) : sui.toFixed(6)} SUI`);
  if (usd  > 0) parts.push(fmtUsd(usd));
  return parts.join('  /  ') || 'n/a';
}

function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || '?';
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

async function buildAlert(tok, ev) {
  const j = ev.parsedJson;

  // amount_in = pair spent (SUI/AGENT), amount_out = token received
  const pairRaw  = BigInt(j.amount_in  || 0);
  const tokenRaw = BigInt(j.amount_out || 0);

  const tokenAmt = Number(tokenRaw) / Math.pow(10, tok.dec);
  let pairAmt, suiEquiv, pairLabel;

  if (tok.pairType === 'SUI') {
    pairAmt   = Number(pairRaw) / 1e9;
    pairLabel = 'SUI';
    suiEquiv  = pairAmt;
  } else {
    pairAmt   = Number(pairRaw) / 1e9; // AGENT = 9 decimals
    pairLabel = 'AGENT';
    suiEquiv  = pairAmt * _agentPriceSui;
  }

  const spentUsd = suiEquiv * _suiUsd;
  const { badge, glow } = buyTier(suiEquiv);
  const bar    = buyBar(suiEquiv);
  const buyer  = ev.sender || '?';
  const digest = ev.id?.txDigest || '';
  const route  = tok.pairType === 'AGENT' ? '🟢 AGENT MemeLand' : '🔵 Cetus CLMM';

  // Fetch live market data (cached 30s)
  const mkt = await fetchMarketData(tok).catch(() => ({
    priceUsd: 0, priceSui: 0, mcapUsd: 0, vol24Usd: 0, liqUsd: 0,
    holders: null, progress: null,
  }));

  // ── Build message ──────────────────────────────────────────────────
  let msg =
    `${glow ? glow + ' ' : ''}*${badge}*\n` +
    `*${tok.sym}*  —  ${tok.name}\n` +
    `${bar}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n`;

  // Spent line
  msg += `💰 *Spent:*   \`${fmtAmt(pairAmt)} ${pairLabel}\``;
  if (tok.pairType === 'AGENT') msg += `  _(≈ ${suiEquiv.toFixed(3)} SUI)_`;
  if (spentUsd > 0) msg += `  _(${fmtUsd(spentUsd)})_`;
  msg += '\n';

  // Got line
  msg += `📦 *Got:*     \`${fmtAmt(tokenAmt)} ${tok.sym}\`\n`;

  // ── Market data section ─────────────────────────────────────────
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;

  // Price
  if (mkt.priceSui > 0 || mkt.priceUsd > 0) {
    msg += `💵 *Price:*   \`${fmtPrice(mkt.priceSui, mkt.priceUsd)}\`\n`;
  }

  // Market cap
  if (mkt.mcapUsd > 0) {
    msg += `💹 *Mkt Cap:* \`${fmtUsd(mkt.mcapUsd)}\`\n`;
  }

  // 24h volume
  if (mkt.vol24Usd > 0) {
    msg += `📊 *24h Vol:* \`${fmtUsd(mkt.vol24Usd)}\`\n`;
  }

  // Liquidity
  if (mkt.liqUsd > 0) {
    msg += `💧 *Liq:*     \`${fmtUsd(mkt.liqUsd)}\`\n`;
  }

  // Holders
  if (mkt.holders != null && mkt.holders > 0) {
    msg += `👥 *Holders:* \`${Number(mkt.holders).toLocaleString()}\`\n`;
  }

  // ── Footer ────────────────────────────────────────────────────────
  msg +=
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 [${shortAddr(buyer)}](${SUISCAN_ACC}${buyer})\n` +
    `🔗 [View TX](${SUISCAN}${digest})  ·  ${route}`;

  return msg;
}

// ── Poll engine ───────────────────────────────────────────────────────
let _cursor = null;
const _seen = new Set(); // event deduplication: txDigest:eventSeq

async function initCursor() {
  // Start from the current tip — skip all historical events
  try {
    const r = await sui.queryEvents({
      query: { MoveEventType: SWAP_EVENT_T },
      limit: 1,
      order: 'descending',
    });
    if (r.data?.length) {
      _cursor = r.data[0].id;
      console.log('✅ Event cursor initialised to chain tip.');
    }
  } catch(e) { console.error('initCursor error:', e.message); }
}

async function poll() {
  // Build pool → { tokenCfg, chatIds[] } index from DB
  const poolIdx = new Map();
  for (const [cid, ch] of Object.entries(DB.channels)) {
    for (const tok of (ch.tokens || [])) {
      const key = normAddr(tok.poolId);
      if (!poolIdx.has(key)) poolIdx.set(key, { tok, chatIds: [] });
      poolIdx.get(key).chatIds.push(cid);
    }
  }
  if (!poolIdx.size) return;

  try {
    const result = await sui.queryEvents({
      query:  { MoveEventType: SWAP_EVENT_T },
      cursor: _cursor,
      limit:  50,
      order:  'ascending',
    });

    for (const ev of result.data) {
      // Deduplicate
      const evKey = `${ev.id?.txDigest}:${ev.id?.eventSeq}`;
      if (_seen.has(evKey)) continue;
      _seen.add(evKey);
      if (_seen.size > 5000) { _seen.delete(_seen.values().next().value); }

      // Match against tracked pools
      const evPool = normAddr(ev.parsedJson?.pool || ev.parsedJson?.pool_address || '');
      const entry  = poolIdx.get(evPool);
      if (!entry) continue;

      // Is it a buy?
      if (!isBuy(ev, entry.tok)) continue;

      // Fire alert to all chats tracking this token
      const msg = await buildAlert(entry.tok, ev);
      for (const cid of entry.chatIds) {
        bot.sendMessage(cid, msg, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }).catch(e => console.error(`Alert send to ${cid}:`, e.message));
      }
    }

    // Advance cursor
    if (result.nextCursor) _cursor = result.nextCursor;
    else if (result.data?.length) _cursor = result.data.at(-1).id;
  } catch(e) {
    console.error('poll error:', e.message);
  }
}

// ── Admin verification ────────────────────────────────────────────────
async function isAdmin(chatId, userId, chatType) {
  // Private chats — always allow (the user is the only one here)
  if (chatType === 'private') return true;
  try {
    const m = await bot.getChatMember(chatId, userId);
    return ['administrator', 'creator'].includes(m.status);
  } catch {
    // Can't read member list — allow through to avoid blocking real admins
    return true;
  }
}

// ── Inline keyboard helpers ───────────────────────────────────────────
const KB_MAIN = {
  inline_keyboard: [
    [
      { text: '📋 List Tokens',   callback_data: 'list'   },
      { text: '📊 Status',        callback_data: 'status' },
    ],
    [
      { text: '➕ How to Add a Token', callback_data: 'help_add' },
    ],
  ],
};

function kbRemoveList(toks) {
  // Use array index in callback_data — coinTypes exceed Telegram's 64-byte limit
  const rows = toks.map((t, i) => ([{
    text: `❌ Remove ${t.sym}`,
    callback_data: `rm:${i}`,
  }]));
  rows.push([{ text: '🏠 Menu', callback_data: 'menu' }]);
  return { inline_keyboard: rows };
}

function kbBack() {
  return { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'menu' }]] };
}

function kbAfterAdd(chatId) {
  return {
    inline_keyboard: [[
      { text: '📋 List Tokens', callback_data: 'list'   },
      { text: '🏠 Menu',        callback_data: 'menu'   },
    ]],
  };
}

// ── Command handlers ──────────────────────────────────────────────────
function startText() {
  return (
    `🤖 *Agent 007 Buy Bot*\n\n` +
    `Real-time buy alerts for Sui tokens — straight to your group or channel.\n\n` +
    `*Quick setup:*\n` +
    `① Add me as *admin* to your group or channel\n` +
    `② Run \`/addca <coinType>\` in that chat\n` +
    `③ Live buy alerts appear automatically!\n\n` +
    `_Supports AGENT MemeLand tokens and any SUI-paired Cetus token._`
  );
}

function statusText() {
  const totalToks  = Object.values(DB.channels).reduce((s, c) => s + (c.tokens?.length || 0), 0);
  const totalChats = Object.keys(DB.channels).length;
  return (
    `🤖 *Agent 007 Buy Bot*\n\n` +
    `Status:    ✅ Online\n` +
    `Tracking:  *${totalToks} token(s)* across *${totalChats} chat(s)*\n` +
    `Poll rate: every ${POLL_MS / 1000}s\n` +
    `Network:   Sui Mainnet`
  );
}

function listText(chatId) {
  const toks = getTokens(chatId);
  if (!toks.length) return null;
  const lines = toks.map((t, i) => {
    const pair = t.pairType === 'AGENT' ? '🟢 AGENT-paired' : '🔵 SUI-paired';
    return `${i + 1}. *${t.sym}* — ${pair}\n   \`${t.coinType.slice(0, 50)}${t.coinType.length > 50 ? '…' : ''}\``;
  }).join('\n\n');
  return `📋 *Tracked tokens (${toks.length})*\n\n${lines}`;
}

const HELP_ADD_TEXT =
  `➕ *How to track a token*\n\n` +
  `Send this command in your group or channel:\n\n` +
  `\`/addca <coinType>\`\n\n` +
  `*Example:*\n` +
  `\`/addca 0x5613a7e1::agent::AGENT\`\n\n` +
  `The coin type is the full on-chain address for the token. Find it on SuiScan or the token page on agent.land\n\n` +
  `To remove a token:\n` +
  `\`/removeca <coinType>\``;

async function handleMsg(msg) {
  if (!msg || !msg.text) return;
  const chatId   = msg.chat.id;
  const chatType = msg.chat.type;           // 'private' | 'group' | 'supergroup' | 'channel'
  const userId   = msg.from?.id || null;
  // Strip @BotName suffix Telegram appends to commands in groups (/cmd@BotName → /cmd)
  const text = (msg.text || '').trim().replace(/@\w+/, '');

  if (/^\/start/.test(text)) {
    return bot.sendMessage(chatId, startText(), {
      parse_mode: 'Markdown',
      reply_markup: KB_MAIN,
    });
  }

  if (/^\/status/.test(text)) {
    return bot.sendMessage(chatId, statusText(), {
      parse_mode: 'Markdown',
      reply_markup: kbBack(),
    });
  }

  if (/^\/listca/.test(text)) {
    const toks = getTokens(chatId);
    if (!toks.length) {
      return bot.sendMessage(chatId,
        `📭 *No tokens tracked here yet.*\n\nUse \`/addca <coinType>\` to start tracking a token.`,
        { parse_mode: 'Markdown', reply_markup: kbBack() }
      );
    }
    return bot.sendMessage(chatId, listText(chatId), {
      parse_mode: 'Markdown',
      reply_markup: kbRemoveList(toks),
    });
  }

  const addMatch = text.match(/^\/addca\s+(.+)/);
  if (addMatch) return cmdAddCA(chatId, userId, chatType, addMatch[1].trim(), null);

  const remMatch = text.match(/^\/removeca\s+(.+)/);
  if (remMatch) return cmdRemoveCA(chatId, userId, chatType, remMatch[1].trim(), null);
}

async function cmdAddCA(chatId, userId, chatType, ct, msgId) {
  if (userId !== null && !(await isAdmin(chatId, userId, chatType))) {
    const err = '❌ Only channel/group admins can add tokens.';
    return msgId
      ? bot.editMessageText(err, { chat_id: chatId, message_id: msgId })
      : bot.sendMessage(chatId, err);
  }

  if (!ct.includes('::') || ct.length < 20) {
    const err =
      `❌ *Invalid coin type.*\n\nExpected format:\n\`0x<package>::<module>::<TYPE>\`\n\n` +
      `Find the coin type on SuiScan or agent.land`;
    return msgId
      ? bot.editMessageText(err, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' })
      : bot.sendMessage(chatId, err, { parse_mode: 'Markdown', reply_markup: kbBack() });
  }

  const toks = getTokens(chatId);
  if (toks.find(t => t.coinType.toLowerCase() === ct.toLowerCase())) {
    const warn = `⚠️ Already tracking that token in this chat.`;
    return msgId
      ? bot.editMessageText(warn, { chat_id: chatId, message_id: msgId, reply_markup: kbBack() })
      : bot.sendMessage(chatId, warn, { reply_markup: kbBack() });
  }

  const sent = msgId
    ? await bot.editMessageText(
        `⏳ Detecting pool…\n_Checking GeckoTerminal, Cetus, and AGENT backend…_`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
      ).catch(() => null)
    : await bot.sendMessage(chatId,
        `⏳ Detecting pool for \`${ct.slice(0, 40)}…\`\n_Checking GeckoTerminal, Cetus, and AGENT backend…_`,
        { parse_mode: 'Markdown' }
      );

  const editId = sent?.message_id ?? msgId;

  try {
    const pool = await findPool(ct);
    if (!pool) throw new Error(
      `No Cetus pool found for this token.\n` +
      `It may not be listed yet, or the pool has no liquidity.\n` +
      `For AGENT MemeLand tokens make sure the pool is live on agent.land`
    );

    const meta = await getMeta(ct);
    toks.push({
      coinType: ct, sym: meta.sym, name: meta.name, dec: meta.dec,
      poolId: pool.poolId, coinA: pool.coinA, coinB: pool.coinB,
      pairType: pool.pairType, addedAt: Date.now(),
    });
    saveDB();

    const pairLabel = pool.pairType === 'AGENT'
      ? '🟢 TOKEN / AGENT (AGENT MemeLand)'
      : '🔵 TOKEN / SUI (Cetus CLMM)';

    await bot.editMessageText(
      `✅ *Now tracking ${meta.sym}!*\n\n` +
      `Token:  *${meta.name}*\n` +
      `Pair:   ${pairLabel}\n` +
      `Pool:   \`${pool.poolId.slice(0, 44)}…\`\n\n` +
      `🔔 Buy alerts will appear here automatically.`,
      { chat_id: chatId, message_id: editId, parse_mode: 'Markdown', reply_markup: kbAfterAdd(chatId) }
    );
  } catch(e) {
    await bot.editMessageText(
      `❌ *Failed to add token*\n\n${e.message}`,
      { chat_id: chatId, message_id: editId, parse_mode: 'Markdown', reply_markup: kbBack() }
    );
  }
}

async function cmdRemoveCA(chatId, userId, chatType, ct, msgId) {
  if (userId !== null && !(await isAdmin(chatId, userId, chatType))) {
    const err = '❌ Only admins can remove tokens.';
    return msgId
      ? bot.editMessageText(err, { chat_id: chatId, message_id: msgId })
      : bot.sendMessage(chatId, err);
  }
  const toks = getTokens(chatId);
  const norm = ct.toLowerCase();
  const idx  = toks.findIndex(t =>
    t.coinType.toLowerCase() === norm || t.sym.toLowerCase() === norm
  );
  if (idx === -1) {
    const err = `❌ Token not found. Use /listca to see what's tracked here.`;
    return msgId
      ? bot.editMessageText(err, { chat_id: chatId, message_id: msgId, reply_markup: kbBack() })
      : bot.sendMessage(chatId, err, { reply_markup: kbBack() });
  }
  const removed = toks.splice(idx, 1)[0];
  saveDB();
  const ok = `✅ *Stopped tracking ${removed.sym}.*`;
  return msgId
    ? bot.editMessageText(ok, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: kbBack() })
    : bot.sendMessage(chatId, ok, { parse_mode: 'Markdown', reply_markup: kbBack() });
}

// ── Inline button callbacks ───────────────────────────────────────────
async function handleCallback(query) {
  const chatId   = query.message.chat.id;
  const chatType = query.message.chat.type;
  const msgId    = query.message.message_id;
  const userId   = query.from?.id || null;
  const data     = query.data || '';

  // Always acknowledge the tap immediately
  bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === 'menu') {
    return bot.editMessageText(startText(), {
      chat_id: chatId, message_id: msgId,
      parse_mode: 'Markdown', reply_markup: KB_MAIN,
    });
  }

  if (data === 'status') {
    return bot.editMessageText(statusText(), {
      chat_id: chatId, message_id: msgId,
      parse_mode: 'Markdown', reply_markup: kbBack(),
    });
  }

  if (data === 'list') {
    const toks = getTokens(chatId);
    if (!toks.length) {
      return bot.editMessageText(
        `📭 *No tokens tracked here yet.*\n\nUse \`/addca <coinType>\` to start tracking a token.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: kbBack() }
      );
    }
    return bot.editMessageText(listText(chatId), {
      chat_id: chatId, message_id: msgId,
      parse_mode: 'Markdown', reply_markup: kbRemoveList(toks),
    });
  }

  if (data === 'help_add') {
    return bot.editMessageText(HELP_ADD_TEXT, {
      chat_id: chatId, message_id: msgId,
      parse_mode: 'Markdown', reply_markup: kbBack(),
    });
  }

  if (data.startsWith('rm:')) {
    // data = 'rm:<index>' — look up the coinType by index to stay under 64-byte limit
    const idx  = parseInt(data.slice(3), 10);
    const toks = getTokens(chatId);
    const tok  = toks[idx];
    if (!tok) {
      return bot.editMessageText(
        `❌ Token not found. The list may have changed — use /listca to refresh.`,
        { chat_id: chatId, message_id: msgId, reply_markup: kbBack() }
      );
    }
    return cmdRemoveCA(chatId, userId, chatType, tok.coinType, msgId);
  }
}

// ── Telegram listeners ────────────────────────────────────────────────
bot.on('message',         handleMsg);
bot.on('channel_post',    handleMsg);
bot.on('callback_query',  handleCallback);
bot.on('polling_error',   e => console.error('Polling error:', e.code || e.message));

// ── Startup ───────────────────────────────────────────────────────────
async function main() {
  console.log('🤖 Agent 007 Buy Bot starting…');
  await initCursor();
  setInterval(poll, POLL_MS);
  console.log(`✅ Polling Sui mainnet every ${POLL_MS / 1000}s for buy events.`);
  console.log(`📊 Tracking ${Object.values(DB.channels).reduce((s,c) => s+(c.tokens?.length||0), 0)} token(s) across ${Object.keys(DB.channels).length} chat(s).`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
