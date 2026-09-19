#!/usr/bin/env node
/**
 * tests/qa_109_gestures.mjs
 * ---------------------------------------------------------------------------
 * QA 严过关 · 1.0.9 交互重构「真机浏览器手势」独立验证套件（G1~G11）。
 *
 * 依赖（需先手动启动，见 tests/browser.smoke.mjs 头部说明）：
 *   1) 静态服务： python -m http.server 8900 --bind 127.0.0.1   （cwd = 项目根）
 *   2) 无头 Edge： msedge.exe --headless=new --remote-debugging-port=9222
 *
 * 关键设计：
 *   · 世界↔屏幕一律读 <g class="viewport"> 的 transform 换算，绝不假设恒等。
 *   · 「引擎真实状态」通过拦截导出按钮的 Blob 抓取 engine.serialize() 的 JSON 得到
 *     ——页面无全局 engine 句柄，这是唯一无损读真值的途径（非改源码）。
 *   · 每条断言都能在实现坏掉时变红（无 ok(x,true) / >=0 之类恒真断言）。
 *
 * 运行： node tests/qa_109_gestures.mjs
 * 通过： exit 0；有失败： exit 1
 * ---------------------------------------------------------------------------
 */
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';

const DEBUG = process.env.QA_CDP || 'http://127.0.0.1:9222';
const APP = process.env.QA_URL || 'http://127.0.0.1:8900/index.html';

const R = { pass: 0, fail: 0, failures: [], lines: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  R.lines.push(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? ' :: ' + detail : ''}`);
  console.log(`${cond ? '  \u2713' : '  \u2717'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}
function eq(name, a, b) { return ok(name, JSON.stringify(a) === JSON.stringify(b), `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`); }
function note(s) { R.lines.push('  · ' + s); console.log('  \u00b7 ' + s); }

/* ============================== CDP 客户端 ============================== */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      } else for (const h of this.handlers) h(msg);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(fn) { this.handlers.push(fn); }
}
async function connect(url) { const ws = new WebSocket(url); await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws error')); }); return new CDP(ws); }

let page;
let targetId;
const exceptions = [], logErrors = [], failedRequests = [];

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
/** 分步拖拽（含修饰键）；返回落点（屏幕）。 */
async function drag(from, to, { steps = 12, mod = 0, button = 'left' } = {}) {
  const btns = button === 'middle' ? 4 : 1;
  await mouse('mouseMoved', from.x, from.y, { buttons: 0, button, modifiers: mod });
  await mouse('mousePressed', from.x, from.y, { buttons: btns, button, modifiers: mod });
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, { buttons: btns, button, modifiers: mod });
    await sleep(12);
  }
  await mouse('mouseReleased', to.x, to.y, { buttons: 0, button, modifiers: mod });
  await sleep(90);
}
const key = (type, k, code, vk) => page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const spaceDown = () => key('keyDown', ' ', 'Space', 32);
const spaceUp = () => key('keyUp', ' ', 'Space', 32);
async function pressSpace() { await blurFocus(); await spaceDown(); await spaceUp(); await sleep(150); }
async function pressCombo(k, code, vk, mod) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod });
  await sleep(180);
}
const CtrlZ = () => pressCombo('z', 'KeyZ', 90, 2);
const pressEscape = async () => { await blurFocus(); await key('keyDown', 'Escape', 'Escape', 27); await key('keyUp', 'Escape', 'Escape', 27); await sleep(150); };
const blurFocus = () => js(`if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();return 1;`);

const MOD_ALT = 1, MOD_CTRL = 2, MOD_SHIFT = 8;

