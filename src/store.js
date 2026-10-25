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
  // Runtime write failures (Postgres reachable at boot, then failing): opt-outs/opt-ins are also appended to a local
  // spill file (DATA_DIR/optout-spill.jsonl) and merged at the next successful boot. The owner is alerted once per
  // outage (on the first spill, or when writes keep failing for STORAGE_ALERT_MINUTES, default 5).
  const SPILL = path.join(DIR, 'optout-spill.jsonl');
  let failSince = null, degradedAlerted = false, onDegraded = null;
  const alertMs = () => { const m = Number(process.env.STORAGE_ALERT_MINUTES); return (Number.isFinite(m) && m >= 0 ? m : 5) * 60000; };
  const redact = (m) => (m == null ? m : String(m).replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://[redacted]').slice(0, 200));
  function degradedAlert(reason) {
    if (degradedAlerted || !onDegraded) return;
    degradedAlerted = true;
    Promise.resolve().then(() => onDegraded({ reason, since: failSince ? new Date(failSince).toISOString() : null, error: redact(lastError) })).catch(() => {});
  }
  function spill(entry) {
    try { fs.appendFileSync(SPILL, JSON.stringify(entry) + '\n'); console.error(`[store] postgres write failing: ${entry.op === 'out' ? 'opt-out' : 'opt-in'} also saved to ${path.basename(SPILL)}`); }
    catch (e) { console.error('[store] spill write failed:', e.message); }
    degradedAlert('spill');
  }
  const spillCount = () => { try { return fs.readFileSync(SPILL, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  // Apply spilled records (in order) to db. Returns the number applied.
  function mergeSpill() {
    let lines = [];
    try { lines = fs.readFileSync(SPILL, 'utf8').split('\n').filter(Boolean); } catch { return 0; }
    db.optOuts = db.optOuts || {};
    let n = 0;
    for (const l of lines) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (!e || typeof e.phone !== 'string') continue;
      if (e.op === 'out' && !db.optOuts[e.phone]) { db.optOuts[e.phone] = { at: e.at || new Date().toISOString(), source: String(e.source || 'spill').slice(0, 40) }; n++; }
      if (e.op === 'in' && db.optOuts[e.phone] && Date.parse(e.at) >= Date.parse(db.optOuts[e.phone].at || 0)) { delete db.optOuts[e.phone]; n++; }
    }
    return n;
  }
  const clearSpill = () => { try { fs.rmSync(SPILL, { force: true }); } catch {} };

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
        try {
          await pgWrite(); lastError = null;
          if (!dbDirty && !cfgDirty && (failSince || fs.existsSync(SPILL))) {
            if (failSince) console.log(`[store] postgres writes recovered after ${Math.round((Date.now() - failSince) / 1000)}s`);
            failSince = null; degradedAlerted = false; clearSpill(); // everything (incl. spilled opt-outs) is now in Postgres
          }
        } catch (e) {
          lastError = e.message; console.error('[store] postgres write failed, will retry:', redact(e.message));
          failSince = failSince || Date.now();
          if (Date.now() - failSince >= alertMs()) degradedAlert('writes_failing');
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
    if (!databaseUrl) { if (mergeSpill()) writeFiles(); clearSpill(); return { backend }; } // file backend: db.json now has them
    if (backend === 'postgres') return { backend };
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
      const merged = mergeSpill();
      if (merged) { dbDirty = true; console.error(`[store] merged ${merged} opt-out record(s) from ${path.basename(SPILL)} (saved during a postgres outage)`); }
      await flush();
      console.log(`[store] postgres backend ready (${byKey.db ? 'loaded existing data' : 'seeded new database'})`);
    } catch (e) {
      console.error('[store] DATABASE_URL set but postgres unavailable (the server decides: fail closed in production, file storage otherwise):', redact(e.message));
      backend = 'file';
      lastError = e.message;
      if (mergeSpill()) writeFiles(); // honour spilled opt-outs; the spill file is kept until Postgres has them
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
    // degraded = Postgres backend but writes are currently failing (data since then lives in memory + the spill file).
    status: () => ({ backend, lastError: redact(lastError), configured: !!databaseUrl, fallback: !!databaseUrl && backend !== 'postgres',
      degraded: backend === 'postgres' && !!failSince, failingSince: failSince ? new Date(failSince).toISOString() : null, spillPending: spillCount() }),
    setDegradedAlert(fn) { onDegraded = fn || null; },
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
      const entry = { op: 'out', phone, at: db.optOuts[phone].at, source: db.optOuts[phone].source };
      return flush().catch(() => {}).then(() => { if (backend === 'postgres' && failSince) spill(entry); });
    },
    optIn(phone) {
      if (!(db.optOuts && db.optOuts[phone])) return false;
      delete db.optOuts[phone]; save();
      const entry = { op: 'in', phone, at: new Date().toISOString() };
      flush().catch(() => {}).then(() => { if (backend === 'postgres' && failSince) spill(entry); });
      return true;
    },
    // Bot pause: a possible (ambiguous) opt-out stops automated texts to that number for BOT_PAUSE_HOURS (default 72)
    // so the owner can check by hand. START/UNSTOP or the expiry lifts it. Never purged early by retention.
    pauseBot(phone, text) {
      if (!phone) return;
      db.botPaused = db.botPaused || {};
      db.botPaused[phone] = { at: new Date().toISOString(), text: String(text || '').slice(0, 80) };
      save();
    },
    isPaused(phone, now = Date.now()) {
      const p = phone && db.botPaused && db.botPaused[phone];
      if (!p) return false;
      const hours = Number(process.env.BOT_PAUSE_HOURS);
      const ms = (Number.isFinite(hours) && hours >= 0 ? hours : 72) * 3600000;
      if (now - Date.parse(p.at) < ms) return true;
      delete db.botPaused[phone]; save();
      return false;
    },
    resumeBot(phone) { if (db.botPaused && db.botPaused[phone]) { delete db.botPaused[phone]; save(); return true; } return false; },
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
