/**
 * ╔══════════════════════════════════════════════════════╗
 * ║           🤖  AGENT BUYBOT  v3.0                   ║
 * ║   Sui Buy Tracker — Cetus · Turbos · Bluefin        ║
 * ╠══════════════════════════════════════════════════════╣
 * ║  FIXES in v3.0:                                     ║
 * ║  • PRIVACY: each user only sees their own groups    ║
 * ║  • No pool-dir spam: failure cache + concurrency    ║
 * ║  • 409 fix: clean polling restart                   ║
 * ║  • Railway volume: DATA_DIR env for persistence     ║
 * ║  • Multi-token per group (up to 5)                  ║
 * ║  • DexScreener real price + MCap                    ║
 * ║  • Wallet labels (CEX / whale / team)               ║
 * ║  • 24h buy stats broadcast                          ║
 * ║  • Tiered media: small / big / whale                ║
 * ║  • Setup preview card after token add               ║
 * ║  • /ping health check                               ║
 * ╚══════════════════════════════════════════════════════╝
 */

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios       from 'axios';
import fs          from 'fs';
import path        from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── PATHS — use DATA_DIR for Railway volume, fallback to local ──────────────
// In Railway: set DATA_DIR=/data and mount volume at /data
const DATA_DIR     = process.env.DATA_DIR || __dirname;
const CONFIG_FILE  = path.join(DATA_DIR, 'config.json');
const CURSOR_FILE  = path.join(DATA_DIR, 'cursors.json');
const POOL_FILE    = path.join(DATA_DIR, 'pool_dir.json');
const META_FILE    = path.join(DATA_DIR, 'coin_meta.json');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const BOT_VERSION   = '3.0.0';
const POLL_MS       = 4_000;
const PRICE_MS      = 30_000;
const STATS_MS      = 86_400_000;  // 24 h
const DEDUP_TTL     = 600_000;     // 10 min
const MAX_TOKENS    = 5;
const POOL_RETRY_MS = 60_000;      // retry failed pool-dir after 60 s
const AGENT_LINK    = 'https://t.me/Sui_Agent/1';
const SUI_TYPE      = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const SUI_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd';
const DEXS_URL      = 'https://api.dexscreener.com/latest/dex/tokens/';

const RPC_POOL = [
  'https://sui-mainnet.public.blastapi.io',
  'https://mainnet.suiet.app',
  'https://sui-mainnet-rpc.allthatnode.com',
  'https://rpc-mainnet.suiscan.xyz',
  'https://sui-rpc.publicnode.com',
  'https://fullnode.mainnet.sui.io',
];

const CETUS_EVT   = '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent';
const TURBOS_EVT  = '0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool::SwapEvent';
const BLUEFIN_EVT = '0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::spot_dex::OrderFilled';
const DEX_META    = { cetus:{name:'Cetus',icon:'🐋'}, turbos:{name:'Turbos',icon:'🌀'}, bluefin:{name:'Bluefin',icon:'🐬'} };

// Wizard states
const S = {
  IDLE:'idle', TOKEN:'token', MIN:'min', STEP:'step', EMOJI:'emoji', MAXE:'maxe',
  MEDIA_S:'ms', MEDIA_B:'mb', MEDIA_W:'mw', BIG_T:'bt', WHALE_T:'wt',
  WALLET_A:'wa', WALLET_L:'wl',
};

// ─── RUNTIME ─────────────────────────────────────────────────────────────────
let config   = loadJson(CONFIG_FILE, { version:BOT_VERSION, groups:{} });
let cursors  = loadJson(CURSOR_FILE, {});
let poolDir  = loadJson(POOL_FILE,   {});
let coinMeta = loadJson(META_FILE,   {});

let suiPrice  = 1.0;
let botUser   = 'AgentBuyBot';
let startTime = Date.now();
let totalBuys = 0;
let lastBuyTs = null;
let activeRpc = null;

