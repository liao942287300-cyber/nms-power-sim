#!/usr/bin/env node
/**
 * tests/qa_wires_hidden_108.mjs
 * ---------------------------------------------------------------------------
 * NMS 电力模拟器 · 1.0.8 专项回归：线条隐藏开关 + 全景缩放机制自证
 *
 * 两部分：
 *   Part 1（独立搭 board，机制级）：
 *     A. 开关行为：svg 根类切换 / .layer-wires 与 .layer-jumps 计算样式隐藏 /
 *        元件与端口保留 / 交叉拱存在性。
 *     B. O(1) 证明：切换前后 stats.rebuilds / stats.incremental 零增量、
 *        DOM 节点总数不变、单次切换耗时 < 50ms。
 *     C. 拾取行为：显示时右键选线命中；隐藏期间选不中；恢复后照旧；
 *        隐藏时原选中导线自动取消选中。
 *     D. 持久化兼容：serialize 含 wiresHidden；deserialize 往返保留；
 *        旧 JSON（无字段）→ 默认显示；非法值回退显示。
 *     E. 门控完好：隐藏期间 tick 推进 → dynRev 门控刷新照常（恢复显示后
 *        导线通电类正确）；revision 门控不受开关影响（不触发 full）。
 *     F. 低缩放装饰削减：k < 0.55 → svg 根 is-far-zoom 类 → .wire-halos 与
 *        .layer-jumps 计算样式隐藏；k 回升 → 恢复。
 *     G. 视口剔除（moj-scroll-screen.json 大电路）：放大后 culled > 0；
 *        剔除态下视口外导线右键拾取仍命中（拾取查全量数据）；
 *        平移回视口后节点恢复显示。
 *   Part 2（真实应用页面 app.js UI 级）：
 *     H. 工具栏 #btn-wires-hidden 点击 → aria-pressed / is-active / svg 类；
 *        切换零 rebuild；适应视图按钮走 rAF 合帧零 rebuild。
 *
 * 依赖与环境约定与 perf_scroll.mjs 一致（QA_CDP / QA_URL / QA_JSON / QA_PORT）。
 * ---------------------------------------------------------------------------
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(PROJECT_ROOT, '..');
const JSON_PATH = path.join(WORKSPACE, 'moj-scroll-screen.json');

const CDP = process.env.QA_CDP || 'http://127.0.0.1:9222';
const PORT = Number(process.env.QA_PORT) || 8900;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const APP = process.env.QA_URL || `${URL_BASE}/nms-power-sim/index.html`;
const JSON_URL = process.env.QA_JSON || `${URL_BASE}/moj-scroll-screen.json`;

const R = { pass: 0, fail: 0, failures: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  console.log(`${cond ? '  \u2713' : '  \u2717'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}
function eq(name, a, b) { return ok(name, a === b, `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`); }

/* ============================== 服务与浏览器 ============================== */

async function portUp() {
  try {
    const res = await fetch(`${URL_BASE}/`, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch { return false; }
}

async function ensureServer() {
  if (await portUp()) { console.log('  · 复用已运行的静态服务 8900'); return null; }
  const py = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: WORKSPACE, stdio: 'ignore',
  });
  py.on('error', () => { /* 拉起失败由后续 fetch 探测报告 */ });
  for (let i = 0; i < 40; i++) {
    if (await portUp()) { console.log('  · 已自动启动静态服务 8900（cwd=项目父目录）'); return py; }
    await sleep(250);
  }
  throw new Error('静态服务 8900 启动失败');
}

