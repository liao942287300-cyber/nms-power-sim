#!/usr/bin/env node
/**
 * tests/qa2_probe_web.mjs — QA Edward 1.0.6 独立复验专项探针（Round1）
 * 覆盖任务 #14 必做项 2/3 中套件未覆盖部分：
 *   P1 漏刷：MOJ 滚动中逐秒 DOM 比对 ×8（门控下不得漏刷/停帧）
 *   P2 微粒度：100ms 轮询 5s，DOM 画面变化间隔不得 >1.5s（状态面板 120ms 节流余量）
 *   P3 通电视觉：.wire/.port-dot/.jump-arc 通电态 computed style（颜色断言 + filter 实录）
 *   P4 CDP V8 剖析：交互爆发期 renderInspectorStatus / refreshDynamic / render 自耗时
 *   P5 交互延迟：10 次单击选择延迟（dispatch → sel-box 上屏）+ rAF 帧统计
 * 环境：python http.server 8900（cwd=项目根）+ headless Edge CDP 9222（全新 user-data-dir）。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = HERE ? path.resolve(HERE, '..') : '.';
const WORKSPACE = path.resolve(SIM, '..');
const MOJ = path.join(WORKSPACE, 'moj-scroll-screen.json');
const DEBUG = 'http://127.0.0.1:9222';
const APP = 'http://127.0.0.1:8900/index.html';

const R = { pass: 0, fail: 0, failures: [], notes: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}
const note = (s) => { console.log('· ' + s); R.notes.push(s); };

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      else for (const h of this.handlers) h(m); }; }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(fn) { this.handlers.push(fn); }
}
const connect = (url) => new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(new CDP(ws)); ws.onerror = rej; });

let server = null, edge = null, targetId = null, page = null;
const exceptions = [];
async function portUp(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); return r.status < 500; } catch { return false; } }

try {
  /* ---- 环境拉起 ---- */
  try { execSync('taskkill /im msedge /f', { stdio: 'ignore' }); } catch { }
  await sleep(800);
  if (!(await portUp('http://127.0.0.1:8900/'))) {
    server = spawn('python', ['-m', 'http.server', '8900', '--bind', '127.0.0.1'], { cwd: SIM, stdio: 'ignore' });
    for (let i = 0; i < 40 && !(await portUp('http://127.0.0.1:8900/')); i++) await sleep(250);
  }
  const edgeExe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'qa2-probe-edge-'));
  edge = spawn(edgeExe, ['--headless=new', '--remote-debugging-port=9222', `--user-data-dir=${ud.replace(/\\/g, '/')}`,
    '--remote-allow-origins=*', '--no-first-run', '--disable-gpu', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60 && !(await portUp(DEBUG + '/json/version')); i++) await sleep(250);
  const tab = await (await fetch(DEBUG + '/json/new?about:blank', { method: 'PUT' })).json();
  targetId = tab.id;
  page = await connect(tab.webSocketDebuggerUrl);
  page.on((m) => { if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); });
  await page.send('Runtime.enable'); await page.send('Page.enable'); await page.send('Profiler.enable');
  await page.send('Page.navigate', { url: APP });
  await sleep(2200);

  const js = async (expr) => {
    const r = await page.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const mouse = (type, x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: o.button ?? 'left', buttons: o.buttons ?? 0, clickCount: o.clickCount ?? 1, pointerType: 'mouse', modifiers: o.modifiers ?? 0 });
  const keyDown = (k, code, vk, mod = 0) => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod });
  const keyUp = (k, code, vk, mod = 0) => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod });
  async function click(x, y) {
    await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, { buttons: 1 });
    await sleep(25); await mouse('mouseReleased', x, y); await sleep(60);
  }
  async function drag(from, to, steps = 10) {
    await mouse('mouseMoved', from.x, from.y); await mouse('mousePressed', from.x, from.y, { buttons: 1 });
    for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, { buttons: 1 }); await sleep(8); }
    await mouse('mouseReleased', to.x, to.y); await sleep(40);
  }
  async function wheel(x, y, dy) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, button: 'none', pointerType: 'mouse' }); await sleep(10); }
  async function panBy(dx, dy) {
    const st = await boardState();
    const cx = st.rect.left + st.rect.width / 2, cy = st.rect.top + st.rect.height / 2;
    await keyDown(' ', 'Space', 32); await sleep(80);
    await drag({ x: cx, y: cy }, { x: cx + dx, y: cy + dy });
    await keyUp(' ', 'Space', 32); await sleep(200);
  }

  const READ_BOARD = `
    const board=document.getElementById('board');const r=board.getBoundingClientRect();
    const vg=board.querySelector('g.viewport');let k=1,tx=0,ty=0;
    if(vg){const t=vg.getAttribute('transform')||'';const m=/translate\\(([-\\d.]+)[ ,]([-\\d.]+)\\)\\s*scale\\(([-\\d.]+)\\)/.exec(t);if(m){tx=+m[1];ty=+m[2];k=+m[3];}}
    const els=[...board.querySelectorAll('.element')].map(g=>{
      const m=/translate\\(([-\\d.]+)[ ,]([-=\\d.]+)\\)/.exec(g.getAttribute('transform')||'');
      return {id:g.getAttribute('data-el'),x:m?+m[1]:0,y:m?+m[2]:0};});
    return {rect:{left:r.left,top:r.top,width:r.width,height:r.height},view:{k,tx,ty},els};`;
  const boardState = () => js(READ_BOARD);
  const w2c = (st, x, y) => ({ x: st.rect.left + st.view.tx + x * st.view.k, y: st.rect.top + st.view.ty + y * st.view.k });
  const readGrid = () => js(`
    const g=[];for(let r=0;r<5;r++){const row=[];for(let c=0;c<32;c++){
      const el=document.querySelector('[data-el="lamp_r'+r+'c'+c+'"]');
      row.push(!!el && !!el.querySelector('rect[fill="#ffd23f"]'));}
      g.push(row);}return g;`);
  const litCount = (g) => g.flat().filter(Boolean).length;
  const shiftOk = (a, b) => a.every((row, r) => row.every((v, c) => c === 0 || b[r][c] === a[r][c - 1]));

  /* ---- 导入大电路 ---- */
  await js(`document.querySelector('.nav-btn[data-view="lab"]').click();return 1;`); await sleep(300);
  const qaJson = 'C:/Users/liao9/AppData/Local/Temp/qa2_probe_moj.json';
  fs.copyFileSync(MOJ, qaJson);
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
  await page.send('DOM.setFileInputFiles', { files: [qaJson], nodeId });
  let n = 0;
  for (let i = 0; i < 30 && n !== 376; i++) { await sleep(200); n = await js(`return document.querySelectorAll('#board .element').length;`); }
  ok('P0 导入大电路 376/620', n === 376 && (await js(`return document.querySelectorAll('#board path.wire').length;`)) === 620, `els=${n}`);
  await js(`document.getElementById('btn-fit').click();return 1;`); await sleep(400);
  ok('P0b 运行中（未暂停）', await js(`return !document.getElementById('btn-run').classList.contains('is-paused');`));

  /* ---- P1 漏刷：点 START → 稳态 → 逐秒比对 ×8 ---- */
  let st = await boardState();
  let btn = st.els.find((e) => e.id === 'scroll_btn');
  // 平移至按钮可见
  for (let i = 0; i < 5; i++) {
    st = await boardState();
    btn = st.els.find((e) => e.id === 'scroll_btn');
    const c = btn ? w2c(st, btn.x, btn.y) : null;
    if (c && c.x >= st.rect.left && c.x <= st.rect.left + st.rect.width && c.y >= st.rect.top && c.y <= st.rect.top + st.rect.height) break;
    await panBy(-60, -120);
  }
  st = await boardState();
  btn = st.els.find((e) => e.id === 'scroll_btn');
  const btnC = w2c(st, btn.x, btn.y);
  await click(btnC.x, btnC.y);
  let lit0 = 0, t0 = Date.now();
  for (let i = 0; i < 40 && lit0 === 0; i++) { await sleep(500); lit0 = litCount(await readGrid()); }
  ok('P1a 点 START 后屏幕点亮', lit0 > 0, `首亮 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  note('等待稳态 40s…');
  await sleep(40000);
  let stalls = 0, jumpBreaks = 0;
  let prev = await readGrid();
  for (let s = 1; s <= 8; s++) {
    await sleep(1000);
    const cur = await readGrid();
    const okShift = shiftOk(prev, cur);
    const stalled = JSON.stringify(prev) === JSON.stringify(cur);
    if (!okShift) { if (stalled) stalls++; else jumpBreaks++; }
    prev = cur;
  }
  ok('P1b 逐秒比对 ×8：每秒恰右移 1 列（无漏刷/无停帧/无跳变）', stalls === 0 && jumpBreaks === 0, `停帧=${stalls} 跳变=${jumpBreaks}`);

  /* ---- P2 微粒度：100ms 轮询 5s，画面变化间隔 ≤1.5s ---- */
  let lastSig = JSON.stringify(await readGrid()), lastChange = Date.now(), maxGap = 0;
  const endT = Date.now() + 5000;
  while (Date.now() < endT) {
    await sleep(100);
    const sig = JSON.stringify(await readGrid());
    if (sig !== lastSig) { const gap = Date.now() - lastChange; if (gap > maxGap) maxGap = gap; lastSig = sig; lastChange = Date.now(); }
  }
  maxGap = Math.max(maxGap, Date.now() - lastChange);
  ok('P2 100ms 轮询 5s：画面更新间隔 ≤1.5s（门控不漏刷）', maxGap <= 1500, `maxGap=${maxGap}ms`);

  /* ---- P3 通电视觉 ---- */
  const vis = await js(`
    const w=document.querySelector('#board path.wire.is-powered');
    const d=document.querySelector('#board circle.port-dot.is-powered, #board .port-dot.is-powered');
    const j=document.querySelector('#board .jump-arc.is-powered');
    const cs=(el)=>el?getComputedStyle(el):null;
    const wS=cs(w),dS=cs(d),jS=cs(j);
    return {wire:wS?{stroke:wS.stroke,sw:wS.strokeWidth,filter:wS.filter}:null,
      dot:dS?{fill:dS.fill}:null, arc:jS?{stroke:jS.stroke,filter:jS.filter}:null,
      poweredWires:document.querySelectorAll('#board path.wire.is-powered').length};`);
  ok('P3a 存在通电导线', vis.poweredWires > 0, `is-powered × ${vis.poweredWires}`);
  ok('P3b 通电导线描边为 --wire-on 蓝 (#2ea8ff)', vis.wire && vis.wire.stroke === 'rgb(46, 168, 255)', vis.wire ? vis.wire.stroke : 'n/a');
  note(`wire.is-powered computed: stroke=${vis.wire?.stroke} stroke-width=${vis.wire?.sw} filter=${vis.wire?.filter}`);
  note(`port-dot.is-powered computed: fill=${vis.dot?.fill}`);
  note(`jump-arc.is-powered computed: stroke=${vis.arc?.stroke} filter=${vis.arc?.filter}`);
  if (vis.wire && vis.wire.filter && vis.wire.filter.includes('drop-shadow')) {
    R.notes.push('!! 与工程师报告不符：.wire.is-powered 仍含 drop-shadow 滤镜（报告称已移除并改 5px 加亮描边）');
    console.log('!! NOTE: .wire.is-powered 仍含 drop-shadow —— 工程师报告第 4 点仅部分落地');
  }

  /* ---- P4 CDP V8 剖析：交互爆发 6s ---- */
  const SAMPLE_US = 200;
  await page.send('Profiler.start', { interval: SAMPLE_US });
  st = await boardState();
  const cx = st.rect.left + st.rect.width / 2, cy = st.rect.top + st.rect.height / 2;
  const selStart = Date.now();
  const latencies = [];
  for (let i = 0; i < 10; i++) {
    const p = { x: cx + (Math.random() - 0.5) * st.rect.width * 0.7, y: cy + (Math.random() - 0.5) * st.rect.height * 0.7 };
    const t0 = Date.now();
    await js(`window.__selSeen=false;(new MutationObserver(()=>{if(document.querySelector('#board .sel-box')){window.__selSeen=true;}})).observe(document.getElementById('board'),{subtree:true,childList:true});return 1;`);
    await mouse('mouseMoved', p.x, p.y);
    await mouse('mousePressed', p.x, p.y, { buttons: 1 });
    let seen = false;
    for (let k = 0; k < 40 && !seen; k++) { await sleep(5); seen = await js(`return window.__selSeen===true;`); }
    await mouse('mouseReleased', p.x, p.y);
    if (seen) latencies.push(Date.now() - t0);
    await sleep(80);
  }
  for (let i = 0; i < 4; i++) { const a = { x: cx + (Math.random() - 0.5) * 300, y: cy + (Math.random() - 0.5) * 200 }; await drag(a, { x: a.x + 250, y: a.y + 160 }); }
  for (let i = 0; i < 15; i++) await wheel(cx, cy, -120);
  for (let i = 0; i < 15; i++) await wheel(cx, cy, 120);
  await panBy(120, -80);
  const burstMs = Date.now() - selStart;
  const prof = await page.send('Profiler.stop');
  // 聚合函数自耗时
  const byFn = new Map();
  for (const nd of prof.profile.nodes) {
    if (!nd.hitCount) continue;
    const fn = nd.callFrame?.functionName || '(anonymous)';
    byFn.set(fn, (byFn.get(fn) || 0) + nd.hitCount);
  }
  const selfMs = (f) => ((byFn.get(f) || 0) * SAMPLE_US) / 1000;
  const risMs = selfMs('renderInspectorStatus');
  const rdyMs = selfMs('refreshDynamic');
  const renderMs = selfMs('render');
  const tickMs = selfMs('tick');
  note(`交互爆发 ${ (burstMs/1000).toFixed(1) }s 剖析（${(prof.profile.nodes.reduce((a,nd)=>a+(nd.hitCount||0),0)*SAMPLE_US/1000).toFixed(0)}ms 总采样）：renderInspectorStatus=${risMs.toFixed(2)}ms refreshDynamic=${rdyMs.toFixed(2)}ms render=${renderMs.toFixed(2)}ms tick=${tickMs.toFixed(2)}ms`);
  ok('P4a renderInspectorStatus 交互自耗时 ≤15ms（~1ms 量级，原 74.4ms）', risMs <= 15, `${risMs.toFixed(2)}ms / ${(burstMs/1000).toFixed(1)}s`);
  ok('P4b refreshDynamic 门控生效（自耗时不显著）', rdyMs <= 30, `${rdyMs.toFixed(2)}ms`);

  /* ---- P5 交互延迟与帧统计 ---- */
  ok('P5a 单击选择延迟 avg<100ms / max<250ms（n=' + latencies.length + '）',
    latencies.length >= 8 && latencies.reduce((a, b) => a + b, 0) / latencies.length < 100 && Math.max(...latencies) < 250,
    `avg=${(latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length)).toFixed(1)}ms max=${latencies.length ? Math.max(...latencies) : '?'}ms`);
  // rAF 帧统计（爆发后 idle 3s）
  const frames = await js(`return new Promise(res=>{const ds=[];let last=null,n=0;
    function step(t){if(last===null){last=t;requestAnimationFrame(step);return;}
      const d=t-last;last=t;if(d>0&&d<1000)ds.push(d);
      if(++n>=181){res(ds);}else requestAnimationFrame(step);}
    requestAnimationFrame(step);});`);
  const s2 = [...frames].sort((a, b) => a - b);
  const med = s2[Math.floor(s2.length / 2)], p95 = s2[Math.floor(s2.length * 0.95)], mx = s2[s2.length - 1];
  note(`idle 3s 帧间隔：med=${med.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${mx.toFixed(1)}ms（n=${s2.length}）`);
  ok('P5b idle 帧中位 ≤20ms', med <= 20, `med=${med.toFixed(1)}ms`);

  ok('P6 全程无页面异常', exceptions.length === 0, exceptions.slice(0, 2).join('|'));

  console.log(`\n===== 缁撴灉 =====`);
  console.log(`閫氳繃 ${R.pass} / 澶辫触 ${R.fail}`);
  if (R.fail === 0) console.log('QA2_PROBE_WEB_PASS'); else console.log('QA2_PROBE_WEB_FAILED');
  for (const f of R.failures) console.log('  FAIL: ' + f);
  fs.writeFileSync(path.join(WORKSPACE, 'qa2_probe_web_report.txt'), R.notes.join('\n') + '\n', 'utf8');
} catch (e) {
  console.error('PROBE_ERROR: ' + (e && e.stack ? e.stack : e));
  R.fail++;
} finally {
  if (targetId) { try { await fetch(`${DEBUG}/json/close/${targetId}`); } catch { } }
  if (edge) { try { edge.kill(); } catch { } }
  try { execSync('taskkill /im msedge /f', { stdio: 'ignore' }); } catch { }
  if (server) { try { server.kill(); } catch { } }
  process.exit(R.fail === 0 ? 0 : 1);
}