const dexInit      = {};          // dexKey -> bool: cursor initialized
const seenTx       = new Map();   // txKey -> ts
const seenWallet   = new Map();   // `chatId:wallet` -> true
const statsMap     = new Map();   // `chatId:addr` -> stats
const sessions     = new Map();   // userId -> session
const poolInFlight = new Set();   // pool addresses currently being fetched
const poolFailed   = new Map();   // pool addr -> failed timestamp
const dexPriceCache= new Map();   // tokenAddr -> { data, ts }

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────
function loadJson(file, def) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return def;
}
function writeJson(file, data) {
  try {
    // Ensure directory exists (important for Railway volume on first boot)
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch(err) { log(`[Write] ${file}: ${err.message}`); }
}
const save        = () => writeJson(CONFIG_FILE, config);
const saveCursors = () => writeJson(CURSOR_FILE, cursors);
const savePool    = () => writeJson(POOL_FILE,   poolDir);
const saveMeta    = () => writeJson(META_FILE,   coinMeta);

// ─── GROUP / TOKEN FACTORIES ──────────────────────────────────────────────────
function mkGroup(name, ownerId) {
  return { groupName:name||'My Group', ownerId:String(ownerId||''),
           paused:false, tokens:[], knownWallets:{}, statsEnabled:true };
}
function mkToken(address, symbol) {
  return { address, symbol:symbol.toUpperCase(), name:null,
           decimals:6, totalSupply:null, paused:false,
           minBuyUSD:0, buyStep:100, emoji:'🟢', maxEmojis:20,
           media:{ small:null, big:null, whale:null, bigThreshold:100, whaleThreshold:1000 }};
}
function ensureGroup(chatId, name, ownerId) {
  if (!config.groups[chatId]) {
    config.groups[chatId] = mkGroup(name, ownerId);
    save();
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
// Each user only manages groups they own (they added the bot to)
function myGroups(userId) {
  return Object.entries(config.groups)
    .filter(([, g]) => g.ownerId === String(userId));
}
function canManage(userId, chatId) {
  const g = config.groups[chatId];
  return !!(g && g.ownerId === String(userId));
}

// ─── STATS ───────────────────────────────────────────────────────────────────
function getStats(chatId, addr) {
  const key = `${chatId}:${addr}`;
  if (!statsMap.has(key))
    statsMap.set(key, { buys:0, volume:0, wallets:new Set(), biggest:0, lastReset:Date.now() });
  const s = statsMap.get(key);
  if (Date.now() - s.lastReset > STATS_MS) {
    Object.assign(s, { buys:0, volume:0, wallets:new Set(), biggest:0, lastReset:Date.now() });
  }
  return s;
}
function updateStats(s, usd, wallet) {
  s.buys++; s.volume += usd;
  if (wallet) s.wallets.add(wallet);
  if (usd > s.biggest) s.biggest = usd;
}

// ─── LOGGING ─────────────────────────────────────────────────────────────────
function log(m) {
  console.log(`[${new Date().toISOString().slice(0,19).replace('T',' ')}] ${m}`);
}

// ─── FORMATTING ──────────────────────────────────────────────────────────────
const fmt$  = n => '$' + parseFloat(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
const fmtTk = n => n>=1e9?(n/1e9).toFixed(2)+'B': n>=1e6?(n/1e6).toFixed(2)+'M': parseFloat(n).toLocaleString('en-US',{maximumFractionDigits:2});
const fmtMc = n => !n||n<=0?'N/A': n>=1e9?'$'+(n/1e9).toFixed(2)+'B': n>=1e6?'$'+(n/1e6).toFixed(2)+'M': n>=1e3?'$'+(n/1e3).toFixed(1)+'K': '$'+n.toFixed(0);
const short  = a => (!a||a.length<10)?a||'': a.slice(0,6)+'...'+a.slice(-4);
const upStr  = () => { const s=Math.floor((Date.now()-startTime)/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h?`${h}h ${m}m`:`${m}m`; };
const e      = s => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g,'\\$&');

function fmtP(p) {
  if (!p||p===0) return 'N/A';
  if (p>=0.01) return '$'+p.toFixed(4);
  const s=p.toFixed(20), zeros=(s.match(/^0\.(0*)/)||['',''])[1].length;
  const sig=s.replace('0.','').replace(/^0+/,'').slice(0,4);
  const sub=zeros.toString().split('').map(d=>'₀₁₂₃₄₅₆₇₈₉'[+d]).join('');
  return zeros>2?`$0.0${sub}${sig}`:'$'+p.toFixed(8);
}
function buyBar(usd, emoji, step, max) {
  return (emoji||'🟢').repeat(Math.max(1, Math.min(Math.ceil(usd/(step||100)), max||20)));
}
function getMedia(usd, media) {
  if (!media) return null;
  if (usd>=(media.whaleThreshold||1000) && media.whale) return media.whale;
  if (usd>=(media.bigThreshold||100)    && media.big)   return media.big;
  return media.small||null;
}
function walletLine(addr, known) {
  const label = known?.[addr];
  const sh    = short(addr);
  return label ? `${e(label)} · ${e(sh)}` : e(sh);
}

// ─── SUI RPC ─────────────────────────────────────────────────────────────────
async function rpc(method, params) {
  const pool = activeRpc ? [activeRpc, ...RPC_POOL.filter(u=>u!==activeRpc)] : RPC_POOL;
  for (const url of pool) {
    try {
      const r = await axios.post(url, {jsonrpc:'2.0',id:1,method,params}, {timeout:8000});
      if (r.data?.result !== undefined) { activeRpc=url; return r.data.result; }
    } catch {}
  }
  throw new Error('All Sui RPCs unreachable');
}

// ─── PRICE ───────────────────────────────────────────────────────────────────
async function refreshSuiPrice() {
  try {
    const r = await axios.get(SUI_PRICE_URL, {timeout:6000});
    const p = r.data?.sui?.usd;
    if (p && p>0) { suiPrice=p; log(`SUI $${p.toFixed(4)}`); }
  } catch(err) { log(`SUI price err: ${err.message}`); }
}

async function fetchDexPrice(addr) {
  try {
    const r = await axios.get(DEXS_URL+addr, {timeout:7000});
    const pairs = r.data?.pairs;
    if (!pairs?.length) return null;
    const best = pairs.sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];
    return { priceUsd:parseFloat(best.priceUsd||0), mcap:best.marketCap||best.fdv||0 };
  } catch { return null; }
}
async function dexPriceCached(addr) {
  const c = dexPriceCache.get(addr);
  if (c && Date.now()-c.ts<30_000) return c.data;
  const data = await fetchDexPrice(addr);
  dexPriceCache.set(addr, {data, ts:Date.now()});
  return data;
}

// ─── POOL DIRECTION — with failure cache to stop spam ────────────────────────
async function fetchPoolDir(poolAddr) {
  if (!poolAddr) return null;
  if (poolDir[poolAddr]) return poolDir[poolAddr];
  // Don't retry a recently failed pool
  const failedAt = poolFailed.get(poolAddr);
  if (failedAt && Date.now()-failedAt < POOL_RETRY_MS) return null;
  // Don't fire duplicate concurrent fetches for the same pool
  if (poolInFlight.has(poolAddr)) return null;
  poolInFlight.add(poolAddr);
  try {
    const obj = await rpc('suix_getObject', [poolAddr, {showType:true,showContent:false}]);
    const typeStr = obj?.data?.type || '';
    const match = typeStr.match(/<([^,>]+),\s*([^>]+)>/);
    if (!match) { poolFailed.set(poolAddr, Date.now()); return null; }
    const coinA=match[1].trim(), coinB=match[2].trim();
    const isSui = c => c===SUI_TYPE||c.endsWith('::sui::SUI');
    const dir = { suiIsA:isSui(coinA), suiIsB:isSui(coinB) };
    poolDir[poolAddr] = dir;
    poolFailed.delete(poolAddr); // clear fail marker
    savePool();
    log(`Pool ${short(poolAddr)} SUI=${dir.suiIsA?'A':dir.suiIsB?'B':'?'}`);
    return dir;
  } catch {
    poolFailed.set(poolAddr, Date.now()); // mark as failed, wait before retry
    return null;
  } finally {
    poolInFlight.delete(poolAddr);
  }
}

// ─── COIN METADATA ───────────────────────────────────────────────────────────
async function fetchCoinMeta(addr) {
  if (coinMeta[addr]) return coinMeta[addr];
  try {
    const meta = await rpc('suix_getCoinMetadata', [addr]);
    const dec  = meta?.decimals ?? 6;
    const name = meta?.name || addr.split('::').pop();
    let supply = null;
    try {
      const ts = await rpc('suix_getTotalSupply', [addr]);
      if (ts?.value) supply = Number(ts.value) / 10**dec;
    } catch {}
    const result = { decimals:dec, totalSupply:supply, name };
    coinMeta[addr] = result;
    saveMeta();
    log(`Meta ${short(addr)}: dec=${dec} supply=${supply?.toLocaleString()}`);
    return result;
  } catch(err) {
    log(`Meta err ${short(addr)}: ${err.message}`);
    return { decimals:6, totalSupply:null, name:addr.split('::').pop() };
  }
}

// ─── SWAP PARSERS ─────────────────────────────────────────────────────────────
function parseCetus(d, dir, dec) {
  if (!dir) return null;
  let isBuy, suiN, tokN;
  if (dir.suiIsB) {
    isBuy=d.atob===false; suiN=isBuy?+d.amount_in:+d.amount_out; tokN=isBuy?+d.amount_out:+d.amount_in;
  } else if (dir.suiIsA) {
    isBuy=d.atob===true;  suiN=isBuy?+d.amount_in:+d.amount_out; tokN=isBuy?+d.amount_out:+d.amount_in;
  } else return null;
  if (!isBuy||suiN<=0||tokN<=0) return null;
  return { suiAmt:suiN/1e9, tokAmt:tokN/10**dec };
}
function parseTurbos(d, dir, dec) {
  if (!dir) return null;
  let isBuy, suiN, tokN;
  if (dir.suiIsB) {
    isBuy=d.a_to_b===false; suiN=isBuy?+d.amount_b:+d.amount_a; tokN=isBuy?+d.amount_a:+d.amount_b;
  } else if (dir.suiIsA) {
    isBuy=d.a_to_b===true;  suiN=isBuy?+d.amount_a:+d.amount_b; tokN=isBuy?+d.amount_b:+d.amount_a;
  } else return null;
  if (!isBuy||suiN<=0||tokN<=0) return null;
  return { suiAmt:suiN/1e9, tokAmt:tokN/10**dec };
}
function parseBluefin(d, dec) {
  const baseQ  = +(d.base_quantity||d.base_amount||d.quantity||0);
  const quoteQ = +(d.quote_quantity||d.quote_amount||d.filled_quantity||0);
  if (baseQ<=0||quoteQ<=0) return null;
  return { suiAmt:baseQ/1e9, tokAmt:quoteQ/10**dec };
}

// ─── CURSOR INIT — skips history on first launch ─────────────────────────────
async function initCursor(dexKey, eventType) {
  if (cursors[dexKey] || dexInit[dexKey]) { dexInit[dexKey]=true; return; }
  try {
    log(`[${dexKey}] Initializing cursor (skipping history)...`);
    const r = await rpc('suix_queryEvents', [{MoveEventType:eventType}, null, 1, true]);
    if (r?.nextCursor) { cursors[dexKey]=r.nextCursor; saveCursors(); }
    dexInit[dexKey] = true;
    log(`[${dexKey}] Live tracking started`);
  } catch(err) { log(`[${dexKey}] Cursor init err: ${err.message}`); dexInit[dexKey]=true; }
}

// ─── POLL LOOP ────────────────────────────────────────────────────────────────
const DEXES = [
  { key:'cetus',   type:CETUS_EVT,
    async parse(d,pool,dec){ const dir=await fetchPoolDir(pool); return parseCetus(d,dir,dec); },
    pool: d => d.pool||'' },
  { key:'turbos',  type:TURBOS_EVT,
    async parse(d,pool,dec){ const dir=await fetchPoolDir(pool); return parseTurbos(d,dir,dec); },
    pool: d => d.pool||'' },
  { key:'bluefin', type:BLUEFIN_EVT,
    async parse(d,_p,dec){ return parseBluefin(d,dec); },
    pool: d => d.market_id||d.pool_id||'' },
];

async function poll() {
  const activeGroups = Object.entries(config.groups)
    .filter(([,g]) => !g.paused && g.tokens?.some(t=>!t.paused));
  if (!activeGroups.length) return;

  for (const dex of DEXES) {
    await initCursor(dex.key, dex.type);
    if (!dexInit[dex.key]) continue;
    try {
      const res = await rpc('suix_queryEvents',
        [{MoveEventType:dex.type}, cursors[dex.key]||null, 50, false]);
      if (!res?.data?.length) continue;
      if (res.nextCursor) { cursors[dex.key]=res.nextCursor; saveCursors(); }

      for (const ev of res.data) {
        const hash = ev.id?.txDigest||''; if (!hash) continue;
        const txKey = `${dex.key}:${hash}`;
        if (seenTx.has(txKey)) continue;
        seenTx.set(txKey, Date.now());
        // Prune old dedup entries
        if (seenTx.size > 5000) {
          for (const [k,v] of seenTx) if(Date.now()-v>DEDUP_TTL) seenTx.delete(k);
        }

        const d      = ev.parsedJson||{};
        const pool   = dex.pool(d);
        const wallet = ev.sender||'';

        for (const [chatId, grp] of activeGroups) {
          for (const tok of grp.tokens) {
            if (tok.paused) continue;
            const dec    = coinMeta[tok.address]?.decimals ?? tok.decimals ?? 6;
            const parsed = await dex.parse(d, pool, dec);
            if (!parsed||parsed.suiAmt<=0||parsed.tokAmt<=0) continue;

            const usdAmt = parsed.suiAmt * suiPrice;
            if (usdAmt < (tok.minBuyUSD||0)) continue;

            // Real price from DexScreener (30s cache)
            const dp    = await dexPriceCached(tok.address);
            const price = dp?.priceUsd || (parsed.tokAmt>0 ? usdAmt/parsed.tokAmt : 0);
            const mcap  = dp?.mcap || (tok.totalSupply&&price ? price*tok.totalSupply : null);

            totalBuys++; lastBuyTs=Date.now();
            updateStats(getStats(chatId, tok.address), usdAmt, wallet);

            const wk    = `${chatId}:${wallet}`;
            const isNew = !seenWallet.has(wk);
            if (wallet) seenWallet.set(wk, true);
            const buyNum = getStats(chatId, tok.address).buys;
            const wLabel = grp.knownWallets?.[wallet]||null;

            log(`🟢 ${tok.symbol} $${usdAmt.toFixed(2)} on ${dex.key} → ${chatId}`);
            await sendAlert(chatId, grp, tok, {
              suiAmt:parsed.suiAmt, tokAmt:parsed.tokAmt,
              usdAmt, price, mcap, wallet, txHash:hash, buyNum, isNew, wLabel,
            }, dex.key);
          }
        }
      }
    } catch(err) { log(`[Poll:${dex.key}] ${err.message}`); }
  }
}

// ─── BUILD & SEND ALERT ───────────────────────────────────────────────────────
function buildCaption(grp, tok, buy, dexKey) {
  const dm  = DEX_META[dexKey]||{name:dexKey,icon:'🔄'};
  const bar = buyBar(buy.usdAmt, tok.emoji, tok.buyStep, tok.maxEmojis);
  const ta  = tok.address||'';
  const wl  = walletLine(buy.wallet, grp.knownWallets);

  const badges=[];
  if (buy.wLabel?.includes('🏦')||buy.wLabel?.includes('🏛')) badges.push(`${e(buy.wLabel)} deposit`);
  if (buy.isNew)             badges.push('🆕 New Buyer\\!');
  if (buy.buyNum)            badges.push(`🏆 Buyer \\#${buy.buyNum}`);
  if (buy.usdAmt>=5000)      badges.push('🦈 MEGA WHALE\\!');
  else if (buy.usdAmt>=1000) badges.push('🐳 Whale Alert\\!');
  const badgeLine = badges.length ? `\n${badges.join('   ')}` : '';

  return `🤖 *AGENT BUYBOT*
━━━━━━━━━━━━━━━━━━━
*${e(tok.symbol)}* Buy on *${e(dm.name)}* ${dm.icon}${badgeLine}

${bar}

💎 SUI: *$${e(suiPrice.toFixed(3))}*
💰 *${e(fmt$(buy.usdAmt))}* \\(${e(buy.suiAmt.toFixed(4))} SUI\\)
🪙 ${e(fmtTk(buy.tokAmt))} *${e(tok.symbol)}*

📊 Price: *${e(fmtP(buy.price))}*
💹 MCap: *${e(fmtMc(buy.mcap))}*

👤 [${wl}](https://suiscan.xyz/mainnet/account/${buy.wallet})
🔗 [TX](https://suiscan.xyz/mainnet/tx/${buy.txHash}) \\| [Chart](https://dexscreener.com/sui/${ta}) \\| [Token](https://suiscan.xyz/mainnet/object/${ta})

⚡ _AGENT BUYBOT_ \\| [Join](${e(AGENT_LINK)})`;
}

async function sendAlert(chatId, grp, tok, buy, dexKey) {
  const caption = buildCaption(grp, tok, buy, dexKey);
  const opts    = {parse_mode:'MarkdownV2', disable_web_page_preview:true};
  const media   = getMedia(buy.usdAmt, tok.media);
  try {
    if (media) {
      const {type,fileId}=media;
      if (type==='photo')          await bot.sendPhoto(chatId,fileId,{caption,...opts});
      else if (type==='animation') await bot.sendAnimation(chatId,fileId,{caption,...opts});
      else if (type==='video')     await bot.sendVideo(chatId,fileId,{caption,...opts});
      else                         await bot.sendMessage(chatId,caption,opts);
    } else                         await bot.sendMessage(chatId,caption,opts);
  } catch(err) {
    log(`[Alert→${chatId}] ${err.message}`);
    if (/kicked|not found|deactivated|blocked/i.test(err.message)) { delete config.groups[chatId]; save(); }
  }
}

// ─── 24H STATS BROADCAST ─────────────────────────────────────────────────────
async function broadcast24h() {
  for (const [chatId, grp] of Object.entries(config.groups)) {
    if (!grp.statsEnabled||!grp.tokens?.length) continue;
    for (const tok of grp.tokens) {
      const s = getStats(chatId, tok.address);
      if (!s.buys) continue;
      try {
        await bot.sendMessage(chatId,
`📊 *${e(tok.symbol)}* — Last 24h
━━━━━━━━━━━━━━━━━━
✅ Total buys: *${s.buys}*
💰 Volume: *${e(fmt$(s.volume))}*
👥 Unique buyers: *${s.wallets.size}*
🐳 Biggest buy: *${e(fmt$(s.biggest))}*

⚡ _AGENT BUYBOT_`, {parse_mode:'MarkdownV2'});
      } catch(err) { log(`[Stats→${chatId}] ${err.message}`); }
    }
  }
}

// ─── KEYBOARDS ───────────────────────────────────────────────────────────────
function kbGroupList(userId) {
  const mine = myGroups(userId);
  const rows = mine.map(([id,g]) => {
    const syms = g.tokens?.map(t=>t.symbol).join(', ')||'';
    const lbl  = syms ? `${g.groupName} — ✅ ${syms}` : `${g.groupName} — ⚠️ No token`;
    return [{text:lbl, callback_data:`grp:${id}`}];
  });
  rows.push([{text:'➕ Add to Another Group', url:`https://t.me/${botUser}?startgroup=add`}]);
  return {inline_keyboard:rows};
}

function kbTokenList(chatId) {
  const g=config.groups[chatId]; if(!g) return {inline_keyboard:[]};
  const rows=(g.tokens||[]).map((tok,i)=>[{
    text:`🪙 ${tok.symbol}${tok.paused?' ⏸':''} — min $${tok.minBuyUSD}`,
    callback_data:`tok:${chatId}:${i}`
  }]);
  if ((g.tokens||[]).length<MAX_TOKENS)
    rows.push([{text:'➕ Add Token', callback_data:`addtok:${chatId}`}]);
  rows.push([{text:'👥 Wallet Labels', callback_data:`wallets:${chatId}`}]);
  rows.push([{text:`📊 Daily Stats: ${g.statsEnabled?'✅ ON':'❌ OFF'}`, callback_data:`togglestats:${chatId}`}]);
  rows.push([{text:g.paused?'▶️ Resume All':'⏸ Pause All', callback_data:`pausegrp:${chatId}`}]);
  rows.push([{text:'⬅️ Back', callback_data:'back'}]);
  return {inline_keyboard:rows};
}

function kbTok(chatId, idx) {
  const tok=config.groups[chatId]?.tokens?.[idx]; if(!tok) return {inline_keyboard:[]};
  const m=tok.media||{};
  return {inline_keyboard:[
    [{text:`🪙 Token: ${tok.symbol}`, callback_data:`ts:addr:${chatId}:${idx}`}],
    [{text:`💰 Min Buy: $${tok.minBuyUSD}`, callback_data:`ts:min:${chatId}:${idx}`},
     {text:`📊 Buy Step: $${tok.buyStep}`, callback_data:`ts:step:${chatId}:${idx}`}],
    [{text:`${tok.emoji} Emoji: ${tok.emoji}`, callback_data:`ts:emoji:${chatId}:${idx}`},
     {text:`🔢 Max: ${tok.maxEmojis}`, callback_data:`ts:maxe:${chatId}:${idx}`}],
    [{text:`🖼 Small media: ${m.small?'✅':'➕ Set'}`, callback_data:`ts:ms:${chatId}:${idx}`}],
    [{text:`🖼 Big ≥$${m.bigThreshold||100}: ${m.big?'✅':'➕ Set'}`, callback_data:`ts:mb:${chatId}:${idx}`},
     {text:`🐳 Whale ≥$${m.whaleThreshold||1000}: ${m.whale?'✅':'➕ Set'}`, callback_data:`ts:mw:${chatId}:${idx}`}],
    [{text:`Set Big $${m.bigThreshold||100}`, callback_data:`ts:bt:${chatId}:${idx}`},
     {text:`Set Whale $${m.whaleThreshold||1000}`, callback_data:`ts:wt:${chatId}:${idx}`}],
    ...(m.small||m.big||m.whale?[[{text:'🗑 Clear All Media', callback_data:`ts:clrm:${chatId}:${idx}`}]]:[]),
    [{text:'🗑 Remove Token', callback_data:`ts:remove:${chatId}:${idx}`},
     {text:tok.paused?'▶️ Resume':'⏸ Pause', callback_data:`ts:pause:${chatId}:${idx}`}],
    [{text:'⬅️ Back', callback_data:`grp:${chatId}`}],
  ]};
}

function kbWallets(chatId) {
  const kw=config.groups[chatId]?.knownWallets||{};
  const rows=Object.entries(kw).map(([addr,lbl])=>[{
    text:`${lbl} — ${short(addr)}`,
    callback_data:`delwl:${chatId}:${addr.slice(0,16)}`
  }]);
  rows.push([{text:'➕ Add Wallet Label', callback_data:`addwl:${chatId}`}]);
  rows.push([{text:'⬅️ Back', callback_data:`grp:${chatId}`}]);
  return {inline_keyboard:rows};
}

const kbCancel = tag => ({inline_keyboard:[[{text:'❌ Cancel', callback_data:`cancel:${tag}`}]]});

// ─── SESSION ─────────────────────────────────────────────────────────────────
const getSess = uid => sessions.get(uid)||{state:S.IDLE,groupId:null,tokenIdx:null,msgId:null,extra:null};
const setSess = (uid,p) => sessions.set(uid,{...getSess(uid),...p});
const clrSess = uid => sessions.set(uid,{state:S.IDLE,groupId:null,tokenIdx:null,msgId:null,extra:null});

// ─── PANELS ──────────────────────────────────────────────────────────────────
async function showGroups(uid, chatId, editId) {
  const groups = myGroups(uid);
  const text = groups.length
    ? '🤖 *AGENT BUYBOT*\n\nSelect a group to configure:'
    : '🤖 *AGENT BUYBOT*\n\nNo groups yet\\. Tap below to add me to a group\\.';
  const kb = kbGroupList(uid);
  try {
    if (editId) await bot.editMessageText(text,{chat_id:chatId,message_id:editId,parse_mode:'MarkdownV2',reply_markup:kb});
    else { const m=await bot.sendMessage(chatId,text,{parse_mode:'MarkdownV2',reply_markup:kb}); setSess(uid,{msgId:m.message_id}); }
  } catch(err) { log(`[showGroups] ${err.message}`); }
}

async function showTokenList(uid, chatId, groupId, editId) {
  const g=config.groups[groupId]; if(!g) return;
  const symList = g.tokens?.length
    ? g.tokens.map(t=>`• *${e(t.symbol)}*${t.paused?' ⏸':''}`).join('\n')
    : '_No tokens yet_';
  const text = `⚙️ *Settings — ${e(g.groupName)}*\n\n${symList}\n\nTap a token to configure or add a new one\\.`;
  try {
    if (editId) await bot.editMessageText(text,{chat_id:chatId,message_id:editId,parse_mode:'MarkdownV2',reply_markup:kbTokenList(groupId)});
    else { const m=await bot.sendMessage(chatId,text,{parse_mode:'MarkdownV2',reply_markup:kbTokenList(groupId)}); setSess(uid,{msgId:m.message_id}); }
  } catch(err) { log(`[showTokenList] ${err.message}`); }
}

async function showTokSettings(uid, chatId, groupId, idx, editId) {
  const tok=config.groups[groupId]?.tokens?.[idx]; if(!tok) return;
  const dp = await dexPriceCached(tok.address).catch(()=>null);
  const price = dp?.priceUsd||0, mcap=dp?.mcap||0;
  const text = `⚙️ *${e(tok.symbol)}* — Token Settings\n\n`
    + (price?`📊 Price: *${e(fmtP(price))}*\n`:'')
    + (mcap ?`💹 MCap: *${e(fmtMc(mcap))}*\n`:'')
    + `\nTap any button to change\\. Type new value and send\\.`;
  try {
    if (editId) await bot.editMessageText(text,{chat_id:chatId,message_id:editId,parse_mode:'MarkdownV2',reply_markup:kbTok(groupId,idx)});
    else { const m=await bot.sendMessage(chatId,text,{parse_mode:'MarkdownV2',reply_markup:kbTok(groupId,idx)}); setSess(uid,{msgId:m.message_id}); }
  } catch(err) { log(`[showTokSettings] ${err.message}`); }
}

async function showWallets(uid, chatId, groupId, editId) {
  const g=config.groups[groupId]; if(!g) return;
  const kw=g.knownWallets||{};
  const list=Object.entries(kw).map(([a,l])=>`${l}: \`${a.slice(0,16)}\\.\\.\\.\``).join('\n')||'_None yet_';
  const text=`👥 *Wallet Labels — ${e(g.groupName)}*\n\n${list}\n\nLabelled wallets show on buy alerts\\.`;
  try {
    if (editId) await bot.editMessageText(text,{chat_id:chatId,message_id:editId,parse_mode:'MarkdownV2',reply_markup:kbWallets(groupId)});
    else { const m=await bot.sendMessage(chatId,text,{parse_mode:'MarkdownV2',reply_markup:kbWallets(groupId)}); setSess(uid,{msgId:m.message_id}); }
  } catch(err) { log(`[showWallets] ${err.message}`); }
}

// Preview after token add
async function sendPreview(chatId, tok, dp) {
  const mockUsd=Math.max(tok.minBuyUSD||0,50);
  const mockSui=(mockUsd/suiPrice).toFixed(4);
  const bar=buyBar(mockUsd,tok.emoji,tok.buyStep,Math.min(tok.maxEmojis,8));
  const price=dp?.priceUsd||0, mcap=dp?.mcap||0;
  const mockTok=price>0?(mockUsd/price).toFixed(0):'~725,000';
  const text=`👁 *Preview — what alerts will look like:*
━━━━━━━━━━━━━━━━━━━
*${e(tok.symbol)}* Buy on Cetus 🐋

${bar}

💎 SUI: *$${e(suiPrice.toFixed(3))}*
💰 *${e(fmt$(mockUsd))}* \\(${e(mockSui)} SUI\\)
🪙 ${e(mockTok)} *${e(tok.symbol)}*

📊 Price: *${e(fmtP(price))}*
💹 MCap: *${e(fmtMc(mcap))}*

👤 0x1234\\.\\.\\.5678
🔗 TX \\| Chart \\| Token

⚡ _AGENT BUYBOT_ \\| [Join](${e(AGENT_LINK)})

_Min buy: \\$${e(String(tok.minBuyUSD))} · Step: \\$${e(String(tok.buyStep))} per emoji_`;
  try { await bot.sendMessage(chatId,text,{parse_mode:'MarkdownV2',disable_web_page_preview:true}); } catch {}
}

// ─── BOT INIT ────────────────────────────────────────────────────────────────
if (!process.env.BOT_TOKEN) { console.error('❌ BOT_TOKEN missing.'); process.exit(1); }
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling:false });

// ─── ADDED TO GROUP ───────────────────────────────────────────────────────────
bot.on('my_chat_member', async msg => {
  try {
    if (msg.new_chat_member?.status !== 'administrator' &&
        msg.new_chat_member?.status !== 'member') return;
    const me = await bot.getMe();
    if (msg.new_chat_member?.user?.id !== me.id) return;
    const chatId  = String(msg.chat.id);
    const name    = msg.chat.title||chatId;
    const ownerId = String(msg.from.id);
    // Only create/update group if we are added (not promoted/demoted)
    if (!config.groups[chatId]) {
      config.groups[chatId] = mkGroup(name, ownerId);
      save();
      log(`✅ Added to: ${name} by user ${ownerId}`);
    }
    const btn = { reply_markup:{ inline_keyboard:[[{text:'⚙️ Set Up in DM', url:`https://t.me/${botUser}?start=g_${chatId}`}]] }};
    await bot.sendMessage(chatId,
      `🤖 AGENT BUYBOT has arrived!\n\nTap below to set me up. Everything is configured in DM — no commands needed here!\n\n1️⃣ Make sure I'm an admin\n2️⃣ Tap the button below\n3️⃣ Pick this group and add your token`, btn);
    await bot.sendMessage(chatId, `🤖 AGENT BUYBOT is active!\n\nTap below to set me up in DM.`, btn);
  } catch(err) { log(`[my_chat_member] ${err.message}`); }
});

// Also keep new_chat_members as fallback
bot.on('new_chat_members', async msg => {
  try {
    const me = await bot.getMe();
    if (!msg.new_chat_members.some(m=>m.id===me.id)) return;
    const chatId  = String(msg.chat.id);
    const name    = msg.chat.title||chatId;
    const ownerId = String(msg.from.id);
    if (!config.groups[chatId]) {
      config.groups[chatId] = mkGroup(name, ownerId);
      save();
      log(`✅ Added to: ${name} by user ${ownerId}`);
    }
    const btn = { reply_markup:{ inline_keyboard:[[{text:'⚙️ Set Up in DM', url:`https://t.me/${botUser}?start=g_${chatId}`}]] }};
    await bot.sendMessage(chatId,
      `🤖 AGENT BUYBOT has arrived!\n\nTap below to set me up. Everything is configured in DM — no commands needed here!\n\n1️⃣ Make sure I'm an admin\n2️⃣ Tap the button below\n3️⃣ Pick this group and add your token`, btn);
    await bot.sendMessage(chatId, `🤖 AGENT BUYBOT is active!\n\nTap below to set me up in DM.`, btn);
  } catch(err) { log(`[new_chat_members] ${err.message}`); }
});

// ─── /start ──────────────────────────────────────────────────────────────────
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const uid=String(msg.from.id), chatId=String(msg.chat.id), param=(match?.[1]||'').trim();
  if (msg.chat.type !== 'private') {
    ensureGroup(chatId, msg.chat.title, uid);
    return bot.sendMessage(chatId, '🤖 AGENT BUYBOT is active!\n\nTap below to set me up in DM.',
      {reply_markup:{inline_keyboard:[[{text:'⚙️ Set Up in DM',url:`https://t.me/${botUser}?start=g_${chatId}`}]]}});
  }
  // Deep link from group "Set Up in DM" button
  if (param.startsWith('g_')) {
    const gid = param.slice(2);
    if (config.groups[gid] && canManage(uid, gid)) {
      clrSess(uid); setSess(uid,{groupId:gid});
      return showTokenList(uid, chatId, gid, null);
    }
    // Group exists but this user isn't owner — add them as owner if no owner set yet
    if (config.groups[gid] && !config.groups[gid].ownerId) {
      config.groups[gid].ownerId = uid; save();
      clrSess(uid); setSess(uid,{groupId:gid});
      return showTokenList(uid, chatId, gid, null);
    }
  }
  clrSess(uid);
  await showGroups(uid, chatId, null);
});

