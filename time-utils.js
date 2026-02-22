'use strict';

const { DateTime } = require('luxon');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function normalizeTimeInput(str) {
  return String(str || '').trim().replaceAll('.', ':');
}

function parseHHMM(str) {
  const s = normalizeTimeInput(str);
  const m = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(s);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return { hour, minute, text: `${pad2(hour)}:${pad2(minute)}` };
}

function formatHM(dt) {
  return dt.toFormat('HH:mm');
}

function formatHMWithDayHint(dt, now) {
  // If date differs from now date, show (yarın) or (dün)
  if (!now) return formatHM(dt);
  const d0 = now.startOf('day');
  const d1 = dt.startOf('day');
  const diffDays = Math.round(d1.diff(d0, 'days').days);
  if (diffDays === 0) return formatHM(dt);
  if (diffDays === 1) return `${formatHM(dt)} (yarın)`;
  if (diffDays === -1) return `${formatHM(dt)} (dün)`;
  return `${formatHM(dt)} (${dt.toFormat('dd.LL')})`;
}

function floorToMinuteMs(ms) {
  return Math.floor(ms / 60000) * 60000;
}

function buildShiftForDay(dayStartDt, schedule) {
  const start = dayStartDt.set({ hour: schedule.start.hour, minute: schedule.start.minute, second: 0, millisecond: 0 });
  let end = dayStartDt.set({ hour: schedule.end.hour, minute: schedule.end.minute, second: 0, millisecond: 0 });
  if (end <= start) end = end.plus({ days: 1 });
  return { start, end };
}

/**
 * Returns shift bounds that CONTAIN now, otherwise null.
 */
function getShiftBoundsContainingNow(now, schedule, zone) {
  const today = now.setZone(zone).startOf('day');
  let bounds = buildShiftForDay(today, schedule);
  if (now >= bounds.start && now < bounds.end) return bounds;
  const yesterday = today.minus({ days: 1 });
  bounds = buildShiftForDay(yesterday, schedule);
  if (now >= bounds.start && now < bounds.end) return bounds;
  return null;
}

/**
 * Maps a HH:MM time to a concrete DateTime within the given shift bounds.
 * Returns null if the mapped time is outside shift.
 */
function mapTimeToShift(time, shiftBounds) {
  let candidate = shiftBounds.start.startOf('day').set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 });
  if (candidate < shiftBounds.start) candidate = candidate.plus({ days: 1 });
  if (candidate < shiftBounds.start || candidate >= shiftBounds.end) return null;
  return candidate;
}

/**
 * Format DateTime as DD.MM.YYYY
 */
function formatDate(dt) {
  return dt.toFormat('dd.MM.yyyy');
}

/**
 * Parse date input: "17.02.2026", "bugun", "dun"
 * Returns DateTime (start of day in tz) or null
 */
function parseDateInput(str, tz) {
  const s = (str || '').trim().toLowerCase();
  const now = DateTime.now().setZone(tz);
  if (!s || s === 'bugun' || s === 'bugün') return now.startOf('day');
  if (s === 'dun' || s === 'dün') return now.minus({ days: 1 }).startOf('day');
  // try DD.MM.YYYY
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    const dt = DateTime.fromObject({ year, month, day }, { zone: tz });
    if (dt.isValid) return dt.startOf('day');
  }
  return null;
}

/**
 * Return Monday-Sunday range for the week containing dayDt.
 * Both returned DateTimes are start-of-day.
 */
function getWeekRange(dayDt) {
  // luxon weekday: 1=Monday ... 7=Sunday
  const monday = dayDt.startOf('day').minus({ days: dayDt.weekday - 1 });
  const sunday = monday.plus({ days: 6 });
  return { start: monday, end: sunday };
}

/**
 * Return first day and last day of the month containing dayDt.
 * Both returned DateTimes are start-of-day.
 */
function getMonthRange(dayDt) {
  const first = dayDt.startOf('month');
  const last = dayDt.endOf('month').startOf('day');
  return { start: first, end: last };
}

/**
 * Check if a DD.MM.YYYY date string falls within [rangeStart, rangeEnd] (inclusive).
 */
function isDateInRange(shiftDateStr, rangeStart, rangeEnd) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(shiftDateStr);
  if (!m) return false;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const dt = DateTime.fromObject({ year, month, day }, { zone: rangeStart.zone });
  if (!dt.isValid) return false;
  const d = dt.startOf('day');
  return d >= rangeStart.startOf('day') && d <= rangeEnd.startOf('day');
}

module.exports = {
  DateTime,
  pad2,
  normalizeTimeInput,
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
};
