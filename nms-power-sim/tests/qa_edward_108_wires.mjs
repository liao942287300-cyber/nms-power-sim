#!/usr/bin/env node
/**
 * tests/qa_edward_108_wires.mjs — QA Edward 独立终验脚本（1.0.8 线条隐藏开关）r2
 * ---------------------------------------------------------------------------
 * r2 修正：先经真实导入放入元件再测拖线/框选；撤销序列改为
 *   S1(显示态连线) → 开隐藏 → 元件拖动 S2(隐藏态) → 关显示 → undo→S2 → undo→S1 → redo；
 *   稳态搜索边界修正（t-18 ≥ 0 且 t+1 < N）；灯点亮检测改为图标填充色
 *   #ffd23f（图标为内联 SVG 片段，无 use[href]，r1 选择器错误）。
 *
 *   A. 应用 UI 级（真实 app.js 页面）：
 *      A1 工具栏按钮开：aria-pressed / is-active / svg 根类 / 双层隐藏 / 元件端口保留。
 *      A2 O(1)：开关一次 DOM 节点零增删、rebuilds 零增量。
 *      A3 隐藏期间连线预览（.wire-preview）出现且可见。
 *      A4 隐藏期间框选（.marquee-box）出现且可见。
 *      A5 隐藏期间拖线到端口可创建导线。
 *      A6 撤销/重做 UI 同步（双向，见上序列）。
 *      A7 导入同步：含 wiresHidden:true 的 JSON → 开；旧 JSON（无字段）→ 显示。
 *   B. 机制级（独立 board，moj-scroll-screen.json）：
 *      B1 隐藏期间 MOJ 灯态逐秒正确：DOM 亮灯集合与引擎视图逐秒一致且持续变化。
 *      B2 滚动语义：lit(c,t) === lit(c-1,t-1)（稳态后逐秒核对）。
 *      B3 隐藏全程导线层保持隐藏；B4 恢复后 .wire.is-powered 正确。
 * ---------------------------------------------------------------------------
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(process.argv[1]);
const PROJECT_ROOT = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(PROJECT_ROOT, '..');

const CDP = process.env.QA_CDP || 'http://127.0.0.1:9222';
const PORT = Number(process.env.QA_PORT) || 8900;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const APP = process.env.QA_URL || `${URL_BASE}/nms-power-sim/index.html`;
const JSON_URL = process.env.QA_JSON || `${URL_BASE}/moj-scroll-screen.json`;

const R = { pass: 0, fail: 0, failures: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  console.log(`${cond ? '  [OK]' : '  [NG]'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}
function eq(name, a, b) { return ok(name, a === b, `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`); }

async function portUp() {
  try { const res = await fetch(`${URL_BASE}/`, { signal: AbortSignal.timeout(1500) }); return res.status < 500; }
  catch { return false; }
}
async function ensureServer() {
  if (await portUp()) { console.log('  · 复用已运行静态服务 8900'); return null; }
  const py = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: WORKSPACE, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { if (await portUp()) { console.log('  · 静态服务 8900 已启动'); return py; } await sleep(250); }
  throw new Error('静态服务 8900 启动失败');
}
async function ensureEdge() {
  try { await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) })).json(); return { proc: null }; }
  catch { /* 拉起 */ }
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
    .find((p) => fs.existsSync(p));
  if (!exe) throw new Error('找不到 msedge.exe');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa108w-edge-'));
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${new URL(CDP).port}`,
    `--user-data-dir=${dir.replace(/\\/g, '/')}`, '--remote-allow-origins=*', '--no-first-run',
    '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1000) })).json(); return { proc }; }
    catch { await sleep(250); }
  }
  throw new Error('headless Edge 启动失败');
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
}
const connect = (url) => new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(new Cdp(ws)); ws.onerror = () => rej(new Error('ws error')); });

const IMPORT_HIDDEN = path.join(os.tmpdir(), 'qa108_import_hidden.json');
const IMPORT_OLD = path.join(os.tmpdir(), 'qa108_import_old.json');
fs.writeFileSync(IMPORT_HIDDEN, JSON.stringify({
  simTime: 0, timeOfDay: 8, dayCycle: true, wireStyle: 'straight', wiresHidden: true,
  idSeq: 3, wireSeq: 1,
  elements: [
    { id: 'p1', type: 'power', x: 100, y: 100 },
    { id: 'l1', type: 'lamp', x: 320, y: 100 },
  ],
  wires: [],
}));
fs.writeFileSync(IMPORT_OLD, JSON.stringify({
  simTime: 0, timeOfDay: 8, dayCycle: true, wireStyle: 'straight',
  idSeq: 3, wireSeq: 1,
  elements: [
    { id: 'p1', type: 'power', x: 100, y: 100 },
    { id: 'l1', type: 'lamp', x: 320, y: 100 },
  ],
  wires: [],
}));

/* ============================== Part A · 应用 UI 级 ============================== */
const A_FN = `
  async () => {
    document.getElementById('view-switch').querySelector('[data-view="lab"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const btn = document.getElementById('btn-wires-hidden');
    const svg = document.getElementById('board');
    const stats = svg.__nmsRenderStats;
    const disp = (sel) => { const n = svg.querySelector(sel); return n ? getComputedStyle(n).display : null; };
    const out = { btnExists: !!btn };

    // 显示态先拖一条导线（快照 S1：hidden=false、0 条导线）
    const ports = [...svg.querySelectorAll('[data-port]')];
    const byPort = (el, pn) => ports.find((p) => p.getAttribute('data-el') === el && p.getAttribute('data-portname') === pn);
    const cOf = (n) => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
    const drag = async (from, to) => {
      from.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: cOf(from).x, clientY: cOf(from).y, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: cOf(to).x, clientY: cOf(to).y, bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: cOf(to).x, clientY: cOf(to).y, bubbles: true }));
      await new Promise((r) => setTimeout(r, 180));
    };
    const pOut = byPort('p1', 'out'), pIn = byPort('l1', 'in');
    out.nPorts = ports.length;
    if (pOut && pIn) await drag(pOut, pIn);
    out.wireAfterShownDrag = svg.querySelectorAll('.wire').length;

    // ---- A1 开启隐藏 ----
    const r0 = { rebuilds: stats.rebuilds, nodes: svg.querySelectorAll('*').length };
    btn.click();
    await new Promise((r) => setTimeout(r, 250));
    out.on = {
      aria: btn.getAttribute('aria-pressed'),
      active: btn.classList.contains('is-active'),
      cls: svg.classList.contains('wires-hidden'),
      wires: disp('.layer-wires'),
      jumps: disp('.layer-jumps'),
      elem: disp('.element'),
      port: disp('.port'),
      nodesDelta: svg.querySelectorAll('*').length - r0.nodes,
      rebuildsDelta: stats.rebuilds - r0.rebuilds,
    };

    // ---- A6 序列（先做，避免隐藏期拖线快照混入）：隐藏态拖动灯元件（S2：hidden=true、1 线）→
    //      关显示 → 撤销（→S2）→ 撤销（→S1）→ 重做（→S2 内容） ----
    const lampNode = svg.querySelector('[data-el="l1"]');
    if (lampNode) {
      const c = cOf(lampNode);
      lampNode.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: c.x, clientY: c.y, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: c.x + 40, clientY: c.y + 20, bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: c.x + 40, clientY: c.y + 20, bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
    }
    btn.click(); // 关闭显示
    await new Promise((r) => setTimeout(r, 200));
    document.getElementById('btn-undo').click();
    await new Promise((r) => setTimeout(r, 250));
    out.undo1 = { aria: btn.getAttribute('aria-pressed'), cls: svg.classList.contains('wires-hidden'), wires: disp('.layer-wires') };
    document.getElementById('btn-undo').click();
    await new Promise((r) => setTimeout(r, 250));
    out.undo2 = {
      aria: btn.getAttribute('aria-pressed'), cls: svg.classList.contains('wires-hidden'), wires: disp('.layer-wires'),
      wireCount: svg.querySelectorAll('.wire').length,
    };
    document.getElementById('btn-redo').click();
    await new Promise((r) => setTimeout(r, 250));
    out.redo1 = { aria: btn.getAttribute('aria-pressed'), cls: svg.classList.contains('wires-hidden') };
    // 重做后处于隐藏态（S2 内容），正好继续 A3/A4/A5 的隐藏期测试

    // ---- A3 隐藏期间连线预览（拖起不松手，回起点松开不建线）----
    // 注意：undo/redo 走 deserialize 全量重建 DOM，端口节点需重新查询
    const portNow = (el, pn) => [...svg.querySelectorAll('[data-port]')]
      .find((p) => p.getAttribute('data-el') === el && p.getAttribute('data-portname') === pn);
    const pOut2 = portNow('p1', 'out'), pIn2 = portNow('l1', 'in');
    if (pOut2 && pIn2) {
      pOut2.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: cOf(pOut2).x, clientY: cOf(pOut2).y, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: (cOf(pOut2).x + cOf(pIn2).x) / 2, clientY: (cOf(pOut2).y + cOf(pIn2).y) / 2, bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const pv = svg.querySelector('.wire-preview');
      out.previewDuringHidden = pv ? { exists: true, display: getComputedStyle(pv).display } : { exists: false };
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: cOf(pOut2).x, clientY: cOf(pOut2).y, bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
    } else {
      out.previewDuringHidden = { exists: false, reason: 'port not found' };
    }

    // ---- A4 隐藏期间框选 ----
    const rect = svg.getBoundingClientRect();
    const sx = rect.x + 40, sy = rect.y + 40;
    svg.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: sx, clientY: sy, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: sx + 120, clientY: sy + 80, bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const mq = svg.querySelector('.marquee-box');
    out.marqueeDuringHidden = mq ? { exists: true, display: getComputedStyle(mq).display } : { exists: false };
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: sx + 120, clientY: sy + 80, bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));

    // ---- A5 隐藏期间拖线到端口松手 → 建线（端口节点重新查询） ----
    const pOut3 = portNow('p1', 'out'), pIn3 = portNow('l1', 'in');
    if (pOut3 && pIn3) await drag(pOut3, pIn3);
    out.wireCountAfterHiddenDrag = svg.querySelectorAll('.wire').length;
    return out;
  }