// ─── /help ───────────────────────────────────────────────────────────────────
bot.onText(/\/help/, async msg => {
  const chatId=String(msg.chat.id);
  if (msg.chat.type!=='private')
    return bot.sendMessage(chatId,'🤖 AGENT BUYBOT\n\nConfigure in DM.',
      {reply_markup:{inline_keyboard:[[{text:'⚙️ Set Up in DM',url:`https://t.me/${botUser}?start=help`}]]}});
  await bot.sendMessage(chatId,
`🤖 *AGENT BUYBOT* — Help
━━━━━━━━━━━━━━━━━━━━━

*Setup:*
1\\. Add me to your group as admin
2\\. Tap *"⚙️ Set Up in DM"*
3\\. Select your group → add tokens
4\\. Customise each token's settings

*Per\\-token settings:*
🔗 Token address · 💰 Min buy · 📊 Buy step
🎨 Emoji · 🔢 Max emojis
🖼 3 media tiers: Small / Big / Whale

*Group features:*
👥 Wallet labels \\(CEX, whale, team\\)
📊 Daily stats auto\\-broadcast

*Commands:*
/start — Open setup wizard
/ping  — Check bot is alive
/stats — 24h buy stats

*DEXes:* Cetus 🐋   Turbos 🌀   Bluefin 🐬
⚡ [Join AGENT Community](${e(AGENT_LINK)})`,
    {parse_mode:'MarkdownV2',disable_web_page_preview:true});
});

