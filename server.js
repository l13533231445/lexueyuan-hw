/* 乐学园晚托作业辅导工作台 · 云端后端
 * 零依赖主逻辑；若设置了 DATABASE_URL 环境变量则自动改用 Postgres（云端持久存储），
 * 否则退回本地 JSON 文件存储（兼容本机隧道版）。前端无需任何改动。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DIR = (() => { let d = process.env.DATA_DIR || path.join(__dirname, 'data'); d = d.replace(/^\/([a-zA-Z])\//, '$1:/'); return path.resolve(d); })();
const DB = path.join(DIR, 'db.json');
const PUBLIC = path.join(__dirname, 'public');
const STORES = ['students', 'homework', 'followups', 'exams'];
const RETAIN_DAYS = 120; // 数据留存 4 个月（≈120天），超期自动删除
const PASSWORD = process.env.PASSWORD || 'lexueyuan2026'; // 访问密码：部署时用环境变量 PASSWORD 覆盖
const USE_PG = !!process.env.DATABASE_URL;

/* ---------- 记录时间提取（用于留存清理） ---------- */
function recDate(data) {
  const s = data.date || data.visitTime || data.createdAt;
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}

/* ================= 本地 JSON 存储（本机/隧道版） ================= */
function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }
function readDB() {
  ensureDir();
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); }
  catch { return { students: [], homework: [], followups: [], exams: [], rev: 0 }; }
}
function writeDB(d) {
  ensureDir();
  const tmp = DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d));
  fs.renameSync(tmp, DB); // 原子替换，避免半写入
}
let chain = Promise.resolve();
function lock(fn) { const run = chain.then(fn, fn); chain = run.then(() => {}, () => {}); return run; }
function localUpsert(store, rec) {
  return lock(() => {
    const d = readDB();
    if (!d[store]) d[store] = [];
    if (!rec.id) rec.id = crypto.randomUUID();
    const i = d[store].findIndex(r => r.id === rec.id);
    if (i >= 0) d[store][i] = rec; else d[store].push(rec);
    d.rev = (d.rev || 0) + 1;
    writeDB(d);
    return rec;
  });
}
function localDelete(store, id) {
  return lock(() => {
    const d = readDB();
    if (d[store]) {
      const n = d[store].length;
      d[store] = d[store].filter(r => r.id !== id);
      if (d[store].length !== n) d.rev = (d.rev || 0) + 1;
    }
    writeDB(d);
    return { ok: true };
  });
}
function localRetention() {
  const cut = Date.now() - RETAIN_DAYS * 86400000;
  const d = readDB();
  let removed = 0;
  for (const s of ['homework', 'followups', 'exams']) {
    const before = (d[s] || []).length;
    d[s] = (d[s] || []).filter(r => { const t = recDate(r); return t === null || t >= cut; });
    removed += before - d[s].length;
  }
  if (removed > 0) { d.rev = (d.rev || 0) + 1; writeDB(d); }
  return removed;
}

/* ================= Postgres 存储（Render 云端持久） ================= */
let pgClient = null;
async function pg() {
  if (!pgClient) {
    const { Client } = require('pg');
    pgClient = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pgClient.connect();
    await pgClient.query(`CREATE TABLE IF NOT EXISTS records(store text, id text, data jsonb, date timestamptz, primary key(store,id))`);
    await pgClient.query(`CREATE TABLE IF NOT EXISTS meta(k text primary key, v jsonb)`);
  }
  return pgClient;
}
async function pgSnapshot() {
  const c = await pg();
  const r = await c.query('SELECT store,data FROM records');
  const out = { students: [], homework: [], followups: [], exams: [], rev: 0 };
  for (const row of r.rows) if (STORES.includes(row.store)) out[row.store].push(row.data);
  const m = await c.query("SELECT v FROM meta WHERE k='rev'");
  if (m.rows[0]) out.rev = Number(m.rows[0].v);
  return out;
}
async function pgUpsert(store, rec) {
  const c = await pg();
  if (!rec.id) rec.id = crypto.randomUUID();
  const dt = recDate(rec);
  await c.query(
    'INSERT INTO records(store,id,data,date) VALUES($1,$2,$3,$4) ON CONFLICT(store,id) DO UPDATE SET data=$3,date=$4',
    [store, rec.id, JSON.stringify(rec), dt]);
  await c.query("INSERT INTO meta(k,v) VALUES('rev',0) ON CONFLICT(k) DO UPDATE SET v=(meta.v::int+1)");
  return rec;
}
async function pgDelete(store, id) {
  const c = await pg();
  await c.query('DELETE FROM records WHERE store=$1 AND id=$2', [store, id]);
  await c.query("INSERT INTO meta(k,v) VALUES('rev',0) ON CONFLICT(k) DO UPDATE SET v=(meta.v::int+1)");
}
async function pgRetention() {
  const cut = new Date(Date.now() - RETAIN_DAYS * 86400000);
  const c = await pg();
  const r = await c.query(
    "DELETE FROM records WHERE store=ANY($1) AND date IS NOT NULL AND date < $2",
    [['homework', 'followups', 'exams'], cut]);
  if (r.rowCount > 0) await c.query("INSERT INTO meta(k,v) VALUES('rev',0) ON CONFLICT(k) DO UPDATE SET v=(meta.v::int+1)");
  return r.rowCount || 0;
}

