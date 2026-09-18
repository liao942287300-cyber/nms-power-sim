#!/usr/bin/env node
/**
 * tests/profile_interact.mjs
 * ---------------------------------------------------------------------------
 * NMS 电力模拟器 · 大电路交互剖析（1.0.6 剖析驱动优化）
 *
 * 在 headless Edge CDP 下载入大电路（moj-scroll-screen.json），分阶段用
 * V8 采样剖析器（Profiler.start/stop）+ rAF 帧间隔采样量化：
 *   A. steady   —— 稳定运行 5s（rAF 主循环：tick + render + statusLoop）
 *   B. interact —— 交互爆发 8s（单击 / 框选 / 元件拖拽 / 滚轮缩放 / 平移）
 * 输出各阶段：帧间隔中位数 / p95 / 最大值，以及函数级 self-time 热点 Top N。
 *
 * 用法：node tests/profile_interact.mjs [--out 报告路径]
 * 环境：自动拉起 8901 静态服务（cwd=项目父目录）与 headless Edge（CDP 9223）。
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

const CDP = 'http://127.0.0.1:9223';
const PORT = 8901;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const APP = `${URL_BASE}/nms-power-sim/index.html`;
const TOP_N = 18;
const SAMPLE_US = 200; // 采样间隔（微秒）

/* ============================== 环境拉起 ============================== */
async function portUp() {
  try { const r = await fetch(`${URL_BASE}/`, { signal: AbortSignal.timeout(1200) }); return r.status < 500; }
  catch { return false; }
}
async function ensureServer() {
  if (await portUp()) { console.log('· 复用已运行静态服务'); return null; }
  const py = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: WORKSPACE, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { if (await portUp()) { console.log('· 静态服务已启动'); return py; } await sleep(250); }
  throw new Error('静态服务启动失败');
}
async function ensureEdge() {
  try {
    const ver = await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1200) })).json();
    return { proc: null, wsUrl: ver.webSocketDebuggerUrl };
  } catch { /* 拉起 */ }
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
    .find((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-prof-edge-'));
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=9223', `--user-data-dir=${dir.replace(/\\/g, '/')}`,
    '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000',
    '--js-flags=--expose-gc', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { const ver = await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1000) })).json(); return { proc, wsUrl: ver.webSocketDebuggerUrl }; }
    catch { await sleep(250); }
  }
  throw new Error('headless Edge 启动失败');
}
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }; }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params })); }); }
}
const connect = (url) => new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(new Cdp(ws)); ws.onerror = rej; });

/* ============================== 页面工具 ============================== */
async function js(page, expr) {
  const r = await page.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
const mouse = (page, type, x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: o.button ?? 'left', buttons: o.buttons ?? 0, clickCount: o.clickCount ?? 1, pointerType: 'mouse', modifiers: o.modifiers ?? 0, deltaX: 0, deltaY: o.deltaY ?? 0 });
async function drag(page, from, to, steps = 10) {
  await mouse(page, 'mouseMoved', from.x, from.y);
  await mouse(page, 'mousePressed', from.x, from.y, { buttons: 1 });
  for (let i = 1; i <= steps; i++) {
    await mouse(page, 'mouseMoved', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, { buttons: 1 });
    await sleep(8);
  }
  await mouse(page, 'mouseReleased', to.x, to.y);
  await sleep(40);
}
async function click(page, x, y) {
  await mouse(page, 'mouseMoved', x, y);
  await mouse(page, 'mousePressed', x, y, { buttons: 1 });
  await sleep(20);
  await mouse(page, 'mouseReleased', x, y);
  await sleep(60);
}
async function wheel(page, x, y, deltaY) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, button: 'none', pointerType: 'mouse' });
  await sleep(12);
}

/** 帧间隔采样器注入（rAF deltas）。 */
const FRAME_SAMPLER_ON = `window.__fd=[];window.__fsamp=(t)=>{window.__fd.push(t);window.__rafId=requestAnimationFrame(window.__fsamp);};window.__rafId=requestAnimationFrame(window.__fsamp);return 1;`;
const FRAME_SAMPLER_OFF = `cancelAnimationFrame(window.__rafId);const d=window.__fd;const g=[];for(let i=1;i<d.length;i++)g.push(d[i]-d[i-1]);g.sort((a,b)=>a-b);const q=(p)=>g.length?g[Math.min(g.length-1,Math.floor(p*g.length))]:0;window.__fd=[];return {frames:g.length,med:q(0.5),p95:q(0.95),max:g.length?g[g.length-1]:0};`;