// ─── /ping ───────────────────────────────────────────────────────────────────
bot.onText(/\/ping/, async msg => {
  const chatId=String(msg.chat.id);
  const lastStr=lastBuyTs?`${Math.floor((Date.now()-lastBuyTs)/1000)}s ago`:'none yet';
  const groups=Object.values(config.groups);
  const tokenCount=groups.reduce((n,g)=>n+(g.tokens?.length||0),0);
  await bot.sendMessage(chatId,
`🟢 *AGENT BUYBOT* is alive\\!
━━━━━━━━━━━━━━━━━━
💎 SUI: *$${e(suiPrice.toFixed(4))}*
✅ Total buys: *${totalBuys}*
🏠 Groups: *${groups.length}*
🪙 Tokens: *${tokenCount}*
⏱ Uptime: *${e(upStr())}*
🕐 Last buy: *${e(lastStr)}*
🌐 RPC: \`${e(activeRpc?activeRpc.split('/')[2]:'connecting...')}\`
📦 *v${e(BOT_VERSION)}*`,{parse_mode:'MarkdownV2'});
});

// ─── /stats ──────────────────────────────────────────────────────────────────
bot.onText(/\/stats/, async msg => {
  const chatId=String(msg.chat.id);
  const grp=config.groups[chatId];
  if (!grp?.tokens?.length)
    return bot.sendMessage(chatId,'No tokens tracked yet. Set up in DM first.');
  for (const tok of grp.tokens) {
    const s=getStats(chatId,tok.address);
    await bot.sendMessage(chatId,
`📊 *${e(tok.symbol)}* — Last 24h
━━━━━━━━━━━━━━━━━━
✅ Buys: *${s.buys}*
💰 Volume: *${e(fmt$(s.volume))}*
👥 Unique buyers: *${s.wallets.size}*
🐳 Biggest: *${e(fmt$(s.biggest))}*`,{parse_mode:'MarkdownV2'});
  }
});

