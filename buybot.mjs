/**
 * ╔══════════════════════════════════════════════════╗
 * ║           🤖  AGENT BUYBOT  v2.0               ║
 * ║  Sui Buy Tracker — Cetus · Turbos · Bluefin     ║
 * ║  Button-wizard setup · No commands in group     ║
 * ╚══════════════════════════════════════════════════╝
 *
 * ROOT-CAUSE FIX from v1:
 *   Old code matched token address inside Cetus event JSON.
 *   Cetus SwapEvent contains ONLY pool address — never coin type.
 *   Fix: SUI-scale heuristic (MIST range) detects buy vs sell correctly
 *   for every pool without needing the coin address in the event.
 *
 * UX (mirrors Bublz, improved):
 *   • Bot added to group → sends "Set Up in DM" button
 *   • DM /start → inline group picker
 *   • Tap group → settings panel (all inline buttons)
 *   • Track Token / Min Buy / Buy Step / Emoji / Max Emojis / Media
 *   • All input collected conversationally in DM — zero commands in group
 */

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios       from 'axios';
import fs          from 'fs';
import path        from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const BOT_VERSION   = '2.0.0';
const CONFIG_FILE   = path.join(__dirname, 'config.json');
const POLL_MS       = 4_000;
const PRICE_REFRESH = 60_000;
const DEDUP_TTL     = 600_000;
const AGENT_LINK    = 'https://t.me/Sui_Agent/1';

// SUI MIST range for buy/sell heuristic (0.001 SUI → 100,000 SUI)
const SUI_MIST_MIN  = 1e6;
const SUI_MIST_MAX  = 1e14;

const SUI_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd';

const RPC_POOL = [
  'https://sui-mainnet.public.blastapi.io',
  'https://mainnet.suiet.app',
  'https://sui-mainnet-rpc.allthatnode.com',
  'https://rpc-mainnet.suiscan.xyz',
  'https://sui-rpc.publicnode.com',
  'https://fullnode.mainnet.sui.io',
];

// ─── DEX DEFINITIONS ─────────────────────────────────────────────────────────

const DEX = {
  cetus: {
    name: 'Cetus',
    icon: '🐋',
    event: '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent',
    // amount_in / amount_out — detect direction by SUI MIST scale
    parse(d) {
      const i = Number(d.amount_in), o = Number(d.amount_out);
      const isSui = (n) => n >= SUI_MIST_MIN && n <= SUI_MIST_MAX;
      if (isSui(i) && !isSui(o)) return { isBuy: true,  suiMist: i, tokNative: o };
      if (!isSui(i) && isSui(o)) return { isBuy: false, suiMist: o, tokNative: i };
      // fallback: atob=false = SUI→Token = BUY
      return d.atob === false
        ? { isBuy: true,  suiMist: i, tokNative: o }
        : { isBuy: false, suiMist: o, tokNative: i };
    },
    pool: (d) => d.pool || '',
  },
  turbos: {
    name: 'Turbos',
    icon: '🌀',
    event: '0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool::SwapEvent',
    parse(d) {
      const a = Number(d.amount_a), b = Number(d.amount_b);
      const isSui = (n) => n >= SUI_MIST_MIN && n <= SUI_MIST_MAX;
      if (isSui(a) && !isSui(b)) return { isBuy: true,  suiMist: a, tokNative: b };
      if (!isSui(a) && isSui(b)) return { isBuy: false, suiMist: b, tokNative: a };
      return d.a_to_b === true
        ? { isBuy: true,  suiMist: a, tokNative: b }
        : { isBuy: false, suiMist: b, tokNative: a };
    },
    pool: (d) => d.pool || '',
  },
  bluefin: {
    name: 'Bluefin',
    icon: '🐬',
    event: '0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::spot_dex::OrderFilled',
    parse(d) {
      // Bluefin: base = SUI, quote = token (or vice versa)
      const base  = Number(d.base_quantity  || d.quantity       || 0);
      const quote = Number(d.quote_quantity || d.filled_quantity || 0);
      const isSui = (n) => n >= SUI_MIST_MIN && n <= SUI_MIST_MAX;
      if (isSui(base) && !isSui(quote)) return { isBuy: true,  suiMist: base,  tokNative: quote };
      if (!isSui(base) && isSui(quote)) return { isBuy: false, suiMist: quote, tokNative: base };
      return { isBuy: true, suiMist: base, tokNative: quote };
    },
    pool: (d) => d.market_id || d.pool_id || '',
  },
};

