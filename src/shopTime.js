'use strict';
// Civil-calendar arithmetic in an explicit IANA zone. Never change process.env.TZ.
const env = require('./config').env;
const shopContext = require('./shopContext');
const formatters = new Map();
function timeZone() {
  const fallback = shopContext.current() ? 'America/New_York' : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = env.BUSINESS_TZ || fallback;
  try { formatter(zone); return zone; } catch { return fallback; }
}
function formatter(zone) {
  if (!formatters.has(zone)) {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value);
    formatters.set(zone, fmt);
  }
  return formatters.get(zone);
}
function parts(value, zone = timeZone()) {
  if (value == null) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const p = {};
  for (const { type, value: v } of formatter(zone).formatToParts(d)) if (type !== 'literal') p[type] = Number(v);
  return p;
}
const civilUTC = (p) => Date.UTC(p.year, p.month - 1, p.day, p.hour || 0, p.minute || 0, p.second || 0);
function addDays(p, count) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + count));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
const weekday = (p) => new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
const dateKey = (p) => p ? `${p.year}-${p.month}-${p.day}` : null;
const sameDay = (a, b, zone = timeZone()) => {
  const x = parts(a, zone), y = parts(b, zone);
  return !!x && !!y && dateKey(x) === dateKey(y);
};
// Convert a local date + minute-of-day to an instant. Check all nearby offsets
// rather than accepting Date's gap normalization. Gaps return null; folds choose
// the earlier occurrence deterministically (never duplicate a wall-clock slot).
function toInstant(p, minutes = 0, zone = timeZone()) {
  if (!p || !Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) return null;
  const want = { year: p.year, month: p.month, day: p.day, hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0 };
  const wall = civilUTC(want), offsets = new Set();
  if (!Number.isFinite(wall)) return null;
  for (const h of [-36, -12, 0, 12, 36]) {
    const sample = wall + h * 3600000;
    offsets.add(civilUTC(parts(sample, zone)) - sample);
  }
  const matches = [];
  for (const offset of offsets) {
    const instant = wall - offset, got = parts(instant, zone);
    if (Object.keys(want).every((k) => got[k] === want[k])) matches.push(instant);
  }
  return matches.length ? new Date(Math.min(...matches)) : null;
}
const timeLabel = (d, zone = timeZone()) => new Date(d).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
const dayLabel = (d, zone = timeZone()) => new Date(d).toLocaleDateString('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' });
module.exports = { timeZone, parts, addDays, weekday, sameDay, toInstant, timeLabel, dayLabel };
