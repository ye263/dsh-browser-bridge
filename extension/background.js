// DSH Browser Bridge — MV3 service worker
// 语义化控制：CDP 真实输入事件 + DOM 读数，不需要截图或视觉模型。
// 侧边栏打开时（长连接存活）持续轮询本地桥，取指令 → 执行 → 回传结果。

const DEFAULTS = { endpoint: 'http://127.0.0.1:3099', pollMs: 700, allowEval: false };

let cfg = { ...DEFAULTS };
let tabId = null;
let attached = false;
let polling = false;
let port = null;
const log = [];

// ── 页面内代理：分配稳定 ref、给出可交互元素清单与坐标（无截图）────────────
const PAGE_AGENT = String.raw`
(() => {
  if (window.__DSH_BRIDGE__) return 'already';
  let seq = 0;
  const SELECTOR = 'a[href],button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[contenteditable="true"]';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const name = (el) => String(
    el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') ||
    el.value || el.innerText || el.textContent || el.title || el.alt || ''
  ).replace(/\s+/g, ' ').trim().slice(0, 140);
  const role = (el) => el.getAttribute('role') || ({
    A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox',
    LABEL: 'label', SUMMARY: 'button'
  }[el.tagName] || (el.tagName === 'INPUT'
    ? (el.type === 'checkbox' ? 'checkbox' : ((el.type === 'submit' || el.type === 'button') ? 'button' : 'textbox'))
    : el.tagName.toLowerCase()));
  const byRef = (ref) => document.querySelector('[data-dsh-ref="' + ref + '"]');

  window.__DSH_BRIDGE__ = {
    snapshot() {
      const out = [];
      for (const el of document.querySelectorAll(SELECTOR)) {
        if (!visible(el)) continue;
        let ref = el.getAttribute('data-dsh-ref');
        if (!ref) { ref = 'e' + (++seq); el.setAttribute('data-dsh-ref', ref); }
        const r = el.getBoundingClientRect();
        out.push({
          ref, role: role(el), name: name(el), tag: el.tagName.toLowerCase(),
          value: String(el.value === undefined ? '' : el.value).slice(0, 200),
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          disabled: !!el.disabled
        });
        if (out.length >= 250) break;
      }
      return {
        url: location.href,
        title: document.title,
        text: (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 12000),
        elements: out
      };
    },
    box(ref) {
      const el = byRef(ref);
      if (!el) throw new Error('找不到 ref=' + ref);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    },
    focus(ref) {
      const el = byRef(ref);
      if (!el) throw new Error('找不到 ref=' + ref);
      el.scrollIntoView({ block: 'center' });
      el.focus();
      return true;
    },
    text(ref) {
      if (!ref) return (document.body ? document.body.innerText : '').slice(0, 20000);
      const el = byRef(ref);
      if (!el) throw new Error('找不到 ref=' + ref);
      return String(el.innerText || el.textContent || '').slice(0, 20000);
    },
    waitFor(selector, text, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 10000);
      return new Promise((resolve, reject) => {
        const hit = () => (selector && document.querySelector(selector)) ||
          (text && document.body && document.body.innerText.includes(text));
        if (hit()) return resolve(true);
        const timer = setInterval(() => {
          if (hit()) { clearInterval(timer); resolve(true); }
          else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('等待超时')); }
        }, 120);
      });
    }
  };
  return 'installed';
})()
`;

// ── 基础设施 ────────────────────────────────────────────────────────────
async function loadCfg() {
  cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

function state() {
  return {
    endpoint: cfg.endpoint, pollMs: cfg.pollMs, allowEval: cfg.allowEval,
    tabId, attached, log: log.slice(0, 40)
  };
}

function record(kind, text) {
  const entry = { t: Date.now(), kind, text };
  log.unshift(entry);
  if (log.length > 300) log.pop();
  try { if (port) port.postMessage({ type: 'log', entry }); } catch (e) {}
}

async function cdp(method, params) {
  if (!attached || tabId === null) throw new Error('未连接：先执行 attach');
  return await chrome.debugger.sendCommand({ tabId }, method, params || {});
}

async function evalInPage(expression, awaitPromise) {
  const r = await cdp('Runtime.evaluate', {
    expression, awaitPromise: !!awaitPromise, returnByValue: true, userGesture: true
  });
  if (r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '页面执行失败');
  }
  return r.result ? r.result.value : undefined;
}

