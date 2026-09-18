#!/usr/bin/env node
/**
 * tests/profile_fit_108.mjs
 * ---------------------------------------------------------------------------
 * NMS 电力模拟器 · 1.0.8 全景缩放/平移性能剖析与回归
 *
 * 场景：导入 moj-scroll-screen.json（376 元件 / 620 导线，约 4000 SVG 节点），
 *       剖析并回归「fit 全景 + 全景下平移/滚轮缩放」的帧耗时。
 *
 * 测量项（全部走真实交互路径：fit 按钮路径 / zoomAt 滚轮缩放 / pointer 平移手势）：
 *   A. fit 场景：resetView → fitToContent → 等待 rAF 渲染完成，单次总耗时（×20 取均值/最大值）。
 *   B. 全景下滚轮放大（zoomAt ×60 次，rAF 合帧采样帧间隔 avg/p50/p95/max）。
 *   C. 全景下滚轮缩小（同上）。
 *   D. 全景下平移手势（中键 pointerdown + window pointermove ×90 次，rAF 采样）。
 *   E. 机制计数：整个剖析过程 stats.rebuilds 必须为 0（纯视图操作零重建）；
 *      stats.culled = 上一次剔除扫描中被隐藏的节点数（1.0.8 视口剔除自证）。
 *
 * 用法：
 *   node tests/profile_fit_108.mjs                     # 与基线对比（perf_fit.baseline.json）
 *   node tests/profile_fit_108.mjs --save-baseline     # 保存当前结果为基线
 *
 * 环境约定与 perf_scroll.mjs 完全一致（QA_CDP / QA_URL / QA_JSON / QA_PORT 可覆盖）。
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
const BASELINE_FILE = path.join(HERE, 'perf_fit.baseline.json');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-fit-edge-'));
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

/* ============================== 页面内剖析 ============================== */
/**
 * 在页面里独立搭 board（不依赖 app.js 的 DOM 结构），执行四组场景：
 * fit / 滚轮放大 / 滚轮缩小 / 平移手势。帧耗时用 rAF 间隔采样；
 * fit 单次耗时用 performance.mark 包裹（Performance 面板可直接回放）。
 */
