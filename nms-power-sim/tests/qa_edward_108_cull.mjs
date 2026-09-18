#!/usr/bin/env node
/**
 * tests/qa_edward_108_cull.mjs — QA Edward 独立终验脚本（1.0.8 视口剔除 + 装饰削减 + 性能复现）
 * ---------------------------------------------------------------------------
 *   C1 小电路剔除禁用：<200 节点电路平移/缩放到节点全部出视口 → 零 display:none、
 *      stats.culled === 0（剔除整体禁用）。
 *   C2 k ≥ 0.55 装饰削减不激活：大电路 k=0.6 → 无 is-far-zoom 类、halo/交叉拱可见。
 *   C3 k < 0.55 装饰削减激活：is-far-zoom 类、halo 层隐藏（回归核对）。
 *   C4 剔除-恢复无丢失：大电路放大 k=3 → 大量 display:none；平移手势扫回 →
 *      display:none 归零、可见元件数 == 元件总数；全程 rebuilds=0。
 *   C5 性能独立复现（rAF 帧间隔采样）：fit ×12 取中位；滚轮放大 ×48 帧 ×2 取最优；
 *      平移 ×72 帧。与 tests/perf_fit.baseline.json（1.0.8 修复前基线）对比，
 *      断言 fit 中位 ≤ 基线 85%、放大 p95 ≤ 基线 92%、剔除计数 > 0、rebuilds = 0。
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
const BASELINE = JSON.parse(fs.readFileSync(path.join(HERE, 'perf_fit.baseline.json'), 'utf8'));

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa108c-edge-'));
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

const C_FN = `
  async (jsonUrl) => {
    const u = (p) => new URL(p, location.href).href;
    const [eng, brd] = await Promise.all([import(u('js/engine.js')), import(u('js/board.js'))]);
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const out = {};

    /* ---- C1 小电路：剔除禁用 ---- */
    {
      const engine = eng.createEngine();
      for (let i = 0; i < 40; i++) {
        engine.addElement('power', { id: 'p' + i, x: 80 + i * 30, y: 100 });
        engine.addElement('lamp', { id: 'l' + i, x: 80 + i * 30, y: 260 });
        engine.addWire('p' + i, 'out', 'l' + i, 'in');
      }
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'board');
      svg.style.cssText = 'width:1200px;height:800px;position:fixed;left:0;top:0;';
      document.body.appendChild(svg);
      const board = brd.createBoard(svg, engine, {});
      board.render();
      for (let i = 0; i < 5; i++) { engine.tick(1 / 60); board.render(); }
      const stats = svg.__nmsRenderStats;
      // 平移到远处：全部节点出视口（若剔除启用必然大量 display:none）
      board.zoomAt(4, 600, 400);
      board.render(); await raf(); await raf();
      // 记录当前 k 与剔除态
      const hiddenNow = svg.querySelectorAll('[style*="display: none"], [style*="display:none"]').length;
      const culledNow = stats.culled;
      const k = board.getView().k;
      out.small = { nEls: engine.getElements().length, nWires: engine.getWires().length, hiddenNow, culledNow, k };
      svg.remove();
    }

    /* ---- 大电路：C2/C3/C4/C5 ---- */
    {
      const engine = eng.createEngine();
      const text = await (await fetch(jsonUrl)).text();
      engine.deserialize(text);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'board');
      svg.style.cssText = 'width:1400px;height:900px;position:fixed;left:0;top:0;';
      document.body.appendChild(svg);
      const board = brd.createBoard(svg, engine, {});
      board.render();
      for (let i = 0; i < 20; i++) { engine.tick(1 / 60); board.render(); }
      const stats = svg.__nmsRenderStats;
      const rebuilds0 = stats.rebuilds;
      const disp = (sel) => { const n = svg.querySelector(sel); return n ? getComputedStyle(n).display : null; };

      // C2：k=0.6 ≥ 0.55 → 装饰削减不激活
      board.fitToContent(); await raf(); await raf();
      const kFit = board.getView().k;
      board.zoomAt(0.6 / kFit, 700, 450); board.render(); await raf(); await raf();
      out.mid = {
        k: board.getView().k,
        farCls: svg.classList.contains('is-far-zoom'),
        halos: disp('.wire-halos'),
        jumps: disp('.layer-jumps'),
      };

      // C3：k=0.4 < 0.55 → 激活
      board.zoomAt(0.4 / board.getView().k, 700, 450); board.render(); await raf(); await raf();
      out.far = {
        k: board.getView().k,
        farCls: svg.classList.contains('is-far-zoom'),
        halos: disp('.wire-halos'),
        label: disp('.el-label'),
      };

      // C4：放大 k=3 → 剔除大量；平移离开再平移回来 → 剔除集应恢复
      board.zoomAt(3 / board.getView().k, 700, 450); board.render(); await raf(); await raf();
      const nElsTotal = engine.getElements().length;
      const hiddenAtZoom = svg.querySelectorAll('[style*="display: none"], [style*="display:none"]').length;
      const visibleAtZoom = svg.querySelectorAll('.element:not([style*="display: none"]):not([style*="display:none"])').length;
      const panBy = async (dx) => {
        svg.dispatchEvent(new PointerEvent('pointerdown', { button: 1, clientX: 700, clientY: 450, bubbles: true }));
        const steps = 20;
        for (let i = 1; i <= steps; i++) {
          window.dispatchEvent(new PointerEvent('pointermove', { clientX: 700 + (dx * i) / steps, clientY: 450, bubbles: true }));
          board.render();
        }
        window.dispatchEvent(new PointerEvent('pointerup', { button: 1, clientX: 700 + dx, clientY: 450, bubbles: true }));
        await raf(); await raf();
      };
      // 平移 -600px（移向新区域）→ 仍是剔除态
      await panBy(-600);
      const hiddenAfterPanAway = svg.querySelectorAll('[style*="display: none"], [style*="display:none"]').length;
      // 平移 +600px 回原位 → 被剔除节点应恢复（剔除集与 pan 前一致）
      await panBy(600);
      const hiddenAfterPanBack = svg.querySelectorAll('[style*="display: none"], [style*="display:none"]').length;
      // fit 回全景 → 全部恢复
      board.fitToContent(); await raf(); await raf();
      const hiddenAfterFit = svg.querySelectorAll('[style*="display: none"], [style*="display:none"]').length;
      const visibleAfterFit = svg.querySelectorAll('.element:not([style*="display: none"]):not([style*="display:none"])').length;
      out.restore = { nElsTotal, hiddenAtZoom, visibleAtZoom, hiddenAfterPanAway, hiddenAfterPanBack, hiddenAfterFit, visibleAfterFit,
        rebuildsDelta: stats.rebuilds - rebuilds0, culledZoom: stats.culled };

      // C5 性能采样（rAF 帧间隔；与应用主循环一致：每帧 step + render）
      const sample = async (n, step) => {
        const ds = []; let last = performance.now();
        for (let i = 0; i < n; i++) { step(i); board.render(); await raf(); const now = performance.now(); ds.push(now - last); last = now; }
        ds.sort((a, b) => a - b);
        return { avg: ds.reduce((s, x) => s + x, 0) / ds.length, p50: ds[Math.floor(ds.length * 0.5)], p95: ds[Math.floor(ds.length * 0.95)] };
      };
      const fitOnce = async () => {
        const t0 = performance.now();
        board.resetView(); board.fitToContent();
        await raf(); await raf();
        return performance.now() - t0;
      };
      const zoomInOnce = async () => {
        board.fitToContent(); await raf(); await raf();
        return sample(48, () => board.zoomAt(1.06, 700, 450));
      };
      const panOnce = async () => {
        board.fitToContent(); await raf(); await raf();
        svg.dispatchEvent(new PointerEvent('pointerdown', { button: 1, clientX: 700, clientY: 450, bubbles: true }));
        const r = await sample(72, (i) => {
          const off = ((i % 60) - 30) * 12;
          window.dispatchEvent(new PointerEvent('pointermove', { clientX: 700 + off, clientY: 450 + off * 0.4, bubbles: true }));
        });
        window.dispatchEvent(new PointerEvent('pointerup', { button: 1, clientX: 700, clientY: 450, bubbles: true }));
        await raf();
        return r;
      };
      // 预热
      await fitOnce(); await zoomInOnce(); await panOnce();
      const fitTimes = [];
      for (let i = 0; i < 12; i++) fitTimes.push(await fitOnce());
      fitTimes.sort((a, b) => a - b);
      const fitMed = fitTimes[Math.floor(fitTimes.length / 2)];
      const z1 = await zoomInOnce(); const z2 = await zoomInOnce();
      const zoomIn = { avg: Math.min(z1.avg, z2.avg), p95: Math.min(z1.p95, z2.p95) };
      const pan = await panOnce();
      out.perf = { fitMed, zoomIn, pan, rebuildsDelta2: stats.rebuilds - rebuilds0, domNodes: svg.querySelectorAll('*').length };
      svg.remove();
    }
    return out;
  }