async function activeTabId() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!t || t.id === undefined) throw new Error('没有活动标签页');
  return t.id;
}

function waitLoaded(timeout) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.debugger.onEvent.removeListener(on); resolve(true); } };
    const on = (src, method) => { if (method === 'Page.loadEventFired') finish(); };
    chrome.debugger.onEvent.addListener(on);
    setTimeout(finish, timeout || 15000);
  });
}

async function attach(id) {
  await loadCfg();
  const target = (id === undefined || id === null) ? await activeTabId() : id;
  if (tabId !== null && attached && tabId !== target) {
    try { await chrome.debugger.detach({ tabId }); } catch (e) {}
    attached = false;
  }
  tabId = target;
  if (!attached) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      if (!String(e && e.message).includes('Another debugger')) throw e;
    }
    attached = true;
  }
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  const a = await evalInPage(PAGE_AGENT, false);
  if (a !== 'installed' && a !== 'already') throw new Error('页面代理安装失败：' + a);
  record('ok', '已连接标签页 ' + tabId);
  return { tabId };
}

async function keyEvent(key) {
  const table = {
    Enter: { code: 'Enter', vk: 13, text: '\r' },
    Tab: { code: 'Tab', vk: 9 },
    Escape: { code: 'Escape', vk: 27 },
    Backspace: { code: 'Backspace', vk: 8 },
    ArrowDown: { code: 'ArrowDown', vk: 40 },
    ArrowUp: { code: 'ArrowUp', vk: 38 }
  };
  const k = table[key] || { code: key, vk: 0 };
  const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await cdp('Input.dispatchKeyEvent', { ...base, type: k.text ? 'keyDown' : 'rawKeyDown', text: k.text });
  await cdp('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

async function clickAt(x, y) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

// ── 操作表 ──────────────────────────────────────────────────────────────
const OPS = {
  'bridge.status': async () => state(),

  'tabs.list': async () => (await chrome.tabs.query({})).map((t) => ({
    id: t.id, title: t.title, url: t.url, active: t.active, pinned: t.pinned
  })),
  'tabs.open': async (a) => ({ tabId: (await chrome.tabs.create({ url: a.url })).id }),
  'tabs.activate': async (a) => { await chrome.tabs.update(a.tabId, { active: true }); return await attach(a.tabId); },
  'tabs.close': async (a) => { await chrome.tabs.remove(a.tabId); return true; },

  // 批量：一次关掉勾选的一批标签页；或重载
  'tabs.closeMany': async (a) => {
    const ids = (a.tabIds || []).filter((n) => typeof n === 'number');
    if (!ids.length) return { closed: 0 };
    await chrome.tabs.remove(ids);
    return { closed: ids.length };
  },
  'tabs.reload': async (a) => { await chrome.tabs.reload(a.tabId); return true; },

  'attach': async (a) => await attach(a.tabId),

  'page.open': async (a) => {
    await attach(a.tabId);
    await cdp('Page.navigate', { url: a.url });
    await waitLoaded(a.timeoutMs || 15000);
    const agent = await evalInPage(PAGE_AGENT, false);
    return { url: a.url, agent };
  },

  'page.snapshot': async (a) => { await attach(a.tabId); return await evalInPage('window.__DSH_BRIDGE__.snapshot()', false); },

  'page.text': async (a) => {
    await attach(a.tabId);
    return await evalInPage('window.__DSH_BRIDGE__.text(' + JSON.stringify(a.ref || null) + ')', false);
  },

  'page.click': async (a) => {
    await attach(a.tabId);
    const box = await evalInPage('window.__DSH_BRIDGE__.box(' + JSON.stringify(a.ref) + ')', false);
    await clickAt(box.x, box.y);
    return box;
  },

  'page.type': async (a) => {
    await attach(a.tabId);
    await evalInPage('window.__DSH_BRIDGE__.focus(' + JSON.stringify(a.ref) + ')', false);
    if (a.clear) {
      const ctrl = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 };
      await cdp('Input.dispatchKeyEvent', { ...ctrl, type: 'rawKeyDown' });
      await cdp('Input.dispatchKeyEvent', { ...ctrl, type: 'keyUp' });
      await keyEvent('Backspace');
    }
    await cdp('Input.insertText', { text: a.text });
    if (a.submit) await keyEvent('Enter');
    return true;
  },

  'page.press': async (a) => { await attach(a.tabId); await keyEvent(a.key); return true; },

  'page.scroll': async (a) => {
    await attach(a.tabId);
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: a.x || 300, y: a.y || 400, deltaX: 0, deltaY: a.dy || 400
    });
    return true;
  },

  'page.waitFor': async (a) => {
    await attach(a.tabId);
    return await evalInPage(
      'window.__DSH_BRIDGE__.waitFor(' + JSON.stringify(a.selector || null) + ',' +
      JSON.stringify(a.text || null) + ',' + (a.timeoutMs || 10000) + ')', true
    );
  },

  'page.eval': async (a) => {
    if (!cfg.allowEval) throw new Error('page.eval 默认关闭：请在侧边栏勾选后重试');
    await attach(a.tabId);
    return await evalInPage(a.expression, true);
  }
};

