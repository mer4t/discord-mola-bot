'use strict';

const fsp = require('fs/promises');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

/** @type {object|null} */
let _cache = null;

function defaultDb() {
  return {
    version: 1,
    guilds: {}
  };
}

async function loadDb() {
  if (_cache) return _cache;
  try {
    const raw = await fsp.readFile(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      _cache = defaultDb();
    } else {
      if (!parsed.guilds || typeof parsed.guilds !== 'object') parsed.guilds = {};
      _cache = parsed;
    }
  } catch {
    _cache = defaultDb();
  }
  return _cache;
}

async function saveDb(db) {
  _cache = db;
  const tmp = DB_PATH + '.tmp';
  const json = JSON.stringify(db, null, 2);
  await fsp.writeFile(tmp, json, 'utf8');
  await fsp.rename(tmp, DB_PATH);
}

let mutex = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withDbLock(fn) {
  const run = mutex.then(fn, fn);
  // Keep chain alive even if fn throws
  mutex = run.catch(() => undefined);
  return run;
}

function ensureGuild(db, guildId) {
  if (!db.guilds[guildId]) {
    db.guilds[guildId] = {
      users: {},
      waitlist: []
    };
  }
  if (!db.guilds[guildId].users) db.guilds[guildId].users = {};
  if (!Array.isArray(db.guilds[guildId].waitlist)) db.guilds[guildId].waitlist = [];
  return db.guilds[guildId];
}

function ensureUser(guild, userId) {
  if (!guild.users[userId]) {
    guild.users[userId] = {
      lastResetShiftStartMs: null,
      freeRights: { '10': 2, '20': 1 },
      rez: [],
      activeBreak: null,
      lastNormalBreakClosedAtMs: null,
      breakLog: []
    };
  }
  const u = guild.users[userId];
  if (!u.freeRights) u.freeRights = { '10': 0, '20': 0 };
  if (!u.extraRights || typeof u.extraRights !== 'object') u.extraRights = {};
  if (!Array.isArray(u.rez)) u.rez = [];
  if (!('activeBreak' in u)) u.activeBreak = null;
  if (!('lastNormalBreakClosedAtMs' in u)) u.lastNormalBreakClosedAtMs = null;
  if (!Array.isArray(u.breakLog)) u.breakLog = [];
  return u;
}

/**
 * Wait for any pending DB operations, flush cache to disk, then release.
 * Runs through the mutex to prevent concurrent writes.
 */
async function flushAndClose() {
  await withDbLock(async () => {
    if (_cache) {
      await saveDb(_cache);
    }
  });
}

module.exports = {
  DB_PATH,
  loadDb,
  saveDb,
  withDbLock,
  flushAndClose,
  ensureGuild,
  ensureUser
};
