require('dotenv').config();
const {
  Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes
} = require('discord.js');
const axios = require('axios');
const cron = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');

// ─────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Watchlist: userId -> Set<tokenAddress>
const watchlist = new Map();
// Alert channels: guildId -> channelId
const alertChannels = new Map();
// Price cache for change detection: tokenAddress -> lastPrice
const priceCache = new Map();

// ─────────────────────────────────────────
//  API HELPERS
// ─────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function dexscreenerTopBoosted() {
  const { data } = await axios.get('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 8000 });
  return Array.isArray(data) ? data : [];
}

async function dexscreenerByAddress(address) {
  const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 8000 });
  // Return best pair by liquidity
  const pairs = data?.pairs || [];
  return pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
}

async function geckoTerminalTrending() {
  const { data } = await axios.get(
    'https://api.geckoterminal.com/api/v2/networks/trending_pools?include=base_token&page=1',
    { headers: { Accept: 'application/json;version=20230302' }, timeout: 8000 }
  );
  return data?.data || [];
}

// ─────────────────────────────────────────
//  RUG / MANIPULATION DETECTOR
// ─────────────────────────────────────────
function detectRug(pair) {
  if (!pair) return { signals: ['❓ Tidak ada data pair'], score: 100, detail: [] };

  const signals = [];
  const detail = [];
  let score = 0;

  const liq    = parseFloat(pair.liquidity?.usd   || 0);
  const vol24  = parseFloat(pair.volume?.h24       || 0);
  const vol1   = parseFloat(pair.volume?.h1        || 0);
  const pc24   = parseFloat(pair.priceChange?.h24  || 0);
  const pc1    = parseFloat(pair.priceChange?.h1   || 0);
  const pc5m   = parseFloat(pair.priceChange?.m5   || 0);
  const buys   = pair.txns?.h24?.buys  || 0;
  const sells  = pair.txns?.h24?.sells || 0;
  const mcap   = parseFloat(pair.marketCap || pair.fdv || 0);
  const age    = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 86400000 : 999;

  // 1. Liquidity
  if (liq < 5000)  { signals.push('🔴 Liquidity <$5K (sangat berbahaya)');    score += 35; }
  else if (liq < 30000) { signals.push('🟡 Liquidity rendah <$30K');          score += 15; }
  else if (liq < 100000){ signals.push('🟡 Liquidity sedang <$100K');          score += 5;  }
  detail.push(`Liquidity: $${liq.toLocaleString()}`);

  // 2. Honeypot heuristic
  if (buys > 10 && sells === 0) {
    signals.push('🔴 0 sell txn — kemungkinan HONEYPOT!'); score += 45;
  } else if (buys > 0 && sells / (buys + 1) < 0.05) {
    signals.push('🟡 Ratio sell sangat rendah (<5%) — waspadai honeypot'); score += 20;
  }
  detail.push(`Buys/Sells 24h: ${buys}/${sells}`);

  // 3. Extreme pump
  if (pc24 > 1000) { signals.push('🔴 Pump +1000% dalam 24h — manipulasi?');  score += 30; }
  else if (pc24 > 300) { signals.push('🟡 Pump +300% dalam 24h');              score += 15; }
  if (pc1 > 100)   { signals.push('🔴 Pump +100% dalam 1 jam');               score += 25; }
  if (pc5m > 50)   { signals.push('🔴 Pump +50% dalam 5 menit — alert!');     score += 20; }

  // 4. Extreme dump
  if (pc24 < -80)  { signals.push('🔴 Dump -80% dalam 24h — rug kemungkinan terjadi'); score += 25; }
  else if (pc24 < -50) { signals.push('🟡 Dump -50% dalam 24h');              score += 10; }

  // 5. Wash trading
  if (liq > 0 && vol24 / liq > 100) {
    signals.push('🔴 Volume/Liquidity ratio >100x — wash trading?'); score += 25;
  } else if (liq > 0 && vol24 / liq > 20) {
    signals.push('🟡 Volume/Liquidity ratio tinggi (>20x)'); score += 10;
  }
  detail.push(`Vol/Liq ratio: ${liq > 0 ? (vol24/liq).toFixed(1) : 'N/A'}x`);

  // 6. New token (high risk)
  if (age < 1) {
    signals.push('🟡 Token baru (<24 jam) — risiko tinggi'); score += 15;
  } else if (age < 7) {
    signals.push('🟡 Token muda (<7 hari)'); score += 5;
  }
  detail.push(`Umur pair: ${age < 1 ? '<1 hari' : `${Math.floor(age)} hari`}`);

  // 7. MCap vs Liquidity (potential exit scam setup)
  if (mcap > 0 && liq > 0 && mcap / liq > 500) {
    signals.push('🟡 MCap/Liquidity ratio >500x — exit scam risk'); score += 15;
  }

  if (signals.length === 0) signals.push('✅ Tidak ada sinyal rug yang terdeteksi');

  return { signals, score: Math.min(score, 100), detail };
}