`;

const IMPORT_FN = `
  async () => {
    const btn = document.getElementById('btn-wires-hidden');
    const svg = document.getElementById('board');
    const disp = (sel) => { const n = svg.querySelector(sel); return n ? getComputedStyle(n).display : null; };
    return {
      aria: btn.getAttribute('aria-pressed'),
      cls: svg.classList.contains('wires-hidden'),
      wires: disp('.layer-wires'),
      nEls: svg.querySelectorAll('.element').length,
    };
  }
`;

/* ============================== Part B · 机制级（MOJ） ============================== */
const B_FN = `
  async (jsonUrl) => {
    const u = (p) => new URL(p, location.href).href;
    const [eng, brd] = await Promise.all([import(u('js/engine.js')), import(u('js/board.js'))]);
    const engine = eng.createEngine();
    const text = await (await fetch(jsonUrl)).text();
    engine.deserialize(text);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'board');
    svg.style.cssText = 'width:1200px;height:800px;position:fixed;left:0;top:0;';
    document.body.appendChild(svg);
    const board = brd.createBoard(svg, engine, {});
    board.render();
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 10; i++) { engine.tick(1 / 60); board.render(); }
    engine.triggerButton('scroll_btn');

    board.setWiresHidden(true);
    board.render();
    // 点亮灯 = 图标填充色 #ffd23f（iconLamp：亮 #ffd23f / 灭 #9aa4ad）
    const litMapFromDom = () => {
      const s = new Set();
      for (const n of svg.querySelectorAll('.element-lamp rect[fill="#ffd23f"]')) {
        const elNode = n.closest('.element');
        if (elNode) s.add(elNode.getAttribute('data-el'));
      }
      return [...s].sort();
    };
    const litSetFromViews = () => {
      const s = new Set();
      for (const v of engine.getElementViews()) {
        const m = /^lamp_r(\\d+)c(\\d+)$/.exec(v.id);
        if (m && v.state && v.state.lit) s.add(m[0]);
      }
      return [...s].sort();
    };
    const samples = [];
    for (let s = 0; s < 90; s++) {
      for (let i = 0; i < 60; i++) engine.tick(1 / 60);
      board.render();
      samples.push({ views: litSetFromViews(), dom: litMapFromDom() });
    }
    const wiresDispHidden = getComputedStyle(svg.querySelector('.layer-wires')).display;

    const gridOf = (set) => {
      const g = Array.from({ length: 5 }, () => new Array(32).fill(false));
      for (const id of set) { const m = /r(\\d+)c(\\d+)/.exec(id); if (m) g[+m[1]][+m[2]] = true; }
      return g;
    };
    const setEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    // 稳态：samples[t] === samples[t-18] 连续 2 秒（t-18 ≥ 0 且 t+1 < N）
    let steady = -1;
    for (let t = 18; t + 1 < samples.length; t++) {
      if (setEq(samples[t].views, samples[t - 18].views) && setEq(samples[t + 1].views, samples[t - 17].views)) { steady = t; break; }
    }
    let scrollOk = null;
    if (steady >= 0) {
      scrollOk = true;
      for (let t = steady + 1; t < samples.length && scrollOk; t++) {
        const cur = gridOf(samples[t].views), prev = gridOf(samples[t - 1].views);
        for (let r = 0; r < 5 && scrollOk; r++)
          for (let c = 1; c < 32; c++)
            if (cur[r][c] !== prev[r][c - 1]) { scrollOk = false; break; }
      }
    }
    let domMatches = true, domChanges = false, firstMismatch = '';
    for (let t = 0; t < samples.length; t++) {
      if (!setEq(samples[t].views, samples[t].dom)) { domMatches = false; firstMismatch = '第' + t + 's dom=' + samples[t].dom.length + ' views=' + samples[t].views.length; break; }
      if (t > 0 && samples[t].dom.length !== samples[t - 1].dom.length) domChanges = true;
    }
    const maxLit = Math.max(...samples.map((s) => s.dom.length));
    const maxLitViews = Math.max(...samples.map((s) => s.views.length));
    // 诊断：首次 grid(t)==grid(t-18) 的 t 与逐 10 秒亮灯数
    let firstEqT = -1;
    for (let t = 18; t < samples.length; t++) {
      if (setEq(samples[t].views, samples[t - 18].views)) { firstEqT = t; break; }
    }
    const litTrace = samples.map((s) => s.views.length).filter((_, i) => i % 10 === 0).join(',');

    board.setWiresHidden(false);
    await raf(); await raf();
    const wiresDispBack = getComputedStyle(svg.querySelector('.layer-wires')).display;
    const poweredWires = svg.querySelectorAll('.wire.is-powered').length;
    const totalWires = svg.querySelectorAll('.wire').length;
    return {
      nEls: engine.getElements().length, nWires: engine.getWires().length,
      steady, scrollOk, domMatches, domChanges, firstMismatch, maxLit, maxLitViews,
      firstEqT, litTrace,
      wiresDispHidden, wiresDispBack, poweredWires, totalWires,
    };
  }