const MEASURE_FN = `
  async (jsonUrl) => {
    const u = (p) => new URL(p, location.href).href;
    const [eng, brd] = await Promise.all([import(u('js/engine.js')), import(u('js/board.js'))]);
    const engine = eng.createEngine();
    const text = await (await fetch(jsonUrl)).text();
    const imported = engine.deserialize(text);
    const nEls = engine.getElements().length;
    const nWires = engine.getWires().length;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'width:1400px;height:900px;position:fixed;left:0;top:0;';
    document.body.appendChild(svg);
    const board = brd.createBoard(svg, engine, {});
    board.render(); // 首帧结构重建（不计入采样）

    // 预热：JIT + 图标母本缓存
    for (let i = 0; i < 30; i++) { engine.tick(1 / 60); board.render(); }

    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const stats = svg.__nmsRenderStats;
    const rebuilds0 = stats.rebuilds; // 初次建图 + 预热的重建计数基线

    // 帧间隔采样：每帧执行一次 step() + 一次 render()（与应用主循环每帧
    // board.render() 一致，保证装饰削减 / 视口剔除按真实 shipped 行为执行），
    // 采集 rAF 间隔分布
    async function sampleFrames(iterations, step) {
      const deltas = [];
      let last = performance.now();
      for (let i = 0; i < iterations; i++) {
        step(i);
        board.render();
        await raf();
        const now = performance.now();
        deltas.push(now - last);
        last = now;
      }
      deltas.sort((a, b) => a - b);
      const sum = deltas.reduce((s, x) => s + x, 0);
      return {
        avg: sum / deltas.length,
        p50: deltas[Math.floor(deltas.length * 0.5)],
        p95: deltas[Math.floor(deltas.length * 0.95)],
        max: deltas[deltas.length - 1],
      };
    }

    /** 抗噪声：重复 reps 次取「最小」（min = 受后台干扰最少的代表值）。 */
    async function bestOf(reps, run) {
      const results = [];
      for (let i = 0; i < reps; i++) results.push(await run(i));
      const pick = (key) => Math.min(...results.map((r) => r[key]));
      return { avg: pick('avg'), p50: pick('p50'), p95: pick('p95'), max: pick('max'), raw: results };
    }

    // ---- 场景定义（先各跑一遍预热丢弃，再 bestOf(3) 采样）----
    const cx = 700, cy = 450;
    const fitOnce = async () => {
      performance.mark('fit108:start');
      const t0 = performance.now();
      board.resetView();
      board.fitToContent();
      await raf(); await raf(); // fit 走 rAF 合帧时等待延迟渲染落地
      const ms = performance.now() - t0;
      performance.mark('fit108:end');
      performance.measure('fit108:one', 'fit108:start', 'fit108:end');
      return ms;
    };
    const zoomInOnce = async () => {
      board.fitToContent(); await raf(); await raf();
      return sampleFrames(60, () => board.zoomAt(1.06, cx, cy));
    };
    const zoomOutOnce = async () => {
      board.fitToContent(); await raf(); await raf();
      return sampleFrames(60, () => board.zoomAt(1 / 1.06, cx, cy));
    };
    const panOnce = async () => {
      board.fitToContent(); await raf(); await raf();
      svg.dispatchEvent(new PointerEvent('pointerdown', { button: 1, clientX: 700, clientY: 450, bubbles: true }));
      const r = await sampleFrames(90, (i) => {
        // 大幅往复平移：让大量节点移出/移回视口（单步 ±12px，扫幅 ±360px）
        const off = ((i % 60) - 30) * 12;
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 700 + off, clientY: 450 + off * 0.4, bubbles: true }));
      });
      window.dispatchEvent(new PointerEvent('pointerup', { button: 1, clientX: 700, clientY: 450, bubbles: true }));
      await raf();
      return r;
    };

    // 预热（丢弃）：各场景过一遍，触发 JIT / 光栅缓存 / 图标母本
    await fitOnce(); await zoomInOnce(); await zoomOutOnce(); await panOnce();

    // ---- A. fit：20 次取中位数（均值对离群帧敏感）----
    const fitTimes = [];
    for (let i = 0; i < 20; i++) fitTimes.push(await fitOnce());
    fitTimes.sort((a, b) => a - b);
    const fitAvg = fitTimes[Math.floor(fitTimes.length / 2)];
    const fitMax = fitTimes[fitTimes.length - 1];

    // ---- B/C/D. 三个手势场景：bestOf(3) ----
    const zoomIn = await bestOf(3, zoomInOnce);
    const kMax = board.getView().k;
    const culledZoomIn = stats.culled;
    const zoomOut = await bestOf(3, zoomOutOnce);
    const kMin = board.getView().k;
    const pan = await bestOf(3, panOnce);
    const culledPanEnd = stats.culled;

    board.fitToContent(); await raf(); await raf();
    const kFit = board.getView().k;

    return {
      imported, nEls, nWires, kFit, kMax, kMin,
      fitAvg, fitMax,
      zoomInAvg: zoomIn.avg, zoomInP95: zoomIn.p95, zoomInMax: zoomIn.max,
      zoomOutAvg: zoomOut.avg, zoomOutP95: zoomOut.p95, zoomOutMax: zoomOut.max,
      panAvg: pan.avg, panP95: pan.p95, panMax: pan.max,
      culledZoomIn, culledPanEnd,
      rebuilds: stats.rebuilds - rebuilds0,
      domNodes: svg.querySelectorAll('*').length,
    };
  }
`;