// ─── WIZARD STATES ───────────────────────────────────────────────────────────

const S = {
  IDLE:       'idle',
  TOKEN:      'await_token',
  MIN_BUY:    'await_min_buy',
  BUY_STEP:   'await_buy_step',
  EMOJI:      'await_emoji',
  MAX_EMOJIS: 'await_max_emojis',
  MEDIA:      'await_media',
};

// ─── RUNTIME STATE ────────────────────────────────────────────────────────────

let config     = loadConfig();
let suiPrice   = 1.0;
let botUsername = 'AgentBuyBot';   // overwritten after bot.getMe()
let startTime  = Date.now();
let totalBuys  = 0;
let activeRpc  = null;

const seenTxs    = new Map();   // `dex:txHash` -> ts
const seenWallets = new Map();  // `groupId:wallet` -> true
const buyerCounts = new Map();  // `groupId` -> number
const dmSessions  = new Map();  // userId  -> { state, groupId, msgId }
const dexCursors  = {};         // `dex` -> cursor

// ─── CONFIG ──────────────────────────────────────────────────────────────────

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch { log('[Config] Parse error — using defaults'); }
  }
  return { version: BOT_VERSION, groups: {} };
}

/**
 * GroupConfig:
 * {
 *   groupName: string,
 *   tokenAddress: string|null,   // full 0x::module::COIN
 *   tokenSymbol:  string|null,
 *   decimals:     number,        // token decimals (default 6)
 *   totalSupply:  number|null,   // for mcap calc
 *   knownPools:   string[],      // optional pool filter
 *   minBuyUSD:    number,
 *   buyStep:      number,
 *   emoji:        string,
 *   maxEmojis:    number,
 *   media:        {type,fileId}|null,
 *   paused:       boolean,
 *   addedAt:      number
 * }
 */
function mkGroup(name) {
  return {
    groupName:    name || 'My Group',
    tokenAddress: null,
    tokenSymbol:  null,
    decimals:     6,
    totalSupply:  null,
    knownPools:   [],
    minBuyUSD:    0,
    buyStep:      100,
    emoji:        '🟢',
    maxEmojis:    20,
    media:        null,
    paused:       false,
    addedAt:      Date.now(),
  };
}

function ensureGroup(chatId, name) {
  if (!config.groups[chatId]) { config.groups[chatId] = mkGroup(name); save(); }
}

function save() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ─── LOGGING ─────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── FORMATTING ──────────────────────────────────────────────────────────────

