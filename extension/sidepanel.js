// DSH Browser Bridge · 侧边栏逻辑（浏览器面板 + 文件面板）
// 与 service worker 的长连接既传指令，也让 SW 在侧边栏打开期间保持存活。
// 文件面板直接走本地桥的 HTTP 接口：读 /list · /text · /file · /panel/next，写 /write · /delete

const port = chrome.runtime.connect({ name: 'dsh-sidepanel' });
const $ = (id) => document.getElementById(id);
const baseName = (p) => String(p).split(/[\\/]/).pop() || String(p);
let seq = 0;
const waiters = new Map();
let state = { endpoint: 'http://127.0.0.1:3099', allowEval: false };
let cwd = '';          // 当前列出的目录
let parentDir = null;  // 上级目录（已在根时为 null）
let curFile = '';      // 正在预览 / 编辑的文件
let editing = false;   // 编辑器是否展开
let isNewFile = false; // 当前编辑的是不是新建出来的空文件
let tabsLoaded = false;
const tabsSel = new Set();

const base = () => String(state.endpoint || 'http://127.0.0.1:3099').replace(/\/+$/, '');

// ── 与 service worker 的通道 ────────────────────────────────
port.onMessage.addListener((msg) => {
  if (msg.type === 'state') render(msg.state);
  if (msg.type === 'log') append(msg.entry);
  if (msg.type === 'result') {
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); msg.ok ? w.resolve(msg.result) : w.reject(new Error(msg.error)); }
  }
});

function run(op, args) {
  const id = 'c' + (++seq);
  port.postMessage({ type: 'run', id, op, args });
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    setTimeout(() => { if (waiters.delete(id)) reject(new Error('超时')); }, 60000);
  });
}

function append(e) {
  const d = document.createElement('div');
  d.className = 'e k-' + e.kind;
  d.textContent = new Date(e.t).toLocaleTimeString() + '  ' + e.text;
  $('log').prepend(d);
  $('count').textContent = $('log').childElementCount + ' 条';
}

function render(s) {
  if (!s) return;
  state = s;
  $('endpoint').value = s.endpoint;
  $('allowEval').checked = !!s.allowEval;
  $('dot').className = 'dot' + (s.attached ? ' on' : '');
  $('status').textContent = s.attached ? ('已连接 #' + s.tabId) : '未连接标签页';
  $('info').textContent = '桥 ' + s.endpoint + ' · 轮询 ' + s.pollMs + 'ms';
  const seen = new Set([...$('log').children].map((n) => n.textContent));
  (s.log || []).slice().reverse().forEach((e) => {
    const t = new Date(e.t).toLocaleTimeString() + '  ' + e.text;
    if (!seen.has(t)) append(e);
  });
  if (!tabsLoaded) { tabsLoaded = true; loadTabs(); }
}

// ── 浏览器面板 ──────────────────────────────────────────────
$('save').onclick = () => port.postMessage({
  type: 'config',
  value: { endpoint: $('endpoint').value.trim(), allowEval: $('allowEval').checked }
});
$('attach').onclick = () => run('attach', {})
  .then((r) => { $('info').textContent = '已连接 #' + r.tabId; loadTabs(); })
  .catch((e) => alert(e.message));
$('snap').onclick = () => run('page.snapshot', {})
  .then((s) => {
    $('info').textContent = s.title + ' · ' + s.elements.length + ' 个可交互元素（明细见控制台）';
    console.log(s);
  })
  .catch((e) => alert(e.message));
$('open').onclick = () => run('page.open', { url: $('url').value.trim() })
  .then(loadTabs)
  .catch((e) => alert(e.message));

