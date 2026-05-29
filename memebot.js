require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder,
  SlashCommandBuilder, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const axios = require('axios');
const Database = require('better-sqlite3');

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database('memebot.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS signal_channels (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    chain TEXT NOT NULL,
    symbol TEXT,
    channel_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    added_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    chain TEXT NOT NULL,
    symbol TEXT,
    signal TEXT,
    entry_price REAL,
    confidence REAL,
    reasoning TEXT,
    channel_id TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS cooldowns (
    user_id TEXT NOT NULL,
    command TEXT NOT NULL,
    last_used INTEGER NOT NULL,
    PRIMARY KEY (user_id, command)
  );
`);

// ─── Config ───────────────────────────────────────────────────────────────────
const DEXSCREENER_API  = 'https://api.dexscreener.com/latest/dex';
const GECKO_API        = 'https://api.geckoterminal.com/api/v2';
const SCAN_INTERVAL    = 15 * 60 * 1000; // 15 menit
const COOLDOWNS_MAP    = { scan: 60, analyze: 20, ca: 15, watchlist: 5, setchannel: 5, signals: 5, help: 5 };

// Chains supported
const CHAINS = {
  ethereum: 'eth',
  solana: 'solana',
  base: 'base',
  bsc: 'bsc'
};

// ─── Client ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// ─── Commands ─────────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('scan')
    .setDescription('🔍 Scan meme coin terbaik untuk scalping sekarang')
    .addStringOption(o => o.setName('chain')
      .setDescription('Chain (default: semua)')
      .setRequired(false)
      .addChoices(
        { name: 'Semua Chain', value: 'all' },
        { name: 'Ethereum', value: 'ethereum' },
        { name: 'Solana', value: 'solana' },
        { name: 'Base', value: 'base' },
        { name: 'BSC', value: 'bsc' }
      )),

  new SlashCommandBuilder()
    .setName('ca')
    .setDescription('🔎 Analisis token by contract address')
    .addStringOption(o => o.setName('address').setDescription('Contract address token').setRequired(true))
    .addStringOption(o => o.setName('chain')
      .setDescription('Chain token')
      .setRequired(false)
      .addChoices(
        { name: 'Auto Detect', value: 'auto' },
        { name: 'Ethereum', value: 'ethereum' },
        { name: 'Solana', value: 'solana' },
        { name: 'Base', value: 'base' },
        { name: 'BSC', value: 'bsc' }
      )),

  new SlashCommandBuilder()
    .setName('analyze')
    .setDescription('📊 Analisis teknikal mendalam sebuah token')
    .addStringOption(o => o.setName('symbol').setDescription('Symbol token (contoh: PEPE, DOGE, WIF)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('watchlist')
    .setDescription('📋 Lihat watchlist token yang dipantau'),

  new SlashCommandBuilder()
    .setName('signals')
    .setDescription('📡 Lihat sinyal terbaru yang digenerate bot'),

  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('📌 Set channel untuk sinyal otomatis (admin only)')
    .addChannelOption(o => o.setName('channel').setDescription('Channel target').setRequired(true)),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('❓ Panduan lengkap MemeBot'),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    if (process.env.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
      console.log('✅ Commands registered (instant)');
    } else {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
      console.log('✅ Global commands registered');
    }
  } catch (e) { console.error('❌ Register failed:', e.message); }
}

// ─── Cooldown ─────────────────────────────────────────────────────────────────
function checkCooldown(userId, command) {
  const secs = COOLDOWNS_MAP[command] || 10;
  const row = db.prepare('SELECT last_used FROM cooldowns WHERE user_id=? AND command=?').get(userId, command);
  const now = Math.floor(Date.now() / 1000);
  if (row && now - row.last_used < secs) return secs - (now - row.last_used);
  db.prepare('INSERT OR REPLACE INTO cooldowns (user_id, command, last_used) VALUES (?,?,?)').run(userId, command, now);
  return 0;
}

// ─── API Helpers ──────────────────────────────────────────────────────────────
async function apiGet(url, params = {}, headers = {}, attempt = 1) {
  try {
    const res = await axios.get(url, { params, headers, timeout: 10000 });
    return res.data;
  } catch (err) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return apiGet(url, params, headers, attempt + 1);
    }
    throw err;
  }
}

// ─── DexScreener ──────────────────────────────────────────────────────────────
async function getDexScreenerToken(address) {
  try {
    const data = await apiGet(`${DEXSCREENER_API}/tokens/${address}`);
    return data?.pairs?.[0] || null;
  } catch { return null; }
}

async function searchDexScreener(query) {
  try {
    const data = await apiGet(`${DEXSCREENER_API}/search`, { q: query });
    return data?.pairs || [];
  } catch { return []; }
}

async function getDexScreenerTrending() {
  try {
    // Get trending from multiple chains
    const chains = ['ethereum', 'solana', 'base', 'bsc'];
    const results = [];
    for (const chain of chains) {
      try {
        const data = await apiGet(`${DEXSCREENER_API}/pairs/${chain}`, {});
        if (data?.pairs) results.push(...data.pairs.slice(0, 5));
      } catch { /* skip chain */ }
    }
    return results;
  } catch { return []; }
}

// ─── GeckoTerminal ────────────────────────────────────────────────────────────
async function getGeckoTrending() {
  try {
    const data = await apiGet(`${GECKO_API}/networks/trending_pools`, {
      include: 'base_token',
      page: 1
    }, { 'Accept': 'application/json;version=20230302' });
    return data?.data || [];
  } catch { return []; }
}

async function getGeckoToken(network, address) {
  try {
    const data = await apiGet(
      `${GECKO_API}/networks/${network}/tokens/${address}`,
      { include: 'top_pools' },
      { 'Accept': 'application/json;version=20230302' }
    );
    return data?.data || null;
  } catch { return null; }
}

async function getGeckoOHLCV(network, poolAddress, timeframe = 'hour') {
  try {
    const data = await apiGet(
      `${GECKO_API}/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}`,
      { limit: 24 },
      { 'Accept': 'application/json;version=20230302' }
    );
    return data?.data?.attributes?.ohlcv_list || [];
  } catch { return []; }
}

// ─── Technical Analysis ───────────────────────────────────────────────────────
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcMACD(prices) {
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  if (!ema12 || !ema26) return null;
  return { macd: ema12 - ema26, ema12, ema26 };
}

function calcBollingerBands(prices, period = 20) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + 2 * std, middle: mean, lower: mean - 2 * std, std };
}

function calcVolumeProfile(volumes) {
  if (!volumes.length) return { avg: 0, trend: 'neutral' };
  const avg = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const recent = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const trend = recent > avg * 1.5 ? 'surging' : recent > avg * 1.1 ? 'increasing' : recent < avg * 0.5 ? 'declining' : 'stable';
  return { avg, recent, trend };
}

// ─── Rug / Manipulation Detector ─────────────────────────────────────────────
function detectRisks(pair) {
  const risks = [];
  const warnings = [];
  let riskScore = 0;

  // Liquidity check
  const liquidity = parseFloat(pair.liquidity?.usd || 0);
  if (liquidity < 10000) { risks.push('⛔ Likuiditas sangat rendah (<$10K)'); riskScore += 40; }
  else if (liquidity < 50000) { warnings.push('⚠️ Likuiditas rendah (<$50K)'); riskScore += 15; }

  // Volume vs Liquidity ratio (pump detector)
  const volume24h = parseFloat(pair.volume?.h24 || 0);
  const volLiqRatio = liquidity > 0 ? volume24h / liquidity : 0;
  if (volLiqRatio > 50) { risks.push('⛔ Volume/Likuiditas ratio ekstrem (pump & dump risk)'); riskScore += 35; }
  else if (volLiqRatio > 20) { warnings.push('⚠️ Volume spike tinggi — perhatikan exit liquidity'); riskScore += 10; }

  // Age check
  const createdAt = pair.pairCreatedAt;
  if (createdAt) {
    const ageHours = (Date.now() - createdAt) / (1000 * 60 * 60);
    if (ageHours < 1) { risks.push('⛔ Token sangat baru (<1 jam) — rug risk tinggi'); riskScore += 45; }
    else if (ageHours < 24) { warnings.push('⚠️ Token baru (<24 jam) — DYOR'); riskScore += 20; }
  }

  // Price change manipulation check
  const priceChange24h = parseFloat(pair.priceChange?.h24 || 0);
  const priceChange1h = parseFloat(pair.priceChange?.h1 || 0);
  if (priceChange1h > 100) { risks.push('⛔ Pump ekstrem +100% dalam 1 jam — kemungkinan manipulasi'); riskScore += 30; }
  else if (priceChange1h > 50) { warnings.push('⚠️ Pump besar +50% dalam 1 jam'); riskScore += 15; }
  if (priceChange24h < -70) { risks.push('⛔ Dump besar -70% dalam 24 jam'); riskScore += 25; }

  // Txn count (wash trading detector)
  const txns24h = (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0);
  if (txns24h < 10 && volume24h > 10000) { warnings.push('⚠️ Volume tinggi tapi transaksi sedikit — kemungkinan wash trading'); riskScore += 20; }

  // Buy/sell ratio (manipulation)
  const buys = pair.txns?.h1?.buys || 0;
  const sells = pair.txns?.h1?.sells || 0;
  if (buys > 0 && sells === 0) { warnings.push('⚠️ Tidak ada sell dalam 1 jam — kemungkinan honeypot'); riskScore += 25; }

  const level = riskScore >= 50 ? 'HIGH' : riskScore >= 25 ? 'MEDIUM' : 'LOW';
  return { risks, warnings, riskScore, level };
}

// ─── Scalping Score ───────────────────────────────────────────────────────────
function calcScalpScore(pair, techAnalysis) {
  let score = 0;

  // Volume score (higher = better for scalping)
  const vol24h = parseFloat(pair.volume?.h24 || 0);
  if (vol24h > 1000000) score += 25;
  else if (vol24h > 500000) score += 20;
  else if (vol24h > 100000) score += 10;

  // Liquidity score
  const liq = parseFloat(pair.liquidity?.usd || 0);
  if (liq > 500000) score += 20;
  else if (liq > 100000) score += 15;
  else if (liq > 50000) score += 8;

  // Price momentum
  const pc1h = parseFloat(pair.priceChange?.h1 || 0);
  const pc5m = parseFloat(pair.priceChange?.m5 || 0);
  if (pc5m > 2 && pc5m < 15) score += 15; // healthy momentum
  if (pc1h > 5 && pc1h < 30) score += 10;

  // Technical indicators
  if (techAnalysis?.rsi) {
    const rsi = techAnalysis.rsi;
    if (rsi > 40 && rsi < 65) score += 15; // sweet spot for scalping
    else if (rsi > 30 && rsi < 70) score += 8;
  }

  // Txn activity
  const txns1h = (pair.txns?.h1?.buys || 0) + (pair.txns?.h1?.sells || 0);
  if (txns1h > 200) score += 15;
  else if (txns1h > 50) score += 8;

  return Math.min(score, 100);
}

// ─── AI Analysis ─────────────────────────────────────────────────────────────
async function analyzeWithAI(tokenData, techData, riskData) {
  const systemPrompt = `Kamu adalah trader kripto berpengalaman yang spesialis di meme coin scalping.