function rugRating(score) {
  if (score >= 70) return { emoji: '🔴', label: 'HIGH RISK',    color: 0xFF3B30 };
  if (score >= 40) return { emoji: '🟠', label: 'MEDIUM RISK',  color: 0xFF9500 };
  if (score >= 20) return { emoji: '🟡', label: 'LOW-MED RISK', color: 0xFFCC00 };
  return           { emoji: '🟢', label: 'LOW RISK',            color: 0x34C759 };
}

// ─────────────────────────────────────────
//  AI ANALYSIS (CLAUDE)
// ─────────────────────────────────────────
async function aiAnalysis(pair, rug) {
  if (!pair) return null;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 350,
      messages: [{
        role: 'user',
        content: `Kamu adalah analis crypto DeFi berpengalaman. Analisis token ini secara ringkas (max 250 kata, dalam Bahasa Indonesia):

Token  : ${pair.baseToken?.name} (${pair.baseToken?.symbol})
Chain  : ${pair.chainId}
DEX    : ${pair.dexId}
Harga  : $${pair.priceUsd}
MCap   : $${(pair.marketCap || pair.fdv || 0).toLocaleString()}
Liq    : $${(pair.liquidity?.usd || 0).toLocaleString()}
Vol24h : $${(pair.volume?.h24 || 0).toLocaleString()}
5m/1h/24h: ${pair.priceChange?.m5}% / ${pair.priceChange?.h1}% / ${pair.priceChange?.h24}%
Buys/Sells: ${pair.txns?.h24?.buys}/${pair.txns?.h24?.sells}
Rug Score: ${rug.score}/100
Sinyal: ${rug.signals.join(' | ')}

Format jawaban:
📊 **Kondisi**: (1-2 kalimat ringkasan)
🎯 **Verdict**: BUY / HOLD / AVOID / DANGER
⚠️ **Risiko**: (poin-poin risiko utama)
💡 **Catatan**: (tips atau insight tambahan)`
      }]
    });
    return msg.content[0]?.text || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────
