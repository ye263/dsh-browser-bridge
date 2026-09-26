// dsh-browser-bridge · 自测（不需要 Chrome）
// 用法：node bridge/selftest.mjs
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:' + (process.env.DSH_BRIDGE_PORT || 3099);
let failures = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
  if (!cond) failures++;
};

// 1) 桥在不在；不在就把它拉起来（已在运行则复用）
let running = false;
try {
  const h = await fetch(BASE + '/health');
  running = h.ok;
} catch (e) {}
if (running) {
  console.log('NOTE  检测到已有桥在 ' + BASE + '，直接复用');
} else {
  await import('./relay.mjs');
  await sleep(700);
}

// 2) 探活
const health = await (await fetch(BASE + '/health')).json();
ok('/health', health.ok === true, JSON.stringify(health));

// 3) 没有扩展时应正确超时 —— 验证队列与超时链路
const t0 = Date.now();
const miss = await (await fetch(BASE + '/cmd', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ op: 'bridge.status', args: {}, timeoutMs: 600 })
})).json();
ok('/cmd 无扩展→超时', miss.ok === false && /超时/.test(miss.error || ''),
  (Date.now() - t0) + 'ms   ' + JSON.stringify(miss));

// 4) 假装自己是扩展：取一条指令、回传结果，验证 agent↔扩展 的往返
const pending = fetch(BASE + '/cmd', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ op: 'page.snapshot', args: {}, timeoutMs: 3000 })
}).then((r) => r.json());

await sleep(200);
const next = await (await fetch(BASE + '/next')).json();
ok('/next 取到指令', next.op === 'page.snapshot', JSON.stringify(next));

await fetch(BASE + '/result', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: next.id,
    ok: true,
    result: {
      url: 'https://example.com',
      title: '假页面（自测用）',
      elements: [{ ref: 'e1', role: 'link', name: 'More information' }]
    }
  })
});

const got = await pending;
ok('/cmd 拿到扩展结果',
  got.ok === true && got.result && Array.isArray(got.result.elements) && got.result.elements.length === 1,
  JSON.stringify(got));

// 5) 文件面：写 → 读回 → 越界被拒 → 删
const probe = join(tmpdir(), 'dsh-bridge-selftest.txt');
const body = (o) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(o)
});
const text = 'hello · 写入测试\n第二行';

const w = await (await fetch(BASE + '/write', body({ path: probe, text, create: true }))).json();
ok('/write 写入', w.ok === true, probe);

const back = await (await fetch(BASE + '/text?path=' + encodeURIComponent(probe))).json();
ok('/text 读回一致', back.text === text, JSON.stringify(back.text));

const outside = process.platform === 'win32'
  ? 'C:\\Windows\\Temp\\dsh-should-not-write.txt'
  : '/dsh-should-not-write.txt';
const denied = await fetch(BASE + '/write', body({ path: outside, text: 'x' }));
ok('/write 越界 → 403', denied.status === 403, 'HTTP ' + denied.status);

const del = await (await fetch(BASE + '/delete', body({ path: probe }))).json();
ok('/delete 删除', del.ok === true, JSON.stringify(del));

console.log(failures === 0 ? '\n全部通过 ✅  （队列 / 超时 / 往返 / 文件读写链路正确；剩下的只有 Chrome 侧真机验证）'
  : '\n失败 ' + failures + ' 项 ❌');
process.exit(failures === 0 ? 0 : 1);
