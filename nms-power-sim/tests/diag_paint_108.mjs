#!/usr/bin/env node
/**
 * tests/diag_paint_108.mjs — 一次性诊断（不进回归门禁）：
 * fit 平移/缩放帧耗时的成本拆分。
 * 对比五种状态：原样（全景，装饰已削减）/ 隐藏导线层 / 隐藏元件层 /
 * 全部隐藏（纯 transform 开销）/ k 放大后（大量节点被剔除）。
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
const CDP = 'http://127.0.0.1:9222';
const PORT = 8900;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const APP = `${URL_BASE}/nms-power-sim/index.html`;
const JSON_URL = `${URL_BASE}/moj-scroll-screen.json`;

async function portUp() {
  try { return (await fetch(`${URL_BASE}/`, { signal: AbortSignal.timeout(1500) })).status < 500; } catch { return false; }
}
async function ensureServer() {
  if (await portUp()) return null;
  const py = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: WORKSPACE, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { if (await portUp()) return py; await sleep(250); }
  throw new Error('server');
}
async function ensureEdge() {
  try {
    const ver = await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) })).json();
    return { proc: null, wsUrl: ver.webSocketDebuggerUrl };
  } catch { /* spawn below */ }
  const cands = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
  const exe = cands.find((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-diag-'));
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=9222', `--user-data-dir=${dir.replace(/\\/g, '/')}`, '--remote-allow-origins=*', '--no-first-run', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { const ver = await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1000) })).json(); return { proc, wsUrl: ver.webSocketDebuggerUrl }; }
    catch { await sleep(250); }
  }
  throw new Error('edge');
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
}
const connect = (url) => new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(new Cdp(ws)); ws.onerror = () => rej(new Error('ws')); });

const FN = `
  async (jsonUrl) => {
    const u = (p) => new URL(p, location.href).href;
    const [eng, brd] = await Promise.all([import(u('js/engine.js')), import(u('js/board.js'))]);
    const engine = eng.createEngine();
    engine.deserialize(await (await fetch(jsonUrl)).text());
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'board');
    svg.style.cssText = 'width:1400px;height:900px;position:fixed;left:0;top:0;';
    document.body.appendChild(svg);
    const board = brd.createBoard(svg, engine, {});
    board.render();
    for (let i = 0; i < 30; i++) { engine.tick(1/60); board.render(); }
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    async function sample(iterations, step) {
      const deltas = [];
      let last = performance.now();
      for (let i = 0; i < iterations; i++) { step(i); await raf(); const n = performance.now(); deltas.push(n - last); last = n; }
      deltas.sort((a,b)=>a-b);
      return { avg: deltas.reduce((s,x)=>s+x,0)/deltas.length, p95: deltas[Math.floor(deltas.length*0.95)] };
    }
    const cx = 700, cy = 450;
    async function panScenario(label) {
      board.fitToContent(); await raf(); await raf();
      svg.dispatchEvent(new PointerEvent('pointerdown', { button: 1, clientX: 700, clientY: 450, bubbles: true }));
      const r = await sample(90, (i) => {
        const off = ((i % 60) - 30) * 12;
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 700 + off, clientY: 450 + off * 0.4, bubbles: true }));
      });
      window.dispatchEvent(new PointerEvent('pointerup', { button: 1, clientX: 700, clientY: 450, bubbles: true }));
      await raf();
      return { label, ...r, culled: svg.__nmsRenderStats.culled };
    }
    async function zoomScenario(label) {
      board.fitToContent(); await raf(); await raf();
      const r = await sample(60, () => board.zoomAt(1.06, cx, cy));
      return { label, ...r, culled: svg.__nmsRenderStats.culled, k: board.getView().k };
    }
    const out = {};
    out.panNormal = await panScenario('pan/normal');
    out.zoomNormal = await zoomScenario('zoom/normal');
    // 导线层隐藏（隔离元件绘制成本）
    svg.querySelector('.layer-wires').style.display = 'none';
    svg.querySelector('.layer-jumps').style.display = 'none';
    out.panNoWires = await panScenario('pan/no-wires');
    // 元件层隐藏（隔离导线绘制成本）
    svg.querySelector('.layer-wires').style.display = '';
    svg.querySelector('.layer-jumps').style.display = '';
    svg.querySelector('.layer-elements').style.display = 'none';
    out.panNoElems = await panScenario('pan/no-elems');
    // 全部隐藏（纯 transform + 合帧开销）
    svg.querySelector('.layer-elements').style.display = 'none';
    out.panAllHidden = await panScenario('pan/all-hidden');
    svg.querySelector('.layer-elements').style.display = '';
    // k 放大（大量节点被视口剔除）
    board.fitToContent(); await raf(); await raf();
    for (let i = 0; i < 40; i++) board.zoomAt(1.14, cx, cy);
    await raf(); await raf();
    out.panZoomedCulled = await panScenario('pan/zoomed-culled @k=' + board.getView().k.toFixed(2));
    // JS 侧 render 纯耗时（不含绘制）：平移中直接调 render()
    board.fitToContent(); await raf(); await raf();
    svg.dispatchEvent(new PointerEvent('pointerdown', { button: 1, clientX: 700, clientY: 450, bubbles: true }));
    let jsT0 = performance.now();
    for (let i = 0; i < 90; i++) {
      const off = ((i % 60) - 30) * 12;
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 700 + off, clientY: 450 + off * 0.4, bubbles: true }));
      board.render();
    }
    const jsRenderAvg = (performance.now() - jsT0) / 90;
    window.dispatchEvent(new PointerEvent('pointerup', { button: 1, clientX: 700, clientY: 450, bubbles: true }));
    out.jsRenderAvg = jsRenderAvg;
    return out;
  }
`;

let server = null, edge = null, targetId = null;
try {
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
    expression: `(${FN})(${JSON.stringify(JSON_URL)})`, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  const m = r.result.value;
  const lines = [];
  for (const k of Object.keys(m)) {
    const v = m[k];
    if (typeof v === 'object') lines.push(`${k}: avg=${v.avg?.toFixed(2)}ms p95=${v.p95?.toFixed(2)}ms culled=${v.culled} k=${v.k ?? ''}`);
    else lines.push(`${k}: ${v.toFixed?.(3) ?? v}`);
  }
  fs.writeFileSync(path.join(HERE, '_diag_paint_out.txt'), lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
} catch (e) {
  console.log('ERR: ' + (e && e.message));
} finally {
  if (targetId) { try { await fetch(`${CDP}/json/close/${targetId}`); } catch {} }
  if (edge && edge.proc) { try { edge.proc.kill(); } catch {} }
  if (server) { try { server.kill(); } catch {} }
}