async function dispatch(op, args) {
  const fn = OPS[op];
  if (!fn) throw new Error('未知操作：' + op);
  record('cmd', op + '  ' + JSON.stringify(args || {}).slice(0, 120));
  const result = await fn(args || {});
  record('ok', op + ' 完成');
  return result;
}

// ── 桥轮询 ──────────────────────────────────────────────────────────────
async function pollOnce() {
  const base = cfg.endpoint.replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(base + '/next', { cache: 'no-store' });
  } catch (e) {
    record('err', '桥不在线：' + cfg.endpoint);
    return;
  }
  if (!res.ok || res.status === 204) return;
  let cmd;
  try { cmd = await res.json(); } catch (e) { return; }
  let payload;
  try {
    payload = { id: cmd.id, ok: true, result: await dispatch(cmd.op, cmd.args) };
  } catch (e) {
    payload = { id: cmd.id, ok: false, error: String((e && e.message) || e) };
    record('err', payload.error);
  }
  try {
    await fetch(base + '/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {}
}

async function loop() {
  if (!polling) return;
  await pollOnce();
  setTimeout(loop, cfg.pollMs);
}

function startPolling() {
  if (polling) return;
  polling = true;
  record('ok', '桥轮询已启动：' + cfg.endpoint);
  loop();
}

// ── 侧边栏长连接（也用它保活 service worker）────────────────────────────
chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== 'dsh-sidepanel') return;
  port = p;
  loadCfg().then(startPolling);
  p.postMessage({ type: 'state', state: state() });
  p.onMessage.addListener(async (msg) => {
    if (msg.type === 'config') {
      await chrome.storage.local.set(msg.value);
      await loadCfg();
      p.postMessage({ type: 'state', state: state() });
    }
    if (msg.type === 'run') {
      try {
        p.postMessage({ type: 'result', id: msg.id, ok: true, result: await dispatch(msg.op, msg.args || {}) });
      } catch (e) {
        p.postMessage({ type: 'result', id: msg.id, ok: false, error: String((e && e.message) || e) });
      }
    }
  });
  p.onDisconnect.addListener(() => {
    port = null;
    polling = false;
    record('err', '侧边栏关闭，桥离线');
  });
});

chrome.debugger.onDetach.addListener(() => {
  attached = false;
  tabId = null;
  record('err', '调试通道已断开');
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

loadCfg();