function fmt$(n) {
  return '$' + parseFloat(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  return parseFloat(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function fmtPrice(p) {
  if (!p || p === 0) return 'N/A';
  if (p >= 0.01)     return '$' + p.toFixed(4);
  const s    = p.toFixed(20);
  const zeros = (s.match(/^0\.(0*)/) || ['', ''])[1].length;
  const sig   = s.replace('0.', '').replace(/^0+/, '').slice(0, 4);
  const sub   = zeros.toString().split('').map(d => '₀₁₂₃₄₅₆₇₈₉'[+d]).join('');
  return zeros > 2 ? `$0.0${sub}${sig}` : '$' + p.toFixed(8);
}

function fmtMcap(n) {
  if (!n || n <= 0) return 'N/A';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}

function shortAddr(a) {
  if (!a || a.length < 10) return a || '';
  return a.slice(0, 6) + '...' + a.slice(-4);
}

function bar(usd, emoji, step, max) {
  const n = Math.min(Math.ceil(usd / (step || 100)), max || 20);
  return (emoji || '🟢').repeat(Math.max(1, n));
}

function uptime() {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Escape for MarkdownV2
function e(str) {
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// ─── SUI RPC ─────────────────────────────────────────────────────────────────

async function rpc(method, params) {
  const endpoints = activeRpc
    ? [activeRpc, ...RPC_POOL.filter(u => u !== activeRpc)]
    : RPC_POOL;
  for (const url of endpoints) {
    try {
      const r = await axios.post(url,
        { jsonrpc: '2.0', id: 1, method, params },
        { timeout: 8000 }
      );
      if (r.data?.result !== undefined) { activeRpc = url; return r.data.result; }
    } catch { /* try next */ }
  }
  throw new Error('All Sui RPC endpoints unreachable');
}

async function refreshPrice() {
  try {
    const r = await axios.get(SUI_PRICE_URL, { timeout: 6000 });
    const p = r.data?.sui?.usd;
    if (p && p > 0) { suiPrice = p; log(`SUI $${p}`); }
  } catch (err) { log(`Price refresh failed: ${err.message}`); }
}

// ─── EVENT POLLING ────────────────────────────────────────────────────────────

async function poll() {
  // Build set of groups that have a token configured
  const active = Object.entries(config.groups).filter(([, g]) => g.tokenAddress && !g.paused);
  if (!active.length) return;

  for (const [dexKey, dex] of Object.entries(DEX)) {
    try {
      const result = await rpc('suix_queryEvents', [
        { MoveEventType: dex.event },
        dexCursors[dexKey] || null,
        50,
        false,
      ]);
      if (!result?.data?.length) continue;
      if (result.nextCursor) dexCursors[dexKey] = result.nextCursor;

      for (const event of result.data) {
        const txHash = event.id?.txDigest || '';
        if (!txHash) continue;
        const txKey = `${dexKey}:${txHash}`;
        if (seenTxs.has(txKey)) continue;
        seenTxs.set(txKey, Date.now());
        pruneDedup();

        const d = event.parsedJson;
        if (!d) continue;

        const parsed = dex.parse(d);
        if (!parsed.isBuy || !parsed.suiMist) continue;

        const eventPool = dex.pool(d);
        const wallet    = event.sender || '';
        const suiAmt    = parsed.suiMist / 1e9;
        const usdAmt    = suiAmt * suiPrice;

        // Send to every group whose token's knownPools matches (or has no pool filter)
        for (const [chatId, grp] of active) {
          // Pool filter
          if (grp.knownPools.length > 0 && eventPool &&
              !grp.knownPools.some(p => p === eventPool)) continue;

          const tokAmt = parsed.tokNative / 10 ** (grp.decimals || 6);
          const price  = tokAmt > 0 ? usdAmt / tokAmt : 0;
          const mcap   = (grp.totalSupply && price) ? price * grp.totalSupply : null;

          // Min buy filter
          if (usdAmt < (grp.minBuyUSD || 0)) continue;

          totalBuys++;
          const cnt = (buyerCounts.get(chatId) || 0) + 1;
          buyerCounts.set(chatId, cnt);
          const walletKey = `${chatId}:${wallet}`;
          const isNew     = !seenWallets.has(walletKey);
          if (wallet) seenWallets.set(walletKey, true);

          log(`🟢 ${grp.tokenSymbol} $${usdAmt.toFixed(2)} on ${dex.name} → ${chatId}`);

          await sendAlert(chatId, grp, {
            sym: grp.tokenSymbol, suiAmt, tokAmt, usdAmt,
            price, mcap, wallet, txHash, eventPool, buyNum: cnt, isNew,
          }, dex);
        }
      }
    } catch (err) {
      log(`[Poll:${dexKey}] ${err.message}`);
    }
  }
}

function pruneDedup() {
  const now = Date.now();
  for (const [k, v] of seenTxs) if (now - v > DEDUP_TTL) seenTxs.delete(k);
}

// ─── BUY ALERT ───────────────────────────────────────────────────────────────

function buildCaption(grp, buy, dex) {
  const buyBar    = bar(buy.usdAmt, grp.emoji, grp.buyStep, grp.maxEmojis);
  const wallet    = shortAddr(buy.wallet);
  const tokenAddr = grp.tokenAddress || '';

  const suiscanTx  = `https://suiscan.xyz/mainnet/tx/${buy.txHash}`;
  const chart      = `https://dexscreener.com/sui/${tokenAddr}`;
  const tokenLink  = `https://suiscan.xyz/mainnet/object/${tokenAddr}`;
  const walletLink = `https://suiscan.xyz/mainnet/account/${buy.wallet}`;

  const badges = [];
  if (buy.isNew)            badges.push('🆕 New Buyer\\!');
  if (buy.buyNum)           badges.push(`🏆 Buyer \\#${buy.buyNum}`);
  if (buy.usdAmt >= 5000)   badges.push('🦈 MEGA WHALE\\!');
  else if (buy.usdAmt >= 1000) badges.push('🐳 Whale Alert\\!');

  const badgeLine = badges.length ? `\n${badges.join('   ')}` : '';

  return (
`🤖 *AGENT BUYBOT*
━━━━━━━━━━━━━━━━━━━
*${e(buy.sym)}* Buy on *${e(dex.name)}* ${dex.icon}${badgeLine}

${buyBar}

💎 SUI: *$${e(suiPrice.toFixed(3))}*
💰 *${e(fmt$(buy.usdAmt))}* \\(${e(buy.suiAmt.toFixed(4))} SUI\\)
🪙 ${e(fmtTok(buy.tokAmt))} *${e(buy.sym)}*

📊 Price: *${e(fmtPrice(buy.price))}*
💹 MCap: *${e(fmtMcap(buy.mcap))}*

👤 [${e(wallet)}](${walletLink})
🔗 [TX](${suiscanTx}) \\| [Chart](${chart}) \\| [Token](${tokenLink})

⚡ _AGENT BUYBOT_ \\| [Join](${e(AGENT_LINK)})`
  );
}

async function sendAlert(chatId, grp, buy, dex) {
  const caption = buildCaption(grp, buy, dex);
  const opts    = { parse_mode: 'MarkdownV2', disable_web_page_preview: true };
  try {
    if (grp.media) {
      const { type, fileId } = grp.media;
      if (type === 'photo')     await bot.sendPhoto(chatId,     fileId, { caption, ...opts });
      else if (type === 'animation') await bot.sendAnimation(chatId, fileId, { caption, ...opts });
      else if (type === 'video')     await bot.sendVideo(chatId,     fileId, { caption, ...opts });
      else await bot.sendMessage(chatId, caption, opts);
    } else {
      await bot.sendMessage(chatId, caption, opts);
    }
  } catch (err) {
    log(`[Alert→${chatId}] ${err.message}`);
    if (/kicked|not found|deactivated|blocked/i.test(err.message)) {
      delete config.groups[chatId]; save();
      log(`[Alert] Removed dead group ${chatId}`);
    }
  }
}

// ─── KEYBOARDS ───────────────────────────────────────────────────────────────

function kbGroupList() {
  const entries = Object.entries(config.groups);
  if (!entries.length) {
    return { inline_keyboard: [[{ text: '➕ Add to a Group', callback_data: 'add_group' }]] };
  }
  const rows = entries.map(([id, g]) => {
    const label = g.tokenSymbol ? `${g.groupName} — ${g.tokenSymbol}` : `${g.groupName} — ⚠️ No token`;
    return [{ text: label, callback_data: `grp:${id}` }];
  });
  rows.push([{ text: '➕ Add to Another Group', callback_data: 'add_group' }]);
  return { inline_keyboard: rows };
}

function kbSettings(chatId) {
  const g = config.groups[chatId];
  if (!g) return { inline_keyboard: [] };
  const rows = [];

  if (g.tokenSymbol) {
    rows.push([{ text: `🪙 Token: ${g.tokenSymbol}`, callback_data: `s:token:${chatId}` }]);
  } else {
    rows.push([{ text: '🔗 Track Token', callback_data: `s:token:${chatId}` }]);
  }

  rows.push([
    { text: `💰 Min Buy: $${g.minBuyUSD ?? 0}`,   callback_data: `s:minbuy:${chatId}` },
    { text: `📊 Buy Step: $${g.buyStep ?? 100}`,  callback_data: `s:buystep:${chatId}` },
  ]);
  rows.push([
    { text: `${g.emoji ?? '🟢'} Emoji: ${g.emoji ?? '🟢'}`, callback_data: `s:emoji:${chatId}` },
    { text: `🔢 Max Emojis: ${g.maxEmojis ?? 20}`,           callback_data: `s:maxemojis:${chatId}` },
  ]);
  rows.push([{ text: `🖼 Media: ${g.media ? '✅ Set' : 'Not set'}`, callback_data: `s:media:${chatId}` }]);
  if (g.media) rows.push([{ text: '🗑 Clear Media', callback_data: `clr:media:${chatId}` }]);
  if (g.tokenSymbol) rows.push([{ text: '🗑 Untrack Token', callback_data: `untrack:${chatId}` }]);
  rows.push([{
    text: g.paused ? '▶️ Resume Alerts' : '⏸ Pause Alerts',
    callback_data: `toggle:${chatId}`,
  }]);
  rows.push([{ text: '⬅️ Back to Groups', callback_data: 'back' }]);
  return { inline_keyboard: rows };
}

function kbCancel(tag) {
  return { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `cancel:${tag}` }]] };
}

// ─── DM SESSION ──────────────────────────────────────────────────────────────

function sess(userId) {
  if (!dmSessions.has(userId)) dmSessions.set(userId, { state: S.IDLE, groupId: null, msgId: null });
  return dmSessions.get(userId);
}

function setSess(userId, patch) {
  dmSessions.set(userId, { ...sess(userId), ...patch });
}

function clearSess(userId) {
  dmSessions.set(userId, { state: S.IDLE, groupId: null, msgId: null });
}

// ─── PANEL HELPERS ───────────────────────────────────────────────────────────

async function showGroupList(userId, chatId, editId) {
  const text = `🤖 *AGENT BUYBOT*\n\nSelect a group to configure:`;
  const kb   = kbGroupList();
  try {
    if (editId) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: editId, parse_mode: 'MarkdownV2', reply_markup: kb });
    } else {
      const m = await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', reply_markup: kb });
      setSess(userId, { msgId: m.message_id });
    }
  } catch (err) { log(`[GroupList] ${err.message}`); }
}

