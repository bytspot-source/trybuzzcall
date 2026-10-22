// Tiny JSON-file store (no native deps). Fine for a pilot; swap for SQLite/Postgres later.
const fs = require('fs');
const path = require('path');
const DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, 'db.json');
const defaults = { leads: [], alerts: [], waitlist: [], bookings: [], billing: {}, smsPermissions: [] };
let contents;
try {
  contents = fs.readFileSync(FILE, 'utf8');
} catch (error) {
  // Only a genuinely absent database is new. Never overwrite an unreadable database.
  if (error.code !== 'ENOENT') throw new Error('Unable to read database');
}
let loaded = {};
if (contents !== undefined) {
  try { loaded = JSON.parse(contents); }
  catch { throw new Error('Invalid database JSON'); }
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new Error('Invalid database structure');
  }
  for (const key of ['leads', 'alerts', 'waitlist', 'bookings', 'smsPermissions']) {
    if (Object.hasOwn(loaded, key) && !Array.isArray(loaded[key])) {
      throw new Error(`Invalid database collection: ${key}`);
    }
  }
  if (Object.hasOwn(loaded, 'billing') &&
      (!loaded.billing || typeof loaded.billing !== 'object' || Array.isArray(loaded.billing))) {
    throw new Error('Invalid database billing state');
  }
}
const db = { ...defaults, ...loaded };
let sequence = 0;
// A candidate can be persisted before its caller publishes it in db. Existing save() callers
// remain compatible. Atomic replacement is for this single-process store, not multi-writer use.
function save(candidate = db) {
  const serialized = JSON.stringify(candidate, null, 2);
  const temporary = path.join(DIR, `.db-${process.pid}-${++sequence}.tmp`);
  let created = false;
  try {
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    created = true;
    fs.renameSync(temporary, FILE);
  } catch {
    // Only remove the exact temporary file created by this save operation.
    if (created) { try { fs.unlinkSync(temporary); } catch {} }
    throw new Error('Unable to persist database');
  }
}

module.exports = {
  db,
  findOpenLead: (phone) => db.leads.find((l) => l.phone === phone && l.status !== 'done'),
  findBooking: (id) => db.bookings.find((b) => b.id === id),
  createLead(phone) {
    const lead = { id: Date.now().toString(36), phone, name: null, need: null, window: null,
      step: 'name', status: 'collecting', messages: [], createdAt: new Date().toISOString() };
    db.leads.unshift(lead); save(); return lead;
  },
  addAlert(a) { db.alerts.unshift({ ...a, at: new Date().toISOString() }); save(); },
  addWaitlist(email, businessType) {
    let entry = db.waitlist.find((w) => w.email === email);
    if (!entry) {
      entry = { email, at: new Date().toISOString() };
      db.waitlist.push(entry);
    }
    if (businessType === 'home_services' || businessType === 'braiders') entry.businessType = businessType;
    save();
  },
  save,
};
