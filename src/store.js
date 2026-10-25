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

// ---- DATA_DIR / SPILL_DIR validation (T1) ----
// These folders hold full phone numbers (db.json, sms.log, the opt-out spill file). Rules:
//   - production: the path must be absolute (a relative path would resolve against whatever the working directory is);
//   - never inside public/ (express.static would serve the files on the web) and never elsewhere inside the app
//     folder, except the default data/ folder (git-ignored and not served);
//   - folders we create are 0700 and files 0600; an existing group- or world-writable folder gets a loud warning.
// A refused value does not crash the server: we log a loud warning and use the safe default (DATA_DIR -> <app>/data,
// SPILL_DIR -> DATA_DIR) so the missed-call line keeps answering. status().pathWarnings shows it on admin /health.
const APP_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(APP_ROOT, 'data');
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const within = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
// realpath of the deepest existing ancestor + the rest, so a symlink can't smuggle the folder into public/.
function realish(p) {
  let cur = p; const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch {}
    const up = path.dirname(cur); if (up === cur) return p;
    rest.unshift(path.basename(cur)); cur = up;
  }
}
function checkDir(raw, name) {
  if (raw == null || String(raw).trim() === '') return { dir: null };
  const s = String(raw).trim();
  if (require('./security').isProduction() && !path.isAbsolute(s)) return { problem: `${name} must be an absolute path in production (got a relative path)` };
  const dir = path.resolve(s), real = realish(dir), root = realish(APP_ROOT);
  if (within(dir, PUBLIC_DIR) || within(real, realish(PUBLIC_DIR))) return { problem: `${name} is inside public/ (files there are served on the web)` };
  if ((within(dir, APP_ROOT) && !within(dir, DEFAULT_DATA_DIR)) || (within(real, root) && !within(real, realish(DEFAULT_DATA_DIR)))) return { problem: `${name} is inside the app folder` };
  return { dir };
}
function ensureDir(dir, name, warnings) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const m = fs.statSync(dir).mode & 0o777;
    if (m & 0o022) {
      const w = `${name} folder is group- or world-writable (mode ${m.toString(8).padStart(4, '0')}); use a folder only this app's user can write (chmod 700)`;
      warnings.push(w); console.error(`[store] WARNING: ${w}: ${dir}`);
    }
  } catch {}
}
const FILE_MODE = { mode: 0o600 };

