// Tiny JSON-file store (no native deps). Fine for a pilot; swap for SQLite/Postgres later.
const fs = require('fs');
const path = require('path');
const DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, 'db.json');
let db = { leads: [], alerts: [], waitlist: [], bookings: [], billing: {}, setups: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
// Config override (admin 'Apply to this line'): { values: { ENV_KEY: 'value' }, setupId, appliedAt }.
// Read with priority over env by src/config.js. Kept in its own file so db.json stays data-only.
const CONFIG_FILE = path.join(DIR, 'config.json');
let override = {};
try { override = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch {}
const MAX_SETUPS = 500;
const WAITLIST_TYPES = ['home_services', 'braiders', 'other']; // landing-page segments (other = any other local business)

module.exports = {
  db, WAITLIST_TYPES,
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
    if (WAITLIST_TYPES.includes(businessType)) entry.businessType = businessType;
    save();
  },
  addSetup(s) {
    db.setups = db.setups || [];
    db.setups.unshift(s);
    if (db.setups.length > MAX_SETUPS) db.setups.length = MAX_SETUPS;
    save(); return s;
  },
  findSetup: (id) => (db.setups || []).find((s) => s.id === id),
  getOverride: () => override,
  setOverride(o) {
    override = o || {};
    if (Object.keys(override).length) fs.writeFileSync(CONFIG_FILE, JSON.stringify(override, null, 2));
    else fs.rmSync(CONFIG_FILE, { force: true });
  },
  save,
};
