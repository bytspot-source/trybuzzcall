// Storage layer. Two backends behind one synchronous API (callers mutate `db` and call save()):
//   - file     (default): DATA_DIR/db.json + DATA_DIR/config.json. On Render's free plan DATA_DIR is ephemeral.
//   - postgres (when DATABASE_URL is set): the same two JSON documents are kept in table buzz_kv and written
//     through from memory (debounced, serialized). Call `await store.init()` once at boot to load them.
// If DATABASE_URL is set but Postgres is unreachable at boot, we log loudly and fall back to the file backend
// so the missed-call line keeps answering (data is then only as durable as the file). The server adds an owner alert,
// and REQUIRE_POSTGRES=1 makes that fatal instead (see src/server.js initStorage).
// Opt-outs/opt-ins are written through immediately (no debounce): optOut()/optIn() return the flush promise.
const fs = require('fs');
const path = require('path');

const MAX_SETUPS = 500;
const MAX_WAITLIST = Number(process.env.MAX_WAITLIST) > 0 ? Number(process.env.MAX_WAITLIST) : 5000; // public form: bounded
const WAITLIST_TYPES = ['home_services', 'braiders', 'other']; // landing-page segments (other = any other local business)
const FLUSH_DELAY_MS = 200;
const RETRY_DELAY_MS = 5000;
const TABLE = 'buzz_kv';

const defaultDb = () => ({ leads: [], alerts: [], waitlist: [], bookings: [], billing: {}, setups: [], optOuts: {} });

function pgConfig(url) {
  const cfg = { connectionString: url, max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 };
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(host);
  const explicit = /[?&]sslmode=/.test(url);
  // Remote hosts get TLS WITH certificate verification (Neon/Render/Supabase present publicly trusted certs).
  // DATABASE_SSL=disable = no TLS; DATABASE_SSL=no-verify = TLS without verification (old behaviour, MITM-able; only
  // for a provider with a self-signed cert). An explicit sslmode=... in the URL is left to pg's own parsing.
  const mode = (process.env.DATABASE_SSL || '').toLowerCase();
  if (!local && !explicit && mode !== 'disable') cfg.ssl = { rejectUnauthorized: mode !== 'no-verify' };
  return cfg;
}
function defaultPoolFactory(url) {
  const { Pool } = require('pg');
  const pool = new Pool(pgConfig(url));
  pool.on('error', (e) => console.error('[store] postgres pool error:', e.message));
  return pool;
}