// ── 标签页清单（批量操作）───────────────────────────────────
function renderTabs(list) {
  const box = $('tabs');
  box.textContent = '';
  box.className = '';
  $('tcount').textContent = list.length + ' 个';
  list.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'te';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = tabsSel.has(t.id);
    cb.onchange = () => { if (cb.checked) tabsSel.add(t.id); else tabsSel.delete(t.id); };
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = (t.active ? '● ' : '') + (t.title || '(无标题)');
    nm.title = t.url || '';
    const idn = document.createElement('span');
    idn.className = 'sz';
    idn.textContent = (state.tabId === t.id ? '⟶ ' : '') + '#' + t.id;
    row.append(cb, nm, idn);
    row.onclick = (ev) => {
      if (ev.target === cb) return;
      run('tabs.activate', { tabId: t.id })
        .then(() => { render(state); loadTabs(); })
        .catch((e) => alert(e.message));
    };
    box.appendChild(row);
  });
}

async function loadTabs() {
  try {
    renderTabs(await run('tabs.list', {}));
  } catch (e) {
    $('tabs').textContent = '';
    $('tcount').textContent = '取不到标签页：' + e.message;
  }
}

$('trefresh').onclick = () => loadTabs();
$('tclose').onclick = async () => {
  const ids = [...tabsSel];
  if (!ids.length) return alert('先勾选要关闭的标签页');
  if (!confirm('关闭 ' + ids.length + ' 个标签页？')) return;
  try {
    await run('tabs.closeMany', { tabIds: ids });
    tabsSel.clear();
    await loadTabs();
  } catch (e) { alert(e.message); }
};

// ── 页签 ────────────────────────────────────────────────────
function showTab(which) {
  const files = which === 'files';
  $('tab-browser').classList.toggle('on', !files);
  $('tab-files').classList.toggle('on', files);
  $('view-browser').hidden = files;
  $('view-files').hidden = !files;
  if (files && !cwd) listDir('').catch(fail);
  if (!files) loadTabs();
}
$('tab-browser').onclick = () => showTab('browser');
$('tab-files').onclick = () => showTab('files');

// ── 文件面板 ────────────────────────────────────────────────
async function api(path, params) {
  const u = new URL(base() + path);
  Object.entries(params || {}).forEach(([k, v]) => { if (v != null) u.searchParams.set(k, v); });
  const r = await fetch(u.toString(), { cache: 'no-store' });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) {
    let m = 'HTTP ' + r.status;
    try { const j = await r.json(); if (j && j.error) m = j.error; } catch (e) {}
    throw new Error(m);
  }
  return ct.indexOf('json') >= 0 ? r.json() : r;
}