Analisis data token berikut dan berikan sinyal trading yang akurat.
Fokus pada: momentum, volume, technical indicators, dan risk management.
Respond HANYA dalam format JSON, tidak ada teks lain di luar JSON.`;

  const prompt = `Analisis token ini untuk scalping:

TOKEN: ${tokenData.symbol} (${tokenData.name})
Chain: ${tokenData.chain}
Harga: $${tokenData.price}
Perubahan 5m: ${tokenData.priceChange5m}%
Perubahan 1h: ${tokenData.priceChange1h}%  
Perubahan 24h: ${tokenData.priceChange24h}%
Volume 24h: $${tokenData.volume24h}
Likuiditas: $${tokenData.liquidity}
Transaksi 1h: ${tokenData.txns1h} (${tokenData.buys1h} buy / ${tokenData.sells1h} sell)

TECHNICAL:
RSI: ${techData.rsi ? techData.rsi.toFixed(1) : 'N/A'}
MACD: ${techData.macd ? `${techData.macd.macd.toFixed(8)} (EMA12: ${techData.macd.ema12.toFixed(8)}, EMA26: ${techData.macd.ema26.toFixed(8)})` : 'N/A'}
Bollinger: ${techData.bb ? `Upper: ${techData.bb.upper.toFixed(8)}, Middle: ${techData.bb.middle.toFixed(8)}, Lower: ${techData.bb.lower.toFixed(8)}` : 'N/A'}
Volume Trend: ${techData.volProfile ? techData.volProfile.trend : 'N/A'}