function createStore(opts = {}) {
  const DIR = opts.dir ? path.resolve(opts.dir) : path.join(__dirname, '..', 'data');
  const databaseUrl = opts.databaseUrl || '';
  const poolFactory = opts.poolFactory || defaultPoolFactory;
  fs.mkdirSync(DIR, { recursive: true });
  const FILE = path.join(DIR, 'db.json');
  // Config override (admin 'Apply to this line'): { values: { ENV_KEY: 'value' }, setupId, appliedAt }.
  // Read with priority over env by src/config.js. Kept separate from db so db stays data-only.
  const CONFIG_FILE = path.join(DIR, 'config.json');

  const db = defaultDb();
  let override = {};
  const readFileState = () => {
    try { Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
    try { override = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch {}
  };
  readFileState();

  let backend = 'file';      // 'file' | 'postgres'
  let pool = null;
  let dbDirty = false, cfgDirty = false, timer = null, flushing = null, lastError = null;

  const writeFiles = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
  const writeConfigFile = () => {
    if (Object.keys(override).length) fs.writeFileSync(CONFIG_FILE, JSON.stringify(override, null, 2));
    else fs.rmSync(CONFIG_FILE, { force: true });
  };

  async function pgWrite() {
    if (dbDirty) {
      dbDirty = false;
      try { await pool.query(`INSERT INTO ${TABLE} (key, value, updated_at) VALUES ('db', $1::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(db)]); }
      catch (e) { dbDirty = true; throw e; }
    }
    if (cfgDirty) {
      cfgDirty = false;
      try {
        if (Object.keys(override).length) await pool.query(`INSERT INTO ${TABLE} (key, value, updated_at) VALUES ('config', $1::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(override)]);
        else await pool.query(`DELETE FROM ${TABLE} WHERE key = 'config'`);
      } catch (e) { cfgDirty = true; throw e; }
    }
  }

  // Resolves when everything dirty so far is written (postgres) — no-op for the file backend.
  function flush() {
    if (backend !== 'postgres') return Promise.resolve();
    if (timer) { clearTimeout(timer); timer = null; }
    const run = async () => {
      while (dbDirty || cfgDirty) {
        try { await pgWrite(); lastError = null; }
        catch (e) {
          lastError = e.message; console.error('[store] postgres write failed, will retry:', e.message);
          timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, RETRY_DELAY_MS); timer.unref?.();
          return;
        }
      }
    };
    flushing = (flushing || Promise.resolve()).then(run).finally(() => { /* keep chain */ });
    return flushing;
  }
  function schedule() {
    if (backend !== 'postgres' || timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, FLUSH_DELAY_MS);
    timer.unref?.();
  }

  const save = () => {
    if (backend === 'postgres') { dbDirty = true; schedule(); } else writeFiles();
  };

  // Load state from Postgres (if configured). Always resolves; may be called again to retry after a failed attempt.
  async function init() {
    if (!databaseUrl || backend === 'postgres') return { backend };
    try {
      pool = poolFactory(databaseUrl);
      await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
      const { rows } = await pool.query(`SELECT key, value FROM ${TABLE} WHERE key IN ('db', 'config')`);
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      if (byKey.db) {
        for (const k of Object.keys(db)) delete db[k];
        Object.assign(db, defaultDb(), byKey.db);
      }
      if (byKey.config) override = byKey.config || {};
      backend = 'postgres';
      // First run on this database: seed it from whatever the file backend had (migration), so nothing is lost.
      if (!byKey.db) dbDirty = true;
      if (!byKey.config && Object.keys(override).length) cfgDirty = true;
      await flush();
      console.log(`[store] postgres backend ready (${byKey.db ? 'loaded existing data' : 'seeded new database'})`);
    } catch (e) {
      console.error('[store] !!! DATABASE_URL set but postgres unavailable; falling back to FILE storage in DATA_DIR (opt-outs, leads and settings are NOT durable on Render):', e.message);
      backend = 'file';
      lastError = e.message;
      try { await pool?.end(); } catch {}
      pool = null;
    }
    return { backend };
  }
  async function close() { await flush(); if (pool) { try { await pool.end(); } catch {} pool = null; } }

  return {
    db, WAITLIST_TYPES, init, flush, close, createStore,
    backend: () => backend,
    // fallback = DATABASE_URL is configured but we are running on the file backend (Postgres was unreachable at boot).
    status: () => ({ backend, lastError, configured: !!databaseUrl, fallback: !!databaseUrl && backend !== 'postgres' }),
    findOpenLead: (phone) => db.leads.find((l) => l.phone === phone && l.status !== 'done' && l.status !== 'opted_out'),
    findBooking: (id) => db.bookings.find((b) => b.id === id),
    createLead(phone) {
      const lead = { id: require('crypto').randomBytes(8).toString('hex'), phone, name: null, need: null, window: null,
        step: 'name', status: 'collecting', messages: [], createdAt: new Date().toISOString() };
      db.leads.unshift(lead); save(); return lead;
    },
    addAlert(a) { db.alerts.unshift({ ...a, at: new Date().toISOString() }); save(); },
    addWaitlist(email, businessType) {
      let entry = db.waitlist.find((w) => w.email === email);
      if (!entry) {
        if (db.waitlist.length >= MAX_WAITLIST) return false;
        entry = { email, at: new Date().toISOString() };
        db.waitlist.push(entry);
      }
      if (WAITLIST_TYPES.includes(businessType)) entry.businessType = businessType;
      save(); return true;
    },
    addSetup(s) {
      db.setups = db.setups || [];
      db.setups.unshift(s);
      if (db.setups.length > MAX_SETUPS) db.setups.length = MAX_SETUPS;
      save(); return s;
    },
    findSetup: (id) => (db.setups || []).find((s) => s.id === id),
    // SMS opt-outs (STOP keywords, plain-language revocations, Twilio 21610). Persisted; never purged by retention.
    isOptedOut: (phone) => !!(phone && db.optOuts && db.optOuts[phone]),
    // Durable now: with Postgres the write is flushed immediately (not debounced) and the returned promise resolves once
    // it is stored (or the write failed and is being retried; the failure is logged). File backend writes synchronously.
    optOut(phone, source) {
      if (!phone) return Promise.resolve();
      db.optOuts = db.optOuts || {};
      let changed = false;
      if (!db.optOuts[phone]) { db.optOuts[phone] = { at: new Date().toISOString(), source: String(source || 'unknown').slice(0, 40) }; changed = true; }
      for (const l of db.leads) if (l.phone === phone && l.status !== 'done' && l.status !== 'opted_out') { l.status = 'opted_out'; changed = true; }
      if (!changed) return Promise.resolve();
      save();
      return flush().catch(() => {});
    },
    optIn(phone) {
      if (!(db.optOuts && db.optOuts[phone])) return false;
      delete db.optOuts[phone]; save(); flush().catch(() => {});
      return true;
    },
    // Retention: drop leads (with their message threads) and owner alerts older than `days`. Bookings (payment records)
    // and opt-outs are kept. Returns counts.
    purgeOlderThan(days, now = Date.now()) {
      if (!(days > 0)) return { leads: 0, alerts: 0 };
      const cutoff = now - days * 86400000, old = (x) => Date.parse(x.createdAt || x.at || '') < cutoff;
      const before = { leads: db.leads.length, alerts: db.alerts.length };
      const keepLeads = db.leads.filter((l) => !old(l)), keepAlerts = db.alerts.filter((a) => !old(a));
      db.leads.length = 0; db.leads.push(...keepLeads); db.alerts.length = 0; db.alerts.push(...keepAlerts);
      const out = { leads: before.leads - db.leads.length, alerts: before.alerts - db.alerts.length };
      if (out.leads || out.alerts) save();
      return out;
    },
    getOverride: () => override,
    setOverride(o) {
      override = o || {};
      if (backend === 'postgres') { cfgDirty = true; schedule(); } else writeConfigFile();
    },
    save,
  };
}

const store = createStore({ dir: process.env.DATA_DIR || undefined, databaseUrl: process.env.DATABASE_URL || '' });
store.pgConfig = pgConfig;
module.exports = store;
