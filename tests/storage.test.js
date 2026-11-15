'use strict';
// Storage layer: file fallback (no DATABASE_URL / unreachable Postgres) and Postgres write-through + reload
// (SQL executed against pg-mem, an in-process Postgres emulator; set TEST_DATABASE_URL to also run against a real one).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { newDb } = require('pg-mem');
const { createStore } = require('../src/store');

const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-storage-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const memPg = () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  // pg-mem chokes on re-running CREATE TABLE IF NOT EXISTS for an existing table (real Postgres is fine); skip it then.
  const poolFactory = () => {
    const p = new Pool(); const q = p.query.bind(p);
    p.query = (sql, ...a) => {
      if (/^CREATE TABLE IF NOT EXISTS/.test(sql)) { try { mem.public.getTable('buzz_kv'); return Promise.resolve({ rows: [] }); } catch {} }
      return q(sql, ...a);
    };
    return p;
  };
  return { mem, poolFactory };
};
const quiet = (t) => { const o = console.error, l = console.log; console.error = () => {}; console.log = () => {}; t.after(() => { console.error = o; console.log = l; }); };

test('no DATABASE_URL: file backend, survives a "restart" (new store on same dir)', async (t) => {
  const dir = tmp(t);
  const a = createStore({ dir });
  assert.equal((await a.init()).backend, 'file');
  a.createLead('+15550001');
  a.addWaitlist('x@example.com', 'braiders');
  a.setOverride({ values: { BUSINESS_NAME: 'Persisted Shop' }, setupId: 's1' });
  assert.ok(fs.existsSync(path.join(dir, 'db.json')));
  assert.ok(fs.existsSync(path.join(dir, 'config.json')));
  const b = createStore({ dir });
  await b.init();
  assert.equal(b.db.leads[0].phone, '+15550001');
  assert.equal(b.db.waitlist[0].businessType, 'braiders');
  assert.equal(b.getOverride().values.BUSINESS_NAME, 'Persisted Shop');
  b.setOverride({});
  assert.ok(!fs.existsSync(path.join(dir, 'config.json')));
});

test('postgres: first boot seeds from files, then data + override survive a restart with an EMPTY data dir', async (t) => {
  quiet(t);
  const { mem, poolFactory } = memPg();
  const dir1 = tmp(t);
  // Pre-existing file data (pre-migration) must be seeded into the new database.
  fs.writeFileSync(path.join(dir1, 'db.json'), JSON.stringify({ leads: [{ id: 'old', phone: '+15559999', messages: [] }] }));
  const a = createStore({ dir: dir1, databaseUrl: 'postgres://u:p@db.example/x', poolFactory });
  assert.equal((await a.init()).backend, 'postgres');
  assert.equal(a.backend(), 'postgres');
  a.addSetup({ id: 'setup1', status: 'pending', businessName: 'Crown Braids' });
  a.setOverride({ values: { BUSINESS_NAME: 'Crown Braids', BUSINESS_TZ: 'America/Chicago' }, setupId: 'setup1' });
  await a.flush();
  const stored = Object.fromEntries((await mem.public.many('SELECT key, value FROM buzz_kv')).map((r) => [r.key, r.value]));
  assert.equal(stored.db.setups[0].id, 'setup1');
  assert.equal(stored.db.leads[0].id, 'old');
  assert.equal(stored.config.values.BUSINESS_NAME, 'Crown Braids');
  // Postgres mode does not write the (ephemeral) files.
  assert.ok(!fs.existsSync(path.join(dir1, 'config.json')));

  // "Restart": brand-new process state, fresh empty data dir, same database.
  const dir2 = tmp(t);
  const b = createStore({ dir: dir2, databaseUrl: 'postgres://u:p@db.example/x', poolFactory });
  await b.init();
  assert.equal(b.findSetup('setup1').businessName, 'Crown Braids');
  assert.equal(b.db.leads[0].id, 'old');
  assert.equal(b.getOverride().values.BUSINESS_TZ, 'America/Chicago');
  // Defaults for collections missing in older stored docs are filled in.
  assert.deepEqual(b.db.bookings, []);

  // Mutations through the shared `db` reference + save() are persisted (debounced write-through).
  b.db.setups[0].status = 'applied'; b.save();
  await b.flush();
  const c = createStore({ dir: tmp(t), databaseUrl: 'postgres://u:p@db.example/x', poolFactory });
  await c.init();
  assert.equal(c.findSetup('setup1').status, 'applied');

  // Clearing the override removes the config row.
  c.setOverride({}); await c.flush();
  const d = createStore({ dir: tmp(t), databaseUrl: 'postgres://u:p@db.example/x', poolFactory });
  await d.init();
  assert.deepEqual(d.getOverride(), {});
  const keys = (await mem.public.many('SELECT key FROM buzz_kv')).map((r) => r.key);
  assert.deepEqual(keys, ['db']);
  await Promise.all([a, b, c, d].map((s) => s.close()));
});