async function apiPost(path, body) {
  const r = await fetch(base() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

function fail(e) { $('fmeta').textContent = '出错：' + (e && e.message ? e.message : e); }

function human(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
}

function fileRow(e) {
  const el = document.createElement('div');
  el.className = 'fe' + (e.dir ? ' d' : '');
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = (e.dir ? '📁 ' : '📄 ') + e.name;
  const sz = document.createElement('span');
  sz.className = 'sz';
  sz.textContent = e.dir ? '' : human(e.size);
  el.append(nm, sz);
  el.onclick = () => { if (e.dir) listDir(e.path).catch(fail); else openFile(e.path, e.name); };
  return el;
}

async function listDir(p) {
  const d = await api('/list', { path: p });
  cwd = d.path;
  parentDir = d.parent;
  $('fpath').value = d.path;
  $('fmeta').textContent = d.entries.length + ' 项 · 根 ' + d.root;
  const box = $('flist');
  box.textContent = '';
  if (d.parent) box.appendChild(fileRow({ name: '..', dir: true, path: d.parent, size: 0 }));
  d.entries.forEach((e) => box.appendChild(fileRow(e)));
  return d;
}

const TEXT_EXT = ['.md', '.markdown', '.txt', '.log', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.jsx', '.py', '.css', '.html', '.htm', '.xml', '.yml', '.yaml', '.csv', '.toml', '.ini',
  '.sh', '.ps1', '.bat', '.vue', '.sql', '.rs', '.go', '.java', '.c', '.h', '.cpp'];
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
const AV_EXT = { '.mp4': 'video', '.webm': 'video', '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio' };

function extOf(name) {
  const s = String(name);
  const i = s.lastIndexOf('.');
  return i < 0 ? '' : s.slice(i).toLowerCase();
}

function setEditor(on, text) {
  editing = on;
  $('ftext').hidden = !on;
  $('fview').hidden = on;
  $('fsave').hidden = !on;
  $('fedit').hidden = !curFile;
  $('fedit').textContent = on ? '取消' : '编辑';
  if (on) {
    $('ftext').value = text == null ? '' : text;
    $('ftext').scrollTop = 0;
    $('ftext').focus();
  }
}

function clearPreview() {
  curFile = '';
  isNewFile = false;
  editing = false;
  $('fname').textContent = '预览';
  $('fraw').hidden = true;
  $('fdl').hidden = true;
  $('fdel').hidden = true;
  $('fedit').hidden = true;
  $('ftext').hidden = true;
  $('fsave').hidden = true;
  const view = $('fview');
  view.hidden = false;
  view.className = 'mut';
  view.textContent = '选一个文件，或让我把文件推到这里。';
}

async function openFile(p, name) {
  curFile = p;
  isNewFile = false;
  setEditor(false);
  const view = $('fview');
  view.textContent = '';
  view.className = '';
  view.hidden = false;
  $('fname').textContent = name;
  $('fraw').hidden = false;
  $('fdl').hidden = false;
  $('fdel').hidden = false;
  $('fedit').hidden = false;
  const e = extOf(name);
  const src = base() + '/file?path=' + encodeURIComponent(p);
  if (IMG_EXT.indexOf(e) >= 0) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = name;
    view.appendChild(img);
  } else if (e === '.pdf') {
    const f = document.createElement('iframe');
    f.src = src;
    view.appendChild(f);
  } else if (AV_EXT[e]) {
    const m = document.createElement(AV_EXT[e]);
    m.src = src;
    m.controls = true;
    m.style.width = '100%';
    view.appendChild(m);
  } else if (TEXT_EXT.indexOf(e) >= 0 || !e) {
    const d = await api('/text', { path: p });
    if (e === '.md' || e === '.markdown') {
      const box = document.createElement('div');
      box.className = 'md';
      box.innerHTML = toHtml(d.text);
      view.appendChild(box);
    } else {
      const pre = document.createElement('pre');
      pre.textContent = d.truncated ? d.text + '\n…（已截断）' : d.text;
      view.appendChild(pre);
    }
  } else {
    const pre = document.createElement('pre');
    pre.textContent = '（该类型不内联预览 —— 用上面的「新标签打开」或「下载」）';
    view.appendChild(pre);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function toHtml(src) {
  const out = [];
  let inCode = false;
  String(src).split(/\r?\n/).forEach((line) => {
    if (/^\s*```/.test(line)) {
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      return;
    }
    if (inCode) { out.push(esc(line)); return; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const n = h[1].length;
      out.push('<h' + n + '>' + inlineMd(h[2]) + '</h' + n + '>');
      return;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      out.push('<div>• ' + inlineMd(line.replace(/^\s*([-*]|\d+\.)\s+/, '')) + '</div>');
      return;
    }
    if (!line.trim()) { out.push('<div style="height:6px"></div>'); return; }
    out.push('<div>' + inlineMd(line) + '</div>');
  });
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

async function openTarget(p) {
  const t = String(p || '').trim();
  if (!t) return listDir('');
  try {
    return await listDir(t);
  } catch (e) {
    const nm = baseName(t);
    return openFile(t, nm);
  }
}

$('fgo').onclick = () => openTarget($('fpath').value).catch(fail);
$('fup').onclick = () => { if (parentDir) listDir(parentDir).catch(fail); };
$('fpath').onkeydown = (ev) => { if (ev.key === 'Enter') $('fgo').click(); };
$('fraw').onclick = () => {
  if (curFile) chrome.tabs.create({ url: base() + '/file?path=' + encodeURIComponent(curFile) });
};
$('fdl').onclick = () => {
  if (curFile) chrome.tabs.create({ url: base() + '/file?path=' + encodeURIComponent(curFile) + '&dl=1' });
};

// ── 编辑 / 新建 / 删除 ──────────────────────────────────────
$('fedit').onclick = async () => {
  if (!curFile) return;
  if (editing) { await openFile(curFile, baseName(curFile)).catch(fail); return; }
  try {
    const d = await api('/text', { path: curFile });
    if (d.truncated) throw new Error('文件超过 2MB：编辑器不支持（保存会把文件截断），请用外部编辑器');
    setEditor(true, d.text);
    $('fmeta').textContent = '编辑中 · ' + baseName(curFile) + ' · Ctrl+S 保存，Esc 取消';
  } catch (e) { fail(e); }
};

async function saveFile() {
  if (!curFile || !editing) return;
  try {
    await apiPost('/write', { path: curFile, text: $('ftext').value, create: isNewFile });
    const p = curFile;
    isNewFile = false;
    await openFile(p, baseName(p));
    if (cwd) await listDir(cwd).catch(() => {});
    $('fmeta').textContent = '已保存 · ' + baseName(p);
  } catch (e) { fail(e); }
}
$('fsave').onclick = () => saveFile();

$('ftext').onkeydown = (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) { ev.preventDefault(); saveFile(); return; }
  if (ev.key === 'Escape') { ev.preventDefault(); $('fedit').click(); return; }
  if (ev.key === 'Tab') {
    ev.preventDefault();
    const t = ev.target;
    const s = t.selectionStart;
    t.setRangeText('  ', s, t.selectionEnd, 'end');
  }
};

$('fdel').onclick = async () => {
  if (!curFile) return;
  if (!confirm('删除 ' + baseName(curFile) + ' ？（目录只会删空的）')) return;
  try {
    await apiPost('/delete', { path: curFile });
    clearPreview();
    if (cwd) await listDir(cwd).catch(() => {});
    $('fmeta').textContent = '已删除';
  } catch (e) { fail(e); }
};

$('fnewgo').onclick = async () => {
  const nm = $('fnew').value.trim();
  if (!nm) return;
  const dir = cwd || '';
  const sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
  const target = dir.replace(/[\\/]+$/, '') + sep + nm;
  try {
    await apiPost('/write', { path: target, text: '', create: true });
    $('fnew').value = '';
    await listDir(dir).catch(() => {});
    curFile = target;
    isNewFile = true;
    $('fname').textContent = nm;
    $('fraw').hidden = false;
    $('fdl').hidden = false;
    $('fdel').hidden = false;
    setEditor(true, '');
    $('fmeta').textContent = '新建中 · ' + nm + ' · Ctrl+S 写入';
  } catch (e) { fail(e); }
};
$('fnew').onkeydown = (ev) => { if (ev.key === 'Enter') $('fnewgo').click(); };

// ── 接收「把文件推到侧窗」的推送 ────────────────────────────
let running = true;
async function pollPanel() {
  if (!running) return;
  try {
    const r = await fetch(base() + '/panel/next', { cache: 'no-store' });
    if (r.status === 200) {
      const item = await r.json();
      showTab('files');
      if (editing) {
        $('fmeta').textContent = '有新的推送（' + item.path + '）—— 你正在编辑，先不打断';
      } else if (item.op === 'dir.open') {
        await listDir(item.path).catch(fail);
      } else if (item.op === 'file.show') {
        await listDir(String(item.path).replace(/[\\/][^\\/]*$/, '')).catch(() => {});
        await openFile(item.path, baseName(item.path)).catch(fail);
      }
    }
  } catch (e) { /* 桥没在跑：静默重试 */ }
  setTimeout(pollPanel, 1500);
}
window.addEventListener('unload', () => { running = false; });
pollPanel();