async function showSettings(userId, chatId, groupId, editId) {
  const g = config.groups[groupId];
  if (!g) return;
  const status = g.tokenSymbol
    ? `Tracking: *${e(g.tokenSymbol)}*`
    : `No token tracked yet — tap *Track Token* to add one\\.`;
  const text = `⚙️ *Settings — ${e(g.groupName || groupId)}*\n\n${status}\n\nTap any button to change a setting\\.\nJust type your new value and send it\\.`;
  const kb   = kbSettings(groupId);
  try {
    if (editId) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: editId, parse_mode: 'MarkdownV2', reply_markup: kb });
    } else {
      const m = await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', reply_markup: kb });
      setSess(userId, { msgId: m.message_id });
    }
  } catch (err) { log(`[Settings] ${err.message}`); }
}

// ─── BOT INIT ────────────────────────────────────────────────────────────────

if (!process.env.BOT_TOKEN) {
  console.error('❌  BOT_TOKEN missing. Copy .env.example → .env and fill it in.');
  process.exit(1);
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ─── GROUP EVENTS ────────────────────────────────────────────────────────────

bot.on('new_chat_members', async (msg) => {
  try {
    const me    = await bot.getMe();
    const added = msg.new_chat_members.some(m => m.id === me.id);
    if (!added) return;
    const chatId = String(msg.chat.id);
    ensureGroup(chatId, msg.chat.title);
    log(`✅ Added to group: ${msg.chat.title} (${chatId})`);

    await bot.sendMessage(chatId,
`🤖 *AGENT BUYBOT has arrived\\!*

Tap below to set me up\\. Everything is configured in DM — no commands needed here\\!

1️⃣ Make sure I'm an *admin*
2️⃣ Tap the button below
3️⃣ Pick this group and add your token`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [[{
          text: '⚙️ Set Up in DM',
          url: `https://t.me/${botUsername}?start=g_${chatId}`,
        }]] },
      }
    );
  } catch (err) { log(`[new_chat_members] ${err.message}`); }
});

