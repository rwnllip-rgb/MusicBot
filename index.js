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
} = require('discord.js');

const mongoose = require('mongoose');
const { LavalinkManager } = require('lavalink-client');

// ====== إعدادات ثابتة ======
const CONTROL_TEXT_CHANNEL_ID = '1410843136594411520';
const PANEL_UPDATE_INTERVAL_MS = 15000;
const DEFAULT_VOLUME = 50;
const MAX_PLAYLIST_SLOTS_PER_ROW = 5;
const MAX_PLAYLIST_ROWS = 3;
const PLAYLIST_DELETE_TOGGLE_ID = 'pl:toggleDelete';

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
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

const resolveArtwork = (track) =>
  track?.info?.artworkUrl ||
  track?.artworkUrl ||
  (track?.info?.identifier ? `https://i.ytimg.com/vi/${track.info.identifier}/hqdefault.jpg` : null);

const ensureGuild = async (guildId) => {
  let doc = await GuildModel.findOne({ guildId });
  if (!doc) doc = await GuildModel.create({ guildId });
  return doc;
};

// بحث متعدد المصادر مع fallback
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
    new ButtonBuilder().setCustomId('ctl:save').setLabel('حفظ').setStyle(ButtonStyle.Secondary),
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

// إضافة للطابور (بدون منع تكرار)
const enqueueTracks = async (player, tracks) => {
  if (!tracks?.length) return false;
  player.queue.add(tracks);
  if (!player.playing && !player.paused) await player.play();
  return true;
};

// التالي/السابق
const playNext = async (player, settings, { keepCurrent = false, random = false } = {}) => {
  const q = player.queue;
  if (settings.shuffle || random) {
    if (q.tracks.length > 0) {
      const idx = Math.floor(Math.random() * q.tracks.length);
      const [picked] = q.tracks.splice(idx, 1);
      if (keepCurrent && q.current) q.add(q.current);
      q.current = picked;
      await player.play(picked);
      return;
    }
  }
  if (keepCurrent && q.current) q.add(q.current);
  await player.skip();
};

const playPrev = async (player, settings) => {
  const q = player.queue;
  if (settings.shuffle) {
    if (q.current) await player.play(q.current, { startTime: 0 });
    return;
  }
  if (q.previous.length) {
    const prev = q.previous.pop();
    if (q.current) q.tracks.unshift(q.current);
    q.current = prev;
    await player.play(prev);
  } else {
    if (q.current) await player.play(q.current, { startTime: 0 });
  }
};

// ====== Playlists UI ======
const buildPlaylistsListMessage = async (guildId, userId) => {
  const lists = await PlaylistModel.find({ guildId, userId }).sort({ name: 1 });
  const names = lists.map((l) => l.name);

  const rows = [];
  const totalSlots = MAX_PLAYLIST_ROWS * MAX_PLAYLIST_SLOTS_PER_ROW;
  const filled = Math.min(names.length, totalSlots);

  let idx = 0;
  for (let r = 0; r < MAX_PLAYLIST_ROWS; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < MAX_PLAYLIST_SLOTS_PER_ROW; c++) {
      const label = idx < filled ? names[idx] : 'فراغ';
      const id = idx < filled ? `pl:open:${names[idx]}` : `pl:create:${r}:${c}`;
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
    new ButtonBuilder().setCustomId(PLAYLIST_DELETE_TOGGLE_ID).setLabel('حذف').setStyle(ButtonStyle.Danger),
  );
  rows.push(lastRow);

  return rows;
};