// ─── CALLBACKS ───────────────────────────────────────────────────────────────
bot.on('callback_query', async query => {
  const uid=String(query.from.id), chatId=String(query.message.chat.id);
  const msgId=query.message.message_id, data=query.data;
  try { await bot.answerCallbackQuery(query.id); } catch {}
  const ss=getSess(uid);

  if (data==='back') { clrSess(uid); setSess(uid,{msgId}); return showGroups(uid,chatId,msgId); }

  if (data.startsWith('grp:')) {
    const gid=data.slice(4);
    if (!canManage(uid,gid)) return bot.answerCallbackQuery(query.id,{text:'⚠️ Not your group',show_alert:true});
    setSess(uid,{groupId:gid,msgId});
    return showTokenList(uid,chatId,gid,msgId);
  }

  if (data.startsWith('tok:')) {
    const [,gid,iStr]=data.split(':'); const idx=parseInt(iStr);
    if (!canManage(uid,gid)) return;
    setSess(uid,{groupId:gid,tokenIdx:idx,msgId});
    return showTokSettings(uid,chatId,gid,idx,msgId);
  }

  if (data.startsWith('addtok:')) {
    const gid=data.slice(7);
    if (!canManage(uid,gid)) return;
    const g=config.groups[gid];
    if ((g.tokens||[]).length>=MAX_TOKENS)
      return bot.answerCallbackQuery(query.id,{text:`Max ${MAX_TOKENS} tokens per group`,show_alert:true});
    setSess(uid,{state:S.TOKEN,groupId:gid,msgId});
    return bot.editMessageText(
      `🔗 Track a Token\n\nPaste the full Sui token address.\n\nFormat: 0xPackageId::module::COIN\n\nFind it on DexScreener or Suiscan.`,
      {chat_id:chatId,message_id:msgId,reply_markup:kbCancel(`tok:${gid}`)});
  }

  if (data.startsWith('wallets:')) {
    const gid=data.slice(8); if(!canManage(uid,gid)) return;
    setSess(uid,{groupId:gid,msgId}); return showWallets(uid,chatId,gid,msgId);
  }
  if (data.startsWith('addwl:')) {
    const gid=data.slice(6); if(!canManage(uid,gid)) return;
    setSess(uid,{state:S.WALLET_A,groupId:gid,msgId});
    return bot.editMessageText(`👥 Add Wallet Label\n\nPaste the full wallet address.`,
      {chat_id:chatId,message_id:msgId,reply_markup:kbCancel(`wallets:${gid}`)});
  }
  if (data.startsWith('delwl:')) {
    const [,,gid,pfx]=data.split(':'); if(!canManage(uid,gid)) return;
    const g=config.groups[gid];
    const addr=Object.keys(g.knownWallets||{}).find(a=>a.startsWith(pfx));
    if (addr) { delete g.knownWallets[addr]; save(); }
    return showWallets(uid,chatId,gid,msgId);
  }
  if (data.startsWith('togglestats:')) {
    const gid=data.slice(12); if(!canManage(uid,gid)) return;
    config.groups[gid].statsEnabled=!config.groups[gid].statsEnabled; save();
    return showTokenList(uid,chatId,gid,msgId);
  }
  if (data.startsWith('pausegrp:')) {
    const gid=data.slice(9); if(!canManage(uid,gid)) return;
    config.groups[gid].paused=!config.groups[gid].paused; save();
    return showTokenList(uid,chatId,gid,msgId);
  }
  if (data.startsWith('cancel:')) {
    const gid=ss.groupId; clrSess(uid);
    if (gid && ss.tokenIdx!=null && config.groups[gid]) return showTokSettings(uid,chatId,gid,ss.tokenIdx,msgId);
    if (gid && config.groups[gid]) return showTokenList(uid,chatId,gid,msgId);
    return showGroups(uid,chatId,msgId);
  }

  // Token settings: ts:field:chatId:idx
  if (data.startsWith('ts:')) {
    const parts=data.split(':'), field=parts[1], gid=parts[2], idx=parseInt(parts[3]);
    if (!canManage(uid,gid)) return;
    const g=config.groups[gid]; const tok=g?.tokens?.[idx]; if(!tok) return;
    setSess(uid,{groupId:gid,tokenIdx:idx,msgId});

    if (field==='remove') { g.tokens.splice(idx,1); save(); return showTokenList(uid,chatId,gid,msgId); }
    if (field==='pause')  { tok.paused=!tok.paused; save(); return showTokSettings(uid,chatId,gid,idx,msgId); }
    if (field==='clrm')   {
      tok.media={small:null,big:null,whale:null,bigThreshold:tok.media?.bigThreshold||100,whaleThreshold:tok.media?.whaleThreshold||1000};
      save(); return showTokSettings(uid,chatId,gid,idx,msgId);
    }

    const P={
      min:  [S.MIN,   '💰 Min Buy',   'Type the minimum USD to alert on. 0 = all buys.'],
      step: [S.STEP,  '📊 Buy Step',  'USD per emoji. Example: 50 → $50 = 1 emoji.'],
      emoji:[S.EMOJI, '🎨 Emoji',     'Send the emoji for the buy bar. E.g. 🚀 💎 🔥 🦅'],
      maxe: [S.MAXE,  '🔢 Max Emojis','Max emojis in bar. Example: 20'],
      ms:   [S.MEDIA_S,'🖼 Small Media','Send photo/GIF/video for buys below big threshold.'],
      mb:   [S.MEDIA_B,'🖼 Big Media',  `Send photo/GIF/video for buys ≥$${tok.media?.bigThreshold||100}.`],
      mw:   [S.MEDIA_W,'🐳 Whale Media',`Send photo/GIF/video for buys ≥$${tok.media?.whaleThreshold||1000}.`],
      bt:   [S.BIG_T, '💰 Big Threshold', 'USD for "big" media tier. Example: 100'],
      wt:   [S.WHALE_T,'🐳 Whale Threshold','USD for "whale" media tier. Example: 1000'],
    };
    const p=P[field]; if(!p) return;
    setSess(uid,{state:p[0]});
    return bot.editMessageText(`${p[1]}\n\n${p[2]}`,
      {chat_id:chatId,message_id:msgId,reply_markup:kbCancel(`ts:${gid}:${idx}`)});
  }
});