// ─── /start ──────────────────────────────────────────────────────────────────

bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const userId  = String(msg.from.id);
  const chatId  = String(msg.chat.id);
  const param   = (match?.[1] || '').trim();
  const isPriv  = msg.chat.type === 'private';

  if (!isPriv) {
    // In group — just show "Set Up in DM" button
    ensureGroup(chatId, msg.chat.title);
    return bot.sendMessage(chatId,
`🤖 *AGENT BUYBOT is active\\!*\n\nTap below to configure in DM\\.`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [[{
          text: '⚙️ Set Up in DM',
          url: `https://t.me/${botUsername}?start=g_${chatId}`,
        }]] },
      }
    );
  }

  // DM with deep-link to specific group
  if (param.startsWith('g_')) {
    const groupId = param.slice(2);
    if (config.groups[groupId]) {
      clearSess(userId);
      setSess(userId, { groupId });
      return showSettings(userId, chatId, groupId, null);
    }
  }

  // DM /start — show group picker
  clearSess(userId);
  await showGroupList(userId, chatId, null);
});

// ─── /help ───────────────────────────────────────────────────────────────────

bot.onText(/\/help/, async (msg) => {
  const chatId = String(msg.chat.id);
  const isPriv = msg.chat.type === 'private';

  if (!isPriv) {
    return bot.sendMessage(chatId,
      `🤖 *AGENT BUYBOT*\n\nSet me up in DM — no commands needed here\\!`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [[{
          text: '⚙️ Set Up in DM',
          url: `https://t.me/${botUsername}?start=setup`,
        }]] },
      }
    );
  }

  await bot.sendMessage(chatId,
`🤖 *AGENT BUYBOT* — Help
━━━━━━━━━━━━━━━━━━━━━

*Setup \\(button\\-driven, no commands\\!\\)*
1\\. Add me to your group as an admin
2\\. Tap *"Set Up in DM"* from the group message
3\\. Pick your group → paste your token address
4\\. Customise emoji, buy step, media — all in DM

*Per\\-group settings:*
🔗 Token address \\(0xPkg::module::COIN format\\)
💰 Min buy in USD \\(0 = alert on all buys\\)
📊 Buy step \\(USD per emoji, e\\.g\\. 50\\)
🎨 Custom emoji for the buy bar
🔢 Max emojis cap
🖼 Media \\(photo / GIF / video\\) on every alert

*DEXes tracked:*
🐋 Cetus   🌀 Turbos   🐬 Bluefin

*In DM:* /start to open the setup wizard

⚡ [Join AGENT Community](${e(AGENT_LINK)})`,
    { parse_mode: 'MarkdownV2', disable_web_page_preview: true }
  );
});