RISK:
Level: ${riskData.level}
Score: ${riskData.riskScore}/100
Risks: ${riskData.risks.join(', ') || 'None'}
Warnings: ${riskData.warnings.join(', ') || 'None'}

Berikan analisis dalam format JSON:
{
  "signal": "BUY" atau "SELL" atau "HOLD" atau "AVOID",
  "confidence": angka 0-100,
  "entry": "harga entry ideal atau range",
  "target1": "target profit 1 (konservatif)",
  "target2": "target profit 2 (agresif)",
  "stop_loss": "level stop loss",
  "timeframe": "estimasi durasi trade (misal: 15-30 menit)",
  "reasoning": "alasan singkat 2-3 kalimat",
  "key_catalyst": "faktor utama yang mendrive pergerakan",
  "risk_reward": "ratio risk/reward (misal: 1:2)"
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        system: systemPrompt,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    const rawText = textBlocks.map(b => b.text).join('');
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON');
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('AI error:', err.message);
    return fallbackSignal(tokenData, techData, riskData);
  }
}

function fallbackSignal(tokenData, techData, riskData) {
  if (riskData.level === 'HIGH') {
    return {
      signal: 'AVOID',
      confidence: 85,
      entry: 'N/A',
      target1: 'N/A',
      target2: 'N/A',
      stop_loss: 'N/A',
      timeframe: 'N/A',
      reasoning: 'Risk terlalu tinggi untuk scalping. Hindari token ini.',
      key_catalyst: 'High risk detected',
      risk_reward: 'N/A'
    };
  }
  const rsi = techData.rsi;
  const signal = rsi && rsi < 40 ? 'BUY' : rsi && rsi > 70 ? 'SELL' : 'HOLD';
  return {
    signal,
    confidence: 45,
    entry: `$${tokenData.price}`,
    target1: `$${(parseFloat(tokenData.price) * 1.05).toFixed(8)}`,
    target2: `$${(parseFloat(tokenData.price) * 1.10).toFixed(8)}`,
    stop_loss: `$${(parseFloat(tokenData.price) * 0.95).toFixed(8)}`,
    timeframe: '15-30 menit',
    reasoning: `Berdasarkan data teknikal. RSI: ${rsi ? rsi.toFixed(1) : 'N/A'}`,
    key_catalyst: 'Technical analysis',
    risk_reward: '1:1.5'
  };
}

