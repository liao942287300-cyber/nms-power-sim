#!/usr/bin/env node
/**
 * tests/qa2_probe_exe.mjs — QA Edward 1.0.6 exe 交互流畅性专项探针
 * 任务 #14 exe 专项补充：便携 exe（中文+空格路径）导入 moj-scroll-screen.json 后，
 *   E1 导入 376/620 成功
 *   E2 单击选择延迟 ×8（dispatch → sel-box 上屏）
 *   E3 拖拽响应：拖拽后元件位移一致
 *   E4 爆发交互（点击/拖拽/滚轮/平移 8s）rAF 帧统计 p95/max
 * 环境：复制 exe 至中文+空格临时目录，--remote-debugging-port=9341，CDP 直连。
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SRC_EXE = 'C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim-desktop/dist/无人深空电力模拟器-1.0.6-portable.exe';
const MOJ_JSON = 'C:/Users/liao9/WorkBuddy/我的工作1/moj-scroll-screen.json';
const TMP_DIR = 'C:/Users/liao9/AppData/Local/Temp/QA2 交互探针 106';
const EXE = path.join(TMP_DIR, '无人深空电力模拟器-1.0.6-portable.exe');
const CDP_PORT = 9341;

const R = { pass: 0, fail: 0, failures: [], notes: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}
const note = (s) => { console.log('· ' + s); R.notes.push(s); };

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }; }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
}
const connect = (url) => new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(new CDP(ws)); ws.onerror = rej; });

let child = null;
try {
  try { execSync(`taskkill /im msedge /f`, { stdio: 'ignore' }); } catch { }
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  copyFileSync(SRC_EXE, EXE);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  child = spawn(EXE, ['--disable-gpu', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`], { env, stdio: 'ignore' });
  let exited = false;
  child.on('exit', () => { exited = true; });
  let page = null;
  for (let i = 0; i < 25 && !page; i++) {
    if (exited) break;
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const pg = list.find((t) => t.type === 'page');
      if (pg) page = await connect(pg.webSocketDebuggerUrl);
    } catch { }
    if (!page) await sleep(1000);
  }
  ok('E0 exe 启动且 CDP 可连', !!page);
  if (page) {
    await page.send('Runtime.enable'); await page.send('Page.enable'); await page.send('DOM.enable');
    const js = async (expr) => {
      const r = await page.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    };
    const mouse = (type, x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: o.button ?? 'left', buttons: o.buttons ?? 0, clickCount: o.clickCount ?? 1, pointerType: 'mouse', modifiers: o.modifiers ?? 0 });
    const keyDown = (k, code, vk, mod = 0) => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod });
    const keyUp = (k, code, vk, mod = 0) => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod });
    async function drag(from, to, steps = 10) {
      await mouse('mouseMoved', from.x, from.y); await mouse('mousePressed', from.x, from.y, { buttons: 1 });
      for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, { buttons: 1 }); await sleep(8); }
      await mouse('mouseReleased', to.x, to.y); await sleep(60);
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

    await sleep(1500);
    // 导入大 JSON
    await js(`document.querySelector('.nav-btn[data-view="lab"]').click();return 1;`); await sleep(300);
    const qaJson = 'C:/Users/liao9/AppData/Local/Temp/qa2_probe_exe_moj.json';
    copyFileSync(MOJ_JSON, qaJson);
    const doc = await page.send('DOM.getDocument');
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
    const tImp = Date.now();
    await page.send('DOM.setFileInputFiles', { files: [qaJson], nodeId });
    let n = 0;
    for (let i = 0; i < 30 && n !== 376; i++) { await sleep(200); n = await js(`return document.querySelectorAll('#board .element').length;`); }
    ok('E1 exe 内导入 376/620 成功', n === 376 && (await js(`return document.querySelectorAll('#board path.wire').length;`)) === 620, `els=${n} 耗时=${Date.now() - tImp}ms`);

    // E2 单击选择延迟 ×N（确定性：点击视口中央附近已知元件）
    let st = await boardState();
    const cx = st.rect.left + st.rect.width / 2, cy = st.rect.top + st.rect.height / 2;
    const visEls = st.els.map((e) => ({ e, sc: w2c(st, e.x, e.y) }))
      .filter(({ sc }) => Math.abs(sc.x - cx) < 200 && Math.abs(sc.y - cy) < 150).slice(0, 6);
    const latencies = [];
    for (const { sc } of visEls) {
      await js(`window.__selSeen=false;(new MutationObserver(()=>{if(document.querySelector('#board .sel-box')){window.__selSeen=true;}})).observe(document.getElementById('board'),{subtree:true,childList:true});return 1;`);
      const t0 = Date.now();
      await mouse('mouseMoved', sc.x, sc.y);
      await mouse('mousePressed', sc.x, sc.y, { buttons: 1 });
      let seen = false;
      for (let k = 0; k < 40 && !seen; k++) { await sleep(5); seen = await js(`return window.__selSeen===true;`); }
      await mouse('mouseReleased', sc.x, sc.y);
      if (seen) latencies.push(Date.now() - t0);
      await sleep(80);
    }
    const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 9999;
    const mx = latencies.length ? Math.max(...latencies) : 9999;
    ok('E2 单击选择延迟 avg<100ms / max<250ms（n=' + latencies.length + '，未命中不计）', latencies.length >= 3 && avg < 100 && mx < 250, `avg=${avg.toFixed(1)}ms max=${mx}ms`);
    note(`选择延迟样本: ${latencies.map((v) => v.toFixed(0)).join(', ')}ms`);

    // E3 拖拽响应：选视口中央附近可见元件，选中后拖 60px，位移一致
    st = await boardState();
    const cxm = st.rect.left + st.rect.width / 2, cym = st.rect.top + st.rect.height / 2;
    let target = null, c0 = null;
    for (const e of st.els) {
      const sc = w2c(st, e.x, e.y);
      if (Math.abs(sc.x - cxm) < 150 && Math.abs(sc.y - cym) < 120) { target = e; c0 = sc; break; }
    }
    if (!target) { target = st.els[Math.floor(st.els.length / 2)]; c0 = w2c(st, target.x, target.y); }
    await mouse('mouseMoved', c0.x, c0.y);
    await mouse('mousePressed', c0.x, c0.y, { buttons: 1 });
    await sleep(25); await mouse('mouseReleased', c0.x, c0.y); await sleep(100);
    const before = (await boardState()).els.find((e) => e.id === target.id);
    st = await boardState();
    const c = w2c(st, before.x, before.y);
    await drag(c, { x: c.x + 60, y: c.y + 30 }, 8);
    const after = (await boardState()).els.find((e) => e.id === target.id);
    ok('E3 拖拽响应位移一致（60,30，24px 网格吸附容差 ±12px）', after && Math.abs(after.x - before.x - 60) <= 12 && Math.abs(after.y - before.y - 30) <= 12,
      `d=(${after ? (after.x - before.x).toFixed(1) : '?'},${after ? (after.y - before.y).toFixed(1) : '?'})`);

    // E4 爆发交互 rAF 统计（8s）
    await js(`window.__fd=[];window.__fsamp=(t)=>{window.__fd.push(t);window.__rafId=requestAnimationFrame(window.__fsamp);};window.__rafId=requestAnimationFrame(window.__fsamp);return 1;`);
    st = await boardState();
    for (let i = 0; i < 10; i++) {
      const p = { x: st.rect.left + st.rect.width / 2 + (Math.random() - 0.5) * st.rect.width * 0.6, y: st.rect.top + st.rect.height / 2 + (Math.random() - 0.5) * st.rect.height * 0.6 };
      await mouse('mouseMoved', p.x, p.y); await mouse('mousePressed', p.x, p.y, { buttons: 1 }); await sleep(20);
      await mouse('mouseReleased', p.x, p.y); await sleep(60);
    }
    await drag({ x: cx, y: cy }, { x: cx + 150, y: cy - 80 });
    for (let i = 0; i < 10; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -120, button: 'none', pointerType: 'mouse' }), await sleep(10);
    for (let i = 0; i < 10; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 120, button: 'none', pointerType: 'mouse' }), await sleep(10);
    await keyDown(' ', 'Space', 32); await sleep(80);
    await drag({ x: cx, y: cy }, { x: cx + 120, y: cy + 60 });
    await keyUp(' ', 'Space', 32); await sleep(300);
    const fd = await js(`cancelAnimationFrame(window.__rafId);const d=window.__fd;const g=[];for(let i=1;i<d.length;i++)g.push(d[i]-d[i-1]);g.sort((a,b)=>a-b);return g;`);
    if (fd.length > 10) {
      const p95 = fd[Math.floor(fd.length * 0.95)], mx2 = fd[fd.length - 1];
      const med = fd[Math.floor(fd.length / 2)];
      note(`exe 爆发交互帧间隔（n=${fd.length}）：med=${med.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${mx2.toFixed(1)}ms`);
      ok('E4 exe 爆发交互帧中位 ≤20ms 且 p95 ≤100ms', med <= 20 && p95 <= 100, `med=${med.toFixed(1)} p95=${p95.toFixed(1)} max=${mx2.toFixed(1)}`);
    } else ok('E4 帧采样不足', false, `n=${fd.length}`);

    try { execSync(`taskkill /pid ${child.pid}`, { stdio: 'ignore' }); } catch { }
    await sleep(2000);
    try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { }
  }
  console.log(`\n===== 缁撴灉 =====`);
  console.log(`閫氳繃 ${R.pass} / 澶辫触 ${R.fail}`);
  if (R.fail === 0) console.log('QA2_PROBE_EXE_PASS'); else console.log('QA2_PROBE_EXE_FAILED');
} catch (e) {
  console.error('EXE_PROBE_ERROR: ' + (e && e.stack ? e.stack : e));
  R.fail++;
} finally {
  if (child) { try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { } }
  try { execSync(`taskkill /im msedge /f`, { stdio: 'ignore' }); } catch { }
  await sleep(1000);
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { }
  process.exit(R.fail === 0 ? 0 : 1);
}
