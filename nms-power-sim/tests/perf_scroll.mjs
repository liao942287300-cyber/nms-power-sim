#!/usr/bin/env node
/**
 * tests/perf_scroll.mjs
 * ---------------------------------------------------------------------------
 * NMS 电力模拟器 · 大电路主循环性能对比（1.0.5 性能修复回归）
 *
 * 场景：导入 moj-scroll-screen.json（376 元件 / 620 导线）后，运行中主循环
 *       每帧执行 engine.tick(FIXED_DT) + board.render()。1.0.4 的
 *       computeStructureSig() 每帧把全部元件/导线拼成大字符串再比较，
 *       叠加 tick 每帧新建 keys 数组 / 并查集 Map / newPowered Set，
 *       大电路上每帧堆分配与 GC 压力大。
 *
 * 三项测量（headless 浏览器 + Node 双侧）：
 *   A. 浏览器 CPU：稳定帧 tick / render / 交错单帧平均耗时（断言 < 8ms 预算）。
 *   B. 机制计数：稳定帧期间 engine.getElements()/getWires() 全量枚举调用次数
 *      —— 1.0.4 每帧各 1 次（供字符串指纹拼接），修复后应为 0
 *      （结构比对改为 O(1) 的 getRevision()）。
 *   C. GC churn（Node 侧，perf_hooks 的 'gc' 条目 = V8 真实 GC 事件）：
 *      纯 engine 连续 tick 2000 次的 Scavenge 次数 / GC 总耗时 / tick CPU。
 *      1.0.4 的 keys 数组 / 并查集 Map / newPowered Set 每帧分配直接体现为
 *      更频繁的 Scavenge；修复后 keys 缓存 + 容器复用应显著减少。
 *
 * 依赖（与 browser.smoke.mjs 同一套环境约定）：
 *   · 静态服务：python -m http.server 8900 --bind 127.0.0.1
 *       （cwd 必须是项目父目录 —— 本脚本需要同时取到
 *         /nms-power-sim/index.html 与 /moj-scroll-screen.json；
 *         端口未监听时脚本会自动以正确 cwd 拉起服务）
 *   · 无头浏览器：脚本自动拉起 msedge --headless=new + CDP，
 *     也可用环境变量 QA_CDP 指向已运行的调试端点。
 *
 * 用法：
 *   node tests/perf_scroll.mjs                     # 测当前代码并与基线对比
 *   node tests/perf_scroll.mjs --save-baseline     # 把当前结果存为基线（修复前跑一次）
 *
 * 可选环境变量：QA_CDP / QA_URL / QA_JSON / QA_PORT
 * ---------------------------------------------------------------------------
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');            // nms-power-sim/
const WORKSPACE = path.resolve(PROJECT_ROOT, '..');       // 项目父目录（JSON 所在）
const BASELINE_FILE = path.join(HERE, 'perf_scroll.baseline.json');
const JSON_PATH = path.join(WORKSPACE, 'moj-scroll-screen.json');

const CDP = process.env.QA_CDP || 'http://127.0.0.1:9222';
const PORT = Number(process.env.QA_PORT) || 8900;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const APP = process.env.QA_URL || `${URL_BASE}/nms-power-sim/index.html`;
const JSON_URL = process.env.QA_JSON || `${URL_BASE}/moj-scroll-screen.json`;

const FRAME_BUDGET_MS = 8;   // 单帧（tick + render）平均耗时预算
const TICKS = 2000;          // GC churn 基准的 tick 次数
const STABLE_FRAMES = 60;    // 机制计数用的稳定帧数

/* ============================== 辅助断言 ============================== */
const R = { pass: 0, fail: 0, failures: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  console.log(`${cond ? '  \u2713' : '  \u2717'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}

/* ============================== C. GC churn 基准（Node 侧） ============================== */
/**
 * 直接在 Node 中 import 纯仿真内核 engine.js，连续 tick 并用 perf_hooks 的
 * 'gc' 条目统计真实 GC 事件。engine.js 零 DOM 依赖，Node 与浏览器内行为一致。
 */
async function benchTickGc() {
  const { createEngine } = await import(pathToFileUrl(path.join(PROJECT_ROOT, 'js', 'engine.js')));
  const engine = createEngine();
  const data = fs.readFileSync(JSON_PATH, 'utf8');
  ok('Node 侧大电路 JSON 导入成功', engine.deserialize(data) === true,
    `${engine.getElements().length} 元件 / ${engine.getWires().length} 导线`);

  // 预热：触发 JIT 编译
  for (let i = 0; i < 500; i++) engine.tick(1 / 60);

  let scavenge = 0, major = 0, gcDurationMs = 0;
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      // kind: 1=Scavenge(_minor) 2=MarkCompact 4=MarkSweepCompact 8/16=增量
      if (e.kind === 1) scavenge++;
      else if (e.kind === 2 || e.kind === 4) major++;
      gcDurationMs += e.duration;
    }
  });
  obs.observe({ entryTypes: ['gc'] });

  const t0 = performance.now();
  for (let i = 0; i < TICKS; i++) engine.tick(1 / 60);
  const wallMs = performance.now() - t0;
  await sleep(50); // 等待 GC 观察条目派发完毕
  obs.disconnect();

  return {
    ticks: TICKS,
    scavenge, major,
    gcDurationMs: Number(gcDurationMs.toFixed(2)),
    tickCpuMs: Number((wallMs / TICKS).toFixed(4)),
  };
}
function pathToFileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
}

/* ============================== 服务与浏览器 ============================== */

/** 探测端口是否有 HTTP 服务在监听。 */
async function portUp() {
  try {
    const res = await fetch(`${URL_BASE}/`, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch { return false; }
}

/** 若 8900 端口空闲，则以「项目父目录」为 cwd 拉起 python http.server。 */
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

/** 拉起 headless Edge（全新 user-data-dir），返回 { proc, wsUrl }。 */
async function ensureEdge() {
  // 已有调试端点 → 直接复用
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-perf-edge-'));
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

/* ============================== CDP 最小客户端 ============================== */
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

/* ============================== 浏览器内测量（页面内执行） ============================== */
/**
 * 搭建场景（导入大电路 → 建画布 → 预热 → CPU 采样）。
 * 结构未变化的稳定帧不应再做全量结构枚举（getElements/getWires），
 * 计数器直接验证 computeStructureSig 替代路径是否生效。
 */
const MEASURE_FN = `
  async (jsonUrl, stableFrames) => {
    const u = (p) => new URL(p, location.href).href;
    const [eng, brd] = await Promise.all([import(u('js/engine.js')), import(u('js/board.js'))]);
    const engine = eng.createEngine();
    const text = await (await fetch(jsonUrl)).text();
    const imported = engine.deserialize(text);
    const nElements = engine.getElements().length; // 规模快照（包计数代理前取）
    const nWires = engine.getWires().length;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.width = '1200px'; svg.style.height = '800px';
    document.body.appendChild(svg);
    const board = brd.createBoard(svg, engine, {});
    board.render(); // 首帧：结构重建（不计入采样）

    // 机制计数：包一层计数代理（只统计调用次数，不改行为）
    let getElementsCalls = 0, getWiresCalls = 0;
    const rawGetElements = engine.getElements.bind(engine);
    const rawGetWires = engine.getWires.bind(engine);
    engine.getElements = (...a) => { getElementsCalls++; return rawGetElements(...a); };
    engine.getWires = (...a) => { getWiresCalls++; return rawGetWires(...a); };

    // 预热 60 帧：触发 JIT 与图标母本缓存
    for (let i = 0; i < 60; i++) { engine.tick(1 / 60); board.render(); }
    // 计数起点：预热后归零，统计稳定帧
    getElementsCalls = 0; getWiresCalls = 0;
    for (let i = 0; i < stableFrames; i++) { engine.tick(1 / 60); board.render(); }
    const stableGetElementsCalls = getElementsCalls;
    const stableGetWiresCalls = getWiresCalls;

    // CPU 采样（N = 300）
    const N = 300;
    let t0 = performance.now();
    for (let i = 0; i < N; i++) engine.tick(1 / 60);
    const tickAvg = (performance.now() - t0) / N;
    t0 = performance.now();
    for (let i = 0; i < N; i++) board.render();
    const renderAvg = (performance.now() - t0) / N;
    t0 = performance.now();
    for (let i = 0; i < N; i++) { engine.tick(1 / 60); board.render(); }
    const frameAvg = (performance.now() - t0) / N;

    // 结构修订号 API 行为自检
    const hasRevisionApi = typeof engine.getRevision === 'function';
    let revisionBumpsOnAdd = null;
    if (hasRevisionApi) {
      const r0 = engine.getRevision();
      engine.addElement('lamp');
      revisionBumpsOnAdd = engine.getRevision() === r0 + 1;
    }
    return {
      imported,
      elements: nElements,
      wires: nWires,
      tickAvg, renderAvg, frameAvg,
      stableGetElementsCalls, stableGetWiresCalls,
      hasRevisionApi,
      revisionBumpsOnAdd,
    };
  }
`;

/* ============================== 主流程 ============================== */
const saveBaseline = process.argv.includes('--save-baseline');
let server = null;
let edge = null;
let targetId = null;
try {
  console.log('===== 大电路主循环性能对比（moj-scroll-screen.json） =====');

  /* ---- C. Node 侧 GC churn ---- */
  const g = await benchTickGc();
  console.log(`  [Node] ${g.ticks} 次 tick：Scavenge ${g.scavenge} 次 / Major ${g.major} 次`
    + ` / GC 总耗时 ${g.gcDurationMs}ms / tick CPU ${g.tickCpuMs}ms`);

  /* ---- A + B. 浏览器侧 ---- */
  server = await ensureServer();
  edge = await ensureEdge();

  // 优先新建一个干净标签页，避免复用可能被占用的页面
  const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json().catch(() => null);
  const target = await (await fetch(`${CDP}/json/list`)).json();
  const tab = created || target[0];
  targetId = tab.id;
  const page = await connect(tab.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: APP });
  await sleep(1500); // 等模块树加载完毕

  const r = await page.send('Runtime.evaluate', {
    expression: `(${MEASURE_FN})(${JSON.stringify(JSON_URL)}, ${STABLE_FRAMES})`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  const m = r.result.value;

  console.log(`  导入 ${m.imported ? '成功' : '失败'}：元件 ${m.elements} / 导线 ${m.wires}`);
  console.log(`  [浏览器] tick   平均 ${m.tickAvg.toFixed(3)} ms`);
  console.log(`  [浏览器] render 平均 ${m.renderAvg.toFixed(3)} ms（结构未变化的稳定帧）`);
  console.log(`  [浏览器] 单帧   平均 ${m.frameAvg.toFixed(3)} ms（tick + render 交错）`);
  console.log(`  [机制] ${STABLE_FRAMES} 个稳定帧内 getElements 调用 ${m.stableGetElementsCalls} 次`
    + ` / getWires 调用 ${m.stableGetWiresCalls} 次`);

  /* ---------------- 断言 ---------------- */
  ok('大电路 JSON 导入成功', m.imported === true, `${m.elements} 元件 / ${m.wires} 导线`);
  ok('大电路规模符合预期（≥300 元件 / ≥500 导线）', m.elements >= 300 && m.wires >= 500);
  ok('engine 暴露 getRevision()（1.0.5 结构修订号）', m.hasRevisionApi === true);
  ok('结构修订号随 addElement 自增', m.revisionBumpsOnAdd === true);
  ok(`单帧平均 < ${FRAME_BUDGET_MS}ms`, m.frameAvg < FRAME_BUDGET_MS, `${m.frameAvg.toFixed(3)}ms`);
  ok(`稳定帧不做全量结构枚举（getElements = 0 / ${STABLE_FRAMES} 帧）`,
    m.stableGetElementsCalls === 0, `实际 ${m.stableGetElementsCalls} 次`);
  ok(`稳定帧不做全量导线枚举（getWires = 0 / ${STABLE_FRAMES} 帧）`,
    m.stableGetWiresCalls === 0, `实际 ${m.stableGetWiresCalls} 次`);

  if (saveBaseline) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({
      savedAt: new Date().toISOString(),
      note: '修复前基线（computeStructureSig 字符串指纹 + tick 每帧分配）',
      ...g, ...m,
    }, null, 2));
    console.log(`  · 基线已保存：${BASELINE_FILE}`);
  } else if (fs.existsSync(BASELINE_FILE)) {
    const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    console.log(`  基线（修复前 ${base.savedAt}）：`
      + `单帧 ${base.frameAvg?.toFixed?.(3)}ms / Scavenge ${base.scavenge} 次 / GC ${base.gcDurationMs}ms`
      + ` / tick CPU ${base.tickCpuMs}ms / 稳定帧枚举 ${base.stableGetElementsCalls}+${base.stableGetWiresCalls}`);

    // GC churn 是本修复的直接指标：tick 每帧分配（keys/Map/Set）减少 → Scavenge 显著减少
    if (Number.isFinite(base.scavenge)) {
      const saved = base.scavenge > 0 ? 1 - g.scavenge / base.scavenge : 0;
      console.log(`  Scavenge 减少：${(saved * 100).toFixed(1)}%（${base.scavenge} → ${g.scavenge}）`);
      ok('tick 侧 GC 压力明显低于基线（Scavenge ≥30% 减少）', g.scavenge <= base.scavenge * 0.7,
        `${g.scavenge} vs 基线 ${base.scavenge}`);
      // GC 总耗时受偶发 Major GC（MarkCompact）影响波动大，只作参考信息输出，
      // 断言用更稳健的「GC 总次数」。
      const gcCount = g.scavenge + g.major;
      const baseGcCount = (base.scavenge || 0) + (base.major || 0);
      ok('tick 侧 GC 总次数明显低于基线（≥30% 减少）', gcCount <= baseGcCount * 0.7,
        `${gcCount}（Scavenge ${g.scavenge} + Major ${g.major}，GC 耗时 ${g.gcDurationMs}ms）`
        + ` vs 基线 ${baseGcCount}（Scavenge ${base.scavenge} + Major ${base.major || 0}，GC 耗时 ${base.gcDurationMs}ms）`);
    }
    ok('tick CPU 耗时不劣于基线（≤1.10x）',
      Number.isFinite(base.tickCpuMs) ? g.tickCpuMs <= base.tickCpuMs * 1.10 : true,
      `${g.tickCpuMs}ms vs 基线 ${base.tickCpuMs}ms`);
    ok('浏览器单帧耗时不劣于基线（≤1.10x）',
      Number.isFinite(base.frameAvg) ? m.frameAvg <= base.frameAvg * 1.10 : true,
      `${m.frameAvg.toFixed(3)}ms vs 基线 ${base.frameAvg?.toFixed?.(3)}ms`);
  }
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
console.log(R.fail === 0 ? 'PERF_TESTS_PASS' : 'PERF_TESTS_FAILED');
process.exit(R.fail === 0 ? 0 : 1);
