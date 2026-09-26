// dsh-browser-bridge · 本地桥（零依赖）
// 用法：node bridge/relay.mjs
//   agent → 扩展   POST /cmd {"op","args"}     阻塞等到扩展执行完
//   扩展  ← 指令   GET  /next                  无指令回 204
//   扩展  → 结果   POST /result {"id",ok,...}
//   侧窗  ← 推送   GET  /panel/next            侧窗轮询，取「要展示的文件」
//   agent → 侧窗   POST /cmd {op:"file.show"}  把文件推到侧窗展示（桥自己处理，不等扩展）
//   侧窗文件读取   GET  /list?path=…  /text?path=…  /file?path=…（原始字节：图片/PDF/音视频）
//   侧窗文件写入   POST /write {path,text,create?}   POST /mkdir {path}   POST /delete {path}
//   探活           GET  /health
// 环境变量：DSH_BRIDGE_PORT（默认 3099）、DSH_BRIDGE_ROOT（文件访问根，默认用户主目录）
import { createServer } from 'node:http';
import { readFile, readdir, stat, writeFile, mkdir, unlink, rmdir } from 'node:fs/promises';
import { extname, resolve, sep, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

const PORT = Number(process.env.DSH_BRIDGE_PORT || 3099);
const ROOT = resolve(process.env.DSH_BRIDGE_ROOT || homedir());
const TEXT_MAX = 2 * 1024 * 1024;

const queue = [];          // 给扩展的指令
const waiting = new Map(); // /cmd 等待中的请求
const panelQueue = [];     // 给侧窗的推送（file.show）
let seq = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4'
};

const readBody = (req) => new Promise((r) => {
  let s = '';
  req.on('data', (c) => { s += c; });
  req.on('end', () => r(s));
});

const send = (res, code, body, type) => {
  res.writeHead(code, {
    'content-type': type || 'application/json; charset=utf-8',
    'access-control-allow-origin': '*'
  });
  res.end(body);
};
const json = (res, code, body) => send(res, code, JSON.stringify(body));
const noContent = (res) => {
  res.writeHead(204, { 'access-control-allow-origin': '*' });
  res.end();
};