//  EMBED BUILDERS
// ─────────────────────────────────────────
function tokenEmbed(pair, rug, ai) {
  const { emoji, label, color } = rugRating(rug.score);
  const pc24 = parseFloat(pair.priceChange?.h24 || 0);
  const pc1  = parseFloat(pair.priceChange?.h1  || 0);
  const pc5m = parseFloat(pair.priceChange?.m5  || 0);

  const fmt = n => isNaN(n) ? 'N/A' : `$${parseFloat(n).toLocaleString(undefined, { maximumFractionDigits: 10 })}`;
  const pct = n => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${pair.baseToken?.name} (${pair.baseToken?.symbol})`)
    .setURL(pair.url || `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`)
    .addFields(
      { name: '💵 Harga',        value: fmt(pair.priceUsd),                                     inline: true },
      { name: '📈 5m / 1h / 24h',value: `${pct(pc5m)} / ${pct(pc1)} / ${pct(pc24)}`,           inline: true },
      { name: '💧 Liquidity',    value: fmt(pair.liquidity?.usd),                               inline: true },
      { name: '📊 Volume 24h',   value: fmt(pair.volume?.h24),                                  inline: true },
      { name: '🏦 Market Cap',   value: fmt(pair.marketCap || pair.fdv),                        inline: true },
      { name: '🔄 Buys / Sells', value: `${pair.txns?.h24?.buys || 0} / ${pair.txns?.h24?.sells || 0}`, inline: true },
      {
        name: `${emoji} Rug Score: ${rug.score}/100 — ${label}`,
        value: rug.signals.slice(0, 5).join('\n') || '—'
      }
    )
    .setFooter({ text: `${pair.chainId?.toUpperCase()} · ${pair.dexId} · ${new Date().toLocaleString('id-ID')}` });

  if (ai) e.addFields({ name: '🤖 AI Analysis', value: ai.slice(0, 1020) });
  return e;
}

function trendingEmbed(pairs) {
  const e = new EmbedBuilder()
    .setColor(0x7B2FBE)
    .setTitle('🔥 Top Trending — DexScreener')
    .setTimestamp();

  pairs.slice(0, 8).forEach((pair, i) => {
    const pc = parseFloat(pair.priceChange?.h24 || 0);
    const icon = pc >= 20 ? '🚀' : pc >= 0 ? '📈' : pc >= -20 ? '📉' : '💀';
    e.addFields({
      name: `${i + 1}. ${pair.baseToken?.name || 'Unknown'} (${pair.baseToken?.symbol || '?'})`,
      value: [
        `${icon} **${pc >= 0 ? '+' : ''}${pc.toFixed(1)}%** 24h`,
        `💧 $${Number(pair.liquidity?.usd || 0).toLocaleString()}`,
        `📊 Vol $${Number(pair.volume?.h24 || 0).toLocaleString()}`,
        `[Chart](${pair.url || '#'})`
      ].join(' · '),
      inline: false
    });
  });
  return e;
}

// ─────────────────────────────────────────
//  SLASH COMMAND DEFINITIONS
// ─────────────────────────────────────────
const COMMANDS = [
  new SlashCommandBuilder()
    .setName('trending')
    .setDescription('🔥 Lihat token trending real-time dari DexScreener'),

  new SlashCommandBuilder()
    .setName('scan')
    .setDescription('🔍 Scan token: rug detector + AI analysis')
    .addStringOption(o => o.setName('address').setDescription('Token/contract address').setRequired(true)),

  new SlashCommandBuilder()
    .setName('watch')
    .setDescription('🔔 Pantau token, dapat alert otomatis')
    .addStringOption(o => o.setName('address').setDescription('Token address').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unwatch')
    .setDescription('🔕 Stop pantau token')
    .addStringOption(o => o.setName('address').setDescription('Token address').setRequired(true)),

  new SlashCommandBuilder()
    .setName('watchlist')
    .setDescription('📋 Lihat semua token yang kamu pantau'),

  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('📡 Set channel untuk menerima alert otomatis')
    .addChannelOption(o => o.setName('channel').setDescription('Target channel').setRequired(true)),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: COMMANDS });
  console.log('✅ Slash commands registered');
}

// ─────────────────────────────────────────
//  AUTO SCAN (every 5 min)
// ─────────────────────────────────────────
async function runAutoScan() {
  if (watchlist.size === 0 || alertChannels.size === 0) return;

  const allAddresses = new Set();
  for (const addrs of watchlist.values()) addrs.forEach(a => allAddresses.add(a));

  for (const address of allAddresses) {
    try {
      const pair = await dexscreenerByAddress(address);
      if (!pair) { await sleep(500); continue; }

      const rug = detectRug(pair);
      const pc1 = parseFloat(pair.priceChange?.h1 || 0);
      const pc5m = parseFloat(pair.priceChange?.m5 || 0);
      const prevPrice = priceCache.get(address);
      const currPrice = parseFloat(pair.priceUsd);
      priceCache.set(address, currPrice);

      const shouldAlert =
        rug.score >= 70 ||
        Math.abs(pc1) >= 30 ||
        Math.abs(pc5m) >= 20 ||
        (pair.txns?.h24?.sells === 0 && pair.txns?.h24?.buys > 30);

      if (!shouldAlert) { await sleep(500); continue; }

      // Find who's watching this
      const watchers = [];
      for (const [uid, addrs] of watchlist.entries()) {
        if (addrs.has(address)) watchers.push(uid);
      }

      for (const [guildId, channelId] of alertChannels.entries()) {
        const channel = client.channels.cache.get(channelId);
        if (!channel) continue;

        const { emoji, label, color } = rugRating(rug.score);
        const alertEmbed = new EmbedBuilder()
          .setColor(color)
          .setTitle(`🚨 ALERT: ${pair.baseToken?.name} (${pair.baseToken?.symbol})`)
          .setDescription(watchers.map(u => `<@${u}>`).join(' ') + ' — token yang kamu pantau butuh perhatian!')
          .addFields(
            { name: `${emoji} Rug Score`,  value: `**${rug.score}/100** — ${label}`, inline: true },
            { name: '📈 1h Change',        value: `${pc1 >= 0 ? '+' : ''}${pc1.toFixed(1)}%`,  inline: true },
            { name: '⚡ 5m Change',        value: `${pc5m >= 0 ? '+' : ''}${pc5m.toFixed(1)}%`, inline: true },
            { name: '🚩 Sinyal Terdeteksi', value: rug.signals.slice(0, 4).join('\n') }
          )
          .setURL(`https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`)
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setURL(`https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`)
            .setLabel('Lihat Chart')
            .setStyle(ButtonStyle.Link),
          new ButtonBuilder()
            .setCustomId(`unwatch_${pair.baseToken?.address || address}`)
            .setLabel('🔕 Stop Watch')
            .setStyle(ButtonStyle.Danger)
        );

        await channel.send({ embeds: [alertEmbed], components: [row] });
      }
    } catch (e) {
      // Silent fail per token
    }
    await sleep(600);
  }
}

// ─────────────────────────────────────────
//  EVENT: READY
// ─────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  client.user.setActivity('/trending | /scan | /watch', { type: 3 });

  await registerCommands();

  // Auto scan every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    console.log(`[${new Date().toLocaleTimeString()}] 🔍 Running auto scan...`);
    runAutoScan().catch(console.error);
  });
});

// ─────────────────────────────────────────
//  EVENT: INTERACTIONS
// ─────────────────────────────────────────
client.on('interactionCreate', async interaction => {

  // ── BUTTON HANDLER ──
  if (interaction.isButton()) {
    const [action, ...parts] = interaction.customId.split('_');
    const addr = parts.join('_');

    if (action === 'watch') {
      if (!watchlist.has(interaction.user.id)) watchlist.set(interaction.user.id, new Set());
      watchlist.get(interaction.user.id).add(addr);
      return interaction.reply({ content: `🔔 Token ditambahkan ke watchlist!`, ephemeral: true });
    }
    if (action === 'unwatch') {
      watchlist.get(interaction.user.id)?.delete(addr);
      return interaction.reply({ content: `🔕 Token dihapus dari watchlist.`, ephemeral: true });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // ── /trending ──
  if (interaction.commandName === 'trending') {
    await interaction.deferReply();
    try {
      const boosted = await dexscreenerTopBoosted();
      const topAddrs = [...new Set(boosted.slice(0, 8).map(t => t.tokenAddress))];

      const pairResults = await Promise.allSettled(topAddrs.map(a => dexscreenerByAddress(a)));
      const pairs = pairResults
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value)
        .slice(0, 8);

      if (!pairs.length) return interaction.editReply('❌ Tidak ada data trending saat ini.');

      const embed = trendingEmbed(pairs);
      const rows = [];
      pairs.slice(0, 4).forEach(pair => {
        const addr = pair.baseToken?.address;
        if (!addr) return;
        rows.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`watch_${addr}`)
            .setLabel(`🔔 ${pair.baseToken?.symbol}`)
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setURL(pair.url || `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`)
            .setLabel('Chart')
            .setStyle(ButtonStyle.Link)
        ));
      });

      await interaction.editReply({ embeds: [embed], components: rows.slice(0, 5) });
    } catch (e) {
      await interaction.editReply(`❌ Error: ${e.message}`);
    }
  }

  // ── /scan ──
  if (interaction.commandName === 'scan') {
    await interaction.deferReply();
    const address = interaction.options.getString('address').trim();
    try {
      const pair = await dexscreenerByAddress(address);
      if (!pair) return interaction.editReply('❌ Token tidak ditemukan. Cek address dan coba lagi.');

      const rug = detectRug(pair);
      await interaction.editReply({ content: '🤖 Menganalisis dengan Claude AI...' });
      const ai = await aiAnalysis(pair, rug);

      const embed = tokenEmbed(pair, rug, ai);
      const addr = pair.baseToken?.address || address;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`watch_${addr}`)
          .setLabel('🔔 Watch Token')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setURL(`https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`)
          .setLabel('DexScreener')
          .setStyle(ButtonStyle.Link),
        new ButtonBuilder()
          .setURL(`https://www.geckoterminal.com/${pair.chainId}/pools/${pair.pairAddress}`)
          .setLabel('GeckoTerminal')
          .setStyle(ButtonStyle.Link)
      );

      await interaction.editReply({ content: null, embeds: [embed], components: [row] });
    } catch (e) {
      await interaction.editReply(`❌ Error: ${e.message}`);
    }
  }

  // ── /watch ──
  if (interaction.commandName === 'watch') {
    const address = interaction.options.getString('address').trim();
    if (!watchlist.has(interaction.user.id)) watchlist.set(interaction.user.id, new Set());
    const uList = watchlist.get(interaction.user.id);

    if (uList.size >= 20) return interaction.reply({ content: '❌ Maksimal 20 token di watchlist.', ephemeral: true });
    uList.add(address);
    await interaction.reply({
      content: `✅ **Token ditambahkan ke watchlist!**\n\`${address}\`\n\n🔔 Kamu akan dapat alert jika:\n• Rug score ≥ 70\n• Price 1h bergerak ±30%\n• Price 5m bergerak ±20%\n• Honeypot terdeteksi`,
      ephemeral: true
    });
  }

  // ── /unwatch ──
  if (interaction.commandName === 'unwatch') {
    const address = interaction.options.getString('address').trim();
    const removed = watchlist.get(interaction.user.id)?.delete(address);
    await interaction.reply({
      content: removed ? `✅ Token \`${address}\` dihapus dari watchlist.` : '❌ Token tidak ada di watchlist kamu.',
      ephemeral: true
    });
  }

  // ── /watchlist ──
  if (interaction.commandName === 'watchlist') {
    const tokens = watchlist.get(interaction.user.id);
    if (!tokens || tokens.size === 0) {
      return interaction.reply({ content: '📋 Watchlist kamu kosong.\nGunakan `/watch <address>` untuk mulai memantau token.', ephemeral: true });
    }

    const tokenList = [...tokens];
    const embed = new EmbedBuilder()
      .setColor(0x7B2FBE)
      .setTitle('📋 Watchlist Kamu')
      .setDescription(tokenList.map((a, i) => `\`${i + 1}.\` \`${a}\``).join('\n'))
      .setFooter({ text: `${tokens.size}/20 token dipantau · Auto scan setiap 5 menit` });

    const rows = tokenList.slice(0, 5).map(addr =>
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`unwatch_${addr}`)
          .setLabel(`❌ ${addr.slice(0, 8)}...`)
          .setStyle(ButtonStyle.Danger)
      )
    );

    await interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
  }

  // ── /setchannel ──
  if (interaction.commandName === 'setchannel') {
    if (!interaction.member.permissions.has('ManageChannels')) {
      return interaction.reply({ content: '❌ Kamu butuh permission **Manage Channels**.', ephemeral: true });
    }
    const channel = interaction.options.getChannel('channel');
    alertChannels.set(interaction.guildId, channel.id);
    await interaction.reply({
      content: `✅ **Alert channel diset ke <#${channel.id}>**\nBot akan mengirim notifikasi otomatis ke channel ini setiap 5 menit.`
    });
  }
});

// ─────────────────────────────────────────
//  LOGIN
// ─────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Login gagal:', err.message);
  process.exit(1);
});