test('postgres: rapid saves are coalesced and the last state wins', async (t) => {
  quiet(t);
  const { mem, poolFactory } = memPg();
  const s = createStore({ dir: tmp(t), databaseUrl: 'postgres://u:p@db.example/x', poolFactory });
  await s.init();
  for (let i = 0; i < 25; i++) s.createLead(`+1555000${i}`);
  await s.flush();
  const [{ value }] = await mem.public.many("SELECT value FROM buzz_kv WHERE key = 'db'");
  assert.equal(value.leads.length, 25);
  await s.close();
});

test('postgres: a failed write is retried with the latest state (nothing dropped)', async (t) => {
  quiet(t);
  const { mem, poolFactory } = memPg();
  let fail = false;
  const flaky = () => {
    const p = poolFactory(); const q = p.query.bind(p);
    p.query = (...a) => (fail && /INSERT INTO buzz_kv/.test(a[0]) ? Promise.reject(new Error('connection reset')) : q(...a));
    return p;
  };
  const s = createStore({ dir: tmp(t), databaseUrl: 'postgres://u:p@db.example/x', poolFactory: flaky });
  await s.init();
  fail = true;
  s.createLead('+15550100');
  await s.flush();
  assert.match(s.status().lastError, /connection reset/);
  fail = false;
  s.createLead('+15550101'); // next save/flush writes the full latest state
  await s.flush();
  assert.equal(s.status().lastError, null);
  const [{ value }] = await mem.public.many("SELECT value FROM buzz_kv WHERE key = 'db'");
  assert.deepEqual(value.leads.map((l) => l.phone).sort(), ['+15550100', '+15550101']);
  await s.close();
});

test('postgres unreachable at boot: falls back to file storage and keeps working', async (t) => {
  quiet(t);
  const dir = tmp(t);
  const bad = () => ({ query: () => Promise.reject(new Error('ECONNREFUSED')), end: async () => {}, on() {} });
  const s = createStore({ dir, databaseUrl: 'postgres://u:p@127.0.0.1:1/x', poolFactory: bad });
  assert.equal((await s.init()).backend, 'file');
  assert.match(s.status().lastError, /ECONNREFUSED/);
  s.createLead('+15550200');
  s.setOverride({ values: { BUSINESS_NAME: 'Fallback' } });
  const again = createStore({ dir });
  assert.equal(again.db.leads[0].phone, '+15550200');
  assert.equal(again.getOverride().values.BUSINESS_NAME, 'Fallback');
});