// ─── Build Token Data ─────────────────────────────────────────────────────────
function buildTokenData(pair) {
  return {
    symbol: pair.baseToken?.symbol || '???',
    name: pair.baseToken?.name || '???',
    address: pair.baseToken?.address || '',
    chain: pair.chainId || 'unknown',
    price: pair.priceUsd || '0',
    priceChange5m: parseFloat(pair.priceChange?.m5 || 0).toFixed(2),
    priceChange1h: parseFloat(pair.priceChange?.h1 || 0).toFixed(2),
    priceChange24h: parseFloat(pair.priceChange?.h24 || 0).toFixed(2),
    volume24h: parseFloat(pair.volume?.h24 || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }),
    liquidity: parseFloat(pair.liquidity?.usd || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }),
    txns1h: (pair.txns?.h1?.buys || 0) + (pair.txns?.h1?.sells || 0),
    buys1h: pair.txns?.h1?.buys || 0,
    sells1h: pair.txns?.h1?.sells || 0,
    dexUrl: pair.url || `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`,
    pairAddress: pair.pairAddress || ''
  };
}

// ─── Signal Embed ─────────────────────────────────────────────────────────────
function signalColor(signal) {
  return { BUY: 0x00e5a0, SELL: 0xff5252, HOLD: 0xffd93d, AVOID: 0x888888 }[signal] || 0x5865f2;
}

function signalEmoji(signal) {
  return { BUY: '🟢 BUY', SELL: '🔴 SELL', HOLD: '🟡 HOLD', AVOID: '⛔ AVOID' }[signal] || '⚪';
}

function riskEmoji(level) {
  return { LOW: '🟢', MEDIUM: '🟡', HIGH: '🔴' }[level] || '🟡';
}

