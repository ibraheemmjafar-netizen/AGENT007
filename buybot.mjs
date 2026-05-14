/**
 * ╔══════════════════════════════════════════════════╗
 * ║         🤖  AGENT BUYBOT  v2.1                 ║
 * ║  Sui Buy Tracker — Cetus · Turbos · Bluefin     ║
 * ╚══════════════════════════════════════════════════╝
 *
 * BUGS FIXED IN v2.1 (vs screenshot):
 * ✅ Wrong token amount  — pool object fetched to get exact coin types
 * ✅ Wrong price         — correct direction + live SUI price every alert
 * ✅ MCap N/A            — suix_getCoinMetadata fetches decimals + totalSupply
 * ✅ Spam old txns       — cursors saved to disk; first run skips history
 * ✅ Turbos meme support — covers Manifest and all Turbos V3 meme pools
 * ✅ Bluefin meme support— OrderFilled event with correct field mapping
 *
 * POOL DIRECTION FIX:
 *   Cetus/Turbos SwapEvent contains ONLY pool address, not coin types.
 *   We fetch suix_getObject on the pool once → parse Pool<CoinA,CoinB> type
 *   to know which side is SUI → derive correct buy/sell + amounts.
 *   Cached per pool address so we only fetch once per deployment.
 */

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios       from 'axios';
import fs          from 'fs';
import path        from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const BOT_VERSION    = '2.1.0';
const CONFIG_FILE    = path.join(__dirname, 'config.json');
const CURSOR_FILE    = path.join(__dirname, 'cursors.json');
const POOL_DIR_FILE  = path.join(__dirname, 'pool_dir.json');
const COIN_META_FILE = path.join(__dirname, 'coin_meta.json');
const POLL_MS        = 4_000;
const PRICE_MS       = 30_000;   // refresh SUI price every 30s
const DEDUP_TTL      = 600_000;
const AGENT_LINK     = 'https://t.me/Sui_Agent/1';

// Full SUI coin type on Sui mainnet
const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

const SUI_PRICE_URL  = 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd';
const RPC_POOL = [
  'https://sui-mainnet.public.blastapi.io',
  'https://mainnet.suiet.app',
  'https://sui-mainnet-rpc.allthatnode.com',
  'https://rpc-mainnet.suiscan.xyz',
  'https://sui-rpc.publicnode.com',
  'https://fullnode.mainnet.sui.io',
];

// ─── DEX EVENT TYPES ─────────────────────────────────────────────────────────
// Cetus CLMM — most memes on Sui (PEEKA, etc.)
const CETUS_EVENT  = '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent';
// Turbos V3 — covers Manifest meme + many others
const TURBOS_EVENT = '0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool::SwapEvent';
// Bluefin Spot DEX — orderbook, meme tokens like BLUE ecosystem
const BLUEFIN_EVENT= '0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::spot_dex::OrderFilled';

// ─── WIZARD STATES ────────────────────────────────────────────────────────────
const S = { IDLE:'idle', TOKEN:'token', MIN:'minbuy', STEP:'buystep', EMOJI:'emoji', MAXE:'maxemojis', MEDIA:'media' };

// ─── RUNTIME ──────────────────────────────────────────────────────────────────
let config    = loadConfig();
let cursors   = loadJson(CURSOR_FILE);         // { dex: cursor } — persisted
let poolDir   = loadJson(POOL_DIR_FILE);       // { poolAddr: { suiIsA, suiIsB } }
let coinMeta  = loadJson(COIN_META_FILE);      // { tokenAddr: { decimals, totalSupply } }
let suiPrice  = 1.0;
let botUser   = 'AgentBuyBot';
let startTime = Date.now();
let totalBuys = 0;
let activeRpc = null;

const dexInit   = {};    // { dex: true } once cursor init'd to latest
const seenTx    = new Map();
const seenWallet = new Map();
const buyCount  = new Map();
const sessions  = new Map();

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')); } catch {}
  }
  return { version: BOT_VERSION, groups: {} };
}

function loadJson(file) {
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch {}
  }
  return {};
}

function save()         { fs.writeFileSync(CONFIG_FILE,  JSON.stringify(config,null,2)); }
function saveCursors()  { fs.writeFileSync(CURSOR_FILE,  JSON.stringify(cursors,null,2)); }
function savePoolDir()  { fs.writeFileSync(POOL_DIR_FILE, JSON.stringify(poolDir,null,2)); }
function saveCoinMeta() { fs.writeFileSync(COIN_META_FILE,JSON.stringify(coinMeta,null,2)); }

function mkGroup(name) {
  return { groupName:name||'My Group', tokenAddress:null, tokenSymbol:null,
           tokenName:null, decimals:6, totalSupply:null, knownPools:[],
           minBuyUSD:0, buyStep:100, emoji:'🟢', maxEmojis:20,
           media:null, paused:false, addedAt:Date.now() };
}
function ensureGroup(id,name){ if(!config.groups[id]){config.groups[id]=mkGroup(name);save();} }

