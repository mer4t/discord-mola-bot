'use strict';

const crypto = require('crypto');
const { Client, GatewayIntentBits, Partials, Events, EmbedBuilder, MessageFlags } = require('discord.js');
const { CONFIG } = require('./config');
const { logger } = require('./logger');
const {
  DateTime,
  parseHHMM,
  formatHM,
  formatHMWithDayHint,
  formatDate,
  parseDateInput,
  floorToMinuteMs,
  getShiftBoundsContainingNow,
  mapTimeToShift,
  getWeekRange,
  getMonthRange,
  isDateInRange
} = require('./time-utils');
const { SHIFT_OPTIONS, detectShiftFromNickname, getShiftExamplesText } = require('./shifts');
const { loadDb, saveDb, withDbLock, flushAndClose, ensureGuild, ensureUser } = require('./db');

// ===== Constants =====
const TZ = CONFIG.timezone;
const FIRST_LAST_BLOCK_MIN = 30;
const MAX_REZ_AHEAD_HOURS = 2;
const REZ_START_WINDOW_MIN = 5;
const AUTO_CLOSE_GRACE_MIN = 2;
const MIN_SHORT_BREAK_MIN = 5;
const REZ_CREATION_COOLDOWN_MIN = 30;

const CAPACITY_LIMIT = {
  10: 2,
  20: 1
};

const RES_WINDOW_MS = REZ_START_WINDOW_MIN * 60 * 1000;
const AUTO_CLOSE_MS = AUTO_CLOSE_GRACE_MIN * 60 * 1000;
const MAX_AHEAD_MS = MAX_REZ_AHEAD_HOURS * 60 * 60 * 1000;
const MIN_SHORT_BREAK_MS = MIN_SHORT_BREAK_MIN * 60 * 1000;

const SUGGEST_STEP_MIN = 5; // alternative suggestions step (minutes)

// ===== Embed Colors =====
const C = {
  ERROR: 0xED4245,
  SUCCESS: 0x57F287,
  WARN: 0xFEE75C,
  INFO: 0x5865F2,
  ADMIN: 0x9B59B6
};

function eEmbed(color, title, desc) {
  const e = new EmbedBuilder().setColor(color);
  if (title) e.setTitle(title);
  if (desc) e.setDescription(desc);
  return e;
}

function errEmbed(desc) { return eEmbed(C.ERROR, null, '❌ ' + desc); }
function okEmbed(desc) { return eEmbed(C.SUCCESS, null, '✅ ' + desc); }
function warnEmbed(desc) { return eEmbed(C.WARN, null, '⚠️ ' + desc); }
function infoEmbed(title, desc) { return eEmbed(C.INFO, title, desc); }
function adminEmbed(title, desc) { return eEmbed(C.ADMIN, title, desc); }

function embedReplyEph(embed) { return { embeds: [embed], flags: MessageFlags.Ephemeral }; }

async function replyPrivate(interaction, embed) {
  await interaction.editReply({ embeds: [embed] });
  setTimeout(() => interaction.deleteReply().catch(() => { }), 30_000);
}

async function replyAdmin(interaction, embed) {
  await interaction.editReply({ embeds: [embed] });
}

async function replyPublic(interaction, embed) {
  await interaction.deleteReply().catch(() => { });
  await interaction.followUp({ embeds: [embed] });
}

// ===== Discord Client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

const CHANNEL_MAP = {};
for (const guildCfg of CONFIG.guildConfigs) {
  for (const [poolKey, ch] of Object.entries(guildCfg.channels)) {
    for (const id of ch.mola) CHANNEL_MAP[id] = { guildId: guildCfg.guildId, poolKey, type: 'mola' };
    for (const id of ch.rez)  CHANNEL_MAP[id] = { guildId: guildCfg.guildId, poolKey, type: 'rez' };
  }
}

function getChannelContext(channelId) {
  return CHANNEL_MAP[channelId] || null;
}

function getGuildConfig(guildId) {
  return CONFIG.guildConfigs.find((g) => g.guildId === guildId) || null;
}

function pushToPool(outbox, guildId, poolKey, type, embeds) {
  const cfg = getGuildConfig(guildId);
  if (!cfg) return;
  if (!cfg.channels[poolKey]) return;
  for (const chId of cfg.channels[poolKey][type]) {
    outbox.push({ channelId: chId, embeds });
  }
}

function clampRights(user) {
  user.freeRights['10'] = Math.max(0, Math.min(user.freeRights['10'], 2));
  user.freeRights['20'] = Math.max(0, Math.min(user.freeRights['20'], 1));
}

function resetUserForNewShift(user, guild, userId, now) {
  if (user.activeBreak) {
    logBreakClose(user, user.activeBreak, 'auto', now);
  }
  user.freeRights = { '10': 2, '20': 1 };
  // Preserve admin-created pending rezs that are still in the future (they were created without consuming rights)
  const nowMs = now.toMillis();
  user.rez = (user.rez || []).filter((r) => r.adminCreated && r.status === 'pending' && r.startAtMs > nowMs);
  user.activeBreak = null;
  user.lastNormalBreakClosedAtMs = null;
  // Remove waitlist entries for this user
  guild.waitlist = (guild.waitlist || []).filter((w) => w.userId !== userId);
}

function mention(userId) {
  return `<@${userId}>`;
}

const POOL_KEY_TR = { morning: 'Sabah', evening: 'Akşam', night: 'Gece' };
const MOLA_COMMANDS = new Set(['mola', 'acil', 'devam', 'ekstra']);
const REZ_COMMANDS = new Set(['rez', 'rezliste', 'reziptal']);
function poolKeyTR(key) {
  return POOL_KEY_TR[key] || key;
}

/**
 * Log a completed break into user's breakLog for reporting.
 */
function logBreakClose(user, breakData, closedBy, now) {
  // Use break start time for shiftDate to handle midnight-crossing shifts
  const shiftDate = formatDate(DateTime.fromMillis(breakData.startAtMs).setZone(TZ));
  user.breakLog.push({
    id: crypto.randomUUID(),
    poolKey: breakData.poolKey,
    duration: breakData.typeMins,
    isAcil: breakData.isAcil || false,
    isExtra: breakData.isExtra || false,
    isAdminBreak: breakData.isAdminBreak || false,
    startAtMs: breakData.startAtMs,
    endAtMs: now.toMillis(),
    scheduledEndAtMs: breakData.scheduledEndAtMs,
    lateMin: Math.max(0, Math.floor((now.toMillis() - breakData.scheduledEndAtMs) / 60000)),
    closedBy, // 'user' | 'auto'
    shiftDate
  });

  // Mark matching rez as completed
  if (breakData.rezId) {
    const rez = (user.rez || []).find((r) => r.id === breakData.rezId);
    if (rez) rez.status = 'completed';
  }
}

/**
 * Check if member has admin permissions.
 */
function isAdmin(member, guildId) {
  const cfg = getGuildConfig(guildId);
  const roleIds = cfg ? cfg.adminRoleIds : [];
  if (roleIds.length && roleIds.some((id) => member.roles?.cache?.has(id))) return true;
  if (member.permissions?.has('Administrator')) return true;
  return false;
}

function ceilToStep(dt, stepMin) {
  const aligned = dt.set({ second: 0, millisecond: 0 });
  const rem = aligned.minute % stepMin;
  if (rem === 0) return aligned;
  return aligned.plus({ minutes: stepMin - rem });
}

function isReservationStartAllowedWithinShift(resStart, durationMin, shiftBounds) {
  const earliest = shiftBounds.start.plus({ minutes: FIRST_LAST_BLOCK_MIN });
  const latestEnd = shiftBounds.end.minus({ minutes: FIRST_LAST_BLOCK_MIN });
  const resEnd = resStart.plus({ minutes: durationMin });

  if (resStart < earliest) return { ok: false, reason: 'Vardiyanın ilk 30 dakikasında rez alınamaz.' };
  if (resEnd > latestEnd) return { ok: false, reason: 'Bu rez vardiya sonundaki kısıtlı alana taşmaktadır.' };
  return { ok: true };
}

function getUserDisplayName(member) {
  return member?.nickname || member?.user?.globalName || member?.user?.username || '';
}

function getNow() {
  return DateTime.now().setZone(TZ);
}

// ===== Capacity helpers =====

function getActiveBreakIntervals(dbGuild, poolKey, duration) {
  /** @type {{userId:string, startAtMs:number, endAtMs:number}[]} */
  const intervals = [];
  for (const [userId, u] of Object.entries(dbGuild.users)) {
    const b = u.activeBreak;
    if (!b) continue;
    if (b.poolKey !== poolKey) continue;
    if (b.typeMins !== duration) continue;
    const startAtMs = b.startAtMs;
    const endAtMs = b.scheduledEndAtMs;
    intervals.push({ userId, startAtMs, endAtMs });
  }
  return intervals;
}

function getPendingReservationIntervals(dbGuild, poolKey, duration) {
  /** @type {{userId:string, startAtMs:number, endAtMs:number}[]} */
  const intervals = [];
  for (const [userId, u] of Object.entries(dbGuild.users)) {
    for (const r of u.rez || []) {
      if (r.poolKey !== poolKey) continue;
      if (r.duration !== duration) continue;
      if (r.status !== 'pending') continue;
      intervals.push({ userId, startAtMs: r.startAtMs, endAtMs: r.endAtMs });
    }
  }
  return intervals;
}

/**
 * Capacity planning check (rez alırken): activeBreak + pendingRez birlikte hesaplanır.
 */
function canReserveSlot(dbGuild, poolKey, duration, startAtMs, endAtMs) {
  const limit = CAPACITY_LIMIT[duration];
  const actives = getActiveBreakIntervals(dbGuild, poolKey, duration);
  const rezs = getPendingReservationIntervals(dbGuild, poolKey, duration);

  for (let t = startAtMs; t < endAtMs; t += 60000) {
    let count = 1; // new slot itself
    for (const it of actives) {
      if (t >= it.startAtMs && t < it.endAtMs) count += 1;
    }
    for (const it of rezs) {
      if (t >= it.startAtMs && t < it.endAtMs) count += 1;
    }
    if (count > limit) {
      return { ok: false, reason: `${duration} dk kapasitesi dolu (${limit}/${limit}).` };
    }
  }

  return { ok: true };
}

/**
 * Start-time check (mola başlatırken): sadece AKTİF molaları sayar.
 * Overrun (devam yazmayan) durumunda başlatmayı engeller.
 */
function canStartBreakNow(dbGuild, poolKey, duration, nowMs, exceptUserId) {
  const limit = CAPACITY_LIMIT[duration];
  let activeCount = 0;
  for (const [userId, u] of Object.entries(dbGuild.users)) {
    if (userId === exceptUserId) continue;
    const b = u.activeBreak;
    if (!b) continue;
    if (b.poolKey !== poolKey) continue;
    if (b.typeMins !== duration) continue;
    const endAtMs = b.autoCloseAtMs;
    if (nowMs >= b.startAtMs && nowMs < endAtMs) activeCount += 1;
  }
  if (activeCount >= limit) {
    return { ok: false, reason: `Şu an ${duration} dk havuz dolu. (Aktif ${activeCount}/${limit})` };
  }
  return { ok: true };
}