function buildSignalEmbed(tokenData, analysis, riskData, techData, isAuto = false) {
  const embed = new EmbedBuilder()
    .setTitle(`${isAuto ? '🤖 Auto Signal' : '📊 Analysis'} — ${tokenData.symbol}`)
    .setDescription(`**${tokenData.name}** on \`${tokenData.chain.toUpperCase()}\`\n\`${tokenData.address}\``)
    .setColor(signalColor(analysis.signal))
    .addFields(
      {
        name: '🎯 Sinyal',
        value: `**${signalEmoji(analysis.signal)}**\nConfidence: **${analysis.confidence}%**`,
        inline: true
      },
      {
        name: `${riskEmoji(riskData.level)} Risk Level`,
        value: `**${riskData.level}** (${riskData.riskScore}/100)`,
        inline: true
      },
      {
        name: '⏱️ Timeframe',
        value: `**${analysis.timeframe}**`,
        inline: true
      },
      {
        name: '💹 Harga & Pergerakan',
        value: `Harga: **$${tokenData.price}**\n5m: ${parseFloat(tokenData.priceChange5m) >= 0 ? '📈' : '📉'} **${tokenData.priceChange5m}%**\n1h: ${parseFloat(tokenData.priceChange1h) >= 0 ? '📈' : '📉'} **${tokenData.priceChange1h}%**\n24h: ${parseFloat(tokenData.priceChange24h) >= 0 ? '📈' : '📉'} **${tokenData.priceChange24h}%**`,
        inline: true
      },
      {
        name: '📊 Volume & Liquidity',
        value: `Vol 24h: **$${tokenData.volume24h}**\nLiquidity: **$${tokenData.liquidity}**\nTxns 1h: **${tokenData.txns1h}** (${tokenData.buys1h}🟢/${tokenData.sells1h}🔴)`,
        inline: true
      },
      {
        name: '📐 Technical',
        value: `RSI: **${techData.rsi ? techData.rsi.toFixed(1) : 'N/A'}**\nMACD: **${techData.macd ? (techData.macd.macd >= 0 ? '🟢 Bullish' : '🔴 Bearish') : 'N/A'}**\nVol Trend: **${techData.volProfile ? techData.volProfile.trend : 'N/A'}**`,
        inline: true
      }
    );

  if (analysis.signal !== 'AVOID' && analysis.signal !== 'HOLD') {
    embed.addFields({
      name: '🎯 Entry & Target',
      value: `Entry: **${analysis.entry}**\nTP1: **${analysis.target1}**\nTP2: **${analysis.target2}**\nSL: **${analysis.stop_loss}**\nR:R: **${analysis.risk_reward}**`,
      inline: false
    });
  }

  if (riskData.risks.length > 0) {
    embed.addFields({
      name: '⛔ Risk Flags',
      value: riskData.risks.slice(0, 3).join('\n'),
      inline: false
    });
  }

  if (riskData.warnings.length > 0) {
    embed.addFields({
      name: '⚠️ Warnings',
      value: riskData.warnings.slice(0, 3).join('\n'),
      inline: false
    });
  }

  embed.addFields({
    name: '💭 AI Reasoning',
    value: (analysis.reasoning || 'N/A').slice(0, 1024),
    inline: false
  });

  embed
    .setURL(tokenData.dexUrl)
    .setFooter({ text: `MemeBot • Bukan financial advice • DYOR! • ${new Date().toLocaleString('id-ID')}` })
    .setTimestamp();

  return embed;
}

function buildActionRow(tokenData) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('📊 DexScreener')
      .setStyle(ButtonStyle.Link)
      .setURL(tokenData.dexUrl),
    new ButtonBuilder()
      .setLabel('🦎 GeckoTerminal')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://www.geckoterminal.com/${tokenData.chain}/pools/${tokenData.pairAddress}`),
    new ButtonBuilder()
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
      .setCustomId(`refresh_${tokenData.address}_${tokenData.chain}`)
  );
}

// ─── Full Analysis Pipeline ───────────────────────────────────────────────────
async function fullAnalysis(pair) {
  const tokenData = buildTokenData(pair);
  const riskData = detectRisks(pair);

  // Get OHLCV for technical analysis
  let techData = { rsi: null, macd: null, bb: null, volProfile: { trend: 'unknown' } };
  try {
    const geckoNetwork = {
      ethereum: 'eth', solana: 'solana', base: 'base', bsc: 'bsc'
    }[pair.chainId] || pair.chainId;

    const ohlcv = await getGeckoOHLCV(geckoNetwork, pair.pairAddress, 'hour');
    if (ohlcv.length >= 14) {
      const closes = ohlcv.map(c => parseFloat(c[4]));
      const volumes = ohlcv.map(c => parseFloat(c[5]));
      techData.rsi = calcRSI(closes);
      techData.macd = calcMACD(closes);
      techData.bb = calcBollingerBands(closes);
      techData.volProfile = calcVolumeProfile(volumes);
    }
  } catch { /* use empty tech data */ }

  const analysis = await analyzeWithAI(tokenData, techData, riskData);
  return { tokenData, techData, riskData, analysis };
}