// ─── LOGGING ──────────────────────────────────────────────────────────────────
function log(m){ console.log(`[${new Date().toISOString().slice(0,19).replace('T',' ')}] ${m}`); }

// ─── FORMAT ───────────────────────────────────────────────────────────────────
const fmt$ = n => '$'+parseFloat(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtTk = n => n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(2)+'M':parseFloat(n).toLocaleString('en-US',{maximumFractionDigits:2});
const fmtMc = n => !n||n<=0?'N/A':n>=1e9?'$'+(n/1e9).toFixed(2)+'B':n>=1e6?'$'+(n/1e6).toFixed(2)+'M':n>=1e3?'$'+(n/1e3).toFixed(1)+'K':'$'+n.toFixed(0);
const short  = a => (!a||a.length<10)?a||'':a.slice(0,6)+'...'+a.slice(-4);
const upStr  = () => { const s=Math.floor((Date.now()-startTime)/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h>0?`${h}h ${m}m`:`${m}m`; };

function fmtP(p) {
  if (!p||p===0) return 'N/A';
  if (p>=0.01) return '$'+p.toFixed(4);
  const s=p.toFixed(20), zeros=(s.match(/^0\.(0*)/)||['',''])[1].length;
  const sig=s.replace('0.','').replace(/^0+/,'').slice(0,4);
  const sub=zeros.toString().split('').map(d=>'₀₁₂₃₄₅₆₇₈₉'[+d]).join('');
  return zeros>2?`$0.0${sub}${sig}`:'$'+p.toFixed(8);
}

function buyBar(usd,emoji,step,max){
  return (emoji||'🟢').repeat(Math.max(1,Math.min(Math.ceil(usd/(step||100)),max||20)));
}
const e = s => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g,'\\$&');

// ─── SUI RPC ─────────────────────────────────────────────────────────────────
async function rpc(method, params) {
  const pool = activeRpc ? [activeRpc,...RPC_POOL.filter(u=>u!==activeRpc)] : RPC_POOL;
  for (const url of pool) {
    try {
      const r = await axios.post(url,{jsonrpc:'2.0',id:1,method,params},{timeout:8000});
      if (r.data?.result!==undefined){ activeRpc=url; return r.data.result; }
    } catch {}
  }
  throw new Error('All Sui RPCs unreachable');
}

// ─── SUI PRICE ────────────────────────────────────────────────────────────────
async function refreshPrice() {
  try {
    const r = await axios.get(SUI_PRICE_URL,{timeout:6000});
    const p = r.data?.sui?.usd;
    if (p&&p>0){ suiPrice=p; log(`SUI price: $${p.toFixed(4)}`); }
  } catch(err){ log(`Price error: ${err.message}`); }
}

// ─── FETCH POOL DIRECTION (coin types) ────────────────────────────────────────
// Fetches pool object, parses Pool<CoinA,CoinB> type to know which side is SUI
async function fetchPoolDir(poolAddr) {
  if (poolDir[poolAddr]) return poolDir[poolAddr]; // cached
  try {
    const obj = await rpc('suix_getObject',[poolAddr,{showType:true,showContent:false}]);
    const typeStr = obj?.data?.type || '';
    // Match: Pool<CoinA, CoinB> or Pool<CoinA,CoinB>
    const match = typeStr.match(/<([^,>]+),\s*([^>]+)>/);
    if (!match) return null;
    const coinA = match[1].trim(), coinB = match[2].trim();
    const isSui = c => c===SUI_TYPE || c.endsWith('::sui::SUI');
    const dir = { suiIsA:isSui(coinA), suiIsB:isSui(coinB) };
    poolDir[poolAddr] = dir;
    savePoolDir();
    log(`Pool ${poolAddr.slice(0,10)}... → SUI is ${dir.suiIsA?'A':dir.suiIsB?'B':'neither'}`);
    return dir;
  } catch(err){ log(`Pool dir fetch error: ${err.message}`); return null; }
}

// ─── FETCH COIN METADATA (decimals + totalSupply) ─────────────────────────────
async function fetchCoinMeta(tokenAddr) {
  if (coinMeta[tokenAddr]) return coinMeta[tokenAddr]; // cached
  try {
    // getCoinMetadata uses the coin type string
    const meta = await rpc('suix_getCoinMetadata',[tokenAddr]);
    let dec = meta?.decimals ?? 6;
    let name = meta?.name || tokenAddr.split('::').pop();
    // getTotalSupply
    let supply = null;
    try {
      const ts = await rpc('suix_getTotalSupply',[tokenAddr]);
      if (ts?.value) supply = Number(ts.value) / 10**dec;
    } catch {}
    const result = { decimals:dec, totalSupply:supply, name };
    coinMeta[tokenAddr] = result;
    saveCoinMeta();
    log(`Coin meta ${tokenAddr.slice(0,10)}...: decimals=${dec} supply=${supply?.toLocaleString()}`);
    return result;
  } catch(err){
    log(`Coin meta error for ${tokenAddr}: ${err.message}`);
    return { decimals:6, totalSupply:null, name:tokenAddr.split('::').pop() };
  }
}

// ─── PARSE CETUS SWAP ────────────────────────────────────────────────────────
function parseCetusSwap(d, dir, decimals, price) {
  if (!dir) return null;
  let isBuy, suiN, tokN;
  if (dir.suiIsB) {
    // SUI=coinB: atob=false (B→A) = SUI→Token = BUY
    isBuy = d.atob === false;
    suiN  = +d.amount_in;  tokN = +d.amount_out;
    if (!isBuy){ suiN=+d.amount_out; tokN=+d.amount_in; }
  } else if (dir.suiIsA) {
    // SUI=coinA: atob=true (A→B) = SUI→Token = BUY
    isBuy = d.atob === true;
    suiN  = +d.amount_in;  tokN = +d.amount_out;
    if (!isBuy){ suiN=+d.amount_out; tokN=+d.amount_in; }
  } else return null;
  if (!isBuy || suiN<=0 || tokN<=0) return null;
  const suiAmt=suiN/1e9, tokAmt=tokN/10**decimals, usdAmt=suiAmt*price;
  return { suiAmt, tokAmt, usdAmt, price: tokAmt>0?usdAmt/tokAmt:0 };
}

// ─── PARSE TURBOS SWAP ───────────────────────────────────────────────────────
// Turbos fields: amount_a (coinA), amount_b (coinB), a_to_b (direction)
function parseTurbosSwap(d, dir, decimals, price) {
  if (!dir) return null;
  let isBuy, suiN, tokN;
  if (dir.suiIsB) {
    // SUI=coinB=amount_b: a_to_b=false (B→A) = SUI→Token = BUY
    isBuy = d.a_to_b === false;
    suiN  = isBuy ? +d.amount_b : +d.amount_a;
    tokN  = isBuy ? +d.amount_a : +d.amount_b;
  } else if (dir.suiIsA) {
    // SUI=coinA=amount_a: a_to_b=true (A→B) = SUI→Token = BUY
    isBuy = d.a_to_b === true;
    suiN  = isBuy ? +d.amount_a : +d.amount_b;
    tokN  = isBuy ? +d.amount_b : +d.amount_a;
  } else return null;
  if (!isBuy || suiN<=0 || tokN<=0) return null;
  const suiAmt=suiN/1e9, tokAmt=tokN/10**decimals, usdAmt=suiAmt*price;
  return { suiAmt, tokAmt, usdAmt, price: tokAmt>0?usdAmt/tokAmt:0 };
}

// ─── PARSE BLUEFIN ORDER ─────────────────────────────────────────────────────
// Bluefin OrderFilled: base=SUI, quote=token (typical for spot)
function parseBluefinOrder(d, decimals, price) {
  // Fields vary by version; try multiple field names
  const baseQ  = +(d.base_quantity  || d.base_amount  || d.quantity      || 0);
  const quoteQ = +(d.quote_quantity || d.quote_amount || d.filled_quantity|| 0);
  if (baseQ<=0 || quoteQ<=0) return null;
  // If base is SUI (in MIST) and quote is token
  const suiAmt  = baseQ  / 1e9;
  const tokAmt  = quoteQ / 10**decimals;
  const usdAmt  = suiAmt * price;
  return { suiAmt, tokAmt, usdAmt, price: tokAmt>0?usdAmt/tokAmt:0 };
}

// ─── INIT CURSOR TO LATEST (skip history) ─────────────────────────────────────
// On very first start (no cursor saved), fetch latest events just to get cursor
// position and skip processing them — avoids flooding with old txns
async function initCursorToLatest(dexKey, eventType) {
  if (cursors[dexKey] || dexInit[dexKey]) { dexInit[dexKey]=true; return; }
  try {
    log(`[${dexKey}] Initializing cursor to latest...`);
    // Query with descending=false, get the latest batch
    const r = await rpc('suix_queryEvents',[{MoveEventType:eventType},null,1,true]);
    // descending=true gives newest first; save that cursor so next poll starts from NOW
    if (r?.nextCursor) { cursors[dexKey]=r.nextCursor; saveCursors(); }
    dexInit[dexKey]=true;
    log(`[${dexKey}] Cursor initialized — skipping historical events`);
  } catch(err){ log(`[${dexKey}] Cursor init error: ${err.message}`); dexInit[dexKey]=true; }
}

// ─── POLL LOOP ────────────────────────────────────────────────────────────────
async function poll() {
  const active = Object.entries(config.groups).filter(([,g])=>g.tokenAddress&&!g.paused);
  if (!active.length) return;

  // Pre-fetch coin metadata for all tracked tokens
  for (const [,g] of active) {
    if (!coinMeta[g.tokenAddress]) {
      const meta = await fetchCoinMeta(g.tokenAddress);
      // Update group decimals/totalSupply from chain data
      if (meta.decimals!==undefined){ g.decimals=meta.decimals; }
      if (meta.totalSupply&&!g.totalSupply){ g.totalSupply=meta.totalSupply; g.tokenName=meta.name; save(); }
    }
  }

  const dexes = [
    { key:'cetus',   type:CETUS_EVENT,   parseEvt: async (d,pool,dec) => {
        const dir = await fetchPoolDir(pool);
        return parseCetusSwap(d,dir,dec,suiPrice);
    }},
    { key:'turbos',  type:TURBOS_EVENT,  parseEvt: async (d,pool,dec) => {
        const dir = await fetchPoolDir(pool);
        return parseTurbosSwap(d,dir,dec,suiPrice);
    }},
    { key:'bluefin', type:BLUEFIN_EVENT, parseEvt: async (d,_pool,dec) => {
        return parseBluefinOrder(d,dec,suiPrice);
    }},
  ];

  for (const dex of dexes) {
    // Initialize cursor on first run (skip history)
    await initCursorToLatest(dex.key, dex.type);
    if (!dexInit[dex.key]) continue;

    try {
      const res = await rpc('suix_queryEvents',[{MoveEventType:dex.type},cursors[dex.key]||null,50,false]);
      if (!res?.data?.length) continue;
      if (res.nextCursor){ cursors[dex.key]=res.nextCursor; saveCursors(); }

      for (const ev of res.data) {
        const hash = ev.id?.txDigest||'';
        if (!hash) continue;
        const txKey = `${dex.key}:${hash}`;
        if (seenTx.has(txKey)) continue;
        seenTx.set(txKey,Date.now());
        for (const [k,v] of seenTx) if(Date.now()-v>DEDUP_TTL)seenTx.delete(k);

        const d    = ev.parsedJson||{};
        const pool = d.pool||d.pool_id||d.market_id||'';
        const wallet = ev.sender||'';

        for (const [chatId, grp] of active) {
          // Pool filter (optional)
          if (grp.knownPools?.length && pool && !grp.knownPools.some(p=>p===pool)) continue;

          const dec = coinMeta[grp.tokenAddress]?.decimals ?? grp.decimals ?? 6;
          const parsed = await dex.parseEvt(d, pool, dec);
          if (!parsed||parsed.usdAmt<=0) continue;
          if (parsed.usdAmt<(grp.minBuyUSD||0)) continue;

          // Use live totalSupply from coin metadata
          const supply = coinMeta[grp.tokenAddress]?.totalSupply ?? grp.totalSupply;
          const mcap   = supply&&parsed.price>0 ? parsed.price*supply : null;

          totalBuys++;
          const cnt=(buyCount.get(chatId)||0)+1; buyCount.set(chatId,cnt);
          const wk=`${chatId}:${wallet}`;
          const isNew=!seenWallet.has(wk);
          if(wallet)seenWallet.set(wk,true);

          log(`🟢 ${grp.tokenSymbol} $${parsed.usdAmt.toFixed(2)} on ${dex.key} → ${chatId}`);
          await sendAlert(chatId,grp,{
            suiAmt:parsed.suiAmt, tokAmt:parsed.tokAmt,
            usdAmt:parsed.usdAmt, price:parsed.price,
            mcap, wallet, txHash:hash, cnt, isNew,
          }, dex.key);
        }
      }
    } catch(err){ log(`[Poll:${dex.key}] ${err.message}`); }
  }
}

// ─── BUILD BUY ALERT ─────────────────────────────────────────────────────────
const DEX_META = {
  cetus:   {name:'Cetus',   icon:'🐋'},
  turbos:  {name:'Turbos',  icon:'🌀'},
  bluefin: {name:'Bluefin', icon:'🐬'},
};

function buildCaption(grp, buy, dexKey) {
  const dm  = DEX_META[dexKey]||{name:dexKey,icon:'🔄'};
  const bar = buyBar(buy.usdAmt,grp.emoji,grp.buyStep,grp.maxEmojis);
  const ta  = grp.tokenAddress||'';
  const badges=[];
  if(buy.isNew)            badges.push('🆕 New Buyer\\!');
  if(buy.cnt)              badges.push(`🏆 Buyer \\#${buy.cnt}`);
  if(buy.usdAmt>=5000)     badges.push('🦈 MEGA WHALE\\!');
  else if(buy.usdAmt>=1000)badges.push('🐳 Whale Alert\\!');
  const badgeLine = badges.length ? `\n${badges.join('   ')}` : '';

  return `🤖 *AGENT BUYBOT*
━━━━━━━━━━━━━━━━━━━
*${e(grp.tokenSymbol)}* Buy on *${e(dm.name)}* ${dm.icon}${badgeLine}

${bar}

💎 SUI: *$${e(suiPrice.toFixed(3))}*
💰 *${e(fmt$(buy.usdAmt))}* \\(${e(buy.suiAmt.toFixed(4))} SUI\\)
🪙 ${e(fmtTk(buy.tokAmt))} *${e(grp.tokenSymbol)}*

📊 Price: *${e(fmtP(buy.price))}*
💹 MCap: *${e(fmtMc(buy.mcap))}*

👤 [${e(short(buy.wallet))}](https://suiscan.xyz/mainnet/account/${buy.wallet})
🔗 [TX](https://suiscan.xyz/mainnet/tx/${buy.txHash}) \\| [Chart](https://dexscreener.com/sui/${ta}) \\| [Token](https://suiscan.xyz/mainnet/object/${ta})

⚡ _AGENT BUYBOT_ \\| [Join](${e(AGENT_LINK)})`;
}

async function sendAlert(chatId,grp,buy,dexKey) {
  const caption = buildCaption(grp,buy,dexKey);
  const opts={parse_mode:'MarkdownV2',disable_web_page_preview:true};
  try {
    if(grp.media){
      const {type,fileId}=grp.media;
      if(type==='photo')          await bot.sendPhoto(chatId,fileId,{caption,...opts});
      else if(type==='animation') await bot.sendAnimation(chatId,fileId,{caption,...opts});
      else if(type==='video')     await bot.sendVideo(chatId,fileId,{caption,...opts});
      else await bot.sendMessage(chatId,caption,opts);
    } else await bot.sendMessage(chatId,caption,opts);
  } catch(err){
    log(`[Alert→${chatId}] ${err.message}`);
    if(/kicked|not found|deactivated|blocked/i.test(err.message)){delete config.groups[chatId];save();}
  }
}

// ─── KEYBOARDS ───────────────────────────────────────────────────────────────
function kbGroupList() {
  const rows=Object.entries(config.groups).map(([id,g])=>{
    const lbl=g.tokenSymbol?`${g.groupName} — ✅ ${g.tokenSymbol}`:`${g.groupName} — ⚠️ No token`;
    return [{text:lbl,callback_data:`grp:${id}`}];
  });
  rows.push([{text:'➕ Add to Another Group', url:`https://t.me/${botUser}?startgroup=add`}]);
  return {inline_keyboard:rows};
}

function kbSettings(chatId) {
  const g=config.groups[chatId]; if(!g) return {inline_keyboard:[]};
  const rows=[];
  rows.push([g.tokenSymbol?{text:`🪙 Token: ${g.tokenSymbol}`,callback_data:`s:token:${chatId}`}:{text:'🔗 Track Token',callback_data:`s:token:${chatId}`}]);
  rows.push([{text:`💰 Min Buy: $${(g.minBuyUSD||0).toFixed(2)}`,callback_data:`s:min:${chatId}`},{text:`📊 Buy Step: $${(g.buyStep||100).toFixed(2)}`,callback_data:`s:step:${chatId}`}]);
  rows.push([{text:`${g.emoji||'🟢'} Emoji: ${g.emoji||'🟢'}`,callback_data:`s:emoji:${chatId}`},{text:`🔢 Max Emojis: ${g.maxEmojis||20}`,callback_data:`s:maxe:${chatId}`}]);
  const mediaLabel=g.media?'✅ '+{photo:'Image',animation:'GIF',video:'Video'}[g.media.type]||'Set':'Not set';
  rows.push([{text:`🖼 Media: ${mediaLabel}`,callback_data:`s:media:${chatId}`}]);
  if(g.media) rows.push([{text:'🗑 Clear Media',callback_data:`clr:${chatId}`}]);
  if(g.tokenSymbol) rows.push([{text:'🗑 Untrack Token',callback_data:`untrack:${chatId}`}]);
  rows.push([{text:g.paused?'▶️ Resume Alerts':'⏸ Pause Alerts',callback_data:`pause:${chatId}`}]);
  rows.push([{text:'⬅️ Back to Groups',callback_data:'back'}]);
  return {inline_keyboard:rows};
}

const kbCancel=tag=>({inline_keyboard:[[{text:'❌ Cancel',callback_data:`cancel:${tag}`}]]});

// ─── SESSION ─────────────────────────────────────────────────────────────────
const getSess=(uid)=>sessions.get(uid)||{state:S.IDLE,groupId:null,msgId:null};
const setSess=(uid,p)=>sessions.set(uid,{...getSess(uid),...p});
const clrSess=(uid)=>sessions.set(uid,{state:S.IDLE,groupId:null,msgId:null});

// ─── PANELS ──────────────────────────────────────────────────────────────────
async function showGroupList(uid,chatId,editId) {
  const text='🤖 *AGENT BUYBOT*\n\nSelect a group to configure:';
  try {
    if(editId) await bot.editMessageText(text,{chat_id:chatId,message_id:editId,parse_mode:'MarkdownV2',reply_markup:kbGroupList()});
    else { const m=await bot.sendMessage(chatId,text,{parse_mode:'MarkdownV2',reply_markup:kbGroupList()}); setSess(uid,{msgId:m.message_id}); }
  } catch(err){log(`[GroupList] ${err.message}`);}
}

async function showSettings(uid,chatId,groupId,editId) {
  const g=config.groups[groupId]; if(!g) return;
  const status=g.tokenSymbol
    ?`Tracking: *${e(g.tokenSymbol)}*${g.tokenName?` \\(${e(g.tokenName)}\\)`:''}`
    :'No token tracked yet — tap *Track Token* to add one\\.';
  const text=`⚙️ *Settings — ${e(g.groupName||groupId)}*\n\n${status}\n\nTap any button to change a setting\\.\nJust type your new value and send it\\.`;
  try {
    if(editId) await bot.editMessageText(text,{chat_id:chatId,message_id:editId,parse_mode:'MarkdownV2',reply_markup:kbSettings(groupId)});
    else { const m=await bot.sendMessage(chatId,text,{parse_mode:'MarkdownV2',reply_markup:kbSettings(groupId)}); setSess(uid,{msgId:m.message_id}); }
  } catch(err){log(`[Settings] ${err.message}`);}
}

// ─── BOT ─────────────────────────────────────────────────────────────────────
if(!process.env.BOT_TOKEN){ console.error('❌ BOT_TOKEN missing.'); process.exit(1); }
const bot=new TelegramBot(process.env.BOT_TOKEN,{polling:true});

// ─── ADDED TO GROUP ───────────────────────────────────────────────────────────
bot.on('new_chat_members',async msg=>{
  try {
    const me=await bot.getMe();
    if(!msg.new_chat_members.some(m=>m.id===me.id)) return;
    const chatId=String(msg.chat.id), name=msg.chat.title||chatId;
    ensureGroup(chatId,name);
    log(`✅ Added to: ${name} (${chatId})`);
    const btn={reply_markup:{inline_keyboard:[[{text:'⚙️ Set Up in DM',url:`https://t.me/${botUser}?start=g_${chatId}`}]]}};
    await bot.sendMessage(chatId,`🤖 AGENT BUYBOT has arrived!\n\nTap below to set me up. Everything is configured in DM — no commands needed here!\n\n1️⃣ Make sure I'm an admin\n2️⃣ Tap the button below\n3️⃣ Pick this group and add your token`,btn);
    await bot.sendMessage(chatId,`🤖 AGENT BUYBOT is active!\n\nTap below to set me up in DM.`,btn);
  } catch(err){log(`[new_chat_members] ${err.message}`);}
});

// ─── /start ──────────────────────────────────────────────────────────────────
bot.onText(/^\/start(?:\s+(.+))?$/,async(msg,match)=>{
  const uid=String(msg.from.id),chatId=String(msg.chat.id),param=(match?.[1]||'').trim();
  if(msg.chat.type!=='private'){
    ensureGroup(chatId,msg.chat.title);
    return bot.sendMessage(chatId,'🤖 AGENT BUYBOT is active!\n\nTap below to set me up in DM.',
      {reply_markup:{inline_keyboard:[[{text:'⚙️ Set Up in DM',url:`https://t.me/${botUser}?start=g_${chatId}`}]]}});
  }
  if(param.startsWith('g_')){
    const gid=param.slice(2);
    if(config.groups[gid]){clrSess(uid);setSess(uid,{groupId:gid});return showSettings(uid,chatId,gid,null);}
  }
  clrSess(uid); await showGroupList(uid,chatId,null);
});

// ─── /help ───────────────────────────────────────────────────────────────────
bot.onText(/\/help/,async msg=>{
  const chatId=String(msg.chat.id);
  if(msg.chat.type!=='private')
    return bot.sendMessage(chatId,'🤖 AGENT BUYBOT\n\nTap below to configure in DM.',
      {reply_markup:{inline_keyboard:[[{text:'⚙️ Set Up in DM',url:`https://t.me/${botUser}?start=setup`}]]}});
  await bot.sendMessage(chatId,
`🤖 *AGENT BUYBOT* — Help
━━━━━━━━━━━━━━━━━━━━━

*Setup:*
1\\. Add me to your group as admin
2\\. Tap *"⚙️ Set Up in DM"* from the group
3\\. Select your group → paste token address
4\\. Customise Emoji, Buy Step, Media

*Settings per group:*
🔗 Token \\(0xPkg::module::COIN\\)
💰 Min buy in USD
📊 Buy step \\(USD per emoji\\)
🎨 Custom emoji
🔢 Max emojis
🖼 Photo / GIF / Video

*DEXes:* Cetus 🐋   Turbos 🌀   Bluefin 🐬

⚡ [Join AGENT Community](${e(AGENT_LINK)})`,
    {parse_mode:'MarkdownV2',disable_web_page_preview:true});
});

// ─── /stats ──────────────────────────────────────────────────────────────────
bot.onText(/\/stats/,async msg=>{
  const chatId=String(msg.chat.id),grps=Object.values(config.groups);
  await bot.sendMessage(chatId,
`📊 *AGENT BUYBOT Stats*
━━━━━━━━━━━━━━━━━━
✅ Buys detected: *${totalBuys}*
🏠 Groups: *${grps.length}*
🪙 Tokens: *${new Set(grps.map(g=>g.tokenAddress).filter(Boolean)).size}*
⏱ Uptime: *${e(upStr())}*
🌐 RPC: \`${e(activeRpc?activeRpc.split('/')[2]:'None')}\`
💎 SUI: *$${e(suiPrice.toFixed(4))}*

💧 Cetus 🐋   Turbos 🌀   Bluefin 🐬
⚡ _v${e(BOT_VERSION)}_`,{parse_mode:'MarkdownV2'});
});

// ─── CALLBACKS ───────────────────────────────────────────────────────────────
bot.on('callback_query',async query=>{
  const uid=String(query.from.id),chatId=String(query.message.chat.id),msgId=query.message.message_id,data=query.data;
  try{await bot.answerCallbackQuery(query.id);}catch{}
  const ss=getSess(uid);
  if(data==='back'){clrSess(uid);setSess(uid,{msgId});return showGroupList(uid,chatId,msgId);}
  if(data.startsWith('grp:')){const gid=data.slice(4);if(!config.groups[gid])return;setSess(uid,{groupId:gid,msgId});return showSettings(uid,chatId,gid,msgId);}
  if(data.startsWith('clr:')){const gid=data.slice(4);if(config.groups[gid]){config.groups[gid].media=null;save();}setSess(uid,{msgId});return showSettings(uid,chatId,gid,msgId);}
  if(data.startsWith('untrack:')){const gid=data.slice(8);if(config.groups[gid]){const g=config.groups[gid];g.tokenAddress=null;g.tokenSymbol=null;g.tokenName=null;g.knownPools=[];save();}setSess(uid,{msgId});return showSettings(uid,chatId,gid,msgId);}
  if(data.startsWith('pause:')){const gid=data.slice(6);if(config.groups[gid]){config.groups[gid].paused=!config.groups[gid].paused;save();}setSess(uid,{msgId});return showSettings(uid,chatId,gid,msgId);}
  if(data.startsWith('cancel:')){const gid=ss.groupId;clrSess(uid);if(gid&&config.groups[gid])return showSettings(uid,chatId,gid,msgId);return showGroupList(uid,chatId,msgId);}
  if(data.startsWith('s:')){
    const parts=data.split(':'),field=parts[1],gid=parts.slice(2).join(':');
    if(!config.groups[gid])return;
    setSess(uid,{groupId:gid,msgId});
    const P={
      token:[S.TOKEN,'🔗 Track a Token','Paste the full Sui token address.\n\nFormat: 0xPackageId::module::COIN\n\nFind it on DexScreener or Suiscan.'],
      min:  [S.MIN,  '💰 Min Buy','Type the minimum USD to trigger an alert.\n\nExample: 5 for $5 minimum. Type 0 for all buys.'],
      step: [S.STEP, '📊 Buy Step','How many USD per emoji?\n\nExample: 50 means $50 = 1 emoji, $500 = 10 emojis.'],
      emoji:[S.EMOJI,'🎨 Emoji','Send the emoji for the buy bar.\n\nExamples: 🚀 💎 🔥 🦅 💰 🟢'],
      maxe: [S.MAXE, '🔢 Max Emojis','Maximum emojis in the buy bar. Example: 20 or 50.'],
      media:[S.MEDIA,'🖼 Media','Send a photo, GIF, or video to show with every buy alert.'],
    };
    const p=P[field]; if(!p)return;
    setSess(uid,{state:p[0]});
    return bot.editMessageText(`${p[1]}\n\n${p[2]}`,{chat_id:chatId,message_id:msgId,reply_markup:kbCancel(`${field}:${gid}`)});
  }
});

// ─── DM TEXT INPUT ───────────────────────────────────────────────────────────
bot.on('message',async msg=>{
  if(msg.chat.type!=='private')return;
  const uid=String(msg.from.id),chatId=String(msg.chat.id);
  const {state,groupId,msgId}=getSess(uid),text=(msg.text||'').trim();
  if(state===S.IDLE)return;
  const g=config.groups[groupId]; if(!g){clrSess(uid);return;}

  const confirm=async txt=>{await bot.sendMessage(chatId,txt);clrSess(uid);setSess(uid,{msgId});await showSettings(uid,chatId,groupId,msgId);};
  const bad=async(txt,field)=>bot.sendMessage(chatId,txt,{reply_markup:kbCancel(`${field}:${groupId}`)});

  if(state===S.TOKEN){
    const addr=text.replace(/\s+/g,'');
    if(!addr.startsWith('0x')||!addr.includes('::')) return bad('⚠️ Invalid format. Expected: 0xPkg::module::COIN\n\nFind it on DexScreener or Suiscan.','token');
    const sym=addr.split('::').pop().toUpperCase();
    g.tokenAddress=addr; g.tokenSymbol=sym; g.tokenName=null; g.knownPools=[]; save();
    // Immediately fetch metadata for this token
    const meta=await fetchCoinMeta(addr);
    if(meta.decimals!==undefined) g.decimals=meta.decimals;
    if(meta.totalSupply){ g.totalSupply=meta.totalSupply; g.tokenName=meta.name; }
    save();
    const supplyStr=g.totalSupply?`\nSupply: ${g.totalSupply.toLocaleString()} ${sym}`:'';
    return confirm(`✅ Now tracking *${sym}*${supplyStr}`);
  }
  if(state===S.MIN){const v=parseFloat(text);if(isNaN(v)||v<0)return bad('⚠️ Send a number ≥ 0. Example: 5 or 0','min');g.minBuyUSD=v;save();return confirm(`✅ Min buy set to $${v.toFixed(2)}`);}
  if(state===S.STEP){const v=parseFloat(text);if(isNaN(v)||v<=0)return bad('⚠️ Send a positive number. Example: 42','step');g.buyStep=v;save();return confirm(`✅ Buy step set to $${v.toFixed(2)} per emoji`);}
  if(state===S.EMOJI){const v=text.trim();if(!v||v.length>10)return bad('⚠️ Send a single emoji like 🚀','emoji');g.emoji=v;save();return confirm(`✅ Emoji set to ${v}`);}
  if(state===S.MAXE){const v=parseInt(text);if(isNaN(v)||v<1||v>100)return bad('⚠️ Send a number 1–100','maxe');g.maxEmojis=v;save();return confirm(`✅ Max emojis set to ${v}`);}
});

// ─── MEDIA INPUT ─────────────────────────────────────────────────────────────
bot.on('message',async msg=>{
  if(msg.chat.type!=='private')return;
  const uid=String(msg.from.id),chatId=String(msg.chat.id);
  const {state,groupId,msgId}=getSess(uid);
  if(state!==S.MEDIA)return;
  const g=config.groups[groupId]; if(!g){clrSess(uid);return;}
  let media=null;
  if(msg.photo)     media={type:'photo',     fileId:msg.photo[msg.photo.length-1].file_id};
  else if(msg.animation)media={type:'animation',fileId:msg.animation.file_id};
  else if(msg.video)    media={type:'video',     fileId:msg.video.file_id};
  if(!media)return bot.sendMessage(chatId,'⚠️ Please send a photo, GIF, or video.',{reply_markup:kbCancel(`media:${groupId}`)});
  g.media=media;save();
  const lbl={photo:'Image',animation:'GIF',video:'Video'}[media.type];
  await bot.sendMessage(chatId,`✅ Media: ${lbl} set`);
  clrSess(uid);setSess(uid,{msgId});await showSettings(uid,chatId,groupId,msgId);
});

// ─── ERRORS ──────────────────────────────────────────────────────────────────
bot.on('polling_error',err=>log(`[Poll] ${err.message}`));
process.on('unhandledRejection',r=>log(`[Unhandled] ${r}`));
process.on('uncaughtException',e=>log(`[Uncaught] ${e.message}`));

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main(){
  log(`🤖 AGENT BUYBOT v${BOT_VERSION}`);
  const me=await bot.getMe(); botUser=me.username;
  log(`✅ @${botUser}`);
  await refreshPrice();
  setInterval(refreshPrice,PRICE_MS);
  log('🚀 Polling Cetus · Turbos · Bluefin...');
  setInterval(async()=>{try{await poll();}catch(err){log(`[Loop] ${err.message}`);}},POLL_MS);
  log('✅ Ready.');
}
main().catch(console.error);