`;

/* ============================== 主流程 ============================== */
let server = null, edge = null, targetId = null;
try {
  console.log('===== QA Edward · 1.0.8 线条隐藏开关独立终验 (r2) =====');
  server = await ensureServer();
  edge = await ensureEdge();
  const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json().catch(() => null);
  const tab = created || (await (await fetch(`${CDP}/json/list`)).json())[0];
  targetId = tab.id;
  const page = await connect(tab.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  /* ---- Part A ---- */
  await page.send('Page.navigate', { url: APP });
  await sleep(1800);
  // 先经真实导入放入元件（旧 JSON：显示态、power + lamp）
  const doc = await page.send('DOM.getDocument');
  const node = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
  if (node.nodeId === 0) throw new Error('import input missing');
  await page.send('DOM.setFileInputFiles', { files: [IMPORT_OLD], nodeId: node.nodeId });
  await sleep(1200);

  let r = await page.send('Runtime.evaluate', { expression: `(${A_FN})()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('PartA 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  const a = r.result.value;

  console.log('  ---- A1 开关行为 ----');
  ok('工具栏按钮存在', a.btnExists);
  ok('画布已有元件与端口（导入生效）', a.nPorts >= 2, `ports=${a.nPorts}`);
  eq('显示态拖线创建导线成功（S1 前置）', a.wireAfterShownDrag, 1);
  eq('开启：aria-pressed=true', a.on.aria, 'true');
  eq('开启：is-active 高亮', a.on.active, true);
  eq('开启：svg 根 .wires-hidden 类', a.on.cls, true);
  eq('开启：.layer-wires display:none', a.on.wires, 'none');
  eq('开启：.layer-jumps display:none', a.on.jumps, 'none');
  ok('开启：元件保留可见', a.on.elem !== 'none', `display=${a.on.elem}`);
  ok('开启：端口点保留可见', a.on.port !== 'none', `display=${a.on.port}`);

  console.log('  ---- A2 O(1) 证明 ----');
  eq('开关一次零 DOM 增删', a.on.nodesDelta, 0);
  eq('开关一次零 rebuild', a.on.rebuildsDelta, 0);

  console.log('  ---- A3/A4/A5 隐藏期间预览 / 框选 / 连线 ----');
  ok('隐藏期间连线预览出现', a.previewDuringHidden.exists === true, JSON.stringify(a.previewDuringHidden));
  if (a.previewDuringHidden.exists) eq('隐藏期间连线预览可见', a.previewDuringHidden.display !== 'none', true);
  ok('隐藏期间框选框出现', a.marqueeDuringHidden.exists === true, JSON.stringify(a.marqueeDuringHidden));
  if (a.marqueeDuringHidden.exists) eq('隐藏期间框选框可见', a.marqueeDuringHidden.display !== 'none', true);
  ok('隐藏期间拖线到端口可创建导线', a.wireCountAfterHiddenDrag === 2, `wire 数=${a.wireCountAfterHiddenDrag}`);

  console.log('  ---- A6 撤销/重做 UI 同步（双向） ----');
  eq('撤销→S2（隐藏态快照）：aria-pressed=true', a.undo1.aria, 'true');
  eq('撤销→S2：svg 类恢复 .wires-hidden', a.undo1.cls, true);
  eq('撤销→S2：导线层恢复隐藏', a.undo1.wires, 'none');
  eq('撤销→S1（显示态快照）：aria-pressed=false', a.undo2.aria, 'false');
  eq('撤销→S1：svg 类移除', a.undo2.cls, false);
  ok('撤销→S1：导线层恢复显示', a.undo2.wires !== 'none', `display=${a.undo2.wires}`);
  eq('撤销→S1：导线已随快照回退（wire=0）', a.undo2.wireCount, 0);
  eq('重做（S2 态）：aria-pressed=true', a.redo1.aria, 'true');
  eq('重做：svg 类恢复', a.redo1.cls, true);

  /* ---- A7 导入同步 ---- */
  await page.send('DOM.setFileInputFiles', { files: [IMPORT_HIDDEN], nodeId: node.nodeId });
  await sleep(1200);
  r = await page.send('Runtime.evaluate', { expression: `(${IMPORT_FN})()`, returnByValue: true, awaitPromise: true });
  const h = r.result.value;
  console.log('  ---- A7 导入同步 ----');
  eq('导入含 wiresHidden:true 的 JSON → aria-pressed=true', h.aria, 'true');
  eq('导入含 wiresHidden:true 的 JSON → svg 类', h.cls, true);
  eq('导入含 wiresHidden:true 的 JSON → 导线层隐藏', h.wires, 'none');
  await page.send('DOM.setFileInputFiles', { files: [IMPORT_OLD], nodeId: node.nodeId });
  await sleep(1200);
  r = await page.send('Runtime.evaluate', { expression: `(${IMPORT_FN})()`, returnByValue: true, awaitPromise: true });
  const o = r.result.value;
  eq('导入旧 JSON（无字段）→ aria-pressed=false', o.aria, 'false');
  eq('导入旧 JSON（无字段）→ svg 类移除', o.cls, false);
  ok('导入旧 JSON → 导线层恢复显示', o.wires !== 'none', `display=${o.wires}`);
  ok('导入后元件已载入', o.nEls >= 2, `elements=${o.nEls}`);

  /* ---- Part B ---- */
  r = await page.send('Runtime.evaluate', { expression: `(${B_FN})(${JSON.stringify(JSON_URL)})`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('PartB 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  const b = r.result.value;

  console.log('  ---- B 隐藏期间 MOJ 滚动灯态（机制级） ----');
  ok('MOJ 大电路导入（≥300 元件 / ≥500 导线）', b.nEls >= 300 && b.nWires >= 500, `${b.nEls}/${b.nWires}`);
  ok('引擎侧确有灯点亮（视图非空）', b.maxLitViews > 0, `maxLitViews=${b.maxLitViews}`);
  ok('找到稳态（18 秒周期流充满窗口）', b.steady >= 0, `steady=${b.steady} firstEqT=${b.firstEqT} litTrace=${b.litTrace}`);
  eq('隐藏期间滚动语义正确（右移 1 列/秒，稳态后逐秒核对）', b.scrollOk, true);
  eq('隐藏期间 DOM 灯态逐秒与引擎一致（dynRev 门控未击穿）', b.domMatches, true, b.firstMismatch);
  ok('隐藏期间灯态画面持续变化（未被冻结）', b.domChanges);
  ok('隐藏期间 DOM 侧确有灯点亮', b.maxLit > 0, `maxLit=${b.maxLit}`);
  eq('隐藏全程导线层保持隐藏', b.wiresDispHidden, 'none');
  ok('恢复显示后导线层恢复', b.wiresDispBack !== 'none', `display=${b.wiresDispBack}`);
  ok('恢复显示后通电类正确（.wire.is-powered > 0）', b.poweredWires > 0, `${b.poweredWires}/${b.totalWires}`);
} catch (e) {
  R.fail++;
  R.failures.push('执行异常：' + (e && e.stack ? e.stack : e));
  console.log('  [NG] 执行异常: ' + (e && e.message));
} finally {
  if (targetId) { try { await fetch(`${CDP}/json/close/${targetId}`); } catch { /* ignore */ } }
  if (edge && edge.proc) { try { edge.proc.kill(); } catch { /* ignore */ } }
  if (server) { try { server.kill(); } catch { /* ignore */ } }
  try { fs.unlinkSync(IMPORT_HIDDEN); } catch { /* ignore */ }
  try { fs.unlinkSync(IMPORT_OLD); } catch { /* ignore */ }
}
console.log('\n===== 结果 =====');
console.log(`  通过 ${R.pass} / 失败 ${R.fail}（断言总数 ${R.pass + R.fail}）`);
if (R.failures.length) { console.log('  失败明细：'); R.failures.forEach((f) => console.log('   [NG] ' + f)); }
console.log(R.fail === 0 ? 'QA108_WIRES_PASS' : 'QA108_WIRES_FAILED');
process.exit(R.fail === 0 ? 0 : 1);