// ===== Suggestions =====

function userHasRezStartConflict(user, candidateStartMs) {
  const oneHourMs = 60 * 60 * 1000;
  for (const r of user.rez || []) {
    if (r.status !== 'pending') continue;
    const diff = Math.abs(r.startAtMs - candidateStartMs);
    if (diff < oneHourMs) return true;
  }
  return false;
}

/**
 * Checks if candidateStartMs falls within the 1h cooldown after last normal break.
 * Returns { ok: true } if no conflict, or { ok: false, earliestMs, leftMin } if blocked.
 */
function userBreakCooldownConflict(user, candidateStartMs) {
  if (!user.lastNormalBreakClosedAtMs) return { ok: true };
  const oneHourMs = 60 * 60 * 1000;
  const earliestMs = user.lastNormalBreakClosedAtMs + oneHourMs;
  if (candidateStartMs < earliestMs) {
    const leftMin = Math.ceil((earliestMs - candidateStartMs) / 60000);
    return { ok: false, earliestMs, leftMin };
  }
  return { ok: true };
}

function findAlternativeTimes({ now, shiftBounds, poolKey, duration, dbGuild, user }) {
  const earliest = DateTime.max(now, shiftBounds.start.plus({ minutes: FIRST_LAST_BLOCK_MIN }));
  const latest = DateTime.min(
    shiftBounds.end.minus({ minutes: FIRST_LAST_BLOCK_MIN + duration }),
    now.plus({ milliseconds: MAX_AHEAD_MS })
  );

  if (latest < earliest) return [];

  const out = [];
  let cursor = ceilToStep(earliest, SUGGEST_STEP_MIN);

  while (cursor <= latest && out.length < 3) {
    const startAt = cursor;
    const endAt = startAt.plus({ minutes: duration });
    const okShift = isReservationStartAllowedWithinShift(startAt, duration, shiftBounds);
    if (okShift.ok) {
      const startAtMs = startAt.toMillis();
      const endAtMs = endAt.toMillis();
      if (!userHasRezStartConflict(user, startAtMs) && userBreakCooldownConflict(user, startAtMs).ok) {
        const cap = canReserveSlot(dbGuild, poolKey, duration, startAtMs, endAtMs);
        if (cap.ok) out.push(startAt);
      }
    }
    cursor = cursor.plus({ minutes: SUGGEST_STEP_MIN });
  }

  return out;
}

function findTenTenPlan({ now, shiftBounds, poolKey, dbGuild, user, anchorStart }) {
  if ((user.freeRights['10'] || 0) < 2) return null;

  const earliest = DateTime.max(
    now,
    anchorStart || now,
    shiftBounds.start.plus({ minutes: FIRST_LAST_BLOCK_MIN })
  );

  const latest = DateTime.min(
    shiftBounds.end.minus({ minutes: FIRST_LAST_BLOCK_MIN + 10 }),
    now.plus({ milliseconds: MAX_AHEAD_MS })
  );

  if (latest < earliest) return null;

  let cursor = ceilToStep(earliest, SUGGEST_STEP_MIN);
  while (cursor <= latest) {
    const start1 = cursor;
    const end1 = start1.plus({ minutes: 10 });
    const start2 = start1.plus({ minutes: 70 });
    const end2 = start2.plus({ minutes: 10 });

    if (start2 > now.plus({ milliseconds: MAX_AHEAD_MS })) {
      cursor = cursor.plus({ minutes: SUGGEST_STEP_MIN });
      continue;
    }

    if (start2 < shiftBounds.start || end2 > shiftBounds.end) {
      cursor = cursor.plus({ minutes: SUGGEST_STEP_MIN });
      continue;
    }

    const ok1 = isReservationStartAllowedWithinShift(start1, 10, shiftBounds);
    const ok2 = isReservationStartAllowedWithinShift(start2, 10, shiftBounds);
    if (!ok1.ok || !ok2.ok) {
      cursor = cursor.plus({ minutes: SUGGEST_STEP_MIN });
      continue;
    }

    const s1 = start1.toMillis();
    const e1 = end1.toMillis();
    const s2 = start2.toMillis();
    const e2 = end2.toMillis();

    if (userHasRezStartConflict(user, s1) || userHasRezStartConflict(user, s2)) {
      cursor = cursor.plus({ minutes: SUGGEST_STEP_MIN });
      continue;
    }

    if (!userBreakCooldownConflict(user, s1).ok || !userBreakCooldownConflict(user, s2).ok) {
      cursor = cursor.plus({ minutes: SUGGEST_STEP_MIN });
      continue;
    }

    if (!canReserveSlot(dbGuild, poolKey, 10, s1, e1).ok) {
      cursor = cursor.plus({ minutes: SUGGEST_STEP_MIN });
      continue;
    }

    if (!canReserveSlot(dbGuild, poolKey, 10, s2, e2).ok) {
      cursor = cursor.plus({ minutes: SUGGEST_STEP_MIN });
      continue;
    }

    return { start1, start2 };
  }

  return null;
}

function findActiveShiftForPool(poolKey, now) {
  for (const schedule of SHIFT_OPTIONS[poolKey] || []) {
    const bounds = getShiftBoundsContainingNow(now, schedule, TZ);
    if (bounds) return { schedule, bounds };
  }
  return null;
}

// ===== Maintenance (auto-expire + auto-close + waitlist notify) =====

function runMaintenance(dbGuild, guildId, now) {
  const guildCfg = getGuildConfig(guildId);
  const nowMs = now.toMillis();
  /** @type {{channelId:string, content?:string, embeds?:EmbedBuilder[]}[]} */
  const outbox = [];

  // 1) expire pending reservations
  for (const [userId, u] of Object.entries(dbGuild.users)) {
    for (const r of u.rez || []) {
      if (r.status !== 'pending') continue;
      const expireAt = r.startAtMs + RES_WINDOW_MS;
      if (nowMs >= expireAt) {
        r.status = 'expired';
        r.expiredAtMs = expireAt;

        // refund right only if it was a user-created rez (admin-created ones never consumed a right)
        if (!r.adminCreated) {
          const key = String(r.duration);
          u.freeRights[key] = (u.freeRights[key] || 0) + 1;
          clampRights(u);
        }

        logger.info('Rez expired: userId=' + userId + ' ' + r.duration + 'dk @ ' + formatHM(DateTime.fromMillis(r.startAtMs).setZone(TZ)));
        pushToPool(outbox, guildId, r.poolKey, 'rez', [warnEmbed(
          mention(userId) + ' — Rezervasyon süresi doldu: **' +
          r.duration + ' dk — ' +
          formatHM(DateTime.fromMillis(r.startAtMs).setZone(TZ)) +
          '** (' + REZ_START_WINDOW_MIN + ' dk içinde başlatılmadı).' +
          (r.adminCreated ? '' : ' Hak iade edildi.')
        )]);
      }
    }

    // prune very old expired/cancelled entries (keep 24h)
    u.rez = (u.rez || []).filter((r) => {
      if (r.status === 'expired' || r.status === 'cancelled' || r.status === 'completed') {
        const t = r.expiredAtMs || r.cancelledAtMs || r.startAtMs || 0;
        return nowMs < t + 24 * 60 * 60 * 1000;
      }
      // Clean up stale 'started' entries (activeBreak already null)
      if (r.status === 'started') {
        return nowMs < r.endAtMs + 24 * 60 * 60 * 1000;
      }
      return true;
    });
  }

  // 2) auto-close active breaks
  for (const [userId, u] of Object.entries(dbGuild.users)) {
    const b = u.activeBreak;
    if (!b) continue;

    const dueCloseAt = b.scheduledEndAtMs + AUTO_CLOSE_MS;
    if (nowMs >= dueCloseAt) {
      const lateMin = Math.max(0, Math.floor((nowMs - b.scheduledEndAtMs) / 60000));

      const closeNow = DateTime.fromMillis(nowMs).setZone(TZ);
      logBreakClose(u, b, 'auto', closeNow);
      u.activeBreak = null;
      if (!b.isAcil && !b.isAdminBreak) {
        u.lastNormalBreakClosedAtMs = dueCloseAt;
      }

      logger.info('Auto-close: userId=' + userId + ' ' + b.typeMins + 'dk geç=' + lateMin + 'dk [' + b.poolKey + ']');
      const autoCloseChannels = b.molaChannelIds || (guildCfg && guildCfg.channels[b.poolKey] ? guildCfg.channels[b.poolKey].mola : []);
      for (const chId of autoCloseChannels) {
        outbox.push({
          channelId: chId,
          embeds: [errEmbed(
            mention(userId) + ' — Mola otomatik sonlandırıldı. Geç kalma süresi: **' + lateMin + ' dk**.'
          )]
        });
      }
    }
  }

  // 3) breakLog cleanup — 90 days
  const LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
  for (const u of Object.values(dbGuild.users)) {
    if (u.breakLog && u.breakLog.length) {
      u.breakLog = u.breakLog.filter((l) => nowMs - l.endAtMs < LOG_RETENTION_MS);
    }
  }

  // 4) waitlist maintenance
  dbGuild.waitlist = (dbGuild.waitlist || []).filter((w) => nowMs <= w.startAtMs);

  const remaining = [];
  for (const w of dbGuild.waitlist || []) {
    const u = dbGuild.users[w.userId];
    if (!u) continue;

    // still has rights?
    if ((u.freeRights[String(w.duration)] || 0) <= 0) {
      remaining.push(w);
      continue;
    }

    // rez 1h rule
    if (userHasRezStartConflict(u, w.startAtMs)) {
      remaining.push(w);
      continue;
    }

    // capacity now available?
    const cap = canReserveSlot(dbGuild, w.poolKey, w.duration, w.startAtMs, w.endAtMs);
    if (cap.ok) {
      const startDt = DateTime.fromMillis(w.startAtMs).setZone(TZ);
      pushToPool(outbox, guildId, w.poolKey, 'rez', [okEmbed(
        mention(w.userId) + ' — Slot müsait: **' +
        w.duration + ' dk — ' + formatHM(startDt) +
        '**. Rezervasyon için: `/rez sure:' + w.duration + ' saat:' + formatHM(startDt) + '`'
      )]);
      // one-shot notify: do not keep entry
    } else {
      remaining.push(w);
    }
  }
  dbGuild.waitlist = remaining;

  // 5) daily extra rights reset at 00:00
  const todayStr = formatDate(now);
  if (!dbGuild.lastExtraRightsResetDate) {
    dbGuild.lastExtraRightsResetDate = todayStr;
  } else if (dbGuild.lastExtraRightsResetDate !== todayStr) {
    for (const u of Object.values(dbGuild.users)) {
      u.extraRights = {};
    }
    dbGuild.lastExtraRightsResetDate = todayStr;
    logger.info('Günlük ekstra haklar sıfırlandı: ' + todayStr);
  }

  return outbox;
}