// ─── DM TEXT HANDLER ─────────────────────────────────────────────────────────
bot.on('message', async msg => {
  if (msg.chat.type !== 'private') return;
  const uid=String(msg.from.id), chatId=String(msg.chat.id);
  const {state,groupId,tokenIdx,msgId}=getSess(uid);
  const text=(msg.text||'').trim();
  if (state===S.IDLE) return;
  const g=config.groups[groupId]; if(!g){ clrSess(uid); return; }
  const tok=g.tokens?.[tokenIdx];

  const confirm = async (txt, dest) => {
    await bot.sendMessage(chatId, txt);
    clrSess(uid); setSess(uid,{msgId});
    if (dest==='wallets') return showWallets(uid,chatId,groupId,msgId);
    if (tok!=null)        return showTokSettings(uid,chatId,groupId,tokenIdx,msgId);
    return showTokenList(uid,chatId,groupId,msgId);
  };
  const bad = (txt, tag) => bot.sendMessage(chatId,txt,{reply_markup:kbCancel(tag)});

  // ── Add token
  if (state===S.TOKEN) {
    const addr=text.replace(/\s+/g,'');
    if (!addr.startsWith('0x')||!addr.includes('::'))
      return bad('⚠️ Invalid format. Expected:\n0xPkg::module::COIN\n\nFind it on DexScreener or Suiscan.',`tok:${groupId}`);
    if (g.tokens?.find(t=>t.address===addr))
      return bad('⚠️ Already tracking this token in this group.',`tok:${groupId}`);
    const sym=addr.split('::').pop().toUpperCase();
    const newTok=mkToken(addr,sym);
    if (!g.tokens) g.tokens=[];
    g.tokens.push(newTok);
    const newIdx=g.tokens.length-1;
    save();
    await bot.sendMessage(chatId,`⏳ Fetching info for *${e(sym)}*\\.\\.\\.`,{parse_mode:'MarkdownV2'});
    const meta=await fetchCoinMeta(addr);
    if (meta.decimals!==undefined) newTok.decimals=meta.decimals;
    if (meta.totalSupply)  { newTok.totalSupply=meta.totalSupply; newTok.name=meta.name; }
    save();
    const dp=await dexPriceCached(addr);
    const mcap=dp?.mcap||(newTok.totalSupply&&dp?.priceUsd?dp.priceUsd*newTok.totalSupply:null);
    await bot.sendMessage(chatId,
`✅ Now tracking *${e(sym)}*
━━━━━━━━━━━━━━━━━━
📛 Name: ${e(newTok.name||sym)}
🔢 Decimals: ${newTok.decimals}
${newTok.totalSupply?`💫 Supply: ${e(newTok.totalSupply.toLocaleString())} ${e(sym)}\n`:''}${dp?.priceUsd?`📊 Price: ${e(fmtP(dp.priceUsd))}\n`:''}${mcap?`💹 MCap: ${e(fmtMc(mcap))}\n`:''}\nAlerts are now live in your group\\!`,
      {parse_mode:'MarkdownV2'});
    await sendPreview(chatId, newTok, dp);
    clrSess(uid); setSess(uid,{msgId});
    return showTokSettings(uid,chatId,groupId,newIdx,msgId);
  }

  if (!tok) { clrSess(uid); return; }

  if (state===S.MIN)    { const v=parseFloat(text); if(isNaN(v)||v<0) return bad('⚠️ Number ≥ 0',`ts:${groupId}:${tokenIdx}`); tok.minBuyUSD=v;save(); return confirm(`✅ Min buy set to $${v.toFixed(2)}`); }
  if (state===S.STEP)   { const v=parseFloat(text); if(isNaN(v)||v<=0) return bad('⚠️ Positive number',`ts:${groupId}:${tokenIdx}`); tok.buyStep=v;save(); return confirm(`✅ Buy step set to $${v.toFixed(2)} per emoji`); }
  if (state===S.EMOJI)  { const v=text.trim(); if(!v||v.length>10) return bad('⚠️ Single emoji like 🚀',`ts:${groupId}:${tokenIdx}`); tok.emoji=v;save(); return confirm(`✅ Emoji set to ${v}`); }
  if (state===S.MAXE)   { const v=parseInt(text); if(isNaN(v)||v<1||v>100) return bad('⚠️ Number 1–100',`ts:${groupId}:${tokenIdx}`); tok.maxEmojis=v;save(); return confirm(`✅ Max emojis: ${v}`); }
  if (state===S.BIG_T)  { const v=parseFloat(text); if(isNaN(v)||v<=0) return bad('⚠️ Positive number',`ts:${groupId}:${tokenIdx}`); if(!tok.media)tok.media={small:null,big:null,whale:null}; tok.media.bigThreshold=v;save(); return confirm(`✅ Big threshold: $${v.toFixed(0)}`); }
  if (state===S.WHALE_T){ const v=parseFloat(text); if(isNaN(v)||v<=0) return bad('⚠️ Positive number',`ts:${groupId}:${tokenIdx}`); if(!tok.media)tok.media={small:null,big:null,whale:null}; tok.media.whaleThreshold=v;save(); return confirm(`✅ Whale threshold: $${v.toFixed(0)}`); }

  if (state===S.WALLET_A) {
    const addr=text.replace(/\s+/g,'');
    if (!addr.startsWith('0x')||addr.length<10) return bad('⚠️ Paste a valid Sui wallet address.',`wallets:${groupId}`);
    setSess(uid,{state:S.WALLET_L,extra:addr});
    return bot.sendMessage(chatId,`Got it\\!\n\nNow send a label for this wallet\\.\n\nExamples:\n🏦 Binance  ·  🐋 Whale  ·  👥 Team  ·  🏛 OKX`,
      {parse_mode:'MarkdownV2',reply_markup:kbCancel(`wallets:${groupId}`)});
  }
  if (state===S.WALLET_L) {
    const label=text.trim(); if(!label) return bad('⚠️ Send a label.',`wallets:${groupId}`);
    const addr=getSess(uid).extra;
    if (!g.knownWallets) g.knownWallets={};
    g.knownWallets[addr]=label; save();
    return confirm(`✅ Labelled: ${label} · ${short(addr)}`, 'wallets');
  }
});

