// index.js
// Discord.js v14 + lavalink-client v4 + MongoDB
// npm i discord.js lavalink-client mongoose

const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
  PermissionFlagsBits,
} = require('discord.js');

const mongoose = require('mongoose');
const { LavalinkManager } = require('lavalink-client');
// keepalive http server for Render Web Service
const http = require('http');
const PORT = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK');
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Discord bot is running');
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server listening on ${PORT}`);
});

// ====== إعدادات ثابتة ======
const CONTROL_TEXT_CHANNEL_ID = process.env.CONTROL_TEXT_CHANNEL_ID || '1410843136594411520';
const PANEL_UPDATE_INTERVAL_MS = 15000;
const DEFAULT_VOLUME = 50;
const MAX_PLAYLIST_SLOTS_PER_ROW = 5;
const MAX_PLAYLIST_ROWS = 3;

// عقدة Lavalink
const LAVALINK_NODES = [
  {
    id: 'main',
    host: '51.178.44.24',
    port: 2333,
    authorization: 'youshallnotpass',
    secure: false,
  },
];

// ====== Discord Client ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// Lavalink
client.lavalink = new LavalinkManager({
  nodes: LAVALINK_NODES,
  autoSkip: true,
  sendToShard: (guildId, payload) => {
    const guild = client.guilds.cache.get(guildId);
    if (guild) guild.shard.send(payload);
  },
  client: {
    id: process.env.DISCORD_CLIENT_ID || undefined,
    username: 'MusicBot',
  },
  playerOptions: {
    applyVolumeAsFilter: false,
    defaultSearchPlatform: 'ytmsearch',
    onDisconnect: {
      autoReconnect: true,
      destroyPlayer: false,
    },
    onEmptyQueue: {
      destroyAfterMs: null, // لا يغادر حتى يُطرد
    },
    useUnresolvedData: true,
  },
});

// تمرير raw
client.on('raw', (d) => client.lavalink.sendRawData(d));

// ====== Mongo Schemas ======
const guildSchema = new mongoose.Schema({
  guildId: { type: String, unique: true, index: true },
  controlChannelId: { type: String, default: CONTROL_TEXT_CHANNEL_ID },
  panelMessageId: { type: String, default: null },
  volume: { type: Number, default: DEFAULT_VOLUME },
  loopMode: { type: String, enum: ['off', 'track', 'queue'], default: 'off' },
  shuffle: { type: Boolean, default: false },
});

const playlistItemSchema = new mongoose.Schema({
  title: String,
  uri: String,
  source: String,
  duration: Number,
  artworkUrl: String,
  addedAt: { type: Date, default: Date.now },
});

const playlistSchema = new mongoose.Schema({
  guildId: { type: String, index: true },
  userId: { type: String, index: true },
  name: { type: String },
  items: [playlistItemSchema],
});
playlistSchema.index({ guildId: 1, userId: 1, name: 1 }, { unique: true });

const GuildModel = mongoose.model('GuildSetting', guildSchema);
const PlaylistModel = mongoose.model('Playlist', playlistSchema);

// ====== أدوات مساعدة ======
const fmtTime = (ms) => {
  if (!ms || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

const resolveArtwork = (track) =>
  track?.info?.artworkUrl || track?.artworkUrl || null;

const ensureGuild = async (guildId) => {
  let doc = await GuildModel.findOne({ guildId });
  if (!doc) doc = await GuildModel.create({ guildId });
  return doc;
};

// تشفير/فك اسم القائمة داخل customId
const encName = (s) => encodeURIComponent(s);
const decName = (s) => decodeURIComponent(s || '');

// customId helpers: "pl|action|userId|data..."
const makeId = (...parts) => parts.join('|');
const parseId = (customId) => customId.split('|');

// بحث متعدد المصادر مع إرجاع أول نتيجة فقط عند البحث النصي
const searchWithFallback = async (player, query, requester) => {
  const isUrl = /^https?:\/\//i.test(query);
  const sources = ['ytsearch', 'ytmsearch', 'scsearch', 'spsearch', 'ymsearch', 'amsearch'];

  if (isUrl) {
    const res = await player.search({ query }, requester).catch(() => null);
    if (res?.tracks?.length) return res;
  }

  for (const source of sources) {
    const res = await player.search({ query, source }, requester).catch(() => null);
    if (res?.tracks?.length) return res;
  }
  return null;
};

// لوحة التحكم
const buildControlRows = (settings) => {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ctl:volUp').setLabel('رفع الصوت').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ctl:volDown').setLabel('خفض الصوت').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ctl:pause').setLabel('إيقاف مؤقت/استئناف').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ctl:stop').setLabel('إيقاف').setStyle(ButtonStyle.Danger),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ctl:skip').setLabel('سكب').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ctl:shuffle').setLabel(`شفل: ${settings.shuffle ? 'تشغيل' : 'إيقاف'}`).setStyle(settings.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ctl:loopTrack').setLabel(`لووب أغنية: ${settings.loopMode === 'track' ? 'تشغيل' : 'إيقاف'}`).setStyle(settings.loopMode === 'track' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ctl:loopQueue').setLabel(`لووب طابور: ${settings.loopMode === 'queue' ? 'تشغيل' : 'إيقاف'}`).setStyle(settings.loopMode === 'queue' ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ctl:playlist').setLabel('البلايليست').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ctl:save').setLabel('حفظ الحالية').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ctl:next').setLabel('التالي').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ctl:prev').setLabel('السابق').setStyle(ButtonStyle.Primary),
  );
  return [row1, row2, row3];
};

const buildPanelEmbed = async (guild, player, settings) => {
  const current = player?.queue?.current;
  const next = player?.queue?.tracks?.[0];
  const pos = player?.position || 0;
  const length = current?.info?.length || 0;
  const left = Math.max(0, length - pos);

  const emb = new EmbedBuilder()
    .setColor(0x00bcd4)
    .setTitle('لوحة تحكم الموسيقى')
    .setDescription(
      current
        ? `الأغنية الحالية: ${current.info.title}\n${current.info.uri || ''}`
        : 'لا توجد أغنية قيد التشغيل',
    )
    .addFields(
      { name: 'الوقت', value: `${fmtTime(pos)} / ${fmtTime(length)} (متبقّي: ${fmtTime(left)})`, inline: true },
      { name: 'التالي', value: next ? `${next.info.title}\n${next.info.uri || ''}` : '—', inline: true },
      { name: 'الحالة', value: `صوت: ${settings.volume}% | شفل: ${settings.shuffle ? 'تشغيل' : 'إيقاف'} | لووب: ${settings.loopMode}`, inline: false },
    )
    .setTimestamp(new Date());

  const art = resolveArtwork(current);
  if (art) emb.setThumbnail(art);

  return emb;
};

// الصوت المحفوظ
const applyVolume = async (player, settings, vol) => {
  const newVol = Math.max(1, Math.min(200, vol));
  settings.volume = newVol;
  await settings.save();
  await player.setVolume(newVol);
};

// لوحة التحكم
const panelIntervals = new Map();
const ensurePanel = async (guild, channel, player, settings) => {
  let msg = null;
  if (settings.panelMessageId) {
    try { msg = await channel.messages.fetch(settings.panelMessageId); } catch (_) {}
  }
  const embed = await buildPanelEmbed(guild, player, settings);
  const rows = buildControlRows(settings);

  if (!msg) {
    const sent = await channel.send({ embeds: [embed], components: rows });
    try { await sent.pin(); } catch (_) {}
    settings.panelMessageId = sent.id;
    await settings.save();
    msg = sent;
  } else {
    await msg.edit({ embeds: [embed], components: rows }).catch(() => {});
  }

  if (!panelIntervals.has(guild.id)) {
    const intv = setInterval(async () => {
      const pl = client.lavalink.players.get(guild.id);
      if (!pl) return;
      const s = await ensureGuild(guild.id);
      const ch = await client.channels.fetch(s.controlChannelId).catch(() => null);
      if (!ch || ch.id !== channel.id) return;
      let m = null;
      try { m = await ch.messages.fetch(s.panelMessageId); } catch (_) {}
      if (!m) return;
      const em = await buildPanelEmbed(guild, pl, s);
      const rs = buildControlRows(s);
      await m.edit({ embeds: [em], components: rs }).catch(() => {});
    }, PANEL_UPDATE_INTERVAL_MS);
    panelIntervals.set(guild.id, intv);
  }
};

// إضافة للطابور
const enqueueTracks = async (player, tracks) => {
  if (!tracks?.length) return false;
  player.queue.add(tracks);
  if (!player.playing && !player.paused) await player.play();
  return true;
};

// ====== نظام السابق/التالي (تاريخ محلي) ======
const lastTrackMap = new Map(); // guildId -> last current track
const historyMap = new Map();   // guildId -> array of previous tracks

const pushHistory = (guildId, track) => {
  if (!track) return;
  if (!historyMap.has(guildId)) historyMap.set(guildId, []);
  historyMap.get(guildId).push(track);
};

const playPrevCustom = async (player, settings) => {
  const guildId = player.guildId;
  const q = player.queue;
  const hist = historyMap.get(guildId) || [];

  // إذا قطع المستخدم مسافة من الأغنية الحالية، أعدها للبداية
  if ((player.position || 0) > 3000 && q.current) {
    await player.play(q.current, { startTime: 0 });
    return;
  }

  if (hist.length > 0) {
    const prev = hist.pop();
    if (q.current) q.tracks.unshift(q.current);
    q.current = prev;
    await player.play(prev, { startTime: 0 });
  } else if (q.current) {
    await player.play(q.current, { startTime: 0 });
  }
};

// ====== Playlists UI (غير إمفيرال + حماية بالمالك) ======
const buildPlaylistsListRows = async (guildId, userId) => {
  const lists = await PlaylistModel.find({ guildId, userId }).sort({ name: 1 });
  const names = lists.map((l) => l.name);

  const rows = [];
  const totalSlots = MAX_PLAYLIST_ROWS * MAX_PLAYLIST_SLOTS_PER_ROW;
  const filled = Math.min(names.length, totalSlots);

  let idx = 0;
  for (let r = 0; r < MAX_PLAYLIST_ROWS; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < MAX_PLAYLIST_SLOTS_PER_ROW; c++) {
      const label = idx < filled ? names[idx] : 'إنشاء';
      const id = idx < filled
        ? makeId('pl', 'open', userId, encName(names[idx]))
        : makeId('pl', 'create', userId);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(id)
          .setLabel(label)
          .setStyle(idx < filled ? ButtonStyle.Primary : ButtonStyle.Secondary),
      );
      idx++;
    }
    rows.push(row);
  }
  const lastRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(makeId('pl', 'toggleDelete', userId))
      .setLabel('وضع حذف')
      .setStyle(ButtonStyle.Danger),
  );
  rows.push(lastRow);

  return rows;
};

const buildSinglePlaylistView = (plist, userId) => {
  const emb = new EmbedBuilder()
    .setColor(0x8bc34a)
    .setTitle(`البلايليست: ${plist.name}`)
    .setDescription(plist.items.length ? `${plist.items.length} أغنية` : 'فارغة')
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(makeId('pl', 'back', userId)).setLabel('عودة').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(makeId('pl', 'add', userId, encName(plist.name))).setLabel('إضافة').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(makeId('pl', 'del', userId, encName(plist.name))).setLabel('حذف عناصر').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(makeId('pl', 'play', userId, encName(plist.name))).setLabel('تشغيل').setStyle(ButtonStyle.Success),
  );

  return { embed: emb, rows: [row] };
};

const showDeleteMenus = (plist, userId) => {
  const chunks = [];
  for (let i = 0; i < plist.items.length; i += 25) chunks.push(plist.items.slice(i, i + 25));
  const rows = [];
  chunks.forEach((chunk, ci) => {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(makeId('pl', 'delMenu', userId, encName(plist.name), String(ci)))
      .setPlaceholder('اختر عناصر للحذف')
      .setMinValues(1)
      .setMaxValues(chunk.length)
      .addOptions(
        chunk.map((it, idx) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(it.title.slice(0, 100))
            .setValue(String(ci * 25 + idx)),
        ),
      );
    rows.push(new ActionRowBuilder().addComponents(menu));
  });
  return rows;
};

// حصر تفاعل البلايليست بمالك الواجهة
const ensureOwner = async (interaction, ownerId) => {
  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: 'هذه الواجهة ليست لك.', ephemeral: true }).catch(() => {});
    return false;
  }
  return true;
};

// ====== أحداث Lavalink ======
client.lavalink.on('trackStart', async (player, track) => {
  const guild = client.guilds.cache.get(player.guildId);
  if (!guild) return;
  const settings = await ensureGuild(guild.id);

  // إدارة التاريخ
  const last = lastTrackMap.get(player.guildId);
  if (last) pushHistory(player.guildId, last);
  lastTrackMap.set(player.guildId, track || player.queue.current);

  const ch = await client.channels.fetch(settings.controlChannelId).catch(() => null);
  if (!ch) return;
  await ensurePanel(guild, ch, player, settings);
});

client.lavalink.on('queueEnd', async (player) => {
  const guild = client.guilds.cache.get(player.guildId);
  if (!guild) return;
  const settings = await ensureGuild(guild.id);
  if (settings.loopMode === 'queue') {
    const q = player.queue;
    // أعد تدوير ما تم تشغيله
    while (q.previous?.length) {
      const prev = q.previous.shift();
      q.add(prev);
    }
    if (q.tracks.length) await player.play(q.tracks.shift());
  }
});

// ====== إدارة فلاتر الصوت (8D / ريسيت) ======
const apply8D = async (player) => {
  try {
    await player.setFilters({ rotation: { rotationHz: 0.2 } });
    return true;
  } catch {
    return false;
  }
};
const resetFilters = async (player) => {
  try {
    await player.setFilters({}); // إزالة جميع الفلاتر
    return true;
  } catch {
    return false;
  }
};

// ====== Interaction Handlers ======
const deleteToggleUsers = new Set(); // userId => وضع حذف مفعل

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    const { customId } = interaction;
    const guild = interaction.guild;
    if (!guild) return;

    const settings = await ensureGuild(guild.id);

    // أزرار التحكم العامة
    if (customId.startsWith('ctl:')) {
      const player =
        client.lavalink.players.get(guild.id) ||
        client.lavalink.createPlayer({
          guildId: guild.id,
          voiceChannelId: null,
          textChannelId: settings.controlChannelId,
          volume: settings.volume,
          selfDeaf: true,
        });

      if (!player.voiceChannelId) {
        await interaction.reply({ content: 'لا يوجد اتصال صوتي نشط.', ephemeral: true }).catch(() => {});
        return;
      }

      if (customId === 'ctl:volUp') {
        await applyVolume(player, settings, settings.volume + 5);
        await interaction.deferUpdate().catch(() => {});
      } else if (customId === 'ctl:volDown') {
        await applyVolume(player, settings, settings.volume - 5);
        await interaction.deferUpdate().catch(() => {});
      } else if (customId === 'ctl:pause') {
        if (player.paused) await player.resume();
        else await player.pause();
        await interaction.deferUpdate().catch(() => {});
      } else if (customId === 'ctl:stop') {
        try {
          settings.loopMode = 'off';
          settings.shuffle = false;
          await settings.save();
          player.queue.clear();
          await player.stop().catch(() => {}); // إيقاف آمن
          if (player.connected) await player.disconnect().catch(() => {});
          lastTrackMap.delete(guild.id);
          historyMap.delete(guild.id);
        } catch {}
        await interaction.deferUpdate().catch(() => {});
      } else if (customId === 'ctl:skip') {
        if (player.queue.tracks.length || settings.loopMode !== 'off') {
          await player.skip().catch(() => {});
        }
        await interaction.deferUpdate().catch(() => {});
      } else if (customId === 'ctl:shuffle') {
        settings.shuffle = !settings.shuffle;
        await settings.save();
        if (settings.shuffle && player.queue.tracks.length > 1) {
          for (let i = player.queue.tracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [player.queue.tracks[i], player.queue.tracks[j]] = [player.queue.tracks[j], player.queue.tracks[i]];
          }
        }
        await interaction.deferUpdate().catch(() => {});
      } else if (customId === 'ctl:loopTrack') {
        settings.loopMode = settings.loopMode === 'track' ? 'off' : 'track';
        await settings.save();
        await interaction.deferUpdate().catch(() => {});
      } else if (customId === 'ctl:loopQueue') {
        settings.loopMode = settings.loopMode === 'queue' ? 'off' : 'queue';
        await settings.save();
        await interaction.deferUpdate().catch(() => {});
      } else if (customId === 'ctl:next') {
        await player.skip().catch(() => {});
        await interaction.deferUpdate().catch(() => {});
      } else if (customId === 'ctl:prev') {
        await playPrevCustom(player, settings).catch(() => {});
        await interaction.deferUpdate().catch(() => {});
      } else if (customId === 'ctl:playlist') {
        const rows = await buildPlaylistsListRows(guild.id, interaction.user.id);
        await interaction.reply({ content: `قوائم ${interaction.user}:`, components: rows, ephemeral: false }).catch(() => {});
      } else if (customId === 'ctl:save') {
        const lists = await PlaylistModel.find({ guildId: guild.id, userId: interaction.user.id }).sort({ name: 1 });
        if (!lists.length) {
          await interaction.reply({ content: 'لا توجد قوائم. أنشئ قائمة أولاً بأمر "بلايليست".', ephemeral: true }).catch(() => {});
          return;
        }
        const row = new ActionRowBuilder();
        for (const l of lists.slice(0, 5)) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(makeId('pl', 'saveInto', interaction.user.id, encName(l.name)))
              .setLabel(l.name)
              .setStyle(ButtonStyle.Primary),
          );
        }
        await interaction.reply({ content: 'اختر قائمة لحفظ الأغنية الحالية:', components: [row], ephemeral: false }).catch(() => {});
      }
      return;
    }

    // أزرار البلايليست
    if (customId.startsWith('pl|')) {
      const parts = parseId(customId); // ['pl','action','ownerId',...]
      const action = parts[1];
      const ownerId = parts[2];

      if (!(await ensureOwner(interaction, ownerId))) return;

      if (action === 'toggleDelete') {
        if (deleteToggleUsers.has(ownerId)) deleteToggleUsers.delete(ownerId);
        else deleteToggleUsers.add(ownerId);
        await interaction.reply({ content: `وضع الحذف: ${deleteToggleUsers.has(ownerId) ? 'تشغيل' : 'إيقاف'}`, ephemeral: true }).catch(() => {});
        return;
      }

      if (action === 'create') {
        const modal = new ModalBuilder().setCustomId(makeId('pl', 'modalCreate', ownerId)).setTitle('إنشاء بلايليست');
        const nameInput = new TextInputBuilder()
          .setCustomId('pl-name')
          .setLabel('اسم البلايليست')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(32)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
        await interaction.showModal(modal).catch(() => {});
        return;
      }

      if (action === 'open') {
        const name = decName(parts[3]);
        if (deleteToggleUsers.has(ownerId)) {
          await PlaylistModel.deleteOne({ guildId: interaction.guildId, userId: ownerId, name });
          deleteToggleUsers.delete(ownerId);
          await interaction.reply({ content: `تم حذف القائمة: ${name}.`, ephemeral: false }).catch(() => {});
        } else {
          const pl = await PlaylistModel.findOne({ guildId: interaction.guildId, userId: ownerId, name });
          if (!pl) return interaction.reply({ content: 'القائمة غير موجودة.', ephemeral: true }).catch(() => {});
          const { embed, rows } = buildSinglePlaylistView(pl, ownerId);
          await interaction.reply({ embeds: [embed], components: rows, ephemeral: false }).catch(() => {});
        }
        return;
      }

      if (action === 'back') {
        const rows = await buildPlaylistsListRows(interaction.guildId, ownerId);
        await interaction.reply({ content: `قوائم ${interaction.user}:`, components: rows, ephemeral: false }).catch(() => {});
        return;
      }

      if (action === 'add') {
        const name = decName(parts[3]);
        const modal = new ModalBuilder().setCustomId(makeId('pl', 'modalAdd', ownerId, encName(name))).setTitle(`إضافة إلى: ${name}`);
        for (let i = 1; i <= 5; i++) {
          const input = new TextInputBuilder()
            .setCustomId(`song${i}`)
            .setLabel(`أدخل اسم/رابط أغنية ${i}`)
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(256);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
        }
        await interaction.showModal(modal).catch(() => {});
        return;
      }

      if (action === 'del') {
        const name = decName(parts[3]);
        const pl = await PlaylistModel.findOne({ guildId: interaction.guildId, userId: ownerId, name });
        if (!pl) return interaction.reply({ content: 'القائمة غير موجودة.', ephemeral: true }).catch(() => {});
        const rows = showDeleteMenus(pl, ownerId);
        if (!rows.length) {
          await interaction.reply({ content: 'القائمة فارغة.', ephemeral: true }).catch(() => {});
          return;
        }
        await interaction.reply({ content: `اختر العناصر للحذف من ${name}:`, components: rows, ephemeral: false }).catch(() => {});
        return;
      }

      if (action === 'play') {
        const name = decName(parts[3]);
        const pl = await PlaylistModel.findOne({ guildId: interaction.guildId, userId: ownerId, name });
        if (!pl || !pl.items.length) return interaction.reply({ content: 'القائمة فارغة.', ephemeral: true }).catch(() => {});

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const vc = member?.voice?.channel;
        if (!vc || vc.type !== ChannelType.GuildVoice) {
          return interaction.reply({ content: 'يجب أن تكون في روم صوتي.', ephemeral: true }).catch(() => {});
        }

        const settings = await ensureGuild(interaction.guildId);
        let player = client.lavalink.players.get(interaction.guildId);
        if (!player) {
          player = client.lavalink.createPlayer({
            guildId: interaction.guildId,
            voiceChannelId: vc.id,
            textChannelId: settings.controlChannelId,
            volume: settings.volume,
            selfDeaf: true,
          });
          await player.connect();
        }

        for (const it of pl.items) {
          const q = it.uri || it.title;
          const res = await searchWithFallback(player, q, interaction.user).catch(() => null);
          if (res?.tracks?.length) {
            const tracksToAdd = res.playlist ? res.tracks : [res.tracks[0]];
            await enqueueTracks(player, tracksToAdd);
          }
        }
        await interaction.reply({ content: `تمت إضافة قائمة ${name} إلى الطابور.`, ephemeral: false }).catch(() => {});
        return;
      }

      if (action === 'saveInto') {
        const name = decName(parts[3]);
        const player = client.lavalink.players.get(interaction.guildId);
        const current = player?.queue?.current;
        if (!current) {
          return interaction.reply({ content: 'لا توجد أغنية حالية.', ephemeral: true }).catch(() => {});
        }
        const art = resolveArtwork(current);
        await PlaylistModel.updateOne(
          { guildId: interaction.guildId, userId: ownerId, name },
          {
            $setOnInsert: { guildId: interaction.guildId, userId: ownerId, name, items: [] },
            $push: {
              items: {
                title: current.info.title,
                uri: current.info.uri,
                source: current.info.sourceName,
                duration: current.info.length,
                artworkUrl: art,
              },
            },
          },
          { upsert: true },
        );
        await interaction.reply({ content: `تم حفظ الأغنية في ${name}.`, ephemeral: false }).catch(() => {});
        return;
      }
    }
  }

  if (interaction.isStringSelectMenu()) {
    const parts = parseId(interaction.customId);
    if (parts[0] === 'pl' && parts[1] === 'delMenu') {
      const ownerId = parts[2];
      if (!(await ensureOwner(interaction, ownerId))) return;
      const name = decName(parts[3]);
      const indexes = interaction.values.map((v) => parseInt(v, 10)).sort((a, b) => b - a);
      const pl = await PlaylistModel.findOne({ guildId: interaction.guildId, userId: ownerId, name });
      if (!pl) return interaction.reply({ content: 'القائمة غير موجودة.', ephemeral: true }).catch(() => {});
      for (const idx of indexes) {
        if (idx >= 0 && idx < pl.items.length) pl.items.splice(idx, 1);
      }
      await pl.save();
      await interaction.reply({ content: `تم الحذف من ${name}.`, ephemeral: false }).catch(() => {});
    }
  }

  if (interaction.isModalSubmit()) {
    const parts = parseId(interaction.customId);

    if (parts[0] === 'pl' && parts[1] === 'modalCreate') {
      const ownerId = parts[2];
      if (!(await ensureOwner(interaction, ownerId))) return;
      const name = interaction.fields.getTextInputValue('pl-name').trim();
      if (!name) return interaction.reply({ content: 'اسم غير صالح.', ephemeral: true }).catch(() => {});
      await PlaylistModel.updateOne(
        { guildId: interaction.guildId, userId: ownerId, name },
        { $setOnInsert: { guildId: interaction.guildId, userId: ownerId, name, items: [] } },
        { upsert: true },
      );
      await interaction.reply({ content: `تم إنشاء ${name}.`, ephemeral: false }).catch(() => {});
      return;
    }

    if (parts[0] === 'pl' && parts[1] === 'modalAdd') {
      const ownerId = parts[2];
      const name = decName(parts[3]);
      if (!(await ensureOwner(interaction, ownerId))) return;

      const fields = [];
      for (let i = 1; i <= 5; i++) {
        const v = interaction.fields.getTextInputValue(`song${i}`)?.trim();
        if (v) fields.push(v);
      }
      if (!fields.length) return interaction.reply({ content: 'لا مدخلات.', ephemeral: true }).catch(() => {});

      const pl = await PlaylistModel.findOne({ guildId: interaction.guildId, userId: ownerId, name });
      if (!pl) return interaction.reply({ content: 'القائمة غير موجودة.', ephemeral: true }).catch(() => {});

      const settings = await ensureGuild(interaction.guildId);
      let player = client.lavalink.players.get(interaction.guildId);
      if (!player) {
        player = client.lavalink.createPlayer({
          guildId: interaction.guildId,
          voiceChannelId: null,
          textChannelId: settings.controlChannelId,
          volume: settings.volume,
          selfDeaf: true,
        });
      }

      for (const q of fields) {
        const res = await searchWithFallback(player, q, interaction.user);
        if (res?.tracks?.length) {
          // أضف أول نتيجة فقط
          const t = res.playlist ? res.tracks[0] : res.tracks[0];
          if (t) {
            pl.items.push({
              title: t.info.title,
              uri: t.info.uri,
              source: t.info.sourceName,
              duration: t.info.length,
              artworkUrl: resolveArtwork(t),
            });
          }
        }
      }

      await pl.save();
      await interaction.reply({ content: `تمت الإضافة إلى ${name}.`, ephemeral: false }).catch(() => {});
      return;
    }
  }
});

// ====== Message Handling ======
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (!msg.guild) return;

  const content = msg.content?.trim();
  if (!content) return;

  // أوامر واجهة البلايليست (من أي روم)
  if (content === 'بلايليست') {
    const rows = await buildPlaylistsListRows(msg.guild.id, msg.author.id);
    await msg.channel.send({ content: `قوائم ${msg.author}:`, components: rows }).catch(() => {});
    return;
  }

  // فلاتر 8D/ريسيت (من أي روم)
  if (content === '!8D' || content === '!ريسيت') {
    const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
    const vc = member?.voice?.channel;
    if (!vc || vc.type !== ChannelType.GuildVoice) {
      await msg.reply('يجب أن تكون في روم صوتي.').catch(() => {});
      return;
    }
    const settings = await ensureGuild(msg.guild.id);
    let player = client.lavalink.players.get(msg.guild.id);
    if (!player) {
      player = client.lavalink.createPlayer({
        guildId: msg.guild.id,
        voiceChannelId: vc.id,
        textChannelId: settings.controlChannelId,
        volume: settings.volume,
        selfDeaf: true,
      });
      await player.connect().catch(() => {});
    } else {
      // تأكد أن المستخدم في نفس روم البوت إذا كان متصلاً
      if (player.voiceChannelId && player.voiceChannelId !== vc.id) {
        await msg.reply('يجب أن تكون في نفس الروم الصوتي مع البوت.').catch(() => {});
        return;
      }
    }

    if (content === '!8D') {
      const ok = await apply8D(player);
      await msg.reply(ok ? 'تم تفعيل 8D.' : 'تعذر تفعيل 8D.').catch(() => {});
    } else if (content === '!ريسيت') {
      const ok = await resetFilters(player);
      await msg.reply(ok ? 'تم إعادة ضبط الفلاتر.' : 'تعذر إعادة ضبط الفلاتر.').catch(() => {});
    }
    return;
  }

  // تشغيل الموسيقى: حصره في روم التحكم فقط
  if (msg.channel.id !== CONTROL_TEXT_CHANNEL_ID) return;

  const settings = await ensureGuild(msg.guild.id);

  const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
  const vc = member?.voice?.channel;
  if (!vc || vc.type !== ChannelType.GuildVoice) {
    await msg.channel.send('يجب أن تكون في روم صوتي ليتم التشغيل.').catch(() => {});
    return;
  }

  let player =
    client.lavalink.players.get(msg.guild.id) ||
    client.lavalink.createPlayer({
      guildId: msg.guild.id,
      voiceChannelId: vc.id,
      textChannelId: settings.controlChannelId,
      volume: settings.volume,
      selfDeaf: true,
    });

  if (!player.connected) await player.connect().catch(() => {});

  const res = await searchWithFallback(player, content, msg.author);
  if (!res || !res.tracks?.length) {
    await msg.channel.send('لم أجد نتائج.').catch(() => {});
    return;
  }

  let ok = false;
  // إذا كانت Playlist أضف الكل، غير ذلك أضف أول نتيجة فقط
  if (res.loadType === 'playlist' || res.playlist) {
    ok = await enqueueTracks(player, res.tracks);
  } else {
    ok = await enqueueTracks(player, [res.tracks[0]]);
  }

  if (ok) await msg.channel.send('تمت إضافة طلبك وسيبدأ التشغيل.').catch(() => {});

  const ch = await client.channels.fetch(settings.controlChannelId).catch(() => null);
  if (ch) await ensurePanel(msg.guild, ch, player, settings);
});

// ====== إقلاع + Mongo + دخول ======
(async () => {
  try {
    await mongoose.connect("mongodb+srv://Nael:i8VFiKISASCUzX5O@discordbot.wzwjonu.mongodb.net/?retryWrites=true&w=majority&appName=DiscordBot", { dbName: 'discord_casino' });
    console.log('MongoDB connected');

    client.on(Events.ClientReady, async () => {
      console.log(`Logged in as ${client.user.tag}`);
      client.lavalink.init({ ...client.user });
      client.lavalink.nodeManager.on('connect', (node) => {
        node.updateSession(true, 300_000);
      });
    });

    await client.login(process.env.TOKEN);
  } catch (e) {
    console.error('Startup error:', e);
    process.exit(1);
  }
})();