// ─── /stats ──────────────────────────────────────────────────────────────────

bot.onText(/\/stats/, async (msg) => {
  const chatId = String(msg.chat.id);
  const groups = Object.values(config.groups);
  const tokenCount = new Set(groups.map(g => g.tokenAddress).filter(Boolean)).size;
  const rpcHost = activeRpc ? activeRpc.split('/')[2] : '❌ None';

  await bot.sendMessage(chatId,
`📊 *AGENT BUYBOT Stats*
━━━━━━━━━━━━━━━━━━
✅ Buys detected: *${totalBuys}*
🏠 Groups active: *${groups.length}*
🪙 Tokens tracked: *${tokenCount}*
⏱ Uptime: *${e(uptime())}*
🌐 RPC: \`${e(rpcHost)}\`
💎 SUI: *$${e(suiPrice.toFixed(3))}*
🔄 Poll interval: *${POLL_MS / 1000}s*

💧 *DEXes:* Cetus 🐋   Turbos 🌀   Bluefin 🐬

⚡ _AGENT BUYBOT v${e(BOT_VERSION)}_`,
    { parse_mode: 'MarkdownV2' }
  );
});

// ─── CALLBACK QUERY ──────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const userId = String(query.from.id);
  const chatId = String(query.message.chat.id);
  const msgId  = query.message.message_id;
  const data   = query.data;

  try { await bot.answerCallbackQuery(query.id); } catch { /* ok */ }

  const session = sess(userId);

  // ── Back to group list
  if (data === 'back') {
    clearSess(userId);
    setSess(userId, { msgId });
    return showGroupList(userId, chatId, msgId);
  }

  // ── Add group instructions
  if (data === 'add_group') {
    return bot.editMessageText(
`➕ *Add to Another Group*

1\\. Open the Telegram group you want to add alerts to
2\\. Add *@${e(botUsername)}* as a member and make them an admin
3\\. The bot will send a *"Set Up in DM"* button in the group automatically

Then come back here and tap /start to see your new group\\.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'back' }]] } }
    );
  }

  // ── Select group
  if (data.startsWith('grp:')) {
    const groupId = data.slice(4);
    if (!config.groups[groupId]) return;
    setSess(userId, { groupId, msgId });
    return showSettings(userId, chatId, groupId, msgId);
  }

  // ── Clear media
  if (data.startsWith('clr:media:')) {
    const groupId = data.slice(10);
    if (config.groups[groupId]) { config.groups[groupId].media = null; save(); }
    setSess(userId, { msgId });
    return showSettings(userId, chatId, groupId, msgId);
  }

  // ── Untrack token
  if (data.startsWith('untrack:')) {
    const groupId = data.slice(8);
    if (config.groups[groupId]) {
      config.groups[groupId].tokenAddress = null;
      config.groups[groupId].tokenSymbol  = null;
      config.groups[groupId].knownPools   = [];
      save();
    }
    setSess(userId, { msgId });
    return showSettings(userId, chatId, groupId, msgId);
  }

  // ── Toggle pause
  if (data.startsWith('toggle:')) {
    const groupId = data.slice(7);
    if (config.groups[groupId]) {
      config.groups[groupId].paused = !config.groups[groupId].paused;
      save();
    }
    setSess(userId, { msgId });
    return showSettings(userId, chatId, groupId, msgId);
  }

  // ── Cancel current input
  if (data.startsWith('cancel:')) {
    const groupId = session.groupId;
    clearSess(userId);
    if (groupId && config.groups[groupId]) return showSettings(userId, chatId, groupId, msgId);
    return showGroupList(userId, chatId, msgId);
  }

  // ── Setting buttons: s:field:groupId
  if (data.startsWith('s:')) {
    const parts   = data.split(':');
    const field   = parts[1];
    const groupId = parts.slice(2).join(':');
    if (!config.groups[groupId]) return;
    setSess(userId, { groupId, msgId });

    const prompts = {
      token: [S.TOKEN,
`🔗 *Track a Token*

Paste the full Sui token address\\.

Format: \`0xPackageId::module::COIN\`

You can find this on DexScreener or Suiscan\\.`],
      minbuy: [S.MIN_BUY,
`💰 *Minimum Buy*

Type the minimum USD value to trigger an alert\\.

Example: \`5\` for \\$5 minimum\\.
Type \`0\` to alert on every buy\\.`],
      buystep: [S.BUY_STEP,
`📊 *Buy Step*

How many USD = 1 emoji in the buy bar?

Example: \`50\` means \\$50 → 1 emoji, \\$500 → 10 emojis\\.`],
      emoji: [S.EMOJI,
`🎨 *Buy Bar Emoji*

Send the emoji you want for the buy bar\\.

Examples: 🚀 💎 🔥 🦅 🐋 💰 🟢`],
      maxemojis: [S.MAX_EMOJIS,
`🔢 *Max Emojis*

Maximum number of emojis in the buy bar\\.

Example: \`20\` or \`50\`\\.`],
      media: [S.MEDIA,
`🖼 *Buy Bar Media*

Send a *photo*, *GIF*, or *video* to show with every buy alert in your group\\.

Supports: photo, animated GIF, short video\\.`],
    };

    const prompt = prompts[field];
    if (!prompt) return;
    setSess(userId, { state: prompt[0] });
    return bot.editMessageText(prompt[1],
      { chat_id: chatId, message_id: msgId, parse_mode: 'MarkdownV2',
        reply_markup: kbCancel(`${field}:${groupId}`) }
    );
  }
});