async function ensureEdge() {
  try {
    const ver = await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) })).json();
    console.log('  · 复用已运行的 CDP 端点 9222');
    return { proc: null, wsUrl: ver.webSocketDebuggerUrl };
  } catch { /* 不在线，自动拉起 */ }

  const candidates = [
    process.env.EDGE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  const exe = candidates.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('找不到 msedge.exe，可设 EDGE_PATH 环境变量');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-hide-edge-'));
  const proc = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${new URL(CDP).port}`,
    `--user-data-dir=${dir.replace(/\\/g, '/')}`,
    '--remote-allow-origins=*',
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1600,1000',
    'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      const ver = await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1000) })).json();
      console.log('  · 已自动启动 headless Edge（CDP 9222）');
      return { proc, wsUrl: ver.webSocketDebuggerUrl };
    } catch { await sleep(250); }
  }
  throw new Error('headless Edge 启动失败（CDP 9222 未就绪）');
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(new Cdp(ws));
    ws.onerror = () => reject(new Error('ws error'));
  });
}

/* ============================== Part 1 · 机制级 ============================== */
/**
 * 电路拓扑（直线走线，保证一个正交交叉 → 一条交叉拱）：
 *   S1.wall_switch(0,0).b  ──水平 y=4──  S2.wall_switch(240,0).a
 *   P1.power(120,-160).out ──垂直 x=120── P2.power(120,160).out（两电源互联 → 恒通电）
 *   S2.b(274,4) ── L1.lamp(400,0).in(400,34)
 * 垂直 wire 在 (120,4) 穿过水平 wire 内部 → 交叉拱归 id 数值较大的一条。
 */
const PART1_FN = `
  async () => {
    const u = (p) => new URL(p, location.href).href;
    const [eng, brd] = await Promise.all([import(u('js/engine.js')), import(u('js/board.js'))]);
    const engine = eng.createEngine();
    engine.addElement('wall_switch', { id: 's1', x: 0, y: 0 });
    engine.addElement('wall_switch', { id: 's2', x: 240, y: 0 });
    engine.addElement('power', { id: 'p1', x: 120, y: -160 });
    engine.addElement('power', { id: 'p2', x: 120, y: 160 });
    engine.addElement('lamp', { id: 'l1', x: 400, y: 0 });
    engine.addWire('s1', 'b', 's2', 'a');   // w1 水平
    engine.addWire('p1', 'out', 'p2', 'out'); // w2 垂直（交叉 + 恒通电）
    engine.addWire('s2', 'b', 'l1', 'in');  // w3 斜线
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'board'); // 与应用一致：CSS 选择器 .board.wires-hidden …
    svg.style.cssText = 'width:1200px;height:800px;position:fixed;left:0;top:0;';
    document.body.appendChild(svg);
    const board = brd.createBoard(svg, engine, {});
    board.render();
    for (let i = 0; i < 10; i++) { engine.tick(1 / 60); board.render(); } // 预热
    const raf = () => new Promise((r) => requestAnimationFrame(r));

    const stats = svg.__nmsRenderStats;
    const disp = (sel) => {
      const n = svg.querySelector(sel);
      return n ? getComputedStyle(n).display : null;
    };
    const ctxPick = (cx, cy) => {
      svg.dispatchEvent(new MouseEvent('contextmenu', { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    };
    const r0 = { rebuilds: stats.rebuilds, incremental: stats.incremental, nodes: svg.querySelectorAll('*').length };

    // ---- A. 初始态 ----
    const init = {
      hasClass: svg.classList.contains('wires-hidden'),
      wiresDisp: disp('.layer-wires'),
      jumpsDisp: disp('.layer-jumps'),
      arcCount: svg.querySelectorAll('.jump-arc').length,
      elemDisp: disp('.element'),
      portDisp: disp('.port'),
    };

    // ---- C1. 显示态拾取：右键 (120,4)（w1/w2 交叉点）----
    ctxPick(120, 4);
    const pickShown = board.getSelection();

    // ---- B+C2. 开启隐藏 ----
    const t0 = performance.now();
    board.setWiresHidden(true);
    const toggleMs = performance.now() - t0;
    await raf();
    const hidden = {
      hasClass: svg.classList.contains('wires-hidden'),
      wiresDisp: disp('.layer-wires'),
      jumpsDisp: disp('.layer-jumps'),
      elemDisp: disp('.element'),
      portDisp: disp('.port'),
      pick: (ctxPick(120, 4), board.getSelection()),
      selAfterHide: pickShown && pickShown.kind === 'wire' ? board.getSelection() : 'n/a',
      childCountSame: svg.querySelectorAll('*').length === r0.nodes,
      rebuildsDelta: stats.rebuilds - r0.rebuilds,
      incrDelta: stats.incremental - r0.incremental,
      toggleMs,
    };

    // ---- E. 隐藏期间动态刷新门控照常（tick 后恢复显示，通电类正确）----
    for (let i = 0; i < 10; i++) engine.tick(1 / 60);
    board.render();
    board.setWiresHidden(false);
    await raf();
    // w2 连接两个电源 out → 恒通电；其 .wire 类应含 is-powered
    const poweredWires = svg.querySelectorAll('.wire.is-powered').length;
    const wiresDispBack = disp('.layer-wires');
    const jumpsDispBack = disp('.layer-jumps');

    // ---- C3. 恢复后拾取照旧 ----
    ctxPick(120, 4);
    const pickRestored = board.getSelection();

    // ---- D. 持久化 ----
    engine.setWiresHidden(true);
    const ser = engine.serialize();
    const e2 = eng.createEngine();
    const roundtrip = e2.deserialize(JSON.parse(JSON.stringify(ser))) && e2.getWiresHidden() === true;
    // 旧 JSON 兼容：删字段 → 默认显示
    const old = JSON.parse(JSON.stringify(ser));
    delete old.wiresHidden;
    const e3 = eng.createEngine();
    const oldCompat = e3.deserialize(old) && e3.getWiresHidden() === false;
    // 非法值回退显示
    const bad = JSON.parse(JSON.stringify(ser));
    bad.wiresHidden = 'yes';
    const e4 = eng.createEngine();
    const badCompat = e4.deserialize(bad) && e4.getWiresHidden() === false;
    // serializeJSON 字符串含字段
    engine.setWiresHidden(false);
    const jsonHasField = /"wiresHidden"\\s*:\\s*false/.test(engine.serializeJSON());
    // setWiresHidden 不动修订号
    const rev0 = engine.getRevision();
    const dyn0 = engine.getDynRev();
    engine.setWiresHidden(true);
    const revUnchanged = engine.getRevision() === rev0 && engine.getDynRev() === dyn0;
    engine.setWiresHidden(false);

    // ---- F. 低缩放装饰削减 ----
    board.zoomAt(0.5, 600, 400); // k=0.5 < 0.55
    board.render(); // 应用主循环每帧 render；独立 board 需手动驱动（剔除/削减在渲染阶段执行）
    await raf();
    const far = {
      cls: svg.classList.contains('is-far-zoom'),
      halosDisp: disp('.wire-halos'),
      jumpsDisp: disp('.layer-jumps'),
      labelDisp: disp('.el-label'),
      k: board.getView().k,
    };
    board.zoomAt(2, 600, 400); // k=1.0
    board.render();
    await raf();
    const back = {
      cls: svg.classList.contains('is-far-zoom'),
      halosDisp: disp('.wire-halos'),
      k: board.getView().k,
    };

    return { init, pickShown, hidden, poweredWires, wiresDispBack, jumpsDispBack,
      pickRestored, ser: { wiresHidden: ser.wiresHidden }, roundtrip, oldCompat, badCompat,
      jsonHasField, revUnchanged, far, back,
      api: { hasGet: typeof board.getWiresHidden === 'function', hasSet: typeof board.setWiresHidden === 'function' } };
  }
`;

/* ============================== Part 1b · 大电路剔除 ============================== */
const PART1B_FN = `
  async (jsonUrl) => {
    const u = (p) => new URL(p, location.href).href;
    const [eng, brd, cat] = await Promise.all([
      import(u('js/engine.js')), import(u('js/board.js')), import(u('js/catalog.js')),
    ]);
    const engine = eng.createEngine();
    const text = await (await fetch(jsonUrl)).text();
    engine.deserialize(text);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'width:1200px;height:800px;position:fixed;left:0;top:0;';
    document.body.appendChild(svg);
    const board = brd.createBoard(svg, engine, {});
    board.render();
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 10; i++) { engine.tick(1 / 60); board.render(); }
    const stats = svg.__nmsRenderStats;
    const r0 = { rebuilds: stats.rebuilds };

    // fit 全景（k 通常 < 0.55 → 装饰削减生效）
    board.fitToContent();
    await raf(); await raf();
    const culledFit = stats.culled;
    const kFit = board.getView().k;
    // 放大 3 倍 → 大量节点移出视口
    board.zoomAt(3, 600, 400);
    board.render(); // 应用主循环每帧 render；独立 board 手动驱动剔除扫描
    await raf(); await raf();
    const culledZoom = stats.culled;
    const k = board.getView().k;

    // 剔除态下视口外导线拾取仍命中（pickWire 查全量 wireGeom，而非仅可见节点）：
    // 用端口偏移精确计算导线中点（在世界坐标必然落在线段上），要求其中点在
    // 视口外 ≥400px（远超剔除边距 160px + 包围盒余量 13px → 必然被剔除），
    // 然后按该点的真实 client 坐标（可为负/超界）派发 contextmenu。
    const wires = engine.getWires();
    const els = new Map(engine.getElements().map((e) => [e.id, e]));
    let picked = null;
    for (const w of wires) {
      const a = els.get(w.a.el);
      const b = els.get(w.b.el);
      if (!a || !b) continue;
      const oa = cat.portOffset(a.type, w.a.port);
      const ob = cat.portOffset(b.type, w.b.port);
      const pa = { x: a.x + oa.dx, y: a.y + oa.dy };
      const pb = { x: b.x + ob.dx, y: b.y + ob.dy };
      const mx = (pa.x + pb.x) / 2;
      const my = (pa.y + pb.y) / 2;
      const c = board.worldToClient(mx, my);
      if (c.x < -400 || c.x > 1600 || c.y < -400 || c.y > 1200) {
        svg.dispatchEvent(new MouseEvent('contextmenu', {
          clientX: c.x, clientY: c.y, bubbles: true, cancelable: true,
        }));
        const sel = board.getSelection();
        if (sel && sel.kind === 'wire') {
          picked = { wireSel: true, id: sel.id, mx: Math.round(mx), my: Math.round(my) };
          break;
        }
      }
    }
    // 复位视图：被剔除节点恢复显示（display:none 内联样式清空）
    const hiddenBefore = svg.querySelectorAll('[style*="display: none"], [style*="display:none"]').length;
    board.fitToContent(); // 全图缩放进视口 → 剔除集应清空
    await raf(); await raf();
    const hiddenAfter = svg.querySelectorAll('[style*="display: none"], [style*="display:none"]').length;
    const rebuildsDelta = stats.rebuilds - r0.rebuilds;
    return { nEls: engine.getElements().length, nWires: engine.getWires().length,
      culledFit, kFit, culledZoom, k, picked, hiddenBefore, hiddenAfter, rebuildsDelta };
  }
`;

/* ============================== Part 2 · 应用 UI 级 ============================== */
const PART2_FN = `
  async () => {
    document.getElementById('view-switch').querySelector('[data-view="lab"]').click();
    await new Promise((r) => setTimeout(r, 300));
    const btn = document.getElementById('btn-wires-hidden');
    const svg = document.getElementById('board');
    const stats = svg.__nmsRenderStats;
    const disp = (sel) => {
      const n = svg.querySelector(sel);
      return n ? getComputedStyle(n).display : null;
    };
    const r0 = { rebuilds: stats.rebuilds };
    btn.click();
    await new Promise((r) => setTimeout(r, 200));
    const afterOn = {
      exists: !!btn,
      aria: btn.getAttribute('aria-pressed'),
      active: btn.classList.contains('is-active'),
      svgCls: svg.classList.contains('wires-hidden'),
      wiresDisp: disp('.layer-wires'),
      jumpsDisp: disp('.layer-jumps'),
      rebuildsDelta: stats.rebuilds - r0.rebuilds,
    };
    btn.click();
    await new Promise((r) => setTimeout(r, 200));
    const afterOff = {
      aria: btn.getAttribute('aria-pressed'),
      active: btn.classList.contains('is-active'),
      svgCls: svg.classList.contains('wires-hidden'),
      wiresDisp: disp('.layer-wires'),
      rebuildsDelta: stats.rebuilds - r0.rebuilds,
    };
    // 适应视图按钮：纯视图操作零 rebuild（空画布 fit）
    document.getElementById('btn-fit').click();
    await new Promise((r) => setTimeout(r, 200));
    const fitRebuildsDelta = stats.rebuilds - r0.rebuilds;
    return { afterOn, afterOff, fitRebuildsDelta };
  }
`;

/* ============================== 主流程 ============================== */
let server = null;
let edge = null;
let targetId = null;
try {
  console.log('===== 1.0.8 专项回归：线条隐藏开关 + 全景缩放机制 =====');
  server = await ensureServer();
  edge = await ensureEdge();

  const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json().catch(() => null);
  const target = await (await fetch(`${CDP}/json/list`)).json();
  const tab = created || target[0];
  targetId = tab.id;
  const page = await connect(tab.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  /* ---------------- Part 1：机制级 ---------------- */
  await page.send('Page.navigate', { url: APP });
  await sleep(1500);
  let r = await page.send('Runtime.evaluate', {
    expression: `(${PART1_FN})()`, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error('Part1 求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  let m = r.result.value;

  console.log('  ---- A. 开关行为（初始态） ----');
  ok('board 暴露 setWiresHidden/getWiresHidden API', m.api.hasGet && m.api.hasSet);
  eq('初始未隐藏（svg 无 wires-hidden 类）', m.init.hasClass, false);
  ok('初始导线层可见', m.init.wiresDisp !== 'none', `display=${m.init.wiresDisp}`);
  ok('初始交叉拱层可见', m.init.jumpsDisp !== 'none', `display=${m.init.jumpsDisp}`);
  ok('测试电路存在交叉拱（.jump-arc > 0）', m.init.arcCount > 0, `count=${m.init.arcCount}`);

  console.log('  ---- B. O(1) 切换证明 ----');
  eq('开启隐藏：svg 根类切换', m.hidden.hasClass, true);
  eq('开启隐藏：.layer-wires 计算样式 display:none', m.hidden.wiresDisp, 'none');
  eq('开启隐藏：.layer-jumps 计算样式 display:none', m.hidden.jumpsDisp, 'none');
  ok('开启隐藏：元件保留可见', m.hidden.elemDisp !== 'none', `display=${m.hidden.elemDisp}`);
  ok('开启隐藏：端口点保留可见', m.hidden.portDisp !== 'none', `display=${m.hidden.portDisp}`);
  eq('切换零 DOM 增删（节点总数不变）', m.hidden.childCountSame, true);
  eq('切换零 rebuild（rebuilds 增量 = 0）', m.hidden.rebuildsDelta, 0);
  eq('切换零增量结构更新（incremental 增量 = 0）', m.hidden.incrDelta, 0);
  ok('单次切换 < 50ms（O(1) 级）', m.hidden.toggleMs < 50, `${m.hidden.toggleMs.toFixed(2)}ms`);

  console.log('  ---- C. 拾取行为 ----');
  ok('显示态右键命中导线', !!(m.pickShown && m.pickShown.kind === 'wire'), JSON.stringify(m.pickShown));
  eq('隐藏期间右键选不中导线', m.hidden.pick, null);
  eq('隐藏时原选中导线自动取消选中', m.hidden.selAfterHide, null);
  ok('恢复显示后拾取照旧', !!(m.pickRestored && m.pickRestored.kind === 'wire'), JSON.stringify(m.pickRestored));

  console.log('  ---- E. 动态刷新门控完好 ----');
  ok('恢复显示后导线通电类正确（.wire.is-powered > 0）', m.poweredWires > 0, `count=${m.poweredWires}`);
  eq('恢复显示后导线层恢复可见', m.wiresDispBack !== 'none', true);
  eq('恢复显示后交叉拱层恢复可见', m.jumpsDispBack !== 'none', true);

  console.log('  ---- D. 持久化与向后兼容 ----');
  eq('serialize 含 wiresHidden=true', m.ser.wiresHidden, true);
  eq('deserialize 往返保留 wiresHidden', m.roundtrip, true);
  eq('旧 JSON（无 wiresHidden 字段）→ 默认显示', m.oldCompat, true);
  eq('非法值（"yes"）→ 回退显示', m.badCompat, true);
  eq('serializeJSON 字符串含字段', m.jsonHasField, true);
  eq('setWiresHidden 不动 revision/dynRev 门控', m.revUnchanged, true);

  console.log('  ---- F. 低缩放装饰削减 ----');
  eq('k=0.5 < 0.55 → is-far-zoom 类', m.far.cls, true);
  eq('低缩放：halo 底衬层隐藏', m.far.halosDisp, 'none');
  eq('低缩放：交叉拱层隐藏', m.far.jumpsDisp, 'none');
  eq('低缩放：元件名称标签隐藏（装饰削减）', m.far.labelDisp, 'none');
  eq('k 回升 → is-far-zoom 移除', m.back.cls, false);
  eq('回升后 halo 层恢复可见', m.back.halosDisp !== 'none', true);

  /* ---------------- Part 1b：大电路剔除 ---------------- */
  r = await page.send('Runtime.evaluate', {
    expression: `(${PART1B_FN})(${JSON.stringify(JSON_URL)})`, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error('Part1b 求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  const g = r.result.value;

  console.log('  ---- G. 视口剔除（moj-scroll-screen.json） ----');
  ok(`大电路导入（${g.nEls} 元件 / ${g.nWires} 导线）`, g.nEls >= 300 && g.nWires >= 500);
  ok('fit 后剔除计数可用（stats.culled 暴露）', typeof g.culledFit === 'number');
  ok('放大 k=3 后大量节点被剔除（culled > 100）', g.culledZoom > 100,
    `culled=${g.culledZoom} @k=${g.k?.toFixed(2)}`);
  ok('剔除态下视口外导线右键拾取仍命中（全量数据）',
    !!(g.picked && g.picked.wireSel), JSON.stringify(g.picked));
  ok('平移/复位视口后被剔除节点恢复显示', g.hiddenAfter < g.hiddenBefore,
    `display:none 节点 ${g.hiddenBefore} → ${g.hiddenAfter}`);
  eq('fit/zoom/复位全程零 rebuild', g.rebuildsDelta, 0);

  /* ---------------- Part 2：应用 UI 级 ---------------- */
  await page.send('Page.navigate', { url: APP });
  await sleep(1800);
  r = await page.send('Runtime.evaluate', {
    expression: `(${PART2_FN})()`, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error('Part2 求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  const a = r.result.value;

  console.log('  ---- H. 应用工具栏按钮（app.js UI 级） ----');
  ok('工具栏按钮存在', a.afterOn.exists);
  eq('开启：aria-pressed=true', a.afterOn.aria, 'true');
  eq('开启：按钮 is-active 高亮', a.afterOn.active, true);
  eq('开启：svg 根 wires-hidden 类', a.afterOn.svgCls, true);
  eq('开启：.layer-wires 隐藏', a.afterOn.wiresDisp, 'none');
  eq('开启：.layer-jumps 隐藏', a.afterOn.jumpsDisp, 'none');
  eq('关闭：aria-pressed=false', a.afterOff.aria, 'false');
  eq('关闭：svg 类移除', a.afterOff.svgCls, false);
  eq('关闭：.layer-wires 恢复', a.afterOff.wiresDisp !== 'none', true);
  eq('UI 切换零 rebuild（开+关）', a.afterOff.rebuildsDelta, 0);
  eq('适应视图按钮零 rebuild（rAF 合帧路径）', a.fitRebuildsDelta, 0);
} catch (e) {
  R.fail++;
  R.failures.push('执行异常：' + (e && e.stack ? e.stack : e));
  console.log('  \u2717 执行异常: ' + (e && e.message));
} finally {
  if (targetId) { try { await fetch(`${CDP}/json/close/${targetId}`); } catch { /* ignore */ } }
  if (edge && edge.proc) { try { edge.proc.kill(); } catch { /* ignore */ } }
  if (server) { try { server.kill(); } catch { /* ignore */ } }
}

console.log('\n===== 结果 =====');
console.log(`  通过 ${R.pass} / 失败 ${R.fail}（断言总数 ${R.pass + R.fail}）`);
if (R.failures.length) { console.log('  失败明细：'); R.failures.forEach((f) => console.log('   \u2717 ' + f)); }
console.log(R.fail === 0 ? 'WIRES_HIDDEN_TESTS_PASS' : 'WIRES_HIDDEN_TESTS_FAILED');
process.exit(R.fail === 0 ? 0 : 1);