/** 把请求路径限制在 ROOT 之内，越界一律拒绝。 */
function safePath(p) {
  if (!p) return undefined;
  const abs = resolve(String(p));
  return abs === ROOT || abs.startsWith(ROOT + sep) ? abs : undefined;
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }

  // ── 扩展侧 ────────────────────────────────────────────────
  if (path === '/next') {
    if (queue.length === 0) return noContent(res);
    return json(res, 200, queue.shift());
  }
  if (path === '/result' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const settle = waiting.get(body.id);
    if (settle) { waiting.delete(body.id); settle(body); }
    return json(res, 200, { ok: true });
  }

  // ── 侧窗侧：取「要展示的文件」 ─────────────────────────────
  if (path === '/panel/next') {
    if (panelQueue.length === 0) return noContent(res);
    return json(res, 200, panelQueue.shift());
  }

  // ── agent 侧：下达指令 ────────────────────────────────────
  if (path === '/cmd' && req.method === 'POST') {
    const cmd = JSON.parse((await readBody(req)) || '{}');
    const args = cmd.args || {};

    // file.show：把文件推到侧窗展示。桥自己处理，不等扩展在线。
    if (cmd.op === 'file.show') {
      const target = safePath(args.path);
      if (!target) return json(res, 200, { ok: false, error: '路径不在允许的根目录内：' + ROOT });
      try {
        const s = await stat(target);
        if (s.isDirectory()) {
          panelQueue.push({ op: 'dir.open', path: target });
          return json(res, 200, { ok: true, result: { dir: target, queued: panelQueue.length } });
        }
      } catch (e) {
        return json(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
      panelQueue.push({ op: 'file.show', path: target });
      return json(res, 200, { ok: true, result: { shown: target, queued: panelQueue.length } });
    }

    const id = 'c' + (++seq);
    queue.push({ id, op: cmd.op, args });
    const out = await new Promise((resolveOut) => {
      waiting.set(id, resolveOut);
      setTimeout(() => {
        if (waiting.delete(id)) resolveOut({ id, ok: false, error: '超时：扩展侧边栏可能未打开' });
      }, cmd.timeoutMs || 45000);
    });
    return json(res, 200, out);
  }

  if (path === '/health') {
    return json(res, 200, {
      ok: true, pending: queue.length, waiting: waiting.size,
      panel: panelQueue.length, root: ROOT
    });
  }

  // ── 文件：给侧窗展示 ──────────────────────────────────────
  if (path === '/list' && req.method === 'GET') {
    const target = safePath(url.searchParams.get('path') || ROOT);
    if (!target) return json(res, 403, { error: '路径不在允许的根目录内：' + ROOT });
    try {
      const entries = await readdir(target, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        const full = resolve(target, e.name);
        let size = 0, mtime = 0;
        try { const s = await stat(full); size = s.size; mtime = s.mtimeMs; } catch (err) {}
        out.push({ name: e.name, path: full, dir: e.isDirectory(), size, mtime });
      }
      out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)));
      return json(res, 200, {
        path: target, name: basename(target), root: ROOT,
        parent: target === ROOT ? null : dirname(target),
        entries: out
      });
    } catch (e) {
      return json(res, 404, { error: String((e && e.message) || e) });
    }
  }

  if (path === '/text' && req.method === 'GET') {
    const target = safePath(url.searchParams.get('path'));
    if (!target) return json(res, 403, { error: '路径不在允许的根目录内：' + ROOT });
    try {
      const s = await stat(target);
      const buf = await readFile(target);
      return json(res, 200, {
        path: target, name: basename(target), size: s.size, mtime: s.mtimeMs,
        truncated: buf.length > TEXT_MAX,
        text: buf.subarray(0, TEXT_MAX).toString('utf8')
      });
    } catch (e) {
      return json(res, 404, { error: String((e && e.message) || e) });
    }
  }

  if (path === '/file' && req.method === 'GET') {
    const target = safePath(url.searchParams.get('path'));
    if (!target) return json(res, 403, { error: '路径不在允许的根目录内：' + ROOT });
    try {
      const mime = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
      const buf = await readFile(target);
      const extra = url.searchParams.get('dl') === '1'
        ? { 'content-disposition': 'attachment; filename="' + basename(target) + '"' } : {};
      res.writeHead(200, {
        'content-type': mime, 'cache-control': 'no-store',
        'access-control-allow-origin': '*', ...extra
      });
      return res.end(buf);
    } catch (e) {
      return json(res, 404, { error: String((e && e.message) || e) });
    }
  }

  // ── 文件写入（侧窗编辑器用；同样只允许 ROOT 之内）──────────
  if (path === '/write' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const target = safePath(body.path);
    if (!target) return json(res, 403, { ok: false, error: '路径不在允许的根目录内：' + ROOT });
    try {
      if (body.create) await mkdir(dirname(target), { recursive: true });
      await writeFile(target, String(body.text === undefined ? '' : body.text), 'utf8');
      const s = await stat(target);
      return json(res, 200, { ok: true, path: target, size: s.size, mtime: s.mtimeMs });
    } catch (e) {
      return json(res, 404, { ok: false, error: String((e && e.message) || e) });
    }
  }

  if (path === '/mkdir' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const target = safePath(body.path);
    if (!target) return json(res, 403, { ok: false, error: '路径不在允许的根目录内：' + ROOT });
    try {
      await mkdir(target, { recursive: true });
      return json(res, 200, { ok: true, path: target });
    } catch (e) {
      return json(res, 404, { ok: false, error: String((e && e.message) || e) });
    }
  }

  if (path === '/delete' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const target = safePath(body.path);
    if (!target) return json(res, 403, { ok: false, error: '路径不在允许的根目录内：' + ROOT });
    if (target === ROOT) return json(res, 400, { ok: false, error: '不能删除文件访问根' });
    try {
      const s = await stat(target);
      if (s.isDirectory()) await rmdir(target); // 只删空目录，避免误伤
      else await unlink(target);
      return json(res, 200, { ok: true, path: target });
    } catch (e) {
      return json(res, 404, { ok: false, error: String((e && e.message) || e) });
    }
  }

  json(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => {
  console.log('[dsh-browser-bridge] http://127.0.0.1:' + PORT);
  console.log('  agent → POST /cmd {"op","args"}   侧窗 → GET /list · /text · /file · /panel/next');
  console.log('  侧窗编辑器 → POST /write · /mkdir · /delete');
  console.log('  文件访问根：' + ROOT);
});