/** 从剖析结果聚合函数级 self-time（hitCount × 采样间隔）。 */
function aggregate(profile) {
  const byName = new Map();
  const byUrl = new Map();
  let totalHits = 0;
  for (const n of profile.nodes) {
    if (!n.hitCount) continue;
    totalHits += n.hitCount;
    const f = n.callFrame || {};
    const name = f.functionName || '(anonymous)';
    const url = (f.url || '').replace(/^.*\//, '');
    byName.set(name, (byName.get(name) || 0) + n.hitCount);
    const k = `${name} @${url}:${f.lineNumber ?? '?'}`;
    byUrl.set(k, (byUrl.get(k) || 0) + n.hitCount);
  }
  const ms = (h) => (h * SAMPLE_US) / 1000;
  const top = [...byUrl.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N)
    .map(([k, h]) => `${k}  ${ms(h).toFixed(1)}ms`);
  return { totalMs: ms(totalHits), top };
}

/* ============================== 主流程 ============================== */
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? process.argv[outArg + 1] : path.join(HERE, '..', '..', 'qa-evidence', 'profile_106_report.txt');
let server = null, edge = null, targetId = null;
const report = [];
const say = (s) => { console.log(s); report.push(s); };

try {
  server = await ensureServer();
  edge = await ensureEdge();
  const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json().catch(() => null);
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const tab = created || list[0];
  targetId = tab.id;
  const page = await connect(tab.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Profiler.enable');
  await page.send('Page.navigate', { url: APP });
  await sleep(1800);

  // 切 lab 视图 + 确保运行
  await js(page, `document.querySelector('.nav-btn[data-view="lab"]').click();return 1;`);
  await sleep(300);
  await js(page, `document.getElementById('btn-run').classList.contains('is-paused') && document.getElementById('btn-run').click();return 1;`);

  // 导入大电路
  const file = 'C:/Users/liao9/AppData/Local/Temp/qa_prof_big.json';
  fs.writeFileSync(file, fs.readFileSync(JSON_PATH));
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
  await page.send('DOM.setFileInputFiles', { files: [file], nodeId });
  await sleep(900);
  await js(page, `document.getElementById('btn-fit').click();return 1;`);
  await sleep(400);

  const st = await js(page, `
    const board=document.getElementById('board');const r=board.getBoundingClientRect();
    const vg=board.querySelector('g.viewport');let k=1,tx=0,ty=0;
    if(vg){const t=vg.getAttribute('transform')||'';const m=/translate\\(([-\\d.]+)[ ,]([-\\d.]+)\\)\\s*scale\\(([-\\d.]+)\\)/.exec(t);if(m){tx=+m[1];ty=+m[2];k=+m[3];}}
    return {rect:{left:r.left,top:r.top,width:r.width,height:r.height},view:{k,tx,ty},
      els:document.querySelectorAll('#board .element').length, wires:document.querySelectorAll('#board path.wire').length};`);
  say(`===== 大电路交互剖析 =====`);
  say(`导入：${st.els} 元件 / ${st.wires} 导线；视图 k=${st.view.k.toFixed(2)}`);
  const R = st.rect, V = st.view;
  const w2c = (x, y) => ({ x: R.left + V.tx + x * V.k, y: R.top + V.ty + y * V.k });
  const cx = R.left + R.width / 2, cy = R.top + R.height / 2;

  /* ---------- A. steady ---------- */
  await js(page, FRAME_SAMPLER_ON);
  await page.send('Profiler.start', { interval: SAMPLE_US });
  await sleep(5000);
  const profA = await page.send('Profiler.stop');
  const framesA = await js(page, FRAME_SAMPLER_OFF);
  const aggA = aggregate(profA.profile);
  say(`\n----- A. steady 稳定运行 5s -----`);
  say(`帧间隔：中位 ${framesA.med.toFixed(2)}ms / p95 ${framesA.p95.toFixed(2)}ms / max ${framesA.max.toFixed(2)}ms（${framesA.frames} 帧）`);
  say(`剖析总采样 ${aggA.totalMs.toFixed(0)}ms，热点 Top${TOP_N}（self time）：`);
  aggA.top.forEach((t) => say(`  ${t}`));

  /* ---------- B. interact ---------- */
  await js(page, FRAME_SAMPLER_ON);
  await page.send('Profiler.start', { interval: SAMPLE_US });
  // 单击元件（画布中随机世界点位 → 命中或空白）
  for (let i = 0; i < 25; i++) {
    await click(page, cx + (Math.random() - 0.5) * R.width * 0.8, cy + (Math.random() - 0.5) * R.height * 0.8);
  }
  // 框选（左右、右左）
  for (let i = 0; i < 6; i++) {
    const a = { x: cx - 200 + Math.random() * 100, y: cy - 150 + Math.random() * 80 };
    await drag(page, a, { x: a.x + 300 + Math.random() * 100, y: a.y + 220 });
  }
  // 元件拖拽（从随机点拖 120px）
  for (let i = 0; i < 10; i++) {
    const a = { x: cx + (Math.random() - 0.5) * R.width * 0.6, y: cy + (Math.random() - 0.5) * R.height * 0.6 };
    await drag(page, a, { x: a.x + 120, y: a.y + 60 });
  }
  // 滚轮缩放（放大 + 缩小）
  for (let i = 0; i < 20; i++) await wheel(page, cx, cy, -120);
  for (let i = 0; i < 20; i++) await wheel(page, cx, cy, 120);
  // 平移
  await drag(page, { x: cx, y: cy }, { x: cx + 150, y: cy - 90 });
  const profB = await page.send('Profiler.stop');
  const framesB = await js(page, FRAME_SAMPLER_OFF);
  const aggB = aggregate(profB.profile);
  say(`\n----- B. interact 交互爆发（25 单击 / 6 框选 / 10 拖拽 / 40 滚轮 / 1 平移） -----`);
  say(`帧间隔：中位 ${framesB.med.toFixed(2)}ms / p95 ${framesB.p95.toFixed(2)}ms / max ${framesB.max.toFixed(2)}ms（${framesB.frames} 帧）`);
  say(`剖析总采样 ${aggB.totalMs.toFixed(0)}ms，热点 Top${TOP_N}（self time）：`);
  aggB.top.forEach((t) => say(`  ${t}`));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, report.join('\n'), 'utf8');
  console.log(`\n报告已写入：${OUT}`);
} catch (e) {
  say('执行异常: ' + (e && e.stack ? e.stack : e));
} finally {
  if (targetId) { try { await fetch(`${CDP}/json/close/${targetId}`); } catch { /* ignore */ } }
  if (edge && edge.proc) { try { edge.proc.kill(); } catch { /* ignore */ } }
  if (server) { try { server.kill(); } catch { /* ignore */ } }
}
