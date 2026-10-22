// Tiny JSON-file store (no native deps). Fine for a pilot; swap for SQLite/Postgres later.
const fs = require('fs');
const path = require('path');
const DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, 'db.json');
let db = { leads: [], alerts: [], waitlist: [], bookings: [], billing: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 2));

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