/* ============================== 主流程 ============================== */
const saveBaseline = process.argv.includes('--save-baseline');
let server = null;
let edge = null;
let targetId = null;
try {
  console.log('===== 1.0.8 全景缩放/平移性能剖析（moj-scroll-screen.json） =====');
  server = await ensureServer();
  edge = await ensureEdge();

  const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json().catch(() => null);
  const target = await (await fetch(`${CDP}/json/list`)).json();
  const tab = created || target[0];
  targetId = tab.id;
  const page = await connect(tab.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: APP });
  await sleep(1500);

  const r = await page.send('Runtime.evaluate', {
    expression: `(${MEASURE_FN})(${JSON.stringify(JSON_URL)})`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  const m = r.result.value;

  console.log(`  导入 ${m.imported ? '成功' : '失败'}：元件 ${m.nEls} / 导线 ${m.nWires} / SVG 节点 ${m.domNodes}`);
  console.log(`  视图范围：fit k=${m.kFit?.toFixed(3)} → zoomIn 末 k=${m.kMax?.toFixed(3)} / zoomOut 末 k=${m.kMin?.toFixed(3)}`);
  console.log(`  [A] fit 单次（含渲染）平均 ${m.fitAvg?.toFixed(2)}ms / 最大 ${m.fitMax?.toFixed(2)}ms`);
  console.log(`  [B] 滚轮放大帧 avg ${m.zoomInAvg?.toFixed(2)}ms / p95 ${m.zoomInP95?.toFixed(2)}ms / max ${m.zoomInMax?.toFixed(2)}ms`);
  console.log(`  [C] 滚轮缩小帧 avg ${m.zoomOutAvg?.toFixed(2)}ms / p95 ${m.zoomOutP95?.toFixed(2)}ms / max ${m.zoomOutMax?.toFixed(2)}ms`);
  console.log(`  [D] 平移手势帧 avg ${m.panAvg?.toFixed(2)}ms / p95 ${m.panP95?.toFixed(2)}ms / max ${m.panMax?.toFixed(2)}ms`);
  console.log(`  [E] 机制：rebuilds=${m.rebuilds} / culledZoomIn=${m.culledZoomIn} / culledPanEnd=${m.culledPanEnd}`);

  /* ---------------- 机制断言（无论是否基线模式都必须成立） ---------------- */
  ok('大电路 JSON 导入成功', m.imported === true, `${m.nEls} 元件 / ${m.nWires} 导线`);
  ok('大电路规模符合预期（≥300 元件 / ≥500 导线）', m.nEls >= 300 && m.nWires >= 500);
  ok('fit + 滚轮缩放 + 平移全程零 rebuildStructure', m.rebuilds === 0, `rebuilds=${m.rebuilds}`);

  if (saveBaseline) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({
      savedAt: new Date().toISOString(),
      note: '1.0.8 修复前基线（无视口剔除 / 无低缩放装饰削减 / fit 同步渲染）',
      ...m,
    }, null, 2));
    console.log(`  · 基线已保存：${BASELINE_FILE}`);
  } else if (fs.existsSync(BASELINE_FILE)) {
    const b = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    console.log(`  基线（${b.savedAt}）：fit avg ${b.fitAvg?.toFixed?.(2)}ms / zoomIn p95 ${b.zoomInP95?.toFixed?.(2)}ms`
      + ` / zoomOut p95 ${b.zoomOutP95?.toFixed?.(2)}ms / pan p95 ${b.panP95?.toFixed?.(2)}ms`);

    const pct = (now, base) => (base > 0 ? ((1 - now / base) * 100).toFixed(1) : '?');
    console.log(`  改善：fit ${(pct(m.fitAvg, b.fitAvg))}% / zoomIn p95 ${(pct(m.zoomInP95, b.zoomInP95))}%`
      + ` / zoomOut p95 ${(pct(m.zoomOutP95, b.zoomOutP95))}% / pan p95 ${(pct(m.panP95, b.panP95))}%`
      + `（剔除自证：culledZoomIn=${m.culledZoomIn}）`);

    // ---- 性能断言 ----
    // fit 中位数与滚轮放大 p95 是本修复的直接收益项（装饰削减 + 视口剔除）；
    // 平移在全景下视口内对象全部可见（剔除无对象可剔），以不劣化为准。
    ok('fit 单次耗时（中位数）显著优于基线（≥20% 改善）', m.fitAvg <= b.fitAvg * 0.80,
      `${m.fitAvg?.toFixed(2)}ms vs 基线 ${b.fitAvg?.toFixed(2)}ms`);
    ok('滚轮放大帧 p95 显著优于基线（≥10% 改善）', m.zoomInP95 <= b.zoomInP95 * 0.90,
      `${m.zoomInP95?.toFixed(2)}ms vs 基线 ${b.zoomInP95?.toFixed(2)}ms`);
    ok('平移手势帧 p95 不劣于基线（±10%）', m.panP95 <= b.panP95 * 1.10,
      `${m.panP95?.toFixed(2)}ms vs 基线 ${b.panP95?.toFixed(2)}ms`);
    ok('滚轮缩小帧 p95 不劣于基线（±10%）', m.zoomOutP95 <= b.zoomOutP95 * 1.10,
      `${m.zoomOutP95?.toFixed(2)}ms vs 基线 ${b.zoomOutP95?.toFixed(2)}ms`);
    ok('视口剔除生效（放大至 k 上限时大量节点被剔除）',
      typeof m.culledZoomIn === 'number' && m.culledZoomIn > 0, `culledZoomIn=${m.culledZoomIn}`);
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
console.log(R.fail === 0 ? 'PERF_FIT_TESTS_PASS' : 'PERF_FIT_TESTS_FAILED');
process.exit(R.fail === 0 ? 0 : 1);