function createStore(opts = {}) {
  const pathWarnings = [];
  const refuse = (problem, fallbackLabel) => {
    pathWarnings.push(`${problem}; using ${fallbackLabel}`);
    console.error(`[store] !!!!!!!!!! WARNING: ${problem}. Ignoring it and using ${fallbackLabel} instead.`);
  };
  const dataCheck = checkDir(opts.dir, 'DATA_DIR');
  if (dataCheck.problem) refuse(dataCheck.problem, `the default ${DEFAULT_DATA_DIR}`);
  const DIR = dataCheck.dir || DEFAULT_DATA_DIR;
  const databaseUrl = opts.databaseUrl || '';
  const poolFactory = opts.poolFactory || defaultPoolFactory;
  ensureDir(DIR, 'DATA_DIR', pathWarnings);
  // Tighten files created by older versions (0644 under the default umask) to owner-only.
  for (const f of ['db.json', 'config.json', 'sms.log', 'optout-spill.jsonl']) { try { const fp = path.join(DIR, f); if (fs.statSync(fp).mode & 0o077) fs.chmodSync(fp, 0o600); } catch {} }
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
  // Runtime write failures (Postgres reachable at boot, then failing): opt-outs are also appended to a local
  // spill file (DATA_DIR/optout-spill.jsonl) and merged at the next successful boot. Opt-ins (START) are NOT spilled
  // and opt-in lines are ignored at merge: the spill file can only ever ADD opt-outs, so a planted or stale line can't
  // silently re-enable texting to someone who said STOP. An opt-in during an outage still applies in memory and is
  // written to Postgres when it recovers; only if the server restarts mid-outage does the caller need to text START again. The owner is alerted once per
  // outage (on the first spill, or when writes keep failing for STORAGE_ALERT_MINUTES, default 5).
  // SPILL_DIR: put the spill file on a persistent disk (e.g. a Render disk mounted at /var/data); default DATA_DIR.
  const spillCheck = checkDir(opts.spillDir || process.env.SPILL_DIR, 'SPILL_DIR');
  if (spillCheck.problem) refuse(spillCheck.problem, 'DATA_DIR');
  const SPILL_DIR = spillCheck.dir || DIR;
  if (SPILL_DIR !== DIR) { try { ensureDir(SPILL_DIR, 'SPILL_DIR', pathWarnings); } catch (e) { console.error('[store] could not create SPILL_DIR:', e.message); } }
  const SPILL = path.join(SPILL_DIR, 'optout-spill.jsonl');
  const { maskPhone } = require('./security');
  let spilledThisOutage = []; // masked numbers opted out while Postgres writes were failing (for the owner alert)
  let failSince = null, degradedAlerted = false, onDegraded = null;
  const alertMs = () => { const m = Number(process.env.STORAGE_ALERT_MINUTES); return (Number.isFinite(m) && m >= 0 ? m : 5) * 60000; };
  const redact = (m) => (m == null ? m : String(m).replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://[redacted]').slice(0, 200));
  // First call per outage: the outage alert (with any masked opted-out numbers so far). Each later opt-out during the
  // same outage sends a short follow-up with its masked number (max 20 per outage), so the owner has an out-of-band
  // record even if this instance's disk is lost.
  function degradedAlert(reason, maskedNumber) {
    if (!onDegraded) return;
    if (degradedAlerted && !maskedNumber) return;
    if (degradedAlerted && spilledThisOutage.length > 20) return;
    const payload = { reason: degradedAlerted ? 'spill_more' : reason, since: failSince ? new Date(failSince).toISOString() : null, error: redact(lastError),
      optedOut: degradedAlerted ? [maskedNumber] : spilledThisOutage.slice() };
    degradedAlerted = true;
    Promise.resolve().then(() => onDegraded(payload)).catch(() => {});
  }
  function spill(entry) {
    if (entry.op !== 'out') { console.error('[store] postgres write failing: opt-in kept in memory only (written when the database recovers; not spilled)'); degradedAlert('spill'); return; }
    try {
      fs.appendFileSync(SPILL, JSON.stringify(entry) + '\n', FILE_MODE);
      try { fs.chmodSync(SPILL, 0o600); } catch {}
      console.error(`[store] postgres write failing: opt-out also saved to ${SPILL}`);
    } catch (e) { console.error('[store] spill write failed:', e.message); }
    const m = maskPhone(entry.phone); spilledThisOutage.push(m); degradedAlert('spill', m);
  }
  const spillCount = () => { try { return fs.readFileSync(SPILL, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  // Apply spilled opt-out records to db (opt-in lines are ignored, see above). Returns the number applied.
  function mergeSpill() {
    let lines = [];
    try { lines = fs.readFileSync(SPILL, 'utf8').split('\n').filter(Boolean); } catch { return 0; }
    db.optOuts = db.optOuts || {};
    let n = 0;
    for (const l of lines) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (!e || typeof e.phone !== 'string' || !/^\+\d{8,15}$/.test(e.phone)) continue;
      if (e.op === 'out' && !db.optOuts[e.phone]) { db.optOuts[e.phone] = { at: e.at || new Date().toISOString(), source: String(e.source || 'spill').slice(0, 40) }; n++; }
    }
    return n;
  }
  const clearSpill = () => { try { fs.rmSync(SPILL, { force: true }); } catch {} };

  const writeFiles = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 2), FILE_MODE);
  const writeConfigFile = () => {
    if (Object.keys(override).length) fs.writeFileSync(CONFIG_FILE, JSON.stringify(override, null, 2), FILE_MODE);
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
            failSince = null; degradedAlerted = false; spilledThisOutage = []; clearSpill(); // everything (incl. spilled opt-outs) is now in Postgres
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
      degraded: backend === 'postgres' && !!failSince, failingSince: failSince ? new Date(failSince).toISOString() : null, spillPending: spillCount(),
      spillDir: SPILL_DIR === DIR ? 'DATA_DIR' : 'SPILL_DIR', pathWarnings: pathWarnings.slice() }),
    dataDir: () => DIR,
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
store.checkDir = checkDir; // exported for tests
module.exports = store;
