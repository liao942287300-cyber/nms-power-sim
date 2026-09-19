#!/usr/bin/env node
/**
 * tests/qa2_probe_shadow.mjs — QA Edward 1.0.6 drop-shadow 因果 A/B 探针
 * 假设：.wire.is-powered 仍含 drop-shadow（工程师报告称已移除），
 *       在软件渲染 headless 下每次动态刷新（MOJ 滚动逐秒翻转）造成 ~150-200ms 绘制尖峰。
 * A/B：同场景（导入+START+稳态滚动）各采样 5s rAF：
 *   A = 现状 CSS；B = 注入 filter:none!important 覆盖后。
 * 若 B 的长帧显著减少 → 因果坐实（源码性能 Bug 证据）。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SIM = 'C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim';
const MOJ = 'C:/Users/liao9/WorkBuddy/我的工作1/moj-scroll-screen.json';
const DEBUG = 'http://127.0.0.1:9222';
const APP = 'http://127.0.0.1:8900/index.html';

let server = null, edge = null, targetId = null;
try {
  try { execSync('taskkill /im msedge /f', { stdio: 'ignore' }); } catch { }
  await sleep(800);
  try { const r = await fetch('http://127.0.0.1:8900/'); } catch {
    server = spawn('python', ['-m', 'http.server', '8900', '--bind', '127.0.0.1'], { cwd: SIM, stdio: 'ignore' });
    await sleep(1500);
  }
  const edgeExe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'qa2-shadow-edge-'));
  edge = spawn(edgeExe, ['--headless=new', '--remote-debugging-port=9222', `--user-data-dir=${ud.replace(/\\/g, '/')}`,
    '--remote-allow-origins=*', '--no-first-run', '--disable-gpu', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await (await fetch(DEBUG + '/json/version')); break; } catch { await sleep(250); } }
  const tab = await (await fetch(DEBUG + '/json/new?about:blank', { method: 'PUT' })).json();
  targetId = tab.id;
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const send = (method, params = {}) => { const i = ++id; return new Promise((res, rej) => { pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); }); };
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const mouse = (type, x, y, o = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: o.button ?? 'left', buttons: o.buttons ?? 0, clickCount: o.clickCount ?? 1, pointerType: 'mouse' });

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: APP }); await sleep(2200);
  await js(`document.querySelector('.nav-btn[data-view="lab"]').click();return 1;`); await sleep(300);
  const qaJson = 'C:/Users/liao9/AppData/Local/Temp/qa2_shadow_moj.json';
  fs.copyFileSync(MOJ, qaJson);
  await send('DOM.enable');
  const doc = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
  await send('DOM.setFileInputFiles', { files: [qaJson], nodeId });
  let n = 0;
  for (let i = 0; i < 30 && n !== 376; i++) { await sleep(200); n = await js(`return document.querySelectorAll('#board .element').length;`); }
  console.log('导入: els=' + n);
  await js(`document.getElementById('btn-fit').click();return 1;`); await sleep(400);

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
  const keyDown = (k, code, vk) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  const keyUp = (k, code, vk) => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  async function panBy(dx, dy) {
    // 1.0.9：空格不再是平移修饰键——优先空白处左键拖动；密集电路回退中键拖动。
    const b0 = await boardState();
    const c0 = { x: b0.rect.left + b0.rect.width / 2, y: b0.rect.top + b0.rect.height / 2 };
    const bp = await js(`const b=document.getElementById('board');const r=b.getBoundingClientRect();
      for(let fy=0.12;fy<=0.94;fy+=0.06)for(let fx=0.08;fx<=0.94;fx+=0.06){const x=r.left+r.width*fx,y=r.top+r.height*fy;
      const el=document.elementFromPoint(x,y);if(el&&!(el.closest&&el.closest('[data-el]'))&&(el===b||b.contains(el)))return {x,y};}return null;`);
    if (bp) {
      await mouse('mouseMoved', bp.x, bp.y); await mouse('mousePressed', bp.x, bp.y, { buttons: 1 });
      for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', bp.x + dx * i / 8, bp.y + dy * i / 8, { buttons: 1 }); await sleep(8); }
      await mouse('mouseReleased', bp.x + dx, bp.y + dy);
    } else {
      await mouse('mouseMoved', c0.x, c0.y, { button: 'middle' }); await mouse('mousePressed', c0.x, c0.y, { buttons: 4, button: 'middle' });
      for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', c0.x + dx * i / 8, c0.y + dy * i / 8, { buttons: 4, button: 'middle' }); await sleep(8); }
      await mouse('mouseReleased', c0.x + dx, c0.y + dy, { button: 'middle' });
    }
    await sleep(200);
  }
  async function click(x, y) { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, { buttons: 1 }); await sleep(25); await mouse('mouseReleased', x, y); await sleep(60); }

  // 平移到 START 并点击
  for (let i = 0; i < 5; i++) {
    const st = await boardState();
    const btn = st.els.find((e) => e.id === 'scroll_btn');
    const c = btn ? w2c(st, btn.x, btn.y) : null;
    if (c && c.x >= st.rect.left && c.x <= st.rect.left + st.rect.width && c.y >= st.rect.top && c.y <= st.rect.top + st.rect.height) { await click(c.x, c.y); break; }
    await panBy(-60, -120);
  }
  console.log('等待稳态 40s…');
  await sleep(40000);

  const sample = async (label, ms) => {
    const d = await js(`return new Promise(res=>{const ds=[];let last=null;const t0=performance.now();
      function step(t){if(last===null){last=t;requestAnimationFrame(step);return;}
        const g=t-last;last=t;if(g>0&&g<1000)ds.push(g);
        if(performance.now()-t0>=${ms}){res(ds);}else requestAnimationFrame(step);}
      requestAnimationFrame(step);});`);
    const s = [...d].sort((a, b) => a - b);
    const p95 = s[Math.floor(s.length * 0.95)], mx = s[s.length - 1];
    const over100 = d.filter((v) => v > 100).length, over50 = d.filter((v) => v > 50).length;
    console.log(`${label}: n=${d.length} med=${s[Math.floor(s.length / 2)].toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${mx.toFixed(1)}ms >50ms=${over50} >100ms=${over100}`);
    return { n: d.length, med: s[Math.floor(s.length / 2)], p95, max: mx, over50, over100 };
  };

  const A = await sample('A 现状CSS  5s', 5000);
  await js(`const s=document.createElement('style');s.id='qa2-shadow-override';s.textContent='.wire.is-powered,.layer-jumps .jump-arc.is-powered{filter:none!important}.wire.is-powered{stroke-width:5px}';document.head.appendChild(s);return 1;`);
  await sleep(500);
  const B = await sample('B 去滤镜  5s', 5000);
  const C = await sample('C 去滤镜  5s', 5000);
  console.log(`\n因果判定: >100ms 长帧 A=${A.over100} B=${B.over100} C=${C.over100}；max A=${A.max.toFixed(1)} B=${B.max.toFixed(1)} C=${C.max.toFixed(1)}`);
  console.log(A.over100 > 0 && B.over100 === 0 && C.over100 === 0 ? 'QA2_SHADOW_CAUSAL_PASS（drop-shadow 即长帧根因）' : 'QA2_SHADOW_INCONCLUSIVE');
} catch (e) {
  console.error('SHADOW_PROBE_ERROR: ' + (e && e.stack ? e.stack : e));
} finally {
  if (targetId) { try { await fetch(`${DEBUG}/json/close/${targetId}`); } catch { } }
  if (edge) { try { edge.kill(); } catch { } }
  try { execSync('taskkill /im msedge /f', { stdio: 'ignore' }); } catch { }
  if (server) { try { server.kill(); } catch { } }
}
