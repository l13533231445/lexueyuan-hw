/* 乐学园晚托作业辅导工作台 · 云端后端
 * 零依赖（仅 Node 内置模块），任何支持 Node 的托管平台都能一键部署。
 * 功能：静态托管 public/ + 共享 REST API + 4个月自动留存清理 + 版本号轮询同步。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB = path.join(DIR, 'db.json');
const PUBLIC = path.join(__dirname, 'public');
const STORES = ['students', 'homework', 'followups', 'exams'];
const RETAIN_DAYS = 120; // 数据留存 4 个月（≈120天），超期自动删除
const PASSWORD = process.env.PASSWORD || 'lexueyuan2026'; // 访问密码：部署时用环境变量 PASSWORD 覆盖

/* ---------- 存储（JSON 文件 + 写锁，防止并发损坏） ---------- */
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

/* ---------- 4个月留存清理 ---------- */
function retention(d) {
  const cut = Date.now() - RETAIN_DAYS * 86400000;
  const toTs = (r) => {
    const s = r.date || r.visitTime || r.createdAt;
    if (!s) return null;
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  };
  let removed = 0;
  for (const s of ['homework', 'followups', 'exams']) {
    const before = (d[s] || []).length;
    d[s] = (d[s] || []).filter(r => { const t = toTs(r); return t === null || t >= cut; });
    removed += before - d[s].length;
  }
  // students 为身份档案，始终保留
  return removed;
}
function runRetention() {
  const d = readDB();
  const n = retention(d);
  if (n > 0) { d.rev = (d.rev || 0) + 1; writeDB(d); console.log('[retention] 清理超期记录 ' + n + ' 条'); }
}

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
      const d = readDB();
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
      return lock(() => {
        const d = readDB();
        if (!d[b.store]) d[b.store] = [];
        if (!b.rec.id) b.rec.id = crypto.randomUUID();
        const i = d[b.store].findIndex(r => r.id === b.rec.id);
        if (i >= 0) d[b.store][i] = b.rec; else d[b.store].push(b.rec);
        d.rev = (d.rev || 0) + 1;
        writeDB(d);
        return sendJSON(res, 200, b.rec);
      });
    }
    if (url === '/api/delete' && req.method === 'POST') {
      const b = await readBody(req);
      if (!STORES.includes(b.store)) return sendJSON(res, 400, { error: 'bad store' });
      return lock(() => {
        const d = readDB();
        if (d[b.store]) {
          const n = d[b.store].length;
          d[b.store] = d[b.store].filter(r => r.id !== b.id);
          if (d[b.store].length !== n) d.rev = (d.rev || 0) + 1;
        }
        writeDB(d);
        return sendJSON(res, 200, { ok: true });
      });
    }
    if (url.startsWith('/api/')) return sendJSON(res, 404, { error: 'not found' });
    return serveStatic(req, res);
  } catch (e) {
    return sendJSON(res, 500, { error: String(e) });
  }
});

/* ---------- 启动即清理一次，并每日清理 ---------- */
runRetention();
setInterval(runRetention, 86400000);

server.listen(PORT, () => {
  console.log('乐学园云端工作台已启动: http://localhost:' + PORT);
  console.log('数据目录: ' + DIR + '   留存时长: ' + RETAIN_DAYS + ' 天（约4个月）');
});