// ---------- corrupt local files are never overwritten; writes are atomic ----------
const corruptCopies = (dir, base = 'db.json') => fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.corrupt-`));
test('corrupt db.json: refuses to load, original left as is, one 0600 copy kept, opt-outs not erased', async (t) => {
  quiet(t);
  const dir = tmp(t), file = path.join(dir, 'db.json');
  const good = createStore({ dir });
  await good.optOut('+14045550123', 'keyword');
  const truncated = fs.readFileSync(file, 'utf8').slice(0, 40);
  fs.writeFileSync(file, truncated);
  for (let i = 0; i < 2; i++) assert.throws(() => createStore({ dir }), (e) => e.code === 'STORE_CORRUPT' && /invalid JSON/.test(e.message));
  assert.equal(fs.readFileSync(file, 'utf8'), truncated, 'never overwritten');
  const copies = corruptCopies(dir);
  assert.equal(copies.length, 1, 'one copy per distinct content, even after repeated attempts');
  assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), truncated);
  assert.equal(fs.statSync(path.join(dir, copies[0])).mode & 0o777, 0o600);
  // Wrong shapes are refused too (they would drop data on the next save).
  for (const [doc, why] of [['[]', /not a JSON object/], ['null', /not a JSON object/], ['{"optOuts":[]}', /optOuts is not an object/], ['{"leads":{}}', /leads is not a list/]]) {
    fs.writeFileSync(file, doc);
    assert.throws(() => createStore({ dir }), (e) => e.code === 'STORE_CORRUPT' && why.test(e.message), doc);
    assert.equal(fs.readFileSync(file, 'utf8'), doc);
  }
  assert.equal(corruptCopies(dir).length, 5);
  // Repairing the file (here: restoring the good data) brings the opt-out back.
  fs.writeFileSync(file, JSON.stringify({ optOuts: { '+14045550123': { at: 'x', source: 'keyword' } } }));
  assert.equal(createStore({ dir }).isOptedOut('+14045550123'), true);
});

test('corrupt or unreadable config.json and an unreadable db.json are refused too; a missing file is a fresh start', (t) => {
  quiet(t);
  const dir = tmp(t);
  assert.deepEqual(createStore({ dir }).db.leads, [], 'ENOENT: fresh start');
  fs.writeFileSync(path.join(dir, 'config.json'), '{"values":');
  assert.throws(() => createStore({ dir }), (e) => e.code === 'STORE_CORRUPT' && /config\.json/.test(e.message));
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{"values":');
  assert.equal(corruptCopies(dir, 'config.json').length, 1);
  const dir2 = tmp(t);
  fs.mkdirSync(path.join(dir2, 'db.json')); // EISDIR: unreadable
  assert.throws(() => createStore({ dir: dir2 }), (e) => e.code === 'STORE_CORRUPT' && /EISDIR/.test(e.message));
  assert.ok(fs.statSync(path.join(dir2, 'db.json')).isDirectory());
});

test('atomic file writes: 0600, no temp files left, a failed rename keeps the old file and removes only its own temp', (t) => {
  const dir = tmp(t), file = path.join(dir, 'db.json');
  const s = createStore({ dir });
  for (let i = 0; i < 5; i++) s.createLead(`+1555000${i}`);
  s.setOverride({ values: { BUSINESS_NAME: 'Atomic Shop' } });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'db.json']);
  for (const f of ['config.json', 'db.json']) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
  const before = fs.readFileSync(file, 'utf8');
  const foreign = path.join(dir, '.db.json.other.tmp');
  fs.writeFileSync(foreign, 'not ours');
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' }); });
  assert.throws(() => s.createLead('+15550099'), /simulated rename failure/);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the previous file is intact');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.db.json.other.tmp', 'config.json', 'db.json'], 'only our own temp file was removed');
  s.save();
  assert.equal(createStore({ dir }).db.leads.length, 6);
});

test('postgres: an invalid stored document is refused and never overwritten', async (t) => {
  quiet(t);
  for (const [key, value] of [['db', '[]'], ['db', 'null'], ['db', '{"optOuts":"x"}'], ['config', '"oops"']]) {
    const { mem, poolFactory } = memPg();
    mem.public.none(`CREATE TABLE buzz_kv (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    mem.public.none(`INSERT INTO buzz_kv (key, value) VALUES ('${key}', '${value}'::jsonb)`);
    const dir = tmp(t);
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ leads: [{ id: 'local', phone: '+15550300', messages: [] }] }));
    const s = createStore({ dir, databaseUrl: 'postgres://u:p@db.example/x', poolFactory });
    await assert.rejects(s.init(), (e) => e.code === 'STORE_CORRUPT' && new RegExp(`Postgres document ${key}`).test(e.message), `${key}=${value}`);
    const rows = mem.public.many('SELECT key, value FROM buzz_kv');
    assert.deepEqual(rows.map((r) => [r.key, JSON.stringify(r.value)]), [[key, JSON.stringify(JSON.parse(value))]], 'nothing written');
    assert.notEqual(s.backend(), 'postgres');
  }
});