// ─── MEDIA HANDLER ───────────────────────────────────────────────────────────
bot.on('message', async msg => {
  if (msg.chat.type!=='private') return;
  const uid=String(msg.from.id), chatId=String(msg.chat.id);
  const {state,groupId,tokenIdx,msgId}=getSess(uid);
  if (![S.MEDIA_S,S.MEDIA_B,S.MEDIA_W].includes(state)) return;
  const g=config.groups[groupId]; if(!g){clrSess(uid);return;}
  const tok=g.tokens?.[tokenIdx]; if(!tok) return;

  let media=null;
  if (msg.photo)          media={type:'photo',     fileId:msg.photo[msg.photo.length-1].file_id};
  else if (msg.animation) media={type:'animation', fileId:msg.animation.file_id};
  else if (msg.video)     media={type:'video',     fileId:msg.video.file_id};
  if (!media) return bot.sendMessage(chatId,'⚠️ Please send a photo, GIF, or video.',{reply_markup:kbCancel(`ts:${groupId}:${tokenIdx}`)});

  if (!tok.media) tok.media={small:null,big:null,whale:null,bigThreshold:100,whaleThreshold:1000};
  const tk={[S.MEDIA_S]:'small',[S.MEDIA_B]:'big',[S.MEDIA_W]:'whale'}[state];
  const tn={[S.MEDIA_S]:'Small', [S.MEDIA_B]:'Big', [S.MEDIA_W]:'Whale'}[state];
  tok.media[tk]=media; save();
  await bot.sendMessage(chatId,`✅ ${tn} media set \\(${media.type}\\)`,{parse_mode:'MarkdownV2'});
  clrSess(uid); setSess(uid,{msgId});
  return showTokSettings(uid,chatId,groupId,tokenIdx,msgId);
});