// ─── Auto Scanner ─────────────────────────────────────────────────────────────
async function runAutoScan() {
  try {
    const channels = db.prepare('SELECT * FROM signal_channels').all();
    if (!channels.length) return;

    console.log('🔍 Auto scan running...');
    const geckoTrending = await getGeckoTrending();

    // Filter & score tokens
    const candidates = [];
    for (const pool of geckoTrending.slice(0, 20)) {
      try {
        const attrs = pool.attributes;
        if (!attrs) continue;

        const vol24h = parseFloat(attrs.volume_usd?.h24 || 0);
        const liq = parseFloat(attrs.reserve_in_usd || 0);
        const priceChange1h = parseFloat(attrs.price_change_percentage?.h1 || 0);

        // Quick filter
        if (vol24h < 50000 || liq < 20000) continue;
        if (Math.abs(priceChange1h) > 100) continue; // too volatile / manipulation

        // Get DexScreener data for more info
        const network = pool.relationships?.network?.data?.id || 'ethereum';
        const baseTokenAddr = pool.relationships?.base_token?.data?.id?.split('_')[1] || '';
        if (!baseTokenAddr) continue;

        const dexPair = await getDexScreenerToken(baseTokenAddr);
        if (!dexPair) continue;

        const riskData = detectRisks(dexPair);
        if (riskData.level === 'HIGH') continue; // skip high risk

        const techData = { rsi: null, macd: null, bb: null, volProfile: { trend: 'unknown' } };
        const ohlcv = await getGeckoOHLCV(network, pool.id?.split('_')[1] || '', 'hour');
        if (ohlcv.length >= 14) {
          const closes = ohlcv.map(c => parseFloat(c[4]));
          const volumes = ohlcv.map(c => parseFloat(c[5]));
          techData.rsi = calcRSI(closes);
          techData.macd = calcMACD(closes);
          techData.bb = calcBollingerBands(closes);
          techData.volProfile = calcVolumeProfile(volumes);
        }

        const tokenData = buildTokenData(dexPair);
        const scalpScore = calcScalpScore(dexPair, techData);

        candidates.push({ tokenData, techData, riskData, dexPair, scalpScore });
        await new Promise(r => setTimeout(r, 500));
      } catch { /* skip */ }
    }

    // Sort by scalp score, take top 3
    candidates.sort((a, b) => b.scalpScore - a.scalpScore);
    const top = candidates.slice(0, 3);
    if (!top.length) return;

    for (const ch of channels) {
      try {
        const channel = await client.channels.fetch(ch.channel_id).catch(() => null);
        if (!channel) continue;

        const headerEmbed = new EmbedBuilder()
          .setTitle(`🤖 Auto Scan — ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`)
          .setDescription(`Ditemukan **${top.length}** meme coin potensial untuk scalping!`)
          .setColor(0x5865f2)
          .setTimestamp();

        await channel.send({ embeds: [headerEmbed] });

        for (const item of top) {
          const analysis = await analyzeWithAI(item.tokenData, item.techData, item.riskData);
          if (analysis.signal === 'AVOID') continue;

          const embed = buildSignalEmbed(item.tokenData, analysis, item.riskData, item.techData, true);
          const row = buildActionRow(item.tokenData);
          const msg = await channel.send({ embeds: [embed], components: [row] });

          db.prepare(`INSERT INTO signals (address, chain, symbol, signal, entry_price, confidence, reasoning, channel_id)
            VALUES (?,?,?,?,?,?,?,?)`)
            .run(item.tokenData.address, item.tokenData.chain, item.tokenData.symbol,
              analysis.signal, parseFloat(item.tokenData.price), analysis.confidence,
              analysis.reasoning, ch.channel_id);

          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (e) { console.error('Auto scan channel error:', e.message); }
    }
  } catch (e) { console.error('Auto scan error:', e.message); }
}

// ─── Interaction Handler ──────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── Button: Refresh ──
  if (interaction.isButton() && interaction.customId.startsWith('refresh_')) {
    const parts = interaction.customId.split('_');
    const address = parts[1];
    const chain = parts[2];
    await interaction.deferReply({ ephemeral: true });
    try {
      const pair = await getDexScreenerToken(address);
      if (!pair) return interaction.editReply('❌ Token tidak ditemukan.');
      const { tokenData, techData, riskData, analysis } = await fullAnalysis(pair);
      const embed = buildSignalEmbed(tokenData, analysis, riskData, techData, false);
      await interaction.editReply({ content: '🔄 Analisis terbaru:', embeds: [embed] });
    } catch { await interaction.editReply('❌ Gagal refresh.'); }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const wait = checkCooldown(interaction.user.id, interaction.commandName);
  if (wait > 0) return interaction.reply({ content: `⏳ Tunggu **${wait}s** lagi.`, ephemeral: true });

  await interaction.deferReply();
  const cmd = interaction.commandName;

  try {

    // ── /scan ──
    if (cmd === 'scan') {
      await interaction.editReply('🔍 Scanning meme coin terbaik untuk scalping...');
      const geckoTrending = await getGeckoTrending();
      const candidates = [];

      for (const pool of geckoTrending.slice(0, 15)) {
        try {
          const attrs = pool.attributes;
          if (!attrs) continue;
          const vol24h = parseFloat(attrs.volume_usd?.h24 || 0);
          const liq = parseFloat(attrs.reserve_in_usd || 0);
          if (vol24h < 50000 || liq < 20000) continue;

          const baseTokenAddr = pool.relationships?.base_token?.data?.id?.split('_')[1] || '';
          if (!baseTokenAddr) continue;

          const dexPair = await getDexScreenerToken(baseTokenAddr);
          if (!dexPair) continue;

          const riskData = detectRisks(dexPair);
          if (riskData.level === 'HIGH') continue;

          const tokenData = buildTokenData(dexPair);
          const techData = { rsi: null, macd: null, bb: null, volProfile: { trend: 'N/A' } };
          const scalpScore = calcScalpScore(dexPair, techData);
          candidates.push({ tokenData, techData, riskData, dexPair, scalpScore });

          await new Promise(r => setTimeout(r, 300));
          if (candidates.length >= 5) break;
        } catch { /* skip */ }
      }

      if (!candidates.length) return interaction.editReply('❌ Tidak ada meme coin yang lolos filter saat ini. Coba lagi nanti.');

      candidates.sort((a, b) => b.scalpScore - a.scalpScore);

      for (const item of candidates.slice(0, 3)) {
        const analysis = await analyzeWithAI(item.tokenData, item.techData, item.riskData);
        const embed = buildSignalEmbed(item.tokenData, analysis, item.riskData, item.techData, false);
        const row = buildActionRow(item.tokenData);
        await interaction.followUp({ embeds: [embed], components: [row] });
        await new Promise(r => setTimeout(r, 1000));
      }

      await interaction.editReply(`✅ Scan selesai! Ditemukan **${Math.min(candidates.length, 3)}** meme coin potensial.`);
    }

    // ── /ca ──
    else if (cmd === 'ca') {
      const address = interaction.options.getString('address');
      await interaction.editReply(`🔎 Menganalisis contract address: \`${address}\`...`);

      const pair = await getDexScreenerToken(address);
      if (!pair) return interaction.editReply('❌ Token tidak ditemukan. Pastikan address benar dan token sudah ada di DexScreener.');

      const { tokenData, techData, riskData, analysis } = await fullAnalysis(pair);
      const embed = buildSignalEmbed(tokenData, analysis, riskData, techData, false);
      const row = buildActionRow(tokenData);
      await interaction.editReply({ content: null, embeds: [embed], components: [row] });

      db.prepare(`INSERT INTO signals (address, chain, symbol, signal, entry_price, confidence, reasoning, channel_id)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(tokenData.address, tokenData.chain, tokenData.symbol,
          analysis.signal, parseFloat(tokenData.price), analysis.confidence,
          analysis.reasoning, interaction.channelId);
    }

    // ── /analyze ──
    else if (cmd === 'analyze') {
      const symbol = interaction.options.getString('symbol');
      await interaction.editReply(`📊 Mencari & menganalisis **${symbol.toUpperCase()}**...`);

      const pairs = await searchDexScreener(symbol);
      if (!pairs.length) return interaction.editReply(`❌ Token **${symbol}** tidak ditemukan.`);

      // Take highest volume pair
      const pair = pairs.sort((a, b) => parseFloat(b.volume?.h24 || 0) - parseFloat(a.volume?.h24 || 0))[0];
      const { tokenData, techData, riskData, analysis } = await fullAnalysis(pair);
      const embed = buildSignalEmbed(tokenData, analysis, riskData, techData, false);
      const row = buildActionRow(tokenData);
      await interaction.editReply({ content: null, embeds: [embed], components: [row] });
    }

    // ── /watchlist ──
    else if (cmd === 'watchlist') {
      const items = db.prepare('SELECT * FROM watchlist WHERE guild_id=? ORDER BY added_at DESC').all(interaction.guildId);
      if (!items.length) return interaction.editReply('📋 Watchlist kosong.');
      const embed = new EmbedBuilder()
        .setTitle('📋 Watchlist Token')
        .setColor(0x5865f2)
        .setDescription(items.map((i, n) => `${n+1}. **${i.symbol || i.address.slice(0,8)+'...'}** (${i.chain.toUpperCase()})\n\`${i.address}\``).join('\n\n'))
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /signals ──
    else if (cmd === 'signals') {
      const recent = db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT 10').all();
      if (!recent.length) return interaction.editReply('📡 Belum ada sinyal. Pakai `/scan` atau `/ca` dulu!');
      const embed = new EmbedBuilder()
        .setTitle('📡 Sinyal Terbaru')
        .setColor(0x5865f2)
        .setTimestamp();
      for (const s of recent) {
        const emoji = { BUY:'🟢', SELL:'🔴', HOLD:'🟡', AVOID:'⛔' }[s.signal] || '⚪';
        embed.addFields({
          name: `${emoji} ${s.symbol || 'Unknown'} — ${s.signal}`,
          value: `Chain: ${s.chain} | Confidence: ${s.confidence}%\n${new Date(s.created_at * 1000).toLocaleString('id-ID')}`,
          inline: false
        });
      }
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /setchannel ──
    else if (cmd === 'setchannel') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.editReply('❌ Perlu permission **Manage Server**.');
      }
      const channel = interaction.options.getChannel('channel');
      db.prepare('INSERT OR REPLACE INTO signal_channels (guild_id, channel_id) VALUES (?,?)').run(interaction.guildId, channel.id);
      await interaction.editReply(`✅ Sinyal otomatis akan dikirim ke ${channel} setiap **15 menit**!`);
    }

    // ── /help ──
    else if (cmd === 'help') {
      const embed = new EmbedBuilder()
        .setTitle('🤖 MemeBot — Panduan')
        .setColor(0x5865f2)
        .setDescription('Bot AI untuk scalping meme coin — scan otomatis, analisis teknikal, rug detector!')
        .addFields(
          { name: '`/scan [chain]`', value: 'Scan meme coin terbaik untuk scalping sekarang', inline: false },
          { name: '`/ca <address>`', value: 'Analisis token by contract address\nContoh: `/ca 0x6982508...`', inline: false },
          { name: '`/analyze <symbol>`', value: 'Analisis token by symbol\nContoh: `/analyze PEPE`', inline: false },
          { name: '`/signals`', value: 'Lihat 10 sinyal terbaru', inline: false },
          { name: '`/watchlist`', value: 'Lihat watchlist token', inline: false },
          { name: '`/setchannel #channel`', value: 'Set channel sinyal otomatis setiap 15 menit', inline: false },
          { name: '🛡️ Rug Detector', value: 'Bot otomatis filter:\n• Likuiditas rendah\n• Pump & dump pattern\n• Honeypot detection\n• Token terlalu baru\n• Wash trading', inline: false },
          { name: '⚠️ Disclaimer', value: 'Bukan financial advice. Selalu DYOR & gunakan risk management!', inline: false }
        )
        .setFooter({ text: 'MemeBot — DexScreener + GeckoTerminal + Claude AI' });
      await interaction.editReply({ embeds: [embed] });
    }

  } catch (err) {
    console.error(`[/${cmd}] Error:`, err.message);
    await interaction.editReply('❌ Terjadi error. Coba lagi nanti.').catch(() => {});
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ MemeBot online: ${client.user.tag}`);
  client.user.setActivity('🔍 Scanning Meme Coins', { type: 3 });
  await registerCommands();
  setInterval(runAutoScan, SCAN_INTERVAL);
  console.log('⏱️ Auto scanner started (every 15 minutes)');
});

client.login(process.env.DISCORD_TOKEN);