async function flushOutbox(outbox) {
  for (const m of outbox) {
    try {
      let ch = client.channels.cache.get(m.channelId);
      if (!ch) {
        try { ch = await client.channels.fetch(m.channelId); } catch { /* channel not accessible */ }
      }
      if (ch && ch.isTextBased()) {
        if (m.embeds) {
          await ch.send({ embeds: m.embeds });
        } else {
          await ch.send(m.content);
        }
      }
    } catch (err) {
      logger.warn('Mesaj gönderilemedi ch=' + m.channelId + ': ' + err.message);
    }
  }
}

// ===== Command handlers =====

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;

  // ===== /admin — works from any channel =====
  if (cmd === 'admin') {
    if (!isAdmin(interaction.member, interaction.guildId)) {
      await interaction.reply(embedReplyEph(errEmbed('Bu komutu kullanma yetkiniz bulunmuyor.')));
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sub = interaction.options.getSubcommand();

    // Pre-fetch member outside of DB lock to avoid blocking mutex with Discord API calls
    let prefetchedMember = null;
    if (sub === 'kullanici') {
      const targetUserPre = interaction.options.getUser('kullanici');
      if (targetUserPre) {
        try {
          prefetchedMember = await interaction.guild.members.fetch(targetUserPre.id);
        } catch { /* member not found or fetch failed */ }
      }
    }

    const result = await withDbLock(async () => {
      const db = await loadDb();
      const guild = ensureGuild(db, interaction.guildId);
      const now = getNow();
      const outbox = runMaintenance(guild, interaction.guildId, now);

      if (sub === 'rapor') {
        const havuzInput = interaction.options.getString('havuz') || null;
        const tarihInput = interaction.options.getString('tarih') || null;
        const donem = interaction.options.getString('donem') || 'gun';

        const targetDay = parseDateInput(tarihInput, TZ);
        if (!targetDay) {
          await replyAdmin(interaction, errEmbed('Geçersiz tarih formatı.\nÖrnek: `17.02.2026`, `bugun`, `dun`'));
          await saveDb(db);
          return { outbox };
        }

        let rangeStart, rangeEnd, dateLabel;
        if (donem === 'hafta') {
          const range = getWeekRange(targetDay);
          rangeStart = range.start; rangeEnd = range.end;
          dateLabel = formatDate(rangeStart) + ' – ' + formatDate(rangeEnd);
        } else if (donem === 'ay') {
          const range = getMonthRange(targetDay);
          rangeStart = range.start; rangeEnd = range.end;
          dateLabel = formatDate(rangeStart) + ' – ' + formatDate(rangeEnd);
        } else {
          rangeStart = targetDay; rangeEnd = targetDay;
          dateLabel = formatDate(targetDay);
        }

        const donemLabel = donem === 'hafta' ? ' (Haftalık)' : donem === 'ay' ? ' (Aylık)' : '';

        function collectPoolLogs(pk) {
          const logs = [];
          for (const [uid, u] of Object.entries(guild.users)) {
            for (const log of u.breakLog || []) {
              if (log.poolKey !== pk) continue;
              if (donem === 'gun') {
                if (log.shiftDate !== formatDate(targetDay)) continue;
              } else {
                if (!isDateInRange(log.shiftDate, rangeStart, rangeEnd)) continue;
              }
              logs.push({ userId: uid, ...log });
            }
          }
          return logs;
        }

        // Genel özet — havuz seçilmemişse
        if (!havuzInput) {
          const desc = [];
          let totalAllPools = 0;
          for (const pk of ['morning', 'evening', 'night']) {
            const logs = collectPoolLogs(pk);
            totalAllPools += logs.length;
            const uniqueU = new Set(logs.map((l) => l.userId)).size;
            const totalDur = logs.reduce((s, l) => s + l.duration, 0);
            const latePersons = new Set(logs.filter((l) => l.lateMin > 0).map((l) => l.userId)).size;
            const avgDur = logs.length > 0 ? Math.round(totalDur / logs.length) : 0;
            desc.push('**' + poolKeyTR(pk) + '** — ' + logs.length + ' mola · ' + totalDur + ' dk · ' + uniqueU + ' kişi · ort. ' + avgDur + ' dk · ' + latePersons + ' kişi geç');
          }
          if (totalAllPools === 0) {
            desc.push('');
            desc.push('ℹ️ Bu tarih için kayıt bulunamadı.');
          }
          await replyAdmin(interaction, adminEmbed('📊 Genel Özet' + donemLabel + ' | ' + dateLabel, desc.join('\n')));
          logger.info('Genel rapor görüntülendi: ' + donem + ' ' + dateLabel + ' by ' + interaction.user.tag);
          await saveDb(db);
          return { outbox };
        }

        const poolMap = { sabah: 'morning', aksam: 'evening', gece: 'night' };
        const poolKey = poolMap[havuzInput];
        if (!poolKey) {
          await replyAdmin(interaction, errEmbed('Geçersiz havuz. Seçenekler: `sabah`, `aksam`, `gece`'));
          await saveDb(db);
          return { outbox };
        }

        const allLogs = collectPoolLogs(poolKey);
        const datesWithData = new Set(allLogs.map((l) => l.shiftDate));

        const userBreaks = {};
        const userLateTotal = {};
        let normalCount = 0, acilCount = 0, ekstraCount = 0, totalDuration = 0;
        const autoCloseList = [];
        const acilUsers = new Set();

        for (const l of allLogs) {
          userBreaks[l.userId] = (userBreaks[l.userId] || 0) + 1;
          totalDuration += l.duration;
          if (l.isExtra) { ekstraCount++; } else if (l.isAcil) { acilCount++; acilUsers.add(l.userId); } else { normalCount++; }
          if (l.lateMin > 0) { userLateTotal[l.userId] = (userLateTotal[l.userId] || 0) + l.lateMin; }
          if (l.closedBy === 'auto') { autoCloseList.push(l); }
        }

        const uniqueUsers = Object.keys(userBreaks).length;
        const avgDuration = allLogs.length > 0 ? Math.round(totalDuration / allLogs.length) : 0;
        const lateUserList = Object.entries(userLateTotal);
        const totalLateAll = lateUserList.reduce((s, [, v]) => s + v, 0);
        const avgLatePerPerson = lateUserList.length > 0 ? Math.round(totalLateAll / lateUserList.length) : 0;

        const desc = [];

        if (donem !== 'gun' && datesWithData.size > 0) {
          const sortedDates = [...datesWithData].sort((a, b) => {
            const [da, ma, ya] = a.split('.').map(Number);
            const [dB, mB, yB] = b.split('.').map(Number);
            return (ya - yB) || (ma - mB) || (da - dB);
          });
          desc.push('📅 Kayıt bulunan günler: ' + sortedDates.join(', '));
          desc.push('');
        }

        desc.push('👥 Toplam mola kullanan: **' + uniqueUsers + '** kişi');
        desc.push('☕ Toplam mola: **' + allLogs.length + '** (Normal: ' + normalCount + ' | Acil: ' + acilCount + (ekstraCount ? ' | Ekstra: ' + ekstraCount : '') + ')');
        desc.push('⏱️ Toplam mola süresi: **' + totalDuration + ' dk** · Ortalama: **' + avgDuration + ' dk**');
        if (lateUserList.length > 0) {
          desc.push('⚠️ Geç kalan: **' + lateUserList.length + '** kişi · Kişi başı ort. geç: **' + avgLatePerPerson + ' dk**');
        }

        // Tam kullanıcı listesi
        const allUsersSorted = Object.entries(userBreaks).sort((a, b) => b[1] - a[1]);
        if (allUsersSorted.length) {
          desc.push('');
          desc.push('**📋 Mola kullananlar:**');
          allUsersSorted.forEach(([uid, count], i) => {
            const totalMin = allLogs.filter((l) => l.userId === uid).reduce((s, l) => s + l.duration, 0);
            const lateMin = userLateTotal[uid] || 0;
            const lateText = lateMin > 0 ? ' · ' + lateMin + ' dk geç' : '';
            desc.push((i + 1) + '. ' + mention(uid) + ' — ' + count + ' mola (' + totalMin + ' dk' + lateText + ')');
          });
        }

        if (autoCloseList.length) {
          desc.push('');
          desc.push('🔴 **Otomatik kapatılan:** ' + autoCloseList.length);
          for (const l of autoCloseList.slice(0, 10)) {
            desc.push('• ' + mention(l.userId) + ' — ' + l.duration + 'dk, ' + l.lateMin + ' dk geç');
          }
        }

        if (acilUsers.size) {
          desc.push('');
          desc.push('🚨 Acil mola kullanan: ' + [...acilUsers].map((uid) => mention(uid)).join(', '));
        }

        // Saatlik yoğunluk
        if (allLogs.length > 0) {
          const hourlyCounts = {};
          for (const l of allLogs) {
            const hour = DateTime.fromMillis(l.startAtMs).setZone(TZ).hour;
            hourlyCounts[hour] = (hourlyCounts[hour] || 0) + 1;
          }
          const maxCount = Math.max(...Object.values(hourlyCounts));
          const BAR_WIDTH = 10;
          const hourLines = [];
          for (let h = 0; h < 24; h++) {
            if (!hourlyCounts[h]) continue;
            const count = hourlyCounts[h];
            const barLen = Math.max(1, Math.round((count / maxCount) * BAR_WIDTH));
            hourLines.push(String(h).padStart(2, '0') + ':00  ' + '█'.repeat(barLen).padEnd(BAR_WIDTH + 1) + count);
          }
          if (hourLines.length) {
            desc.push('');
            desc.push('📊 **Saatlik Yoğunluk:**');
            desc.push('```');
            desc.push(...hourLines);
            desc.push('```');
          }
        }

        if (!allLogs.length) {
          desc.push('');
          desc.push('ℹ️ Bu tarih aralığı ve havuz için kayıt bulunamadı.');
        }

        let descText = desc.join('\n');
        if (descText.length > 4000) {
          descText = descText.slice(0, 3950) + '\n\n⚠️ *Rapor çok uzun, kısaltıldı.*';
        }
        await replyAdmin(interaction, adminEmbed('📊 Vardiya Raporu — ' + poolKeyTR(poolKey) + donemLabel + ' | ' + dateLabel, descText));
        logger.info('Rapor görüntülendi: ' + poolKeyTR(poolKey) + ' ' + donem + ' ' + dateLabel + ' by ' + interaction.user.tag);
        await saveDb(db);
        return { outbox };
      }

      if (sub === 'kullanici') {
        const targetUser = interaction.options.getUser('kullanici', true);
        const tarihInput = interaction.options.getString('tarih') || null;
        const tarih2Input = interaction.options.getString('tarih2') || null;

        const targetDay = parseDateInput(tarihInput, TZ);
        if (!targetDay) {
          await replyAdmin(interaction, errEmbed('Geçersiz tarih formatı.\nÖrnek: `17.02.2026`, `bugun`, `dun`'));
          await saveDb(db);
          return { outbox };
        }

        let rangeStart, rangeEnd, dateLabel;
        if (tarih2Input) {
          const targetDay2 = parseDateInput(tarih2Input, TZ);
          if (!targetDay2) {
            await replyAdmin(interaction, errEmbed('Geçersiz tarih2 formatı.\nÖrnek: `17.02.2026`, `bugun`, `dun`'));
            await saveDb(db);
            return { outbox };
          }
          if (targetDay2 < targetDay) {
            rangeStart = targetDay2; rangeEnd = targetDay;
          } else {
            rangeStart = targetDay; rangeEnd = targetDay2;
          }
          dateLabel = formatDate(rangeStart) + ' – ' + formatDate(rangeEnd);
        } else {
          rangeStart = targetDay; rangeEnd = targetDay;
          dateLabel = formatDate(targetDay);
        }

        const u = guild.users[targetUser.id];
        if (!u) {
          await replyAdmin(interaction, errEmbed('Bu kullanıcıya ait kayıt bulunamadı.'));
          await saveDb(db);
          return { outbox };
        }

        const logs = (u.breakLog || [])
          .filter((l) => isDateInRange(l.shiftDate, rangeStart, rangeEnd))
          .sort((a, b) => a.startAtMs - b.startAtMs);

        const lines = [];

        // Anlık durum
        lines.push('**— Anlık Durum —**');

        let vardiyaLine = '—';
        try {
          const detectedVardiya = detectShiftFromNickname(getUserDisplayName(prefetchedMember));
          if (detectedVardiya) vardiyaLine = poolKeyTR(detectedVardiya.poolKey) + ' (' + detectedVardiya.schedule.label + ')';
        } catch { /* member detect fail */ }
        lines.push('🏢 Vardiya: **' + vardiyaLine + '**');

        if (u.activeBreak) {
          const b = u.activeBreak;
          const endDt = DateTime.fromMillis(b.scheduledEndAtMs).setZone(TZ);
          const startDt = DateTime.fromMillis(b.startAtMs).setZone(TZ);
          const remainMs = b.scheduledEndAtMs - now.toMillis();
          const remainMin = Math.ceil(remainMs / 60000);
          const breakLabel = b.isExtra ? 'ekstra' : b.isAcil ? 'acil' : 'normal';
          const remainText = remainMs > 0 ? remainMin + ' dk kaldı' : Math.abs(remainMin) + ' dk geçti';
          lines.push('🟡 Aktif mola: **' + b.typeMins + ' dk** (' + breakLabel + ') — ' + startDt.toFormat('HH:mm') + '→' + endDt.toFormat('HH:mm') + ' (' + remainText + ')');
        } else {
          lines.push('⚪ Aktif mola: —');
        }

        const pendingRez = (u.rez || [])
          .filter((r) => r.status === 'pending')
          .sort((a, b) => a.startAtMs - b.startAtMs);
        if (pendingRez.length) {
          const rezText = pendingRez.map((r) => '**' + r.duration + ' dk @ ' + DateTime.fromMillis(r.startAtMs).setZone(TZ).toFormat('HH:mm') + '**').join(', ');
          lines.push('📋 Bekleyen rez: ' + rezText);
        } else {
          lines.push('📋 Bekleyen rez: —');
        }

        const free10 = (u.freeRights || {})['10'] || 0;
        const free20 = (u.freeRights || {})['20'] || 0;
        const extraEntries = Object.entries(u.extraRights || {}).filter(([, v]) => v > 0);
        let hakLine = '🎟️ Kalan hak: **10dk×' + free10 + '** · **20dk×' + free20 + '**';
        if (extraEntries.length) hakLine += '  |  Ekstra: ' + extraEntries.map(([k, v]) => '**' + k + 'dk×' + v + '**').join(' · ');
        lines.push(hakLine);
        lines.push('');

        // Mola geçmişi
        if (!logs.length) {
          lines.push('ℹ️ Bu tarih aralığında mola kaydı bulunamadı.');
        } else {
          const totalMin = logs.reduce((s, l) => s + l.duration, 0);
          const totalLate = logs.reduce((s, l) => s + (l.lateMin || 0), 0);
          const autoCloseCount = logs.filter((l) => l.closedBy === 'auto').length;
          const acilCount = logs.filter((l) => l.isAcil && !l.isExtra).length;
          const lateCount = logs.filter((l) => l.lateMin > 0).length;

          lines.push('**— Mola Geçmişi (' + dateLabel + ') —**');
          lines.push('Özet: **' + logs.length + '** mola · **' + totalMin + ' dk** · Geç: **' + totalLate + ' dk** · Auto-close: **' + autoCloseCount + '** · Acil: **' + acilCount + '** · Geç kalan: **' + lateCount + '**');
          lines.push('```');
          lines.push('Tür     Tarih      Başlangıç  Bitiş    Süre   Geç     Kapanış');
          lines.push('─────── ────────── ────────── ──────── ────── ─────── ──────────');

          for (const l of logs) {
            const type = l.isAdminBreak ? 'Admin  ' : l.isExtra ? 'Ekstra ' : l.isAcil ? 'Acil   ' : 'Normal ';
            const dateStr = l.shiftDate ? l.shiftDate.slice(0, 5) : '  —  ';
            const start = DateTime.fromMillis(l.startAtMs).setZone(TZ).toFormat('HH:mm');
            const end = DateTime.fromMillis(l.endAtMs).setZone(TZ).toFormat('HH:mm');
            const dur = String(l.duration).padStart(2) + 'dk';
            const late = l.lateMin > 0 ? (String(l.lateMin).padStart(3) + ' dk') : '  —   ';
            const closed = l.closedBy === 'auto' ? 'auto-close' : l.closedBy === 'admin' ? 'admin     ' : '/devam    ';
            lines.push(type + ' ' + dateStr + '   ' + start + '      ' + end + '    ' + dur + '   ' + late + '  ' + closed);
          }
          lines.push('```');
        }

        // Rez geçmişi
        const rezHistory = (u.rez || [])
          .filter((r) => {
            if (r.status === 'pending') return false;
            const rezDayStr = DateTime.fromMillis(r.startAtMs).setZone(TZ).toFormat('dd.MM.yyyy');
            return isDateInRange(rezDayStr, rangeStart, rangeEnd);
          })
          .sort((a, b) => a.startAtMs - b.startAtMs);

        if (rezHistory.length) {
          lines.push('');
          lines.push('**— Rez Geçmişi (' + dateLabel + ') —**');
          const statusLabel = { completed: 'kullanıldı', expired: 'süresi doldu', cancelled: 'iptal edildi', started: 'başlatıldı' };
          for (const r of rezHistory) {
            const startDt = DateTime.fromMillis(r.startAtMs).setZone(TZ);
            const label = statusLabel[r.status] || r.status;
            const adminTag = r.adminCreated ? ' *(admin)*' : '';
            lines.push('• **' + r.duration + ' dk @ ' + startDt.toFormat('HH:mm') + '** — ' + label + ' (' + startDt.toFormat('dd.MM') + ')' + adminTag);
          }
        }

        let kulText = lines.join('\n');
        if (kulText.length > 4000) {
          kulText = kulText.slice(0, 3950) + '\n\n⚠️ *Çok uzun, kısaltıldı.*';
        }
        await replyAdmin(interaction, adminEmbed('👤 ' + mention(targetUser.id) + ' — ' + dateLabel, kulText));
        await saveDb(db);
        return { outbox };
      }

      if (sub === 'hak-ver') {
        const targetUser = interaction.options.getUser('kullanici', true);
        const sure = interaction.options.getInteger('sure', true);

        const targetUserObj = ensureUser(guild, targetUser.id);
        const key = String(sure);
        targetUserObj.extraRights[key] = (targetUserObj.extraRights[key] || 0) + 1;

        logger.info('Admin ekstra hak verdi: ' + interaction.user.tag + ' → ' + targetUser.tag + ' +1×' + sure + 'dk');
        await replyAdmin(interaction, okEmbed(
          mention(targetUser.id) + ' kullanıcısına **+1 × ' + sure + ' dk ekstra** mola hakkı verildi.\n' +
          'Toplam **' + sure + ' dk** ekstra hakkı: **' + targetUserObj.extraRights[key] + '**\n' +
          'ℹ️ Vardiya dışında `/ekstra` komutuyla kullanılabilir.'
        ));
        await saveDb(db);
        return { outbox };
      }

      if (sub === 'hak-al') {
        const targetUser = interaction.options.getUser('kullanici', true);
        const sure = interaction.options.getInteger('sure', true);
        const tur = interaction.options.getString('tur', true);

        const targetUserObj = ensureUser(guild, targetUser.id);
        const key = String(sure);

        if (tur === 'normal') {
          const current = targetUserObj.freeRights[key] || 0;
          if (current <= 0) {
            await replyAdmin(interaction, warnEmbed(mention(targetUser.id) + ' kullanıcısının **' + sure + ' dk** normal hakkı zaten **0**.'));
            await saveDb(db); return { outbox };
          }
          targetUserObj.freeRights[key] = current - 1;
          clampRights(targetUserObj);
          logger.info('Admin hak aldı (normal): ' + interaction.user.tag + ' → ' + targetUser.tag + ' -1×' + sure + 'dk');
          await replyAdmin(interaction, okEmbed(
            mention(targetUser.id) + ' kullanıcısından **1 × ' + sure + ' dk normal** mola hakkı alındı.\n' +
            'Kalan **' + sure + ' dk** normal hak: **' + targetUserObj.freeRights[key] + '**'
          ));
        } else {
          const current = targetUserObj.extraRights[key] || 0;
          if (current <= 0) {
            await replyAdmin(interaction, warnEmbed(mention(targetUser.id) + ' kullanıcısının **' + sure + ' dk** ekstra hakkı zaten **0**.'));
            await saveDb(db); return { outbox };
          }
          targetUserObj.extraRights[key] = current - 1;
          logger.info('Admin hak aldı (ekstra): ' + interaction.user.tag + ' → ' + targetUser.tag + ' -1×' + sure + 'dk');
          await replyAdmin(interaction, okEmbed(
            mention(targetUser.id) + ' kullanıcısından **1 × ' + sure + ' dk ekstra** mola hakkı alındı.\n' +
            'Kalan **' + sure + ' dk** ekstra hak: **' + targetUserObj.extraRights[key] + '**'
          ));
        }
        await saveDb(db); return { outbox };
      }

      if (sub === 'mola-bitir') {
        const targetUser = interaction.options.getUser('kullanici', true);
        const targetUserObj = ensureUser(guild, targetUser.id);

        if (!targetUserObj.activeBreak) {
          await replyAdmin(interaction, errEmbed(mention(targetUser.id) + ' kullanıcısının aktif molası yok.'));
          await saveDb(db); return { outbox };
        }

        const b = targetUserObj.activeBreak;
        logBreakClose(targetUserObj, b, 'admin', now);
        targetUserObj.activeBreak = null;
        if (!b.isAcil && !b.isAdminBreak) targetUserObj.lastNormalBreakClosedAtMs = now.toMillis();

        const breakLabel = b.isExtra ? 'ekstra' : b.isAcil ? 'acil' : 'normal';
        logger.info('Admin mola bitirdi: ' + interaction.user.tag + ' → ' + targetUser.tag + ' ' + b.typeMins + 'dk [' + b.poolKey + ']');

        pushToPool(outbox, interaction.guildId, b.poolKey, 'mola', [warnEmbed(
          mention(targetUser.id) + ' — Molası admin tarafından sonlandırıldı.' +
          ' (' + b.typeMins + ' dk ' + breakLabel + ') — Admin: ' + mention(interaction.user.id)
        )]);

        await replyAdmin(interaction, okEmbed(
          mention(targetUser.id) + ' kullanıcısının **' + b.typeMins + ' dk** molası sonlandırıldı.'
        ));
        await saveDb(db); return { outbox };
      }

      if (sub === 'rez-ver') {
        const targetUser = interaction.options.getUser('kullanici', true);
        const duration = interaction.options.getInteger('sure', true);
        const timeStr = interaction.options.getString('saat', true);
        const havuzKey = interaction.options.getString('havuz', true);

        const parsed = parseHHMM(timeStr);
        if (!parsed) {
          await replyAdmin(interaction, errEmbed('Geçersiz saat formatı.\nÖrnek: `13:40` veya `13.40`'));
          await saveDb(db); return { outbox };
        }

        const shiftInfo = findActiveShiftForPool(havuzKey, now);
        if (!shiftInfo) {
          await replyAdmin(interaction, errEmbed('**' + poolKeyTR(havuzKey) + '** havuzunda şu an aktif vardiya yok.'));
          await saveDb(db); return { outbox };
        }

        const { bounds: shiftBounds } = shiftInfo;
        const resStartDt = mapTimeToShift(parsed, shiftBounds, TZ);
        if (!resStartDt) {
          await replyAdmin(interaction, errEmbed('Belirtilen saat vardiya aralığının dışında.'));
          await saveDb(db); return { outbox };
        }

        const nowMs = now.toMillis();
        const resStartMs = resStartDt.toMillis();

        if (resStartMs < nowMs - 30000) {
          await replyAdmin(interaction, errEmbed('Geçmiş bir saat için rez oluşturulamaz.'));
          await saveDb(db); return { outbox };
        }

        const okShift = isReservationStartAllowedWithinShift(resStartDt, duration, shiftBounds);
        if (!okShift.ok) {
          await replyAdmin(interaction, errEmbed(okShift.reason));
          await saveDb(db); return { outbox };
        }

        const resEndDt = resStartDt.plus({ minutes: duration });
        const resEndMs = resEndDt.toMillis();

        const cap = canReserveSlot(guild, havuzKey, duration, resStartMs, resEndMs);
        if (!cap.ok) {
          await replyAdmin(interaction, errEmbed('Kapasite dolu — ' + cap.reason));
          await saveDb(db); return { outbox };
        }

        const targetUserObj = ensureUser(guild, targetUser.id);
        targetUserObj.rez.push({
          id: crypto.randomUUID(),
          poolKey: havuzKey,
          duration,
          startAtMs: resStartMs,
          endAtMs: resEndMs,
          createdAtMs: nowMs,
          status: 'pending',
          adminCreated: true
        });

        const startText = formatHMWithDayHint(resStartDt, now);
        logger.info('Admin rez oluşturdu: ' + interaction.user.tag + ' → ' + targetUser.tag + ' ' + duration + 'dk @ ' + startText + ' [' + poolKeyTR(havuzKey) + ']');

        pushToPool(outbox, interaction.guildId, havuzKey, 'rez', [okEmbed(
          mention(targetUser.id) + ' — Admin tarafından rez oluşturuldu: **' + duration + ' dk** | Saat: **' + startText + '**\n' +
          'Başlatmak için: `/mola sure:' + duration + '` — Admin: ' + mention(interaction.user.id)
        )]);

        await replyAdmin(interaction, okEmbed(
          mention(targetUser.id) + ' kullanıcısına **' + duration + ' dk — ' + startText + '** rez oluşturuldu.\nℹ️ Hak düşülmedi.'
        ));
        await saveDb(db); return { outbox };
      }

      if (sub === 'rez-iptal') {
        const targetUser = interaction.options.getUser('kullanici', true);
        const hepsi = interaction.options.getBoolean('hepsi') || false;
        const saatStr = interaction.options.getString('saat');

        const targetUserObj = ensureUser(guild, targetUser.id);
        const pending = (targetUserObj.rez || []).filter((r) => r.status === 'pending');

        if (!pending.length) {
          await replyAdmin(interaction, errEmbed(mention(targetUser.id) + ' kullanıcısının iptal edilecek aktif rezervasyonu yok.'));
          await saveDb(db); return { outbox };
        }

        let targets = [];
        if (hepsi) {
          targets = pending;
        } else if (saatStr) {
          const parsed = parseHHMM(saatStr);
          if (!parsed) {
            await replyAdmin(interaction, errEmbed('Geçersiz saat formatı.\nÖrnek: `13:40` veya `13.40`'));
            await saveDb(db); return { outbox };
          }
          const hhmm = parsed.text;
          targets = pending.filter((r) => DateTime.fromMillis(r.startAtMs).setZone(TZ).toFormat('HH:mm') === hhmm);
          if (!targets.length) {
            await replyAdmin(interaction, errEmbed('**' + hhmm + '** saatinde ' + mention(targetUser.id) + ' kullanıcısına ait rez bulunamadı.'));
            await saveDb(db); return { outbox };
          }
        } else {
          pending.sort((a, b) => a.startAtMs - b.startAtMs);
          targets = [pending[0]];
        }

        for (const r of targets) {
          r.status = 'cancelled';
          r.cancelledAtMs = now.toMillis();
          const k = String(r.duration);
          if (!r.adminCreated) {
            targetUserObj.freeRights[k] = (targetUserObj.freeRights[k] || 0) + 1;
            clampRights(targetUserObj);
          }
        }

        let label;
        const byPool = {};
        for (const r of targets) { (byPool[r.poolKey] = byPool[r.poolKey] || []).push(r); }

        if (hepsi) {
          label = '**' + targets.length + '** adet rezervasyon';
        } else {
          const r = targets[0];
          const startDt = DateTime.fromMillis(r.startAtMs).setZone(TZ);
          label = '**' + r.duration + ' dk — ' + formatHMWithDayHint(startDt, now) + '** rezervasyonu';
        }

        logger.info('Admin rez iptal etti: ' + interaction.user.tag + ' → ' + targetUser.tag + ' ' + targets.length + ' rez');

        for (const [poolKey, rzList] of Object.entries(byPool)) {
          const rzDesc = rzList.map((r) => '**' + r.duration + ' dk @ ' + formatHM(DateTime.fromMillis(r.startAtMs).setZone(TZ)) + '**').join(', ');
          pushToPool(outbox, interaction.guildId, poolKey, 'rez', [warnEmbed(
            mention(targetUser.id) + ' — ' + rzDesc + ' rez' + (rzList.length > 1 ? 'leri' : 'i') + ' admin tarafından iptal edildi.' +
            ' — Admin: ' + mention(interaction.user.id)
          )]);
        }

        const anyRefunded = targets.some((r) => !r.adminCreated);
        await replyAdmin(interaction, okEmbed(
          mention(targetUser.id) + ' — ' + label + ' iptal edildi.' + (anyRefunded ? ' Haklar iade edildi.' : '')
        ));
        await saveDb(db); return { outbox };
      }

      if (sub === 'mola-al') {
        const duration = interaction.options.getInteger('sure', true);
        const adminUser = ensureUser(guild, interaction.user.id);

        if (adminUser.activeBreak) {
          const breakEndCmd = adminUser.activeBreak.isAdminBreak ? '`/admin devam`' : '`/devam`';
          await replyAdmin(interaction, errEmbed('Zaten aktif bir molanız var. Önce ' + breakEndCmd + ' ile bitirin.'));
          await saveDb(db); return { outbox };
        }

        const gCfg = getGuildConfig(interaction.guildId);
        const adminBreakChannelIds = gCfg ? gCfg.adminBreakChannelIds : [];

        const nowMs = now.toMillis();
        const startAtMs = floorToMinuteMs(nowMs);
        const scheduledEndAtMs = startAtMs + duration * 60 * 1000;

        adminUser.activeBreak = {
          id: crypto.randomUUID(),
          poolKey: 'admin',
          typeMins: duration,
          startAtMs,
          scheduledEndAtMs,
          autoCloseAtMs: scheduledEndAtMs + AUTO_CLOSE_MS,
          isAcil: false,
          isAdminBreak: true,
          molaChannelIds: adminBreakChannelIds
        };

        const endDt = DateTime.fromMillis(scheduledEndAtMs).setZone(TZ);
        logger.info('Admin molası başladı: ' + interaction.user.tag + ' ' + duration + 'dk bitiş=' + formatHM(endDt));

        for (const chId of adminBreakChannelIds) {
          outbox.push({
            channelId: chId,
            embeds: [okEmbed(mention(interaction.user.id) + ' — Admin molası başladı — **' + duration + ' dk** | Bitiş: **' + formatHM(endDt) + '**\nBitirmek için: `/admin devam`')]
          });
        }

        await replyAdmin(interaction, okEmbed('Mola başladı — **' + duration + ' dk** | Bitiş: **' + formatHM(endDt) + '**'));
        await saveDb(db); return { outbox };
      }

      if (sub === 'devam') {
        const adminUser = ensureUser(guild, interaction.user.id);

        if (!adminUser.activeBreak || !adminUser.activeBreak.isAdminBreak) {
          await replyAdmin(interaction, errEmbed('Aktif bir admin molanız bulunmuyor.'));
          await saveDb(db); return { outbox };
        }

        const gCfg = getGuildConfig(interaction.guildId);
        const adminBreakChannelIds = gCfg ? gCfg.adminBreakChannelIds : [];

        const b = adminUser.activeBreak;
        const nowMs = now.toMillis();
        const diffMs = nowMs - b.scheduledEndAtMs;
        const lateMin = diffMs <= 0 ? 0 : Math.floor(diffMs / 60000);

        logBreakClose(adminUser, b, 'user', now);
        adminUser.activeBreak = null;

        logger.info('Admin molası bitti: ' + interaction.user.tag + ' ' + b.typeMins + 'dk geç=' + lateMin + 'dk');

        const endEmbed = lateMin > 2
          ? warnEmbed(mention(interaction.user.id) + ' — Admin molası sonlandırıldı.\n⏳ Geç kalma süresi: **' + lateMin + ' dk**')
          : okEmbed(mention(interaction.user.id) + ' — Admin molası sonlandırıldı. İyi çalışmalar.');

        for (const chId of adminBreakChannelIds) {
          outbox.push({ channelId: chId, embeds: [endEmbed] });
        }

        await replyAdmin(interaction, okEmbed('Mola sonlandırıldı.' + (lateMin > 2 ? ' Geç kalma: **' + lateMin + ' dk**' : '')));
        await saveDb(db); return { outbox };
      }

      if (sub === 'restart') {
        await replyAdmin(interaction, okEmbed('Bot yeniden başlatılıyor...'));
        await saveDb(db);
        logger.info('Admin restart komutu: ' + interaction.user.tag);
        setTimeout(() => process.exit(0), 1000);
        return { outbox };
      }

      await replyAdmin(interaction, errEmbed('Tanınmayan alt komut.'));
      await saveDb(db);
      return { outbox };
    });

    if (result?.outbox?.length) {
      await flushOutbox(result.outbox);
    }
    return;
  }

  // ===== Regular commands — require mola/rez channel =====
  const channelCtx = getChannelContext(interaction.channelId);
  if (!channelCtx) {
    await interaction.reply(embedReplyEph(errEmbed('Bu komut yalnızca mola ve rez kanallarında kullanılabilir.')));
    setTimeout(() => interaction.deleteReply().catch(() => { }), 30_000);
    return;
  }

  const { poolKey: channelPoolKey, type } = channelCtx;

  const member = interaction.member;
  const displayName = getUserDisplayName(member);
  const detected = detectShiftFromNickname(displayName);
  const userPoolKey = detected ? detected.poolKey : channelPoolKey;

  if (MOLA_COMMANDS.has(cmd) && type !== 'mola') {
    await interaction.reply(embedReplyEph(errEmbed('Bu komut burada kullanılamaz. Doğru kanal: <#' + (getGuildConfig(interaction.guildId)?.channels[userPoolKey]?.mola[0] || '') + '>')));
    setTimeout(() => interaction.deleteReply().catch(() => { }), 30_000);
    return;
  }

  if (REZ_COMMANDS.has(cmd) && type !== 'rez') {
    await interaction.reply(embedReplyEph(errEmbed('Bu komut burada kullanılamaz. Doğru kanal: <#' + (getGuildConfig(interaction.guildId)?.channels[userPoolKey]?.rez[0] || '') + '>')));
    setTimeout(() => interaction.deleteReply().catch(() => { }), 30_000);
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await withDbLock(async () => {
    const db = await loadDb();
    const guildId = interaction.guildId;
    const guild = ensureGuild(db, guildId);
    const poolKey = channelPoolKey;

    if (!detected) {
      await replyPrivate(interaction, errEmbed(
        'Vardiya bilgisi algılanamadı. Lütfen nick formatını kontrol edin.\nÖrnek: `İsim | 16.00 - 00.00`\n\nGeçerli vardiyalar:\n' + getShiftExamplesText()
      ));
      return { outbox: [] };
    }

    if (detected.poolKey !== poolKey) {
      await replyPrivate(interaction, errEmbed(
        'Kanal uyumsuzluğu — Bu kanal **' + poolKeyTR(poolKey) + '** havuzuna aittir. Vardiyanız: **' + poolKeyTR(detected.poolKey) + '**\n📌 Doğru kanal: <#' + (getGuildConfig(interaction.guildId)?.channels[detected.poolKey]?.[type]?.[0] || '') + '>'
      ));
      return { outbox: [] };
    }

    const now = getNow();
    const shiftBounds = getShiftBoundsContainingNow(now, detected.schedule, TZ);

    const user = ensureUser(guild, interaction.user.id);
    const outbox = runMaintenance(guild, guildId, now);

    if (shiftBounds) {
      const shiftStartMs = shiftBounds.start.toMillis();
      if (user.lastResetShiftStartMs !== shiftStartMs) {
        resetUserForNewShift(user, guild, interaction.user.id, now);
        user.lastResetShiftStartMs = shiftStartMs;
      }
    }

    const requireInsideShift = () => {
      if (!shiftBounds) {
        return { ok: false, embed: errEmbed('Şu an vardiya saatleri dışındasınız.\nVardiyanız: ' + detected.schedule.label) };
      }
      return { ok: true };
    };

    // ===== /rez =====
    if (cmd === 'rez') {
      const must = requireInsideShift();
      if (!must.ok) { await replyPrivate(interaction, must.embed); await saveDb(db); return { outbox }; }

      const duration = interaction.options.getInteger('sure', true);
      const timeStr = interaction.options.getString('saat', true);
      const bekle = interaction.options.getBoolean('bekle') || false;

      if (duration !== 10 && duration !== 20) {
        await replyPrivate(interaction, errEmbed('Geçersiz süre — Yalnızca **10** veya **20** dakika seçilebilir.'));
        await saveDb(db); return { outbox };
      }

      const parsed = parseHHMM(timeStr);
      if (!parsed) { await replyPrivate(interaction, errEmbed('Geçersiz saat formatı.\nÖrnek: `13:40` veya `13.40`')); await saveDb(db); return { outbox }; }

      const resStartDt = mapTimeToShift(parsed, shiftBounds, TZ);
      if (!resStartDt) { await replyPrivate(interaction, errEmbed('Belirtilen saat vardiya aralığının dışında.')); await saveDb(db); return { outbox }; }

      const nowMs = now.toMillis();
      const resStartMs = resStartDt.toMillis();

      if (resStartMs < nowMs - 30000) { await replyPrivate(interaction, errEmbed('Geçmiş bir saat için rez oluşturulamaz.')); await saveDb(db); return { outbox }; }
      if (resStartMs > nowMs + MAX_AHEAD_MS) { await replyPrivate(interaction, errEmbed('Rez saati en fazla **2 saat** ilerisi olabilir.')); await saveDb(db); return { outbox }; }

      const okShift = isReservationStartAllowedWithinShift(resStartDt, duration, shiftBounds);
      if (!okShift.ok) {
        const alts = findAlternativeTimes({ now, shiftBounds, poolKey, duration, dbGuild: guild, user });
        let msg = okShift.reason;
        if (alts.length) msg += '\n📌 Uygun saatler: ' + alts.map((d) => '**' + formatHM(d) + '**').join(' · ');
        await replyPrivate(interaction, errEmbed(msg)); await saveDb(db); return { outbox };
      }

      const key = String(duration);
      if ((user.freeRights[key] || 0) <= 0) {
        await replyPrivate(interaction, errEmbed('**' + duration + ' dk** mola hakkınız kalmamıştır.'));
        await saveDb(db); return { outbox };
      }

      const lastCreatedRez = (user.rez || [])
        .filter((r) => r.createdAtMs && !r.adminCreated && (r.status === 'pending' || r.status === 'started'))
        .sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
      if (lastCreatedRez) {
        const cooldownMs = REZ_CREATION_COOLDOWN_MIN * 60 * 1000;
        const elapsed = nowMs - lastCreatedRez.createdAtMs;
        if (elapsed < cooldownMs) {
          const waitMin = Math.ceil((cooldownMs - elapsed) / 60000);
          await replyPrivate(interaction, errEmbed(
            'Rez aldıktan sonra **' + REZ_CREATION_COOLDOWN_MIN + ' dakika** beklemeniz gerekmektedir.\n⏳ Kalan süre: **' + waitMin + ' dk**'
          ));
          await saveDb(db); return { outbox };
        }
      }

      const oneHourMs = 60 * 60 * 1000;
      for (const r of user.rez || []) {
        if (r.status !== 'pending' && r.status !== 'started') continue;
        const diff = Math.abs(r.startAtMs - resStartMs);
        if (diff < oneHourMs) {
          const diffMin = Math.floor(diff / 60000);
          const needed = 60 - diffMin;
          const alts = findAlternativeTimes({ now, shiftBounds, poolKey, duration, dbGuild: guild, user });
          let msg = 'Rez alınamadı — Rez başlangıçları arasında en az **1 saat** olmalıdır.\n⏳ Kalan süre: ~' + needed + ' dk';
          if (alts.length) msg += '\n📌 Uygun saatler: ' + alts.map((d) => '**' + formatHM(d) + '**').join(' · ');
          await replyPrivate(interaction, errEmbed(msg)); await saveDb(db); return { outbox };
        }
      }

      const cooldown = userBreakCooldownConflict(user, resStartMs);
      if (!cooldown.ok) {
        const alts = findAlternativeTimes({ now, shiftBounds, poolKey, duration, dbGuild: guild, user });
        let msg = 'Rez alınamadı — Son moladan itibaren **1 saat** bekleme süresi gereklidir.\n⏳ Kalan süre: ~' + cooldown.leftMin + ' dk';
        if (alts.length) msg += '\n📌 Uygun saatler: ' + alts.map((d) => '**' + formatHM(d) + '**').join(' · ');
        await replyPrivate(interaction, errEmbed(msg)); await saveDb(db); return { outbox };
      }

      const resEndDt = resStartDt.plus({ minutes: duration });
      const resEndMs = resEndDt.toMillis();

      const cap = canReserveSlot(guild, poolKey, duration, resStartMs, resEndMs);
      if (!cap.ok) {
        const alts = findAlternativeTimes({ now, shiftBounds, poolKey, duration, dbGuild: guild, user });
        let msg = cap.reason;
        if (alts.length) msg += '\n📌 Uygun saatler: ' + alts.map((d) => '**' + formatHM(d) + '**').join(' · ');
        if (duration === 20) {
          const plan = findTenTenPlan({ now, shiftBounds, poolKey, dbGuild: guild, user, anchorStart: resStartDt });
          if (plan) msg += '\n💡 Alternatif: **10 dk @ ' + formatHM(plan.start1) + '** + **10 dk @ ' + formatHM(plan.start2) + '** şeklinde bölebilirsiniz.';
        }
        if (bekle) {
          const exists = (guild.waitlist || []).some((w) => w.userId === interaction.user.id && w.poolKey === poolKey && w.duration === duration && w.startAtMs === resStartMs);
          if (!exists) {
            guild.waitlist.push({ id: crypto.randomUUID(), userId: interaction.user.id, poolKey, duration, startAtMs: resStartMs, endAtMs: resEndMs, createdAtMs: nowMs });
          }
          msg += '\n🔔 Bekleme listesine eklendiniz. Slot boşaldığında bilgilendirileceksiniz.';
        }
        await replyPrivate(interaction, errEmbed(msg)); await saveDb(db); return { outbox };
      }

      user.freeRights[key] -= 1;
      clampRights(user);
      user.rez.push({ id: crypto.randomUUID(), poolKey, duration, startAtMs: resStartMs, endAtMs: resEndMs, createdAtMs: nowMs, status: 'pending' });

      const startText = formatHMWithDayHint(resStartDt, now);
      logger.info('Rez oluşturuldu: ' + interaction.user.tag + ' ' + duration + 'dk @ ' + startText + ' [' + poolKeyTR(poolKey) + ']');
      await replyPublic(interaction, okEmbed(mention(interaction.user.id) + ' — Rez onaylandı — **' + duration + ' dk** | Saat: **' + startText + '**\nBaşlatmak için: `/mola sure:' + duration + '`'));
      await saveDb(db); return { outbox };
    }

    // ===== /mola =====
    if (cmd === 'mola') {
      const must = requireInsideShift();
      if (!must.ok) { await replyPrivate(interaction, must.embed); await saveDb(db); return { outbox }; }

      const duration = interaction.options.getInteger('sure', true);
      if (duration !== 10 && duration !== 20) { await replyPrivate(interaction, errEmbed('Geçersiz süre — Yalnızca **10** veya **20** dakika seçilebilir.')); await saveDb(db); return { outbox }; }
      if (user.activeBreak) { await replyPrivate(interaction, errEmbed('Zaten aktif bir molanız bulunmaktadır. Önce `/devam` ile sonlandırın.')); await saveDb(db); return { outbox }; }

      const nowMs = now.toMillis();

      if (user.lastNormalBreakClosedAtMs) {
        const earliest = user.lastNormalBreakClosedAtMs + 60 * 60 * 1000;
        if (nowMs < earliest) {
          const leftMin = Math.ceil((earliest - nowMs) / 60000);
          await replyPrivate(interaction, errEmbed('Molalar arası bekleme süresi dolmadı.\n⏳ Kalan süre: **' + leftMin + ' dk**\nAcil durum için: `/acil`'));
          await saveDb(db); return { outbox };
        }
      }

      const candidates = (user.rez || []).filter((r) => {
        if (r.status !== 'pending') return false;
        if (r.poolKey !== poolKey) return false;
        if (r.duration !== duration) return false;
        const windowEnd = r.startAtMs + RES_WINDOW_MS;
        return nowMs >= r.startAtMs && nowMs <= windowEnd;
      });

      if (!candidates.length) {
        const anyInWindow = (user.rez || []).find((r) => {
          if (r.status !== 'pending') return false;
          if (r.poolKey !== poolKey) return false;
          const windowEnd = r.startAtMs + RES_WINDOW_MS;
          return nowMs >= r.startAtMs && nowMs <= windowEnd;
        });
        if (anyInWindow) {
          await replyPrivate(interaction, errEmbed('Bu saat için **' + anyInWindow.duration + ' dk** rezervasyonunuz mevcut.\nDoğru komut: `/mola sure:' + anyInWindow.duration + '`'));
        } else {
          const recentlyExpired = (user.rez || []).find((r) => {
            if (r.status !== 'expired') return false;
            if (r.poolKey !== poolKey) return false;
            if (r.duration !== duration) return false;
            const expiredAt = r.expiredAtMs || (r.startAtMs + RES_WINDOW_MS);
            return nowMs - expiredAt < 30 * 60 * 1000;
          });
          if (recentlyExpired) {
            await replyPrivate(interaction, errEmbed(
              '**' + duration + ' dk** rezervasyonunuzun başlatma penceresi doldu (5 dk içinde başlatılmadı).\nHak iade edildi, yeni rez alabilirsiniz.'
            ));
          } else {
            await replyPrivate(interaction, errEmbed('Aktif bir rezervasyonunuz bulunmuyor.\nÖnce rez kanalında `/rez` ile rezervasyon oluşturun.'));
          }
        }
        await saveDb(db); return { outbox };
      }

      candidates.sort((a, b) => a.startAtMs - b.startAtMs);
      const rez = candidates[0];

      // Use floored start time for effective duration check (same floor applied when break actually starts)
      const flooredNowMs = floorToMinuteMs(nowMs);
      const effectiveMs = rez.endAtMs - flooredNowMs;
      if (effectiveMs < MIN_SHORT_BREAK_MS) {
        await replyPrivate(interaction, errEmbed('Rez süresi dolmak üzere — Mola başlatmak için en az **' + MIN_SHORT_BREAK_MIN + ' dk** gereklidir.'));
        await saveDb(db); return { outbox };
      }

      const startCap = canStartBreakNow(guild, poolKey, duration, nowMs, interaction.user.id);
      if (!startCap.ok) {
        await replyPrivate(interaction, errEmbed('Havuz dolu — ' + startCap.reason + '\nRezervasyonunuz geçerli, kapasite boşaldığında başlatabilirsiniz.'));
        await saveDb(db); return { outbox };
      }

      rez.status = 'started';
      rez.startedAtMs = floorToMinuteMs(nowMs);
      const startAtMs = rez.startedAtMs;
      const scheduledEndAtMs = rez.endAtMs;
      const effectiveMin = Math.floor((scheduledEndAtMs - startAtMs) / 60000);

      user.activeBreak = { id: crypto.randomUUID(), poolKey, typeMins: duration, startAtMs, scheduledEndAtMs, autoCloseAtMs: scheduledEndAtMs + AUTO_CLOSE_MS, isAcil: false, rezId: rez.id };

      const endDt = DateTime.fromMillis(scheduledEndAtMs).setZone(TZ);
      let msg = mention(interaction.user.id) + ' — Mola başladı — **' + duration + ' dk** | Bitiş: **' + formatHM(endDt) + '**\nBitince: `/devam`';
      if (effectiveMin < duration) msg += '\nℹ️ Geç başlama nedeniyle mola süreniz **' + effectiveMin + ' dk** olarak ayarlandı.';

      logger.info('Mola başladı: ' + interaction.user.tag + ' ' + duration + 'dk bitiş=' + formatHM(endDt) + ' [' + poolKeyTR(poolKey) + ']');
      await replyPublic(interaction, okEmbed(msg));
      await saveDb(db); return { outbox };
    }

    // ===== /acil =====
    if (cmd === 'acil') {
      const must = requireInsideShift();
      if (!must.ok) { await replyPrivate(interaction, must.embed); await saveDb(db); return { outbox }; }

      const duration = interaction.options.getInteger('sure', true);
      if (duration !== 10 && duration !== 20) { await replyPrivate(interaction, errEmbed('Geçersiz süre — Yalnızca **10** veya **20** dakika seçilebilir.')); await saveDb(db); return { outbox }; }
      if (user.activeBreak) { await replyPrivate(interaction, errEmbed('Zaten aktif bir molanız bulunmaktadır. Önce `/devam` ile sonlandırın.')); await saveDb(db); return { outbox }; }

      const nowMs = now.toMillis();
      const earliest = shiftBounds.start.plus({ minutes: FIRST_LAST_BLOCK_MIN });
      const latestEnd = shiftBounds.end.minus({ minutes: FIRST_LAST_BLOCK_MIN });
      const endDt = now.plus({ minutes: duration });

      if (now < earliest) { await replyPrivate(interaction, errEmbed('Vardiyanın ilk 30 dakikasında mola kullanılamaz.')); await saveDb(db); return { outbox }; }
      if (endDt > latestEnd) { await replyPrivate(interaction, errEmbed('Bu mola vardiya sonundaki kısıtlı alana taşmaktadır.')); await saveDb(db); return { outbox }; }

      const key = String(duration);
      if ((user.freeRights[key] || 0) <= 0) { await replyPrivate(interaction, errEmbed('**' + duration + ' dk** mola hakkınız kalmamıştır.')); await saveDb(db); return { outbox }; }

      const startCap = canStartBreakNow(guild, poolKey, duration, nowMs, interaction.user.id);
      if (!startCap.ok) { await replyPrivate(interaction, errEmbed('Havuz dolu — ' + startCap.reason)); await saveDb(db); return { outbox }; }

      user.freeRights[key] -= 1;
      clampRights(user);

      const startAtMs = floorToMinuteMs(nowMs);
      const scheduledEndAtMs = startAtMs + duration * 60 * 1000;

      user.activeBreak = { id: crypto.randomUUID(), poolKey, typeMins: duration, startAtMs, scheduledEndAtMs, autoCloseAtMs: scheduledEndAtMs + AUTO_CLOSE_MS, isAcil: true };

      const end = DateTime.fromMillis(scheduledEndAtMs).setZone(TZ);
      logger.info('Acil mola başladı: ' + interaction.user.tag + ' ' + duration + 'dk bitiş=' + formatHM(end) + ' [' + poolKeyTR(poolKey) + ']');
      await replyPublic(interaction, warnEmbed(mention(interaction.user.id) + ' — Acil mola başlatıldı — **' + duration + ' dk** | Bitiş: **' + formatHM(end) + '**\nBitince: `/devam`'));
      await saveDb(db); return { outbox };
    }

    // ===== /ekstra =====
    if (cmd === 'ekstra') {
      if (shiftBounds) {
        await replyPrivate(interaction, errEmbed('Ekstra mola yalnızca vardiya **dışında** kullanılabilir.\nVardiyanız: ' + detected.schedule.label));
        await saveDb(db); return { outbox };
      }

      const duration = interaction.options.getInteger('sure', true);
      if (duration !== 5 && duration !== 10 && duration !== 20) { await replyPrivate(interaction, errEmbed('Geçersiz süre.')); await saveDb(db); return { outbox }; }
      if (user.activeBreak) { await replyPrivate(interaction, errEmbed('Zaten aktif bir molanız bulunmaktadır. Önce `/devam` ile sonlandırın.')); await saveDb(db); return { outbox }; }

      const key = String(duration);
      if ((user.extraRights[key] || 0) <= 0) {
        await replyPrivate(interaction, errEmbed('**' + duration + ' dk** ekstra mola hakkınız bulunmuyor.\nEkstra haklar yalnızca admin tarafından verilebilir.'));
        await saveDb(db); return { outbox };
      }

      user.extraRights[key] -= 1;
      if (user.extraRights[key] < 0) user.extraRights[key] = 0;

      const nowMs = now.toMillis();
      const startAtMs = floorToMinuteMs(nowMs);
      const scheduledEndAtMs = startAtMs + duration * 60 * 1000;

      user.activeBreak = { id: crypto.randomUUID(), poolKey, typeMins: duration, startAtMs, scheduledEndAtMs, autoCloseAtMs: scheduledEndAtMs + AUTO_CLOSE_MS, isAcil: true, isExtra: true };

      const end = DateTime.fromMillis(scheduledEndAtMs).setZone(TZ);
      logger.info('Ekstra mola başladı: ' + interaction.user.tag + ' ' + duration + 'dk bitiş=' + formatHM(end) + ' [' + poolKeyTR(poolKey) + ']');
      await replyPublic(interaction, okEmbed(mention(interaction.user.id) + ' — Ekstra mola başlatıldı — **' + duration + ' dk** | Bitiş: **' + formatHM(end) + '**\nBitince: `/devam`'));
      await saveDb(db); return { outbox };
    }

    // ===== /devam =====
    if (cmd === 'devam') {
      if (!user.activeBreak) { await replyPrivate(interaction, errEmbed('Aktif bir molanız bulunmuyor.')); await saveDb(db); return { outbox }; }

      const nowMs = now.toMillis();
      const b = user.activeBreak;
      const scheduledEndAtMs = b.scheduledEndAtMs;
      const diffMs = nowMs - scheduledEndAtMs;
      const lateMin = diffMs <= 0 ? 0 : Math.floor(diffMs / 60000);

      const closeAtMs = floorToMinuteMs(nowMs);
      logBreakClose(user, b, 'user', now);
      user.activeBreak = null;
      if (!b.isAcil && !b.isAdminBreak) user.lastNormalBreakClosedAtMs = closeAtMs;

      let embed;
      if (lateMin > 2) { embed = warnEmbed(mention(interaction.user.id) + ' — Mola sonlandırıldı.\n⏳ Geç kalma süresi: **' + lateMin + ' dk**'); }
      else { embed = okEmbed(mention(interaction.user.id) + ' — Mola sonlandırıldı. İyi çalışmalar.'); }

      logger.info('Mola bitti: ' + interaction.user.tag + ' ' + b.typeMins + 'dk geç=' + lateMin + 'dk [' + poolKeyTR(poolKey) + ']');
      await replyPublic(interaction, embed);
      await saveDb(db); return { outbox };
    }

    // ===== /hak =====
    if (cmd === 'hak') {
      const free10 = user.freeRights['10'] || 0;
      const free20 = user.freeRights['20'] || 0;
      const reserved10 = (user.rez || []).filter((r) => r.status === 'pending' && r.duration === 10 && r.poolKey === poolKey).length;
      const reserved20 = (user.rez || []).filter((r) => r.status === 'pending' && r.duration === 20 && r.poolKey === poolKey).length;
      const used10 = 2 - free10 - reserved10;
      const used20 = 1 - free20 - reserved20;

      const lines = [];
      lines.push('Boş: **10dk × ' + free10 + '** · **20dk × ' + free20 + '**');
      lines.push('Rezerve: **10dk × ' + reserved10 + '** · **20dk × ' + reserved20 + '**');
      lines.push('Kullanılan: **10dk × ' + Math.max(0, used10) + '** · **20dk × ' + Math.max(0, used20) + '**');

      const extraEntries = Object.entries(user.extraRights || {}).filter(([, v]) => v > 0);
      if (extraEntries.length) {
        lines.push('');
        lines.push('⭐ **Ekstra haklar** (vardiya dışı — `/ekstra`):');
        for (const [k, v] of extraEntries) {
          lines.push('  • **' + k + ' dk × ' + v + '**');
        }
      }

      if (user.activeBreak) {
        const b = user.activeBreak;
        const end = DateTime.fromMillis(b.scheduledEndAtMs).setZone(TZ);
        lines.push('');
        const breakLabel = b.isExtra ? ' (ekstra)' : b.isAcil ? ' (acil)' : '';
        lines.push('Aktif mola: **' + b.typeMins + ' dk** | Bitiş: **' + formatHM(end) + '**' + breakLabel);
      } else {
        lines.push('');
        lines.push('Aktif mola: —');
      }

      if (user.lastNormalBreakClosedAtMs) {
        const earliest = DateTime.fromMillis(user.lastNormalBreakClosedAtMs + 60 * 60 * 1000).setZone(TZ);
        if (now < earliest) {
          lines.push('Sonraki mola: en erken **' + formatHMWithDayHint(earliest, now) + '**');
        } else {
          lines.push('Sonraki mola: Bekleme yok');
        }
      } else {
        lines.push('Sonraki mola: Bekleme yok');
      }

      if (!shiftBounds) {
        lines.push('ℹ️ Vardiya dışındasınız. (' + detected.schedule.label + ')');
      }

      await replyPrivate(interaction, infoEmbed('📊 Mola Hak Durumu', lines.join('\n')));
      await saveDb(db); return { outbox };
    }

    // ===== /rezliste =====
    if (cmd === 'rezliste') {
      const myPending = (user.rez || [])
        .filter((r) => r.status === 'pending' && r.poolKey === poolKey)
        .sort((a, b) => a.startAtMs - b.startAtMs);

      const lines = [];
      if (!myPending.length) { lines.push('• (Yok)'); }
      else { for (const r of myPending) { const start = DateTime.fromMillis(r.startAtMs).setZone(TZ); lines.push('• **' + r.duration + ' dk** — **' + formatHMWithDayHint(start, now) + '**'); } }

      const active10 = []; const active20 = []; const pending10 = []; const pending20 = [];
      for (const [uid, u] of Object.entries(guild.users)) {
        const b = u.activeBreak;
        if (b && b.poolKey === poolKey) {
          const end = DateTime.fromMillis(b.scheduledEndAtMs).setZone(TZ);
          const typeLabel = b.isExtra ? ' ekstra' : b.isAcil ? ' acil' : '';
          const entry = mention(uid) + ' (' + b.typeMins + 'dk' + typeLabel + ' → ' + formatHM(end) + ')';
          if (b.typeMins === 10) active10.push(entry);
          if (b.typeMins === 20) active20.push(entry);
        }
        for (const r of u.rez || []) {
          if (r.poolKey !== poolKey) continue;
          if (r.status !== 'pending') continue;
          const start = DateTime.fromMillis(r.startAtMs).setZone(TZ);
          const entry = mention(uid) + ' (' + r.duration + 'dk @ ' + formatHM(start) + ')';
          if (r.duration === 10) pending10.push(entry);
          if (r.duration === 20) pending20.push(entry);
        }
      }

      lines.push('');
      lines.push('**Havuz Durumu (Aktif)**');
      lines.push('• 10 dk: ' + (active10.length ? active10.join(', ') : '(boş)') + '  [max 2]');
      lines.push('• 20 dk: ' + (active20.length ? active20.join(', ') : '(boş)') + '  [max 1]');
      lines.push('');
      lines.push('**Yaklaşan Rezervasyonlar**');
      lines.push('• 10 dk: ' + (pending10.length ? pending10.slice(0, 10).join(', ') : '(yok)'));
      lines.push('• 20 dk: ' + (pending20.length ? pending20.slice(0, 10).join(', ') : '(yok)'));

      const wCount = (guild.waitlist || []).filter((w) => w.poolKey === poolKey).length;
      if (wCount) lines.push('\n🔔 Bekleme listesi: ' + wCount + ' istek');

      await replyPrivate(interaction, infoEmbed('📋 Rezervasyon Listesi', lines.join('\n')));
      await saveDb(db); return { outbox };
    }

    // ===== /reziptal =====
    if (cmd === 'reziptal') {
      const hepsi = interaction.options.getBoolean('hepsi') || false;
      const saatStr = interaction.options.getString('saat');

      const pending = (user.rez || []).filter((r) => r.status === 'pending' && r.poolKey === poolKey);
      if (!pending.length) { await replyPrivate(interaction, errEmbed('İptal edilecek aktif bir rezervasyonunuz bulunmuyor.')); await saveDb(db); return { outbox }; }

      let targets = [];
      if (hepsi) {
        targets = pending;
      } else if (saatStr) {
        const parsed = parseHHMM(saatStr);
        if (!parsed) { await replyPrivate(interaction, errEmbed('Geçersiz saat formatı.\nÖrnek: `13:40` veya `13.40`')); await saveDb(db); return { outbox }; }
        const hhmm = parsed.text;
        targets = pending.filter((r) => DateTime.fromMillis(r.startAtMs).setZone(TZ).toFormat('HH:mm') === hhmm);
        if (!targets.length) { await replyPrivate(interaction, errEmbed('**' + hhmm + '** saatinde aktif rezervasyon bulunamadı.')); await saveDb(db); return { outbox }; }
      } else {
        pending.sort((a, b) => a.startAtMs - b.startAtMs);
        targets = [pending[0]];
      }

      for (const r of targets) {
        r.status = 'cancelled';
        r.cancelledAtMs = now.toMillis();
        const k = String(r.duration);
        if (!r.adminCreated) {
          user.freeRights[k] = (user.freeRights[k] || 0) + 1;
          clampRights(user);
        }
      }

      let label;
      if (hepsi) {
        label = '**' + targets.length + '** adet rezervasyon';
      } else {
        const r = targets[0];
        const startDt = DateTime.fromMillis(r.startAtMs).setZone(TZ);
        label = '**' + r.duration + ' dk — ' + formatHMWithDayHint(startDt, now) + '** rezervasyonu';
      }
      const anyRefundedUser = targets.some((r) => !r.adminCreated);
      await replyPublic(interaction, okEmbed(mention(interaction.user.id) + ' — ' + label + ' iptal edildi.' + (anyRefundedUser ? ' Haklar iade edildi.' : '')));
      await saveDb(db); return { outbox };
    }

    await replyPrivate(interaction, errEmbed('Tanınmayan komut.'));
    await saveDb(db); return { outbox };
  });

  if (result?.outbox?.length) {
    await flushOutbox(result.outbox);
  }
}

// ===== Scheduler =====
const maintenanceInterval = setInterval(() => {
  withDbLock(async () => {
    const db = await loadDb();
    const now = getNow();
    const allOutbox = [];
    for (const guildCfg of CONFIG.guildConfigs) {
      const g = ensureGuild(db, guildCfg.guildId);
      const outbox = runMaintenance(g, guildCfg.guildId, now);
      allOutbox.push(...outbox);
    }
    await saveDb(db);
    setImmediate(() => flushOutbox(allOutbox));
  }).catch((err) => logger.error('Maintenance error: ' + (err?.message || err)));
}, 30 * 1000);

// ===== Graceful Shutdown =====
let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function gracefulShutdown(signal, exitCode = 0) {
  if (shuttingDown) {
    logger.warn('Tekrar sinyal alındı (' + signal + '), zorla kapatılıyor.');
    process.exit(1);
    return;
  }
  shuttingDown = true;
  logger.info('Shutdown başlatıldı (' + signal + ')...');

  clearInterval(maintenanceInterval);

  const forceTimer = setTimeout(() => {
    logger.error('Shutdown zaman aşımına uğradı, zorla kapatılıyor.');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  try {
    await flushAndClose();
    logger.info('Database kaydedildi.');
  } catch (err) {
    logger.error('Shutdown sırasında DB hatası: ' + err.message);
  }

  try {
    client.destroy();
    logger.info('Discord client kapatıldı.');
  } catch {
    // ignore
  }

  process.exit(exitCode);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT', 0));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 0));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception: ' + (err.stack || err.message));
  gracefulShutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection: ' + (reason instanceof Error ? reason.stack : String(reason)));
  gracefulShutdown('unhandledRejection', 1);
});

client.once(Events.ClientReady, (c) => {
  logger.info('Bot hazır: ' + c.user.tag);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (err) {
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await replyAdmin(interaction, errEmbed('İşlem sırasında bir hata oluştu. Lütfen tekrar deneyin.'));
        } else {
          await interaction.reply(embedReplyEph(errEmbed('İşlem sırasında bir hata oluştu. Lütfen tekrar deneyin.')));
        }
      }
    } catch {
      // ignore
    }
    logger.error('Interaction error: ' + err.stack);
  }
});

client.login(CONFIG.token);
