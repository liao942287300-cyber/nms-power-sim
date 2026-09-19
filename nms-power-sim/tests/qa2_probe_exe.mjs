#!/usr/bin/env node
/**
 * tests/qa2_probe_exe.mjs — 1.0.9 打包版 exe 交互回归（真机：启动便携 exe + CDP）
 *
 * 1.0.9 起交互语义变更，本探针据此重写（原空格平移法已失效）：
 *   · 空白处拖动 = 平移画布
 *   · Ctrl 拖动     = 框选
 *   · 空格          = 显示/隐藏线条（不改播放态）
 *   · Alt 拖动      = 复制一份（原件不动）
 *   · 点色块        = 图标换目标亮色
 *   · 发光地板 glow_floor = 可放置，且通电后出现光晕
 *
 * 另含：大电路 376/620 导入 + 零页面异常 + %APPDATA% 无新增写入。
 * 关键：不传 --no-sandbox（否则 Electron 沙箱渲染器 preload 报错，污染零错误断言）。
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SRC_EXE = 'C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim-desktop/dist/无人深空电力模拟器-1.0.9-portable.exe';
const MOJ_JSON = 'C:/Users/liao9/WorkBuddy/我的工作1/moj-scroll-screen.json';
const TMP_DIR = 'C:/Users/liao9/AppData/Local/Temp/QA109 exe 探针';
const EXE = path.join(TMP_DIR, '无人深空电力模拟器-1.0.9-portable.exe');
const APPDATA_DIR = path.join(process.env.APPDATA || '', 'nms-power-sim-desktop');
const CDP_PORT = 9341;

const R = { pass: 0, fail: 0, failures: [], notes: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}
function eq(name, a, b) { return ok(name, JSON.stringify(a) === JSON.stringify(b), `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`); }
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

function dirSnapshot(dir) {
  if (!existsSync(dir)) return [];
  try { return readdirSync(dir, { recursive: true }).map((f) => { const p = path.join(dir, String(f)); try { return { f: String(f), m: statSync(p).mtimeMs }; } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}

let child = null;
const exceptions = [], logErrors = [], failedRequests = [];
let page = null;

const MOD_ALT = 1, MOD_CTRL = 2;

async function js(expr) {
  const r = await page.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
const mouse = (type, x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: o.button ?? 'left', buttons: o.buttons ?? 0, clickCount: o.clickCount ?? 1, pointerType: 'mouse', modifiers: o.modifiers ?? 0 });
async function click(x, y, mod = 0) {
  await mouse('mouseMoved', x, y, { buttons: 0, modifiers: mod });
  await mouse('mousePressed', x, y, { buttons: 1, modifiers: mod });
  await sleep(30);
  await mouse('mouseReleased', x, y, { buttons: 0, modifiers: mod });
  await sleep(90);
}
async function drag(from, to, { steps = 12, mod = 0, button = 'left' } = {}) {
  const btns = button === 'middle' ? 4 : 1;
  await mouse('mouseMoved', from.x, from.y, { buttons: 0, button, modifiers: mod });
  await mouse('mousePressed', from.x, from.y, { buttons: btns, button, modifiers: mod });
  for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, { buttons: btns, button, modifiers: mod }); await sleep(12); }
  await mouse('mouseReleased', to.x, to.y, { buttons: 0, button, modifiers: mod });
  await sleep(90);
}
const key = (type, k, code, vk) => page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const blurFocus = () => js(`if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();return 1;`);
async function pressSpace() { await blurFocus(); await key('keyDown', ' ', 'Space', 32); await key('keyUp', ' ', 'Space', 32); await sleep(150); }

async function rectOf(sel) { return js(`const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};`); }
async function clickSel(sel) { const c = await rectOf(sel); if (!c) { ok(`点击 ${sel}`, false, '元素不存在'); return false; } await click(c.x, c.y); return true; }
const setView = async (name) => { await clickSel(`.nav-btn[data-view="${name}"]`); await sleep(250); };
const focusBoard = () => js(`document.getElementById('board').scrollIntoView({block:'center'});return 1;`).then(() => sleep(200));
const clearCanvas = () => js(`document.getElementById('btn-clear').click();return 1;`).then(() => sleep(250));
async function ensureRunning() { const paused = await js(`return document.getElementById('btn-run').classList.contains('is-paused');`); if (paused) { await js(`document.getElementById('btn-run').click();return 1;`); await sleep(150); } }
async function importJSON(obj, tag) {
  const file = `${TMP_DIR}/qa109exe_${tag}.json`;
  writeFileSync(file, JSON.stringify(obj));
  const doc = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
  await page.send('DOM.setFileInputFiles', { files: [file], nodeId });
  await sleep(500);
}

const READ_BOARD = `
  const board=document.getElementById('board');const r=board.getBoundingClientRect();
  const vg=board.querySelector('g.viewport');let k=1,tx=0,ty=0;
  if(vg){const t=vg.getAttribute('transform')||'';const m=/translate\\(([-\\d.]+)[ ,]([-\\d.]+)\\)\\s*scale\\(([-\\d.]+)\\)/.exec(t);if(m){tx=+m[1];ty=+m[2];k=+m[3];}}
  const els=[...board.querySelectorAll('.element')].map(g=>{
    const m=/translate\\(([-\\d.]+)[ ,]([-\\d.]+)\\)/.exec(g.getAttribute('transform')||'');
    const ic=g.querySelector('.icon');
    return {id:g.getAttribute('data-el'),cls:g.getAttribute('class'),x:m?+m[1]:0,y:m?+m[2]:0,icon:ic?ic.innerHTML:''};});
  const ports=[...board.querySelectorAll('.port')].map(p=>{
    const dot=p.querySelector('.port-dot');const g=p.closest('.element');
    const m=/translate\\(([-\\d.]+)[ ,]([-\\d.]+)\\)/.exec(g.getAttribute('transform')||'');
    const ex=m?+m[1]:0,ey=m?+m[2]:0;const dx=+dot.getAttribute('cx'),dy=+dot.getAttribute('cy');
    return {el:p.getAttribute('data-el'),port:p.getAttribute('data-portname'),cx:r.left+tx+(ex+dx)*k,cy:r.top+ty+(ey+dy)*k};});
  const wires=[...board.querySelectorAll('path.wire')].map(w=>({id:w.getAttribute('class'),d:w.getAttribute('d')}));
  const sel=[...board.querySelectorAll('.sel-box')].map(b=>b.closest('[data-el]').getAttribute('data-el'));
  const marquee=!!board.querySelector('.marquee-box');
  const status=[...document.querySelectorAll('#inspector-status .status-row')].map(row=>({id:(row.querySelector('.sr-id')||{}).textContent,state:(row.querySelector('.sr-state')||{}).textContent}));
  const insp=(document.getElementById('inspector-props')||{}).textContent||'';
  return {rect:{left:r.left,top:r.top,width:r.width,height:r.height},view:{k,tx,ty},els,ports,sel,marquee,wires,status,insp,
    wiresHidden:board.classList.contains('wires-hidden'), aria:document.getElementById('btn-wires-hidden').getAttribute('aria-pressed'),
    btnRun:document.getElementById('btn-run').textContent, simState:document.getElementById('sim-state').textContent};
`;
const boardState = () => js(READ_BOARD);
const statusOf = (st, id) => (st.status.find((s) => s.id === '#' + id) || {}).state;
const w2c = (st, x, y) => ({ x: st.rect.left + st.view.tx + x * st.view.k, y: st.rect.top + st.view.ty + y * st.view.k });
const c2w = (st, cx, cy) => ({ x: (cx - st.rect.left - st.view.tx) / st.view.k, y: (cy - st.rect.top - st.view.ty) / st.view.k });
const snap = (v) => Math.round(v / 24) * 24;
const elById = (st, id) => st.els.find((e) => e.id === id);
async function waitForStatus(id, text, timeoutMs = 2500) {
  const t0 = Date.now();
  for (;;) { const cur = await js(`const row=[...document.querySelectorAll('#inspector-status .status-row')].find(r=>(r.querySelector('.sr-id')||{}).textContent==='#'+${JSON.stringify(id)});return row?(row.querySelector('.sr-state')||{}).textContent:null;`);
    if (cur === text) return true; if (Date.now() - t0 > timeoutMs) return false; await sleep(60); }
}
function findBlankPoint() {
  return js(`const board=document.getElementById('board');const r=board.getBoundingClientRect();
    for(let fy=0.15; fy<=0.9; fy+=0.08){ for(let fx=0.12; fx<=0.92; fx+=0.08){
      const x=r.left+r.width*fx, y=r.top+r.height*fy;
      if(x<=r.left+6||x>=r.right-6||y<=r.top+6||y>=r.bottom-6) continue;
      const el=document.elementFromPoint(x,y); if(!el) continue;
      if(el.closest&&el.closest('[data-el]')) continue;
      if(!(el===board||board.contains(el))) continue;
      return {x,y}; }} return null;`);
}
async function patchExport() {
  await js(`if(!window.__qaCap){window.__qaCap={blob:null};URL.createObjectURL=function(b){window.__qaCap.blob=b;return 'blob:qa109';};URL.revokeObjectURL=function(){};HTMLAnchorElement.prototype.click=function(){};}return 1;`);
}
async function engineState() {
  await js(`document.getElementById('btn-export').click();return 1;`); await sleep(50);
  const txt = await js(`return window.__qaCap.blob ? window.__qaCap.blob.text() : null;`);
  if (!txt) return null; try { return JSON.parse(txt); } catch (e) { return null; }
}
const engineEl = (es, id) => (es && Array.isArray(es.elements) ? es.elements.find((e) => e.id === id) : null) || null;
async function placePalette(type, wx, wy, st) {
  await js(`const it=document.querySelector('.palette-item[data-type="${type}"]');if(!it.classList.contains('is-active'))it.click();return 1;`);
  await sleep(60); const p = w2c(st, wx, wy); await click(p.x, p.y); await sleep(140);
}

const C_MARQUEE = { elements: [{ id: 'p', type: 'power', x: 120, y: 120 }, { id: 'w1', type: 'wall_switch', x: 360, y: 120 }, { id: 'l', type: 'lamp', x: 600, y: 120 }, { id: 'w2', type: 'wall_switch', x: 360, y: 360 }],
  wires: [{ id: 'wa', a: { el: 'p', port: 'out' }, b: { el: 'w1', port: 'a' } }, { id: 'wb', a: { el: 'w1', port: 'b' }, b: { el: 'l', port: 'in' } }], timeOfDay: 8, dayCycle: false };
const C_TWO_LAMPS = { elements: [{ id: 'p', type: 'power', x: 120, y: 120 }, { id: 'l1', type: 'lamp', x: 480, y: 120 }, { id: 'l2', type: 'lamp', x: 480, y: 360 }],
  wires: [{ id: 'w1', a: { el: 'p', port: 'out' }, b: { el: 'l1', port: 'in' } }, { id: 'w2', a: { el: 'l1', port: 'in' }, b: { el: 'l2', port: 'in' } }], timeOfDay: 8, dayCycle: false };

async function freshCircuit(circ, tag) {
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(150);
  await importJSON(circ, tag);
  await ensureRunning();
}

async function main() {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  copyFileSync(SRC_EXE, EXE);
  ok('T0a 1.0.9 源 exe 存在且复制到隔离目录', existsSync(EXE), EXE);

  const appdataBefore = dirSnapshot(APPDATA_DIR);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  env.NMS_POWER_SIM_NO_DEVTOOLS = '1';
  child = spawn(EXE, ['--disable-gpu', `--remote-debugging-port=${CDP_PORT}`], { env, stdio: 'ignore' });
  let exited = false, exitCode = null;
  child.on('exit', (c) => { exited = true; exitCode = c; });

  for (let i = 0; i < 30 && !page; i++) {
    if (exited) break;
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const pg = list.find((t) => t.type === 'page' && String(t.url || '').startsWith('app://local')) || list.find((t) => t.type === 'page');
      if (pg) page = await connect(pg.webSocketDebuggerUrl);
    } catch { }
    if (!page) await sleep(1000);
  }
  ok('T0 exe 启动且 CDP 可连（app://local）', !!page, page ? 'connected' : `exit=${exitCode}`);
  if (!page) { ok('无法连接渲染进程，后续跳过', false); return; }

  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logErrors.push(m.params.entry.text);
    else if (m.method === 'Network.loadingFailed') failedRequests.push(m.params.errorText);
  });
  await page.send('Runtime.enable'); await page.send('Log.enable'); await page.send('Network.enable'); await page.send('Page.enable'); await page.send('DOM.enable');
  await sleep(1500);
  await patchExport();

  /* ---- T1 大电路导入 ---- */
  await setView('lab'); await sleep(200);
  const qaJson = `${TMP_DIR}/qa109exe_big.json`;
  copyFileSync(MOJ_JSON, qaJson);
  {
    const doc = await page.send('DOM.getDocument');
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
    const t0 = Date.now();
    await page.send('DOM.setFileInputFiles', { files: [qaJson], nodeId });
    let n = 0; for (let i = 0; i < 30 && n !== 376; i++) { await sleep(200); n = await js(`return document.querySelectorAll('#board .element').length;`); }
    const wires = await js(`return document.querySelectorAll('#board path.wire').length;`);
    ok('T1 大电路导入 376/620 成功', n === 376 && wires === 620, `els=${n} wires=${wires} ${Date.now() - t0}ms`);
  }

  /* ---- T2 (G1) 空白拖动 = 平移 ---- */
  {
    await freshCircuit(C_MARQUEE, 'g1');
    let st = await boardState();
    await click(w2c(st, 120, 120).x, w2c(st, 120, 120).y);
    st = await boardState();
    const selBefore = [...st.sel].sort(); eq('T2a 预置：选中 1 个元件', st.sel.length, 1);
    const before = { tx: st.view.tx, ty: st.view.ty };
    const coords0 = st.els.map((e) => `${e.id}:${e.x},${e.y}`).sort();
    const bp = await findBlankPoint();
    ok('T2b 找到空白起始点', !!bp);
    await drag(bp, { x: bp.x + 130, y: bp.y + 70 }, { steps: 10 });
    st = await boardState();
    const dtx = st.view.tx - before.tx, dty = st.view.ty - before.ty;
    ok('T2c 空白拖动使 view.tx/ty 明显变化', Math.abs(dtx) > 30 && Math.abs(dty) > 20, `Δ=(${dtx.toFixed(1)},${dty.toFixed(1)})`);
    eq('T2d 平移期间元件坐标全不变', st.els.map((e) => `${e.id}:${e.x},${e.y}`).sort(), coords0);
    eq('T2e 平移不清空选择集', [...st.sel].sort(), selBefore);
    ok('T2f 平移过程未出现 marquee-box', st.marquee === false);
  }

  /* ---- T3 (G3) Ctrl 拖动 = 框选 ---- */
  {
    await freshCircuit(C_TWO_LAMPS, 'g3');
    let st = await boardState();
    const view0 = { tx: st.view.tx, ty: st.view.ty };
    const a = w2c(st, 380, 40), b = w2c(st, 620, 440);
    await mouse('mouseMoved', a.x, a.y, { buttons: 0, modifiers: MOD_CTRL });
    await mouse('mousePressed', a.x, a.y, { buttons: 1, modifiers: MOD_CTRL });
    for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', a.x + (b.x - a.x) * i / 12, a.y + (b.y - a.y) * i / 12, { buttons: 1, modifiers: MOD_CTRL }); await sleep(12); }
    const mid = await boardState();
    ok('T3a Ctrl 拖动期间 marquee-box 出现', mid.marquee === true);
    await mouse('mouseReleased', b.x, b.y, { buttons: 0, modifiers: MOD_CTRL }); await sleep(120);
    st = await boardState();
    eq('T3b Ctrl 框选命中 l1/l2', [...st.sel].sort(), ['l1', 'l2']);
    ok('T3c 框选期间 tx/ty 不变', Math.abs(st.view.tx - view0.tx) < 0.5 && Math.abs(st.view.ty - view0.ty) < 0.5);
    ok('T3d 松手后 marquee-box 移除', st.marquee === false);
  }

  /* ---- T4 (G4) 空格 = 隐藏/显示线条（且不动播放态） ---- */
  {
    await freshCircuit(C_MARQUEE, 'g4');
    let st = await boardState();
    const run0 = st.btnRun, sim0 = st.simState;
    eq('T4a 初始无 wires-hidden', st.wiresHidden, false);
    eq('T4b 初始 aria-pressed=false', st.aria, 'false');
    await pressSpace(); st = await boardState();
    eq('T4c 空格一次 → wires-hidden', st.wiresHidden, true);
    eq('T4d 空格一次 → aria-pressed=true', st.aria, 'true');
    eq('T4e 空格不改播放按钮文案', st.btnRun, run0);
    eq('T4f 空格不改 sim-state', st.simState, sim0);
    await pressSpace(); st = await boardState();
    eq('T4g 再按空格 → 恢复显示', st.wiresHidden, false);
    eq('T4h 再按空格 → aria=false', st.aria, 'false');
    eq('T4i 再按空格播放状态仍不变', st.btnRun, run0);
  }

  /* ---- T5 (G5) Alt 拖动 = 复制一份（原件不动） ---- */
  {
    await freshCircuit({ elements: [{ id: 'L', type: 'lamp', x: 360, y: 120, props: { color: 'blue' } }], wires: [], timeOfDay: 8, dayCycle: false }, 'g5');
    let st = await boardState();
    eq('T5a 预置 1 个 lamp', st.els.length, 1);
    const origPos = { x: elById(st, 'L').x, y: elById(st, 'L').y };
    const drop = { x: w2c(st, 360, 120).x + 240, y: w2c(st, 360, 120).y + 168 };
    const dropW = c2w(st, drop.x, drop.y);
    await drag(w2c(st, origPos.x, origPos.y), drop, { steps: 16, mod: MOD_ALT });
    st = await boardState();
    eq('T5b Alt 拖动后元件数 = 2（只复制一份）', st.els.length, 2);
    const orig = elById(st, 'L');
    ok('T5c 原元件坐标完全没变', orig.x === origPos.x && orig.y === origPos.y, `原=(${orig.x},${orig.y})`);
    const copy = st.els.find((e) => e.id !== 'L');
    ok('T5d 副本存在', !!copy, `ids=${st.els.map((e) => e.id).join(',')}`);
    if (copy) eq('T5e 副本坐标 = 拖动落点（含吸附）', `${copy.x},${copy.y}`, `${snap(dropW.x)},${snap(dropW.y)}`);
    const es = await engineState();
    ok('T5f 副本 props.color 与原一致（=blue）', !!(copy && engineEl(es, copy.id) && engineEl(es, copy.id).props.color === 'blue' && engineEl(es, 'L').props.color === 'blue'));
  }

  /* ---- T6 (G7) 点色块 → 图标换目标亮色 ---- */
  {
    await freshCircuit({ elements: [{ id: 'p', type: 'power', x: 120, y: 120 }, { id: 'l', type: 'lamp', x: 520, y: 200 }], wires: [{ id: 'w', a: { el: 'p', port: 'out' }, b: { el: 'l', port: 'in' } }], timeOfDay: 8, dayCycle: false }, 'g7');
    await waitForStatus('l', '点亮');
    let st = await boardState();
    ok('T6a 灯已点亮', statusOf(st, 'l') === '点亮', statusOf(st, 'l'));
    await click(w2c(st, 520, 200).x, w2c(st, 520, 200).y);
    st = await boardState();
    ok('T6b 属性面板出现「发光颜色」', (st.insp || '').includes('发光颜色'));
    await clickSel('.color-swatch[data-color="purple"]'); await sleep(150);
    const es = await engineState();
    eq('T6c 引擎 props.color === purple', engineEl(es, 'l').props.color, 'purple');
    st = await boardState();
    const icon = elById(st, 'l').icon;
    ok('T6d 图标出现紫色亮色 #b57bff', icon.includes('#b57bff'));
    ok('T6e 图标不再是黄色亮色 #ffd23f', !icon.includes('#ffd23f'));
  }

  /* ---- T7 (G9) 发光地板：放置 + 通电光晕 ---- */
  {
    // (a) 元件库放置
    await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
    await clickSel('#btn-fit'); await sleep(150);
    let st = await boardState();
    await placePalette('power', 120, 240, st);
    st = await boardState();
    await placePalette('glow_floor', 480, 240, st);
    st = await boardState();
    const gf = st.els.find((e) => e.cls.includes('element-glow_floor'));
    const pw = st.els.find((e) => e.cls.includes('element-power'));
    ok('T7a 元件库放置 → 画布出现发光地板元素', !!gf);
    ok('T7b 画布出现电源元素', !!pw);
    if (gf && pw) {
      const po = st.ports.find((p) => p.el === pw.id && p.port === 'out');
      const gi = st.ports.find((p) => p.el === gf.id && p.port === 'in');
      await drag({ x: po.cx, y: po.cy }, { x: gi.cx, y: gi.cy }, { steps: 14 });
      st = await boardState();
      eq('T7c 端口→端口连线成功（1 根）', st.wires.length, 1);
      await ensureRunning();
      ok('T7d 运行后发光地板 lit', await waitForStatus(gf.id, '点亮'), statusOf(await boardState(), gf.id));
      st = await boardState();
      const icon = (elById(st, gf.id) || {}).icon || '';
      ok('T7e 图标出现黄色亮色 fill', icon.includes('#ffd23f'));
      ok('T7f 图标出现低透明度光晕层 opacity=0.30', icon.includes('opacity="0.30"'));
      ok('T7g 光晕为同色（fill=#ffd23f 且 opacity=0.30）', /opacity="0\.30"/.test(icon) && /fill="#ffd23f"[^>]*opacity="0\.30"|opacity="0\.30"[^>]*fill="#ffd23f"/.test(icon));
      const es = await engineState();
      eq('T7h 引擎：发光地板 lit=true', engineEl(es, gf.id).state.lit, true);
      eq('T7i 引擎：类型 = glow_floor', engineEl(es, gf.id).type, 'glow_floor');
    }
  }

  /* ---- T8 零页面异常 ---- */
  ok('T8 无未捕获异常（Runtime.exceptionThrown）', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));
  ok('T8a 无 Log.entryAdded(level=error)', logErrors.length === 0, logErrors.slice(0, 2).join(' | '));
  ok('T8b 无失败网络请求', failedRequests.length === 0, failedRequests.slice(0, 2).join(' | '));

  /* ---- T9 %APPDATA% 无新增写入 ---- */
  const appdataAfter = dirSnapshot(APPDATA_DIR);
  const beforeSet = new Map(appdataBefore.map((x) => [x.f, x.m]));
  const newWrites = appdataAfter.filter((a) => { const b = beforeSet.get(a.f); return b === undefined || a.m > b; });
  ok('T9 本次运行 %APPDATA%\\nms-power-sim-desktop 无新增/更新', newWrites.length === 0, `新增=${newWrites.length} ${newWrites.slice(0, 3).map((x) => x.f).join('|')}`);
}

try { await main(); }
catch (e) { ok('探针执行异常', false, e && e.stack ? e.stack : String(e)); }
finally {
  console.log(`\n===== 结果 =====\n通过 ${R.pass} / 失败 ${R.fail}`);
  if (R.fail) console.log('FAILURES:\n' + R.failures.join('\n'));
  console.log(R.fail === 0 ? 'QA2_PROBE_EXE_PASS' : 'QA2_PROBE_EXE_FAILED');
  if (child) { try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { } }
  await sleep(1200);
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { }
  process.exit(R.fail === 0 ? 0 : 1);
}