// ─── ERRORS ──────────────────────────────────────────────────────────────────
bot.on('polling_error', err => log(`[Polling] ${err.message}`));
process.on('unhandledRejection', r => log(`[Unhandled] ${r}`));
process.on('uncaughtException', err => log(`[Uncaught] ${err.message}`));

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  log(`🤖 AGENT BUYBOT v${BOT_VERSION}`);
  log(`📂 Data dir: ${DATA_DIR}`);
  const me = await bot.getMe();
  botUser = me.username;
  log(`✅ @${botUser}`);

  // Start polling — dropPendingUpdates clears any stale session from previous instance
  // This fixes the 409 Conflict error from overlapping Railway deployments
  await bot.startPolling({ restart:false, polling:{ params:{ timeout:10, allowed_updates:['message','callback_query','my_chat_member','chat_member'] } } });
  // Clear pending updates to avoid 409 with old instance
  try { await bot.deleteWebhook({drop_pending_updates:true}); } catch {}

  await refreshSuiPrice();
  setInterval(refreshSuiPrice, PRICE_MS);
  setInterval(broadcast24h, STATS_MS);

  log('🚀 Polling Cetus · Turbos · Bluefin...');
  setInterval(async () => { try { await poll(); } catch(err) { log(`[Loop] ${err.message}`); } }, POLL_MS);
  log('✅ Ready. Each user manages only their own groups.');
}

main().catch(console.error);