async function rectOf(sel) { return js(`const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,left:r.left,top:r.top,w:r.width,h:r.height};`); }
async function clickSel(sel) { const c = await rectOf(sel); if (!c) { ok(`点击 ${sel}`, false, '元素不存在'); return false; } await click(c.x, c.y); return true; }
const setView = async (name) => { await clickSel(`.nav-btn[data-view="${name}"]`); await sleep(250); };
const focusBoard = () => js(`document.getElementById('board').scrollIntoView({block:'center'});return 1;`).then(() => sleep(200));
const clearCanvas = () => js(`document.getElementById('btn-clear').click();return 1;`).then(() => sleep(250));
async function ensureRunning() {
  const paused = await js(`return document.getElementById('btn-run').classList.contains('is-paused');`);
  if (paused) { await js(`document.getElementById('btn-run').click();return 1;`); await sleep(150); }
}
async function importJSON(obj, tag) {
  const file = `C:/Users/liao9/AppData/Local/Temp/qa109_${tag}.json`;
  fs.writeFileSync(file, JSON.stringify(obj));
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
  await page.send('DOM.setFileInputFiles', { files: [file], nodeId });
  await sleep(500);
}

/* --------------------------- 画布状态（世界坐标感知） --------------------------- */
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
  const wrap=document.getElementById('canvas-wrap');
  return {rect:{left:r.left,top:r.top,width:r.width,height:r.height},view:{k,tx,ty},els,ports,sel,marquee,wires,status,insp,
    wrapCls:wrap.className, btnRun:document.getElementById('btn-run').textContent, simState:document.getElementById('sim-state').textContent,
    wiresHidden:board.classList.contains('wires-hidden'), aria:document.getElementById('btn-wires-hidden').getAttribute('aria-pressed')};