/* ================= 统一接口（自动选存储） ================= */
const loadSnapshot = () => USE_PG ? pgSnapshot() : readDB();
const doUpsert = (s, r) => USE_PG ? pgUpsert(s, r) : localUpsert(s, r);
const doDelete = (s, id) => USE_PG ? pgDelete(s, id) : localDelete(s, id);
const doRetention = () => USE_PG ? pgRetention() : localRetention();

/* ---------- 静态文件 ---------- */
const CT = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(PUBLIC, p);
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': CT[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((res, rej) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { res(data ? JSON.parse(data) : {}); } catch (e) { rej(e); } });
  });
}

/* ---------- API ---------- */
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    // 访问密码校验：所有 /api/ 路由必须携带正确的 x-access-key（或 ?pw=）
    if (url.startsWith('/api/')) {
      const provided = req.headers['x-access-key'] || (req.url.match(/[?&]pw=([^&]*)/) || [])[1];
      if (provided !== PASSWORD) return sendJSON(res, 401, { error: 'unauthorized' });
    }

    if (url === '/api/data' && req.method === 'GET') {
      const d = await loadSnapshot();
      return sendJSON(res, 200, {
        students: d.students || [], homework: d.homework || [],
        followups: d.followups || [], exams: d.exams || [],
        rev: d.rev || 0, now: Date.now()
      });
    }
    if (url === '/api/upsert' && req.method === 'POST') {
      const b = await readBody(req);
      if (!STORES.includes(b.store)) return sendJSON(res, 400, { error: 'bad store' });
      if (!b.rec || typeof b.rec !== 'object') return sendJSON(res, 400, { error: 'bad rec' });
      const rec = await doUpsert(b.store, b.rec);
      return sendJSON(res, 200, rec);
    }
    if (url === '/api/delete' && req.method === 'POST') {
      const b = await readBody(req);
      if (!STORES.includes(b.store)) return sendJSON(res, 400, { error: 'bad store' });
      await doDelete(b.store, b.id);
      return sendJSON(res, 200, { ok: true });
    }
    if (url.startsWith('/api/')) return sendJSON(res, 404, { error: 'not found' });
    return serveStatic(req, res);
  } catch (e) {
    return sendJSON(res, 500, { error: String(e) });
  }
});

/* ---------- 启动即清理一次，并每日清理 ---------- */
(async () => {
  try { const n = await doRetention(); if (n > 0) console.log('[retention] 清理超期记录 ' + n + ' 条'); }
  catch (e) { console.error('[retention] 启动清理失败:', e); }
  setInterval(() => { doRetention().catch(e => console.error('[retention]', e)); }, 86400000);
  server.listen(PORT, () => {
    console.log('乐学园云端工作台已启动: http://localhost:' + PORT + '  (存储: ' + (USE_PG ? 'Postgres云端' : '本地JSON') + ')');
    console.log('留存时长: ' + RETAIN_DAYS + ' 天（约4个月）');
  });
})();
