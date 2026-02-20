'use strict';

const { parseHHMM } = require('./time-utils');

const SHIFT_OPTIONS = {
  morning: [
    { start: { hour: 8, minute: 0 }, end: { hour: 16, minute: 0 }, label: '08:00-16:00' },
    { start: { hour: 10, minute: 0 }, end: { hour: 18, minute: 0 }, label: '10:00-18:00' }
  ],
  evening: [
    { start: { hour: 16, minute: 0 }, end: { hour: 0, minute: 0 }, label: '16:00-00:00' },
    { start: { hour: 18, minute: 0 }, end: { hour: 2, minute: 0 }, label: '18:00-02:00' },
    { start: { hour: 20, minute: 0 }, end: { hour: 4, minute: 0 }, label: '20:00-04:00' }
  ],
  night: [
    { start: { hour: 0, minute: 0 }, end: { hour: 8, minute: 0 }, label: '00:00-08:00' }
  ]
};

function normalizeNickname(name) {
  return String(name || '')
    .replace(/–|—/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses shift time range from nickname and matches it to allowed schedules.
 * @returns {{poolKey: 'morning'|'evening'|'night', schedule: {start:{hour:number,minute:number}, end:{hour:number,minute:number}, label:string}} | null}
 */
function detectShiftFromNickname(nickname) {
  const s = normalizeNickname(nickname);
  const m = /(\d{1,2}[.:]\d{2})\s*-\s*(\d{1,2}[.:]\d{2})/.exec(s);
  if (!m) return null;
  const start = parseHHMM(m[1]);
  const end = parseHHMM(m[2]);
  if (!start || !end) return null;

  for (const [poolKey, options] of Object.entries(SHIFT_OPTIONS)) {
    for (const opt of options) {
      if (opt.start.hour === start.hour && opt.start.minute === start.minute && opt.end.hour === end.hour && opt.end.minute === end.minute) {
        return { poolKey: /** @type any */ (poolKey), schedule: opt };
      }
    }
  }
  return null;
}

function getShiftExamplesText() {
  const parts = [];
  parts.push('Sabah: 08.00 - 16.00 | 10.00 - 18.00');
  parts.push('Akşam: 16.00 - 00.00 | 18.00 - 02.00 | 20.00 - 04.00');
  parts.push('Gece: 00.00 - 08.00');
  return parts.join('\n');
}

module.exports = {
  SHIFT_OPTIONS,
  detectShiftFromNickname,
  getShiftExamplesText
};