test('postgres: a corrupt local file is ignored when Postgres has the data, refused when it would be needed', async (t) => {
  quiet(t);
  const corruptDir = (t2) => { const d = tmp(t2); fs.writeFileSync(path.join(d, 'db.json'), '{"optOuts":'); return d; };
  const url = 'postgres://u:p@db.example/x';
  // Postgres has the db document: boot normally, leave the local file alone.
  const { poolFactory } = memPg();
  const seed = createStore({ dir: tmp(t), databaseUrl: url, poolFactory });
  await seed.init(); await seed.optOut('+14045550124', 'keyword'); await seed.close();
  const dir = corruptDir(t);
  const s = createStore({ dir, databaseUrl: url, poolFactory });
  assert.equal((await s.init()).backend, 'postgres');
  assert.equal(s.isOptedOut('+14045550124'), true);
  assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), '{"optOuts":');
  await s.close();
  // Empty database: seeding from an unreadable file is refused (nothing written).
  const fresh = memPg();
  const s2 = createStore({ dir: corruptDir(t), databaseUrl: url, poolFactory: fresh.poolFactory });
  await assert.rejects(s2.init(), (e) => e.code === 'STORE_CORRUPT');
  assert.equal(fresh.mem.public.many('SELECT key FROM buzz_kv').length, 0);
  // Postgres unreachable: no fallback onto the corrupt file, and it is not overwritten.
  const d3 = corruptDir(t);
  const bad = () => ({ query: () => Promise.reject(new Error('ECONNREFUSED')), end: async () => {}, on() {} });
  const s3 = createStore({ dir: d3, databaseUrl: url, poolFactory: bad });
  await assert.rejects(s3.init(), (e) => e.code === 'STORE_CORRUPT');
  assert.throws(() => s3.save(), (e) => e.code === 'STORE_CORRUPT', 'file writes are refused');
  assert.equal(fs.readFileSync(path.join(d3, 'db.json'), 'utf8'), '{"optOuts":');
});

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test('server boots on file storage with no DATABASE_URL, and with an unreachable DATABASE_URL', { timeout: 30000 }, async (t) => {
  for (const databaseUrl of ['', 'postgres://u:p@127.0.0.1:1/nope']) {
    await t.test(databaseUrl ? 'unreachable DATABASE_URL' : 'no DATABASE_URL', async (t2) => {
      const dir = tmp(t2);
      const port = await freePort();
      const child = spawn(process.execPath, [path.resolve(__dirname, '../src/server.js')], {
        cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
        env: { NODE_ENV: 'test', PORT: String(port), DATA_DIR: dir, DATABASE_URL: databaseUrl, STRIPE_SECRET_KEY: '', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_PHONE_NUMBER: '', OPENAI_API_KEY: '' },
      });
      let out = '';
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server did not start\n' + out)), 15000);
        const cap = (c) => { out += c; if (out.includes(`missedcall-buzz on :${port} (`)) { clearTimeout(timer); resolve(); } };
        child.stdout.on('data', cap); child.stderr.on('data', cap);
      });
      t2.after(async () => { child.kill('SIGTERM'); await new Promise((r) => (child.exitCode !== null || child.signalCode ? r() : child.once('close', r))); });
      const h = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(h.status, 200);
      const hj = await h.json();
      // no DATABASE_URL in dev = file storage = ok; unreachable DATABASE_URL = file fallback = degraded
      assert.equal(hj.storageState, databaseUrl ? 'degraded' : 'ok'); assert.equal('storage' in hj, false, 'storage backend is admin-only (T3)');
      for (const p of ['/', '/setup']) assert.equal((await fetch(`http://127.0.0.1:${port}${p}`)).status, 200);
    });
  }
});

test('server refuses to start on a corrupt db.json and leaves it in place', { timeout: 30000 }, async (t) => {
  const dir = tmp(t), file = path.join(dir, 'db.json');
  fs.writeFileSync(file, '{"optOuts":{"+14045550125":');
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve(__dirname, '../src/server.js')], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port), DATA_DIR: dir, DATABASE_URL: '', DOTENV_CONFIG_PATH: '/nonexistent' },
  });
  t.after(() => child.kill('SIGKILL'));
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  const code = await Promise.race([new Promise((r) => child.on('exit', r)), new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
  assert.notEqual(code, 0, out);
  assert.notEqual(code, 'timeout', out);
  assert.doesNotMatch(out, /missedcall-buzz on :/);
  assert.match(out, /db\.json is unreadable or invalid \(invalid JSON\); refusing to load or overwrite it/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"optOuts":{"+14045550125":');
  assert.equal(corruptCopies(dir).length, 1);
});

test('real Postgres round trip (only when TEST_DATABASE_URL is set)', { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  quiet(t);
  const url = process.env.TEST_DATABASE_URL;
  const a = createStore({ dir: tmp(t), databaseUrl: url });
  await a.init();
  assert.equal(a.backend(), 'postgres');
  const id = `t${Date.now()}`;
  a.addSetup({ id, status: 'pending' }); a.setOverride({ values: { BUSINESS_NAME: id } });
  await a.flush();
  const b = createStore({ dir: tmp(t), databaseUrl: url });
  await b.init();
  assert.ok(b.findSetup(id));
  assert.equal(b.getOverride().values.BUSINESS_NAME, id);
  b.setOverride({}); b.db.setups = b.db.setups.filter((s) => s.id !== id); b.save();
  await Promise.all([a.close(), b.close()]);
});