// ─── DM TEXT INPUT HANDLER ───────────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (msg.chat.type !== 'private') return;
  const userId  = String(msg.from.id);
  const chatId  = String(msg.chat.id);
  const session = sess(userId);
  const text    = (msg.text || '').trim();
  const { state, groupId, msgId } = session;

  if (state === S.IDLE) return;
  const g = config.groups[groupId];
  if (!g) { clearSess(userId); return; }

  // ── Token address
  if (state === S.TOKEN) {
    const addr = text.replace(/\s+/g, '');
    if (!addr.startsWith('0x') || !addr.includes('::')) {
      return bot.sendMessage(chatId,
        `⚠️ That doesn't look right\\.\n\nExpected format: \`0xPkg::module::COIN\`\n\nYou can copy it from DexScreener or Suiscan\\.`,
        { parse_mode: 'MarkdownV2', reply_markup: kbCancel(`token:${groupId}`) }
      );
    }
    const sym = addr.split('::').pop().toUpperCase();
    g.tokenAddress = addr;
    g.tokenSymbol  = sym;
    g.knownPools   = [];    // reset pools on new token
    save();
    clearSess(userId);
    setSess(userId, { msgId });
    await bot.sendMessage(chatId, `✅ Now tracking *${e(sym)}*\\.`, { parse_mode: 'MarkdownV2' });
    return showSettings(userId, chatId, groupId, msgId);
  }

  // ── Min buy
  if (state === S.MIN_BUY) {
    const val = parseFloat(text);
    if (isNaN(val) || val < 0) {
      return bot.sendMessage(chatId,
        `⚠️ Please send a number ≥ 0, e\\.g\\. \`5\` or \`0\`\\.`,
        { parse_mode: 'MarkdownV2', reply_markup: kbCancel(`minbuy:${groupId}`) }
      );
    }
    g.minBuyUSD = val; save();
    clearSess(userId); setSess(userId, { msgId });
    await bot.sendMessage(chatId, `✅ Min buy set to *$${e(val.toFixed(2))}*\\.`, { parse_mode: 'MarkdownV2' });
    return showSettings(userId, chatId, groupId, msgId);
  }

  // ── Buy step
  if (state === S.BUY_STEP) {
    const val = parseFloat(text);
    if (isNaN(val) || val <= 0) {
      return bot.sendMessage(chatId,
        `⚠️ Please send a positive number, e\\.g\\. \`42\` or \`100\`\\.`,
        { parse_mode: 'MarkdownV2', reply_markup: kbCancel(`buystep:${groupId}`) }
      );
    }
    g.buyStep = val; save();
    clearSess(userId); setSess(userId, { msgId });
    await bot.sendMessage(chatId, `✅ Buy step set to *$${e(val.toFixed(2))}* per emoji\\.`, { parse_mode: 'MarkdownV2' });
    return showSettings(userId, chatId, groupId, msgId);
  }

  // ── Emoji
  if (state === S.EMOJI) {
    const val = text.trim();
    if (!val || val.length > 10) {
      return bot.sendMessage(chatId,
        `⚠️ Please send a single emoji like 🚀 or 💎\\.`,
        { parse_mode: 'MarkdownV2', reply_markup: kbCancel(`emoji:${groupId}`) }
      );
    }
    g.emoji = val; save();
    clearSess(userId); setSess(userId, { msgId });
    await bot.sendMessage(chatId, `✅ Emoji set to ${val}\\.`, { parse_mode: 'MarkdownV2' });
    return showSettings(userId, chatId, groupId, msgId);
  }

  // ── Max emojis
  if (state === S.MAX_EMOJIS) {
    const val = parseInt(text);
    if (isNaN(val) || val < 1 || val > 100) {
      return bot.sendMessage(chatId,
        `⚠️ Please send a number between 1 and 100\\.`,
        { parse_mode: 'MarkdownV2', reply_markup: kbCancel(`maxemojis:${groupId}`) }
      );
    }
    g.maxEmojis = val; save();
    clearSess(userId); setSess(userId, { msgId });
    await bot.sendMessage(chatId, `✅ Max emojis set to *${val}*\\.`, { parse_mode: 'MarkdownV2' });
    return showSettings(userId, chatId, groupId, msgId);
  }
});