`;
const boardState = () => js(READ_BOARD);
const statusOf = (st, id) => (st.status.find((s) => s.id === '#' + id) || {}).state;
const w2c = (st, x, y) => ({ x: st.rect.left + st.view.tx + x * st.view.k, y: st.rect.top + st.view.ty + y * st.view.k });
const c2w = (st, cx, cy) => ({ x: (cx - st.rect.left - st.view.tx) / st.view.k, y: (cy - st.rect.top - st.view.ty) / st.view.k });
const snap = (v) => Math.round(v / 24) * 24;
const elById = (st, id) => st.els.find((e) => e.id === id);

async function waitForStatus(id, text, timeoutMs = 1800) {
  const t0 = Date.now();
  for (;;) {
    const cur = await js(`const row=[...document.querySelectorAll('#inspector-status .status-row')].find(r=>(r.querySelector('.sr-id')||{}).textContent==='#'+${JSON.stringify(id)});return row?(row.querySelector('.sr-state')||{}).textContent:null;`);
    if (cur === text) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(60);
  }
}

/** 找一个「画布内、不在任何元件上、且落在 svg 上」的空白屏幕点。 */
function findBlankPoint() {
  return js(`
    const board=document.getElementById('board');const r=board.getBoundingClientRect();
    for(let fy=0.15; fy<=0.9; fy+=0.08){ for(let fx=0.12; fx<=0.92; fx+=0.08){
      const x=r.left+r.width*fx, y=r.top+r.height*fy;
      if(x<=r.left+6||x>=r.right-6||y<=r.top+6||y>=r.bottom-6) continue;
      const el=document.elementFromPoint(x,y);
      if(!el) continue;
      if(el.closest&&el.closest('[data-el]')) continue;
      if(!(el===board||board.contains(el))) continue;
      return {x,y};
    }} return null;`);
}

/* ---------------- 引擎真实状态：拦截导出按钮的 Blob 抓 serialize() ---------------- */
async function patchExport() {
  await js(`
    if(!window.__qaCap){
      window.__qaCap={blob:null};
      URL.createObjectURL=function(b){window.__qaCap.blob=b;return 'blob:qa109';};
      URL.revokeObjectURL=function(){};
      HTMLAnchorElement.prototype.click=function(){};
    }
    return 1;`);
}
async function engineState() {
  await js(`document.getElementById('btn-export').click();return 1;`);
  await sleep(50);
  const txt = await js(`return window.__qaCap.blob ? window.__qaCap.blob.text() : null;`);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (e) { return null; }
}
const engineEl = (st, id) => (st && Array.isArray(st.elements) ? st.elements.find((e) => e.id === id) : null) || null;

async function placePalette(type, wx, wy, st) {
  await js(`const it=document.querySelector('.palette-item[data-type="${type}"]');if(!it.classList.contains('is-active'))it.click();return 1;`);
  await sleep(60);
  const p = w2c(st, wx, wy);
  await click(p.x, p.y);
  await sleep(140);
}

/* ================================ 电路样例 ================================ */
const C_TWO_LAMPS = {
  elements: [
    { id: 'p', type: 'power', x: 120, y: 120 },
    { id: 'l1', type: 'lamp', x: 480, y: 120 },
    { id: 'l2', type: 'lamp', x: 480, y: 360 },
  ],
  wires: [
    { id: 'w1', a: { el: 'p', port: 'out' }, b: { el: 'l1', port: 'in' } },
    { id: 'w2', a: { el: 'l1', port: 'in' }, b: { el: 'l2', port: 'in' } },
  ],
  timeOfDay: 8, dayCycle: false,
};
const C_MARQUEE = {
  elements: [
    { id: 'p', type: 'power', x: 120, y: 120 },
    { id: 'w1', type: 'wall_switch', x: 360, y: 120 },
    { id: 'l', type: 'lamp', x: 600, y: 120 },
    { id: 'w2', type: 'wall_switch', x: 360, y: 360 },
  ],
  wires: [
    { id: 'wa', a: { el: 'p', port: 'out' }, b: { el: 'w1', port: 'a' } },
    { id: 'wb', a: { el: 'w1', port: 'b' }, b: { el: 'l', port: 'in' } },
  ],
  timeOfDay: 8, dayCycle: false,
};

/* ================================ G1 ================================ */
async function G1_blankDragPans() {
  console.log('\n--- G1 空白拖动 = 平移 ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(150);
  await importJSON(C_MARQUEE, 'g1');
  await ensureRunning();
  let st = await boardState();
  // 先选中一个元件（用于验证平移期间选择集不被清空）
  await click(w2c(st, 120, 120).x, w2c(st, 120, 120).y);
  st = await boardState();
  const selBefore = [...st.sel].sort();
  eq('G1 预置：已选中 1 个元件', st.sel.length, 1);
  const before = { tx: st.view.tx, ty: st.view.ty };
  const coords0 = st.els.map((e) => `${e.id}:${e.x},${e.y}`).sort();

  const bp = await findBlankPoint();
  ok('G1 找到空白起始点', !!bp, JSON.stringify(bp));
  const from = bp, to = { x: bp.x + 130, y: bp.y + 70 };
  // 手动拖：中途检查 marquee-box 未出现
  await mouse('mouseMoved', from.x, from.y, { buttons: 0 });
  await mouse('mousePressed', from.x, from.y, { buttons: 1 });
  for (let i = 1; i <= 10; i++) {
    await mouse('mouseMoved', from.x + (to.x - from.x) * i / 10, from.y + (to.y - from.y) * i / 10, { buttons: 1 });
    await sleep(12);
  }
  const mid = await boardState();
  ok('G1 平移期间 marquee-box 未出现', mid.marquee === false);
  await mouse('mouseReleased', to.x, to.y, { buttons: 0 });
  await sleep(120);

  st = await boardState();
  const dtx = st.view.tx - before.tx, dty = st.view.ty - before.ty;
  ok('G1 空白拖动使 view.tx/ty 明显变化', Math.abs(dtx) > 30 && Math.abs(dty) > 20, `tx ${before.tx.toFixed(1)}→${st.view.tx.toFixed(1)} (Δ${dtx.toFixed(1)}), ty ${before.ty.toFixed(1)}→${st.view.ty.toFixed(1)} (Δ${dty.toFixed(1)})`);
  const coords1 = st.els.map((e) => `${e.id}:${e.x},${e.y}`).sort();
  eq('G1 平移期间元件坐标一个都没变', coords1, coords0);
  eq('G1 平移不清空选择集', [...st.sel].sort(), selBefore);
}

/* ================================ G2 ================================ */
async function G2_blankClickClears() {
  console.log('\n--- G2 空白单击（无位移）= 清空选择 ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(150);
  await importJSON(C_MARQUEE, 'g2');
  await ensureRunning();
  let st = await boardState();
  await click(w2c(st, 120, 120).x, w2c(st, 120, 120).y);
  st = await boardState();
  eq('G2 先选中 1 个元件', st.sel.length, 1);
  const before = { tx: st.view.tx, ty: st.view.ty };
  const bp = await findBlankPoint();
  await click(bp.x, bp.y); // 点一下不拖
  st = await boardState();
  eq('G2 空白单击 → 选择集清空', st.sel.length, 0);
  ok('G2 空白单击 → tx/ty 基本不变（|Δ|<2）', Math.abs(st.view.tx - before.tx) < 2 && Math.abs(st.view.ty - before.ty) < 2, `Δ=(${(st.view.tx - before.tx).toFixed(2)},${(st.view.ty - before.ty).toFixed(2)})`);
}

/* ================================ G3 ================================ */
async function G3_ctrlDragMarquee() {
  console.log('\n--- G3 Ctrl+拖动 = 框选 ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(150);
  await importJSON(C_MARQUEE, 'g3');
  await ensureRunning();
  let st = await boardState();
  const view0 = { tx: st.view.tx, ty: st.view.ty };

  // 左→右：完全包含 p/w1/l，排除 w2
  const a = w2c(st, 20, 20), b = w2c(st, 700, 230);
  await mouse('mouseMoved', a.x, a.y, { buttons: 0, modifiers: MOD_CTRL });
  await mouse('mousePressed', a.x, a.y, { buttons: 1, modifiers: MOD_CTRL });
  for (let i = 1; i <= 10; i++) {
    await mouse('mouseMoved', a.x + (b.x - a.x) * i / 10, a.y + (b.y - a.y) * i / 10, { buttons: 1, modifiers: MOD_CTRL });
    await sleep(12);
  }
  const mid = await boardState();
  ok('G3 Ctrl 拖动期间 marquee-box 出现', mid.marquee === true);
  await mouse('mouseReleased', b.x, b.y, { buttons: 0, modifiers: MOD_CTRL });
  await sleep(120);
  st = await boardState();
  eq('G3 左→右框选：完全包含 3 个（p/w1/l）', [...st.sel].sort(), ['l', 'p', 'w1']);
  ok('G3 框外的 w2 未被选中', !st.sel.includes('w2'));
  ok('G3 框选期间 tx/ty 不变', Math.abs(st.view.tx - view0.tx) < 0.5 && Math.abs(st.view.ty - view0.ty) < 0.5,
    `Δ=(${(st.view.tx - view0.tx).toFixed(2)},${(st.view.ty - view0.ty).toFixed(2)})`);
  ok('G3 松手后 marquee-box 移除', st.marquee === false);

  // 右→左：相交即选中
  await pressEscape();
  await importJSON({ elements: [{ id: 'l1', type: 'lamp', x: 120, y: 120 }, { id: 'l2', type: 'lamp', x: 360, y: 120 }], wires: [], timeOfDay: 8, dayCycle: false }, 'g3b');
  st = await boardState();
  await drag(w2c(st, 400, 200), w2c(st, 200, 60), { steps: 12, mod: MOD_CTRL });
  st = await boardState();
  eq('G3 右→左框选（相交即选中）命中 l2 一个', st.sel, ['l2']);
}

/* ================================ G4 ================================ */
async function G4_spaceTogglesWires() {
  console.log('\n--- G4 空格 = 隐藏/显示线条（且不改播放状态） ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(150);
  await importJSON(C_MARQUEE, 'g4');
  await ensureRunning();
  let st = await boardState();
  const run0 = st.btnRun, sim0 = st.simState;
  eq('G4 初始：线条显示（无 wires-hidden 类）', st.wiresHidden, false);
  eq('G4 初始：按钮 aria-pressed=false', st.aria, 'false');

  await pressSpace();
  st = await boardState();
  eq('G4 按一次空格 → svg 根出现 wires-hidden', st.wiresHidden, true);
  eq('G4 按一次空格 → 按钮 aria-pressed=true', st.aria, 'true');
  eq('G4 空格未改变播放/暂停按钮文案', st.btnRun, run0);
  eq('G4 空格未改变 sim-state', st.simState, sim0);

  await pressSpace();
  st = await boardState();
  eq('G4 再按一次 → 恢复显示', st.wiresHidden, false);
  eq('G4 再按一次 → aria-pressed=false', st.aria, 'false');
  eq('G4 再按一次播放状态仍不变', st.btnRun, run0);
}

/* ================================ G5 ================================ */
async function G5_altDragDuplicates() {
  console.log('\n--- G5 Alt+拖动 = 复制一份 ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(150);
  await importJSON({ elements: [{ id: 'L', type: 'lamp', x: 360, y: 120, props: { color: 'blue' } }], wires: [], timeOfDay: 8, dayCycle: false }, 'g5');
  await ensureRunning();
  let st = await boardState();
  eq('G5 预置 1 个 lamp（蓝色）', st.els.length, 1);
  const origPos = { x: elById(st, 'L').x, y: elById(st, 'L').y };
  const drop = { x: w2c(st, 360, 120).x + 240, y: w2c(st, 360, 120).y + 168 };
  const dropW = c2w(st, drop.x, drop.y);

  // 拖动（Alt）+ 连续多步 → 只应产生一份副本
  await drag(w2c(st, origPos.x, origPos.y), drop, { steps: 16, mod: MOD_ALT });
  st = await boardState();
  eq('G5 Alt 拖动后元件总数 = 2（只复制一份，未 +2/+3）', st.els.length, 2);
  const orig = elById(st, 'L');
  ok('G5 原元件坐标完全没变', orig.x === origPos.x && orig.y === origPos.y, `原=(${orig.x},${orig.y})`);
  const copy = st.els.find((e) => e.id !== 'L');
  ok('G5 副本存在', !!copy, `ids=${st.els.map((e) => e.id).join(',')}`);
  if (copy) {
    eq('G5 副本坐标 = 拖动落点（含吸附）', `${copy.x},${copy.y}`, `${snap(dropW.x)},${snap(dropW.y)}`);
    eq('G5 松手后副本处于选中', st.sel, [copy.id]);
  }
  const es = await engineState();
  const eOrig = engineEl(es, 'L'), eCopy = copy ? engineEl(es, copy.id) : null;
  ok('G5 副本 props.color 与原元件一致（=blue）', !!eCopy && eCopy.props.color === 'blue' && eOrig.props.color === 'blue',
    `copy=${eCopy && eCopy.props.color} orig=${eOrig && eOrig.props.color}`);

  await blurFocus();
  await CtrlZ();
  st = await boardState();
  eq('G5 Ctrl+Z 撤销后元件总数回到 1', st.els.length, 1);
}

/* ================================ G6 ================================ */
async function G6_altClickNoAction() {
  console.log('\n--- G6 Alt+单击不触发动作 ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(150);
  await importJSON({ elements: [{ id: 'p', type: 'power', x: 200, y: 200 }], wires: [], timeOfDay: 8, dayCycle: false }, 'g6');
  await ensureRunning();
  let st = await boardState();
  let es = await engineState();
  const on0 = engineEl(es, 'p').state.on;
  ok('G6 预置电源初始 on=true', on0 === true, `on=${on0}`);

  // Alt+单击（不拖）
  await click(w2c(st, 200, 200).x, w2c(st, 200, 200).y, MOD_ALT);
  es = await engineState();
  eq('G6 Alt+单击后电源 on 不变（仍 true）', engineEl(es, 'p').state.on, true);

  // 对照：普通单击会翻转
  st = await boardState();
  await click(w2c(st, 200, 200).x, w2c(st, 200, 200).y, 0);
  es = await engineState();
  eq('G6 对照：普通单击翻转 on → false', engineEl(es, 'p').state.on, false);
}

/* ================================ G7 ================================ */
const PURPLE_ON = '#b57bff'; // catalog.LIGHT_COLORS.purple.on
async function G7_colorChangeRepaints() {
  console.log('\n--- G7 改色真的换色（数据 + 图像） ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(150);
  await importJSON({ elements: [{ id: 'p', type: 'power', x: 120, y: 120 }, { id: 'l', type: 'lamp', x: 480, y: 120 }], wires: [{ id: 'w', a: { el: 'p', port: 'out' }, b: { el: 'l', port: 'in' } }], timeOfDay: 8, dayCycle: false }, 'g7');
  await ensureRunning();
  await waitForStatus('l', '点亮');
  let st = await boardState();
  ok('G7 灯已点亮（lit=true，图标用 on 色）', statusOf(st, 'l') === '点亮', statusOf(st, 'l'));

  // 选中灯 → 点紫色块
  await click(w2c(st, 480, 120).x, w2c(st, 480, 120).y);
  st = await boardState();
  ok('G7 属性面板出现颜色行', (st.insp || '').includes('发光颜色'), (st.insp || '').slice(0, 30));
  await clickSel('.color-swatch[data-color="purple"]');
  await sleep(150);

  const es = await engineState();
  eq('G7 引擎 props.color === purple', engineEl(es, 'l').props.color, 'purple');
  st = await boardState();
  const icon = elById(st, 'l').icon;
  ok('G7 画布图标 SVG 出现紫色亮色 fill', icon.includes(PURPLE_ON), `含 ${PURPLE_ON}=${icon.includes(PURPLE_ON)}`);
  ok('G7 图标不再是黄色亮色（#ffd23f）', !icon.includes('#ffd23f'));
  const active = await js(`const a=document.querySelector('#inspector-props .color-swatch.is-active');return a?a.getAttribute('data-color'):null;`);
  eq('G7 属性面板当前色高亮 = purple', active, 'purple');
}

/* ================================ G8 ================================ */
const GREEN_ON = '#2fd06a'; // LIGHT_COLORS.green.on
async function G8_batchColorMulti() {
  console.log('\n--- G8 多选批量改色 ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(150);
  await importJSON(C_TWO_LAMPS, 'g8');
  await ensureRunning();
  let st = await boardState();
  // Ctrl 框选两个 lamp（世界 (400,40)-(620,440) 完全包含 l1/l2）
  await drag(w2c(st, 400, 40), w2c(st, 620, 440), { steps: 12, mod: MOD_CTRL });
  st = await boardState();
  eq('G8 Ctrl 框选 2 个 lamp', [...st.sel].sort(), ['l1', 'l2']);
  ok('G8 多选面板出现批量颜色行', (st.insp || '').includes('发光颜色（批量'), (st.insp || '').slice(0, 40));

  await clickSel('.color-swatch[data-color="green"]');
  await sleep(150);
  const es = await engineState();
  eq('G8 引擎：l1 props.color = green', engineEl(es, 'l1').props.color, 'green');
  eq('G8 引擎：l2 props.color = green', engineEl(es, 'l2').props.color, 'green');
  st = await boardState();
  const i1 = elById(st, 'l1').icon, i2 = elById(st, 'l2').icon;
  ok('G8 l1 图标换成绿色亮色 fill', i1.includes(GREEN_ON));
  ok('G8 l2 图标换成绿色亮色 fill', i2.includes(GREEN_ON));
}

/* ================================ G9 ================================ */
async function G9_glowFloorE2E() {
  console.log('\n--- G9 发光地板端到端（放置→接线→点亮→光晕） ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(150);
  let st = await boardState();

  // 元件库放置 power 与 glow_floor
  await placePalette('power', 120, 240, st);
  st = await boardState();
  await placePalette('glow_floor', 480, 240, st);
  st = await boardState();
  const gf = st.els.find((e) => e.cls.includes('element-glow_floor'));
  const pw = st.els.find((e) => e.cls.includes('element-power'));
  ok('G9 元件库放置 → 画布出现发光地板元素', !!gf, `els=${st.els.map((e) => e.cls).join('|')}`);
  ok('G9 画布出现电源元素', !!pw);
  if (!gf || !pw) { ok('G9 前置失败，后续跳过', false); return; }

  // 从 power.out 拖到 glow_floor.in
  const po = st.ports.find((p) => p.el === pw.id && p.port === 'out');
  const gi = st.ports.find((p) => p.el === gf.id && p.port === 'in');
  await drag({ x: po.cx, y: po.cy }, { x: gi.cx, y: gi.cy }, { steps: 14 });
  st = await boardState();
  eq('G9 端口→端口成功连线（1 根）', st.wires.length, 1);
  await ensureRunning();
  ok('G9 运行后发光地板 lit（状态=点亮）', await waitForStatus(gf.id, '点亮'), statusOf(await boardState(), gf.id));

  st = await boardState();
  const icon = (elById(st, gf.id) || {}).icon || '';
  const YELLOW_ON = '#ffd23f';
  ok('G9 图标出现黄色亮色 fill', icon.includes(YELLOW_ON), `含 ${YELLOW_ON}=${icon.includes(YELLOW_ON)}`);
  ok('G9 图标出现低透明度光晕层（opacity=0.30）', icon.includes('opacity="0.30"'));
  ok('G9 光晕为同色（fill 与亮色一致）', /opacity="0\.30"/.test(icon) && /fill="#ffd23f"[^>]*opacity="0\.30"|opacity="0\.30"[^>]*fill="#ffd23f"/.test(icon), icon.slice(0, 160));
  const es = await engineState();
  eq('G9 引擎：发光地板 lit=true', engineEl(es, gf.id).state.lit, true);
  eq('G9 引擎：发光地板类型正确', engineEl(es, gf.id).type, 'glow_floor');
}

/* ================================ G10 ================================ */
async function readLampColor(lampId) {
  // 重新选中该灯（撤销后会清空选择）→ 读属性面板当前色
  const st = await boardState();
  const e = elById(st, lampId);
  const p = w2c(st, e.x, e.y);
  await click(p.x, p.y);
  return js(`const a=document.querySelector('#inspector-props .color-swatch.is-active');return a?a.getAttribute('data-color'):null;`);
}
async function G10_undoColorSemantics() {
  console.log('\n--- G10 改色撤销语义（逐级可撤销 + 点当前色为空操作） ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(150);
  await importJSON({ elements: [{ id: 'l', type: 'lamp', x: 360, y: 240 }], wires: [], timeOfDay: 8, dayCycle: false }, 'g10');
  await ensureRunning();
  let st = await boardState();
  // 选中灯
  await click(w2c(st, 360, 240).x, w2c(st, 360, 240).y);
  eq('G10 初始色 = yellow', await readLampColor('l'), 'yellow');

  await clickSel('.color-swatch[data-color="green"]'); await sleep(120);
  await clickSel('.color-swatch[data-color="blue"]'); await sleep(120);
  await clickSel('.color-swatch[data-color="red"]'); await sleep(120);
  eq('G10 连点 绿→蓝→红 后 = red', await readLampColor('l'), 'red');

  await blurFocus();
  await CtrlZ(); eq('G10 撤销 1 → blue', await readLampColor('l'), 'blue');
  await blurFocus();
  await CtrlZ(); eq('G10 撤销 2 → green', await readLampColor('l'), 'green');
  await blurFocus();
  await CtrlZ(); eq('G10 撤销 3 → yellow', await readLampColor('l'), 'yellow');

  // 点当前已选色 = 空操作（不压新快照）
  await clickSel('.color-swatch[data-color="green"]'); await sleep(120); // yellow→green
  await clickSel('.color-swatch[data-color="blue"]'); await sleep(120);  // green→blue
  eq('G10 阶段2：当前色 = blue', await readLampColor('l'), 'blue');
  await clickSel('.color-swatch[data-color="blue"]'); await sleep(120);  // 点当前色（空操作）
  await blurFocus();
  await CtrlZ(); eq('G10 点当前色不产生撤销步：撤销 1 次直接回 green', await readLampColor('l'), 'green');
  await blurFocus();
  await CtrlZ(); eq('G10 再撤销 → yellow', await readLampColor('l'), 'yellow');
}

/* ================================ 主流程 ================================ */
async function boot() {
  const ver = await (await fetch(DEBUG + '/json/version')).json();
  const browser = await connect(ver.webSocketDebuggerUrl);
  ({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }));
  try {
    const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId });
    await browser.send('Browser.setWindowBounds', { windowId, bounds: { width: 1600, height: 1000, windowState: 'normal' } });
  } catch (e) { note('setWindowBounds 失败（忽略）: ' + e.message); }
  const list = await (await fetch(DEBUG + '/json/list')).json();
  page = await connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logErrors.push(m.params.entry.text);
    else if (m.method === 'Network.loadingFailed') failedRequests.push(m.params.errorText);
  });
  await page.send('Runtime.enable'); await page.send('Log.enable'); await page.send('Network.enable'); await page.send('Page.enable'); await page.send('DOM.enable');
  const loaded = new Promise((res) => page.on((m) => { if (m.method === 'Page.loadEventFired') res(); }));
  await page.send('Page.navigate', { url: APP });
  await Promise.race([loaded, sleep(8000)]); await sleep(1500);
  await patchExport();
  return browser;
}

const SECTIONS = [
  ['G1 空白拖动=平移', G1_blankDragPans],
  ['G2 空白单击=清空选择', G2_blankClickClears],
  ['G3 Ctrl+拖动=框选', G3_ctrlDragMarquee],
  ['G4 空格=隐藏/显示线条', G4_spaceTogglesWires],
  ['G5 Alt+拖动=复制一份', G5_altDragDuplicates],
  ['G6 Alt+单击不触发动作', G6_altClickNoAction],
  ['G7 改色真的换色', G7_colorChangeRepaints],
  ['G8 多选批量改色', G8_batchColorMulti],
  ['G9 发光地板端到端', G9_glowFloorE2E],
  ['G10 改色撤销语义', G10_undoColorSemantics],
];

const browser = await boot();
console.log('===== 1.0.9 · 真机浏览器手势独立验证（G1~G11）=====');
for (const [name, fn] of SECTIONS) {
  try { await fn(); } catch (e) { R.fail++; R.failures.push(`[${name}] 抛出异常：${e && e.stack ? e.stack : e}`); console.log('  \u2717 [' + name + '] 异常: ' + (e && e.message)); }
}
// G11 控制台零错误
console.log('\n--- G11 控制台零错误 ---');
ok('G11 无未捕获异常（Runtime.exceptionThrown）', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));
ok('G11 无 Log.entryAdded(level=error)', logErrors.length === 0, logErrors.slice(0, 3).join(' | '));
ok('G11 无失败网络请求', failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '));

try { await browser.send('Target.closeTarget', { targetId }); } catch (e) { /* ignore */ }

console.log('\n===== 结果 =====');
console.log(`  通过 ${R.pass} / 失败 ${R.fail}（断言总数 ${R.pass + R.fail}）`);
if (R.failures.length) { console.log('  失败明细：'); R.failures.forEach((f) => console.log('   ✗ ' + f)); }
console.log(R.fail === 0 ? 'QA109_GESTURES_PASS' : 'QA109_GESTURES_FAILED');
process.exit(R.fail === 0 ? 0 : 1);