`;

let server = null, edge = null, targetId = null;
try {
  console.log('===== QA Edward · 1.0.8 视口剔除 / 装饰削减 / 性能独立复现 =====');
  server = await ensureServer();
  edge = await ensureEdge();
  const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json().catch(() => null);
  const tab = created || (await (await fetch(`${CDP}/json/list`)).json())[0];
  targetId = tab.id;
  const page = await connect(tab.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: APP });
  await sleep(1500);
  const r = await page.send('Runtime.evaluate', {
    expression: `(${C_FN})(${JSON.stringify(JSON_URL)})`, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error('C_FN 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  const c = r.result.value;

  console.log('  ---- C1 小电路剔除禁用 ----');
  ok(`小电路规模 < 200 节点（${c.small.nEls} 元件 + ${c.small.nWires} 导线）`,
    c.small.nEls + c.small.nWires < 200);
  eq('全部出视口后仍零 display:none（剔除禁用）', c.small.hiddenNow, 0);
  eq('stats.culled === 0', c.small.culledNow, 0);

  console.log('  ---- C2 k≥0.55 装饰削减不激活 ----');
  ok(`k 到位（k=${c.mid.k?.toFixed(3)} ≥ 0.55）`, c.mid.k >= 0.549);
  eq('无 is-far-zoom 类', c.mid.farCls, false);
  ok('halo 底衬可见', c.mid.halos !== 'none', `display=${c.mid.halos}`);
  ok('交叉拱可见', c.mid.jumps !== 'none', `display=${c.mid.jumps}`);

  console.log('  ---- C3 k<0.55 装饰削减激活 ----');
  ok(`k 到位（k=${c.far.k?.toFixed(3)} < 0.55）`, c.far.k < 0.55);
  eq('is-far-zoom 类', c.far.farCls, true);
  eq('halo 底衬隐藏', c.far.halos, 'none');
  eq('标签隐藏', c.far.label, 'none');

  console.log('  ---- C4 剔除-恢复无丢失 ----');
  ok(`放大后大量节点被剔除（display:none=${c.restore.hiddenAtZoom}, culled=${c.restore.culledZoom}）`,
    c.restore.hiddenAtZoom > 100);
  ok('放大后视口内元件数 < 总数（剔除确实发生）', c.restore.visibleAtZoom < c.restore.nElsTotal,
    `${c.restore.visibleAtZoom}/${c.restore.nElsTotal}`);
  ok('平移离开后仍处剔除态（无异常全显）', c.restore.hiddenAfterPanAway >= c.restore.hiddenAtZoom,
    `hidden=${c.restore.hiddenAfterPanAway}`);
  eq('平移回原位后剔除集恢复（display:none 回到 pan 前水平）', c.restore.hiddenAfterPanBack, c.restore.hiddenAtZoom,
    `pan后=${c.restore.hiddenAfterPanBack} pan前=${c.restore.hiddenAtZoom}`);
  eq('fit 回全景后可见元件数 == 总数（无丢失）', c.restore.visibleAfterFit, c.restore.nElsTotal);
  eq('全程零 rebuild', c.restore.rebuildsDelta, 0);

  console.log('  ---- C5 性能独立复现 ----');
  console.log(`    fit 中位 ${c.perf.fitMed?.toFixed(2)}ms（基线 ${BASELINE.fitAvg?.toFixed(2)}ms）`);
  console.log(`    滚轮放大 avg ${c.perf.zoomIn.avg?.toFixed(2)}ms / p95 ${c.perf.zoomIn.p95?.toFixed(2)}ms（基线 p95 ${BASELINE.zoomInP95?.toFixed(2)}ms）`);
  console.log(`    平移 avg ${c.perf.pan.avg?.toFixed(2)}ms / p95 ${c.perf.pan.p95?.toFixed(2)}ms（基线 p95 ${BASELINE.panP95?.toFixed(2)}ms）`);
  ok('fit 中位 ≤ 基线 85%', c.perf.fitMed <= BASELINE.fitAvg * 0.85,
    `${c.perf.fitMed?.toFixed(2)} vs ${BASELINE.fitAvg?.toFixed(2)}`);
  ok('滚轮放大 p95 ≤ 基线 92%', c.perf.zoomIn.p95 <= BASELINE.zoomInP95 * 0.92,
    `${c.perf.zoomIn.p95?.toFixed(2)} vs ${BASELINE.zoomInP95?.toFixed(2)}`);
  ok('平移 p95 不劣于基线 110%', c.perf.pan.p95 <= BASELINE.panP95 * 1.10,
    `${c.perf.pan.p95?.toFixed(2)} vs ${BASELINE.panP95?.toFixed(2)}`);
  eq('性能采样全程零 rebuild', c.perf.rebuildsDelta2, 0);
} catch (e) {
  R.fail++;
  R.failures.push('执行异常：' + (e && e.stack ? e.stack : e));
  console.log('  [NG] 执行异常: ' + (e && e.message));
} finally {
  if (targetId) { try { await fetch(`${CDP}/json/close/${targetId}`); } catch { /* ignore */ } }
  if (edge && edge.proc) { try { edge.proc.kill(); } catch { /* ignore */ } }
  if (server) { try { server.kill(); } catch { /* ignore */ } }
}
console.log('\n===== 结果 =====');
console.log(`  通过 ${R.pass} / 失败 ${R.fail}（断言总数 ${R.pass + R.fail}）`);
if (R.failures.length) { console.log('  失败明细：'); R.failures.forEach((f) => console.log('   [NG] ' + f)); }
console.log(R.fail === 0 ? 'QA108_CULL_PASS' : 'QA108_CULL_FAILED');
process.exit(R.fail === 0 ? 0 : 1);