// ─── MEDIA HANDLER (photo / GIF / video in DM) ───────────────────────────────

bot.on('message', async (msg) => {
  if (msg.chat.type !== 'private') return;
  const userId  = String(msg.from.id);
  const chatId  = String(msg.chat.id);
  const session = sess(userId);
  if (session.state !== S.MEDIA) return;

  const { groupId, msgId } = session;
  const g = config.groups[groupId];
  if (!g) { clearSess(userId); return; }

  let media = null;
  if (msg.photo)     media = { type: 'photo',     fileId: msg.photo[msg.photo.length - 1].file_id };
  else if (msg.animation) media = { type: 'animation', fileId: msg.animation.file_id };
  else if (msg.video)     media = { type: 'video',     fileId: msg.video.file_id };

  if (!media) {
    return bot.sendMessage(chatId,
      `⚠️ Please send a *photo*, *GIF*, or *video*\\.`,
      { parse_mode: 'MarkdownV2', reply_markup: kbCancel(`media:${groupId}`) }
    );
  }

  g.media = media; save();
  clearSess(userId); setSess(userId, { msgId });
  const label = { photo: '🖼 Image', animation: '🎞 GIF', video: '🎬 Video' }[media.type] || 'Media';
  await bot.sendMessage(chatId, `✅ Media set to *${e(label)}*\\.`, { parse_mode: 'MarkdownV2' });
  return showSettings(userId, chatId, groupId, msgId);
});

// ─── ERRORS ───────────────────────────────────────────────────────────────────

bot.on('polling_error', (err) => log(`[Polling] ${err.message}`));
process.on('unhandledRejection', (r) => log(`[Unhandled] ${r}`));
process.on('uncaughtException',  (err) => log(`[Uncaught] ${err.message}`));

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`🤖 AGENT BUYBOT v${BOT_VERSION} starting...`);

  const me = await bot.getMe();
  botUsername = me.username;
  log(`✅ Connected as @${botUsername}`);

  await refreshPrice();
  setInterval(refreshPrice, PRICE_REFRESH);

  log('🚀 Polling Cetus · Turbos · Bluefin events...');
  setInterval(async () => {
    try { await poll(); }
    catch (err) { log(`[Loop] ${err.message}`); }
  }, POLL_MS);

  log('✅ Ready! Add me to a group → tap "Set Up in DM".');
}

main().catch(console.error);