const buildSinglePlaylistView = (plist) => {
  const emb = new EmbedBuilder()
    .setColor(0x8bc34a)
    .setTitle(`البلايليست: ${plist.name}`)
    .setDescription(plist.items.length ? `${plist.items.length} أغنية` : 'فارغة')
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pl:back`).setLabel('عودة').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`pl:add:${plist.name}`).setLabel('إضافة').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`pl:del:${plist.name}`).setLabel('حذف').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`pl:play:${plist.name}`).setLabel('تشغيل').setStyle(ButtonStyle.Success),
  );

  return { embed: emb, rows: [row] };
};

const showDeleteMenus = (plist) => {
  const chunks = [];
  for (let i = 0; i < plist.items.length; i += 25) chunks.push(plist.items.slice(i, i + 25));
  const rows = [];
  chunks.forEach((chunk, ci) => {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`pl:delMenu:${plist.name}:${ci}`)
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

// ====== أحداث Lavalink ======
client.lavalink.on('trackStart', async (player) => {
  const guild = client.guilds.cache.get(player.guildId);
  if (!guild) return;
  const settings = await ensureGuild(guild.id);
  const ch = await client.channels.fetch(settings.controlChannelId).catch(() => null);
  if (!ch) return;
  await ensurePanel(guild, ch, player, settings);
});

client.lavalink.on('queueEnd', async (player) => {
  const guild = client.guilds.cache.get(player.guildId);
  if (!guild) return;
  const settings = await ensureGuild(guild.id);
  if (settings.loopMode === 'queue') {
    while (player.queue.previous.length) {
      const prev = player.queue.previous.shift();
      player.queue.add(prev);
    }
    if (player.queue.tracks.length) await player.play(player.queue.tracks.shift());
  }
});

// ====== Interaction Handlers ======
const deleteToggleUsers = new Set();

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    const { customId } = interaction;
    const guild = interaction.guild;
    if (!guild) return;

    const settings = await ensureGuild(guild.id);

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
        player.queue.clear();
        await player.stopPlaying(true);
        await interaction.deferUpdate().catch(() => {});
      } else if (customId === 'ctl:skip') {
        if (player.queue.tracks.length || settings.loopMode !== 'off') {
          await playNext(player, settings, { keepCurrent: false, random: false });
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
        await playNext(player, settings, { keepCurrent: true, random: settings.shuffle });
        await interaction.deferUpdate().catch(() => {});
      } else if (customId === 'ctl:prev') {
        await playPrev(player, settings);
        await interaction.deferUpdate().catch(() => {});
      } else if (customId === 'ctl:playlist') {
        const rows = await buildPlaylistsListMessage(guild.id, interaction.user.id);
        await interaction.reply({ content: 'قوائمك:', components: rows, ephemeral: true }).catch(() => {});
      } else if (customId === 'ctl:save') {
        const lists = await PlaylistModel.find({ guildId: guild.id, userId: interaction.user.id }).sort({ name: 1 });
        if (!lists.length) {
          await interaction.reply({ content: 'لا توجد قوائم. أنشئ قائمة أولاً بأمر "بلايليست".', ephemeral: true }).catch(() => {});
          return;
        }
        const row = new ActionRowBuilder();
        for (const l of lists.slice(0, 5)) {
          row.addComponents(new ButtonBuilder().setCustomId(`pl:saveInto:${l.name}`).setLabel(l.name).setStyle(ButtonStyle.Primary));
        }
        await interaction.reply({ content: 'اختر قائمة لحفظ الأغنية الحالية:', components: [row], ephemeral: true }).catch(() => {});
      }
      return;
    }

    if (customId === PLAYLIST_DELETE_TOGGLE_ID) {
      if (deleteToggleUsers.has(interaction.user.id)) deleteToggleUsers.delete(interaction.user.id);
      else deleteToggleUsers.add(interaction.user.id);
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (customId.startsWith('pl:create:')) {
      const modal = new ModalBuilder().setCustomId('pl:modalCreate').setTitle('إنشاء بلايليست');
      const nameInput = new TextInputBuilder().setCustomId('pl:name').setLabel('اسم البلايليست').setStyle(TextInputStyle.Short).setMaxLength(32).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
      await interaction.showModal(modal).catch(() => {});
      return;
    }

    if (customId.startsWith('pl:open:')) {
      const name = customId.split(':')[15];
      if (deleteToggleUsers.has(interaction.user.id)) {
        await PlaylistModel.deleteOne({ guildId: interaction.guildId, userId: interaction.user.id, name });
        deleteToggleUsers.delete(interaction.user.id);
        await interaction.update({ content: 'تم الحذف. أعد فتح واجهة البلايليست.', components: [] }).catch(() => {});
      } else {
        const pl = await PlaylistModel.findOne({ guildId: interaction.guildId, userId: interaction.user.id, name });
        if (!pl) return interaction.reply({ content: 'القائمة غير موجودة.', ephemeral: true }).catch(() => {});
        const { embed, rows } = buildSinglePlaylistView(pl);
        await interaction.reply({ embeds: [embed], components: rows, ephemeral: true }).catch(() => {});
      }
      return;
    }

    if (customId.startsWith('pl:add:')) {
      const name = customId.split(':')[15];
      const modal = new ModalBuilder().setCustomId(`pl:modalAdd:${name}`).setTitle(`إضافة إلى: ${name}`);
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

    if (customId.startsWith('pl:del:')) {
      const name = customId.split(':')[15];
      const pl = await PlaylistModel.findOne({ guildId: interaction.guildId, userId: interaction.user.id, name });
      if (!pl) return interaction.reply({ content: 'القائمة غير موجودة.', ephemeral: true }).catch(() => {});
      const rows = showDeleteMenus(pl);
      await interaction.reply({ content: 'اختر العناصر لحذفها:', components: rows, ephemeral: true }).catch(() => {});
      return;
    }

    if (customId.startsWith('pl:play:')) {
      const name = customId.split(':')[15];
      const pl = await PlaylistModel.findOne({ guildId: interaction.guildId, userId: interaction.user.id, name });
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
        const res = await searchWithFallback(player, it.uri || it.title, interaction.user);
        if (res?.tracks?.length) {
          await enqueueTracks(player, [res.tracks]);
        }
      }
      await interaction.reply({ content: `تمت إضافة قائمة ${name} إلى الطابور.`, ephemeral: true }).catch(() => {});
      return;
    }

    if (customId.startsWith('pl:saveInto:')) {
      const name = customId.split(':')[15];
      const player = client.lavalink.players.get(interaction.guildId);
      const current = player?.queue?.current;
      if (!current) {
        return interaction.reply({ content: 'لا توجد أغنية حالية.', ephemeral: true }).catch(() => {});
      }
      const art = resolveArtwork(current);
      await PlaylistModel.updateOne(
        { guildId: interaction.guildId, userId: interaction.user.id, name },
        {
          $setOnInsert: { guildId: interaction.guildId, userId: interaction.user.id, name, items: [] },
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
      await interaction.update({ content: `تم حفظ الأغنية في ${name}.`, components: [] }).catch(() => {});
      return;
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith('pl:delMenu:')) {
      const [, , name] = interaction.customId.split(':');
      const indexes = interaction.values.map((v) => parseInt(v, 10)).sort((a, b) => b - a);
      const pl = await PlaylistModel.findOne({ guildId: interaction.guildId, userId: interaction.user.id, name });
      if (!pl) return interaction.reply({ content: 'القائمة غير موجودة.', ephemeral: true }).catch(() => {});
      for (const idx of indexes) {
        if (idx >= 0 && idx < pl.items.length) pl.items.splice(idx, 1);
      }
      await pl.save();
      await interaction.update({ content: 'تم الحذف من القائمة.', components: [] }).catch(() => {});
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'pl:modalCreate') {
      const name = interaction.fields.getTextInputValue('pl:name').trim();
      if (!name) return interaction.reply({ content: 'اسم غير صالح.', ephemeral: true }).catch(() => {});
      await PlaylistModel.updateOne(
        { guildId: interaction.guildId, userId: interaction.user.id, name },
        { $setOnInsert: { guildId: interaction.guildId, userId: interaction.user.id, name, items: [] } },
        { upsert: true },
      );
      await interaction.reply({ content: `تم إنشاء ${name}.`, ephemeral: true }).catch(() => {});
      return;
    }
    if (interaction.customId.startsWith('pl:modalAdd:')) {
      const name = interaction.customId.split(':')[15];
      const fields = [];
      for (let i = 1; i <= 5; i++) {
        const v = interaction.fields.getTextInputValue(`song${i}`)?.trim();
        if (v) fields.push(v);
      }
      if (!fields.length) return interaction.reply({ content: 'لا مدخلات.', ephemeral: true }).catch(() => {});

      const pl = await PlaylistModel.findOne({ guildId: interaction.guildId, userId: interaction.user.id, name });
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
          const t = res.tracks;
          pl.items.push({
            title: t.info.title,
            uri: t.info.uri,
            source: t.info.sourceName,
            duration: t.info.length,
            artworkUrl: resolveArtwork(t),
          });
        }
      }
      await pl.save();
      await interaction.reply({ content: `تمت الإضافة إلى ${name}.`, ephemeral: true }).catch(() => {});
      return;
    }
  }
});

// ====== Message Handling ======
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (!msg.guild) return;
  if (msg.channel.id !== CONTROL_TEXT_CHANNEL_ID) return;

  const settings = await ensureGuild(msg.guild.id);

  const userMsg = msg;
  const content = userMsg.content?.trim();
  if (!content) {
    try { await userMsg.delete(); } catch (_) {}
    return;
  }
  if (content === 'بلايليست') {
    const rows = await buildPlaylistsListMessage(msg.guild.id, msg.author.id);
    const sent = await msg.channel.send({ content: 'قوائمك:', components: rows }).catch(() => null);
    setTimeout(() => {
      userMsg.delete().catch(() => {});
      sent?.delete().catch(() => {});
    }, 5000);
    return;
  }

  const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
  const vc = member?.voice?.channel;
  if (!vc || vc.type !== ChannelType.GuildVoice) {
    const warn = await msg.channel.send('يجب أن تكون في روم صوتي ليتم التشغيل.').catch(() => null);
    setTimeout(() => {
      userMsg.delete().catch(() => {});
      warn?.delete().catch(() => {});
    }, 4000);
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
    const no = await msg.channel.send('لم أجد نتائج.').catch(() => null);
    setTimeout(() => {
      userMsg.delete().catch(() => {});
      no?.delete().catch(() => {});
    }, 4000);
    return;
  }

  let ok = false;
  if (res.loadType === 'playlist' || res.playlist) {
    ok = await enqueueTracks(player, res.tracks);
  } else {
    ok = await enqueueTracks(player, [res.tracks]);
  }

  const conf = ok ? await msg.channel.send('تمت إضافة طلبك وسيبدأ التشغيل.').catch(() => null) : null;
  setTimeout(() => {
    userMsg.delete().catch(() => {});
    conf?.delete().catch(() => {});
  }, 4000);

  const ch = await client.channels.fetch(settings.controlChannelId).catch(() => null);
  if (ch) await ensurePanel(msg.guild, ch, player, settings);
})
;



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
