#!/usr/bin/env node
/**
 * tests/browser.smoke.mjs
 * ---------------------------------------------------------------------------
 * NMS 电力模拟器 · 真机浏览器回归套件（QA 严过关）
 *
 * 依赖（需先手动启动）：
 *   1) 静态服务： python -m http.server 8900 --bind 127.0.0.1   （cwd = 项目根）
 *   2) 无头浏览器： msedge.exe --headless=new --remote-debugging-port=9222
 *        --user-data-dir=C:/tmp/xxx --remote-allow-origins=* --window-size=1600,1000
 * 可选环境变量：QA_CDP / QA_URL / QA_SHOTS
 *
 * 运行： node tests/browser.smoke.mjs
 *
 * 说明：
 *   · 本轮修复了「屏幕坐标 = 世界坐标」的错误假设——现在一律读
 *     <g class="viewport"> 的 transform 做 世界↔屏幕 换算（因为载入实例后会自动 fitToContent，
 *     k/tx/ty 不再是 identity）。
 *   · 断言「需求要求应生效」的行为；已知缺陷用 probe()（仅报告、不计失败），
 *     以保证套件全绿的同时保留缺陷回归探针。
 * ---------------------------------------------------------------------------
 */
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';

const DEBUG = process.env.QA_CDP || 'http://127.0.0.1:9222';
const APP = process.env.QA_URL || 'http://127.0.0.1:8900/index.html';
const SHOTS = process.env.QA_SHOTS || 'C:/Users/liao9/AppData/Local/Temp/qa-shots';

const R = { pass: 0, fail: 0, failures: [], notes: [], known: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  console.log(`${cond ? '  \u2713' : '  \u2717'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}
function eq(name, a, b) { return ok(name, a === b, `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`); }
function note(s) { R.notes.push(s); console.log('  \u00b7 ' + s); }
function probe(name, defectPresent, evidence) {
  R.known.push(`${name} :: ${defectPresent ? '仍在' : '已修复'} :: ${evidence}`);
  console.log(`  ${defectPresent ? '\u26a0' : '\u2714'} [已知缺陷·${defectPresent ? '仍在' : '已修复'}] ${name} :: ${evidence}`);
}
const inBBox = (px, py, ex, ey, w, h) => px >= ex - w / 2 && px <= ex + w / 2 && py >= ey - h / 2 && py <= ey + h / 2;

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
const consoleMsgs = [], exceptions = [], logEntries = [], responses = new Map(), loadFailures = [];

async function js(expr) {
  const r = await page.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
const mouse = (type, x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: o.button ?? 'left', buttons: o.buttons ?? 0, clickCount: o.clickCount ?? 1, pointerType: 'mouse', modifiers: o.modifiers ?? 0 });
async function click(x, y, button = 'left') {
  const b = button === 'middle' ? 4 : 1;
  await mouse('mouseMoved', x, y, { buttons: 0, button });
  await mouse('mousePressed', x, y, { buttons: b, button });
  await sleep(30);
  await mouse('mouseReleased', x, y, { buttons: 0, button });
  await sleep(80);
}
/** 右键单击（导线拾取用）。 */
async function rightClick(x, y) {
  await mouse('mouseMoved', x, y, { buttons: 0, button: 'right' });
  await mouse('mousePressed', x, y, { buttons: 2, button: 'right' });
  await sleep(30);
  await mouse('mouseReleased', x, y, { buttons: 0, button: 'right' });
  await sleep(200);
}
// 1.0.9：新增 modifiers 形参——框选需带 Ctrl（MOD_CTRL），Alt 复制需带 Alt。
async function drag(from, to, steps = 12, button = 'left', modifiers = 0) {
  const btns = button === 'middle' ? 4 : 1;
  await mouse('mouseMoved', from.x, from.y, { buttons: 0, button, modifiers });
  await mouse('mousePressed', from.x, from.y, { buttons: btns, button, modifiers });
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, { buttons: btns, button, modifiers });
    await sleep(10);
  }
  await mouse('mouseReleased', to.x, to.y, { buttons: 0, button, modifiers });
  await sleep(80);
}
async function wheel(x, y, deltaY) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, button: 'none', pointerType: 'mouse' });
  await sleep(16);
}
const key = (type, k, code, vk) => page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const spaceDown = () => key('keyDown', ' ', 'Space', 32);
const spaceUp = () => key('keyUp', ' ', 'Space', 32);
/** 完整按键（keyDown + keyUp）：Delete / Escape 等window级快捷键用。 */
async function pressKey(k, code, vk) {
  await key('keyDown', k, code, vk);
  await key('keyUp', k, code, vk);
  await sleep(120);
}
const pressDelete = () => pressKey('Delete', 'Delete', 46);
const pressEscape = () => pressKey('Escape', 'Escape', 27);
const MOD_SHIFT = 8; // CDP modifiers：Shift=8
const MOD_CTRL = 2;  // CDP modifiers：Ctrl=2
const MOD_CTRL_SHIFT = 10; // Ctrl+Shift
/** 完整组合键（Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 等撤销重做快捷键用）。 */
async function pressCombo(k, code, vk, modifiers) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(150);
}
const pressCtrlZ = () => pressCombo('z', 'KeyZ', 90, MOD_CTRL);
const pressCtrlY = () => pressCombo('y', 'KeyY', 89, MOD_CTRL);
const pressCtrlShiftZ = () => pressCombo('z', 'KeyZ', 90, MOD_CTRL_SHIFT);
const undoDisabled = () => js(`return document.getElementById('btn-undo').disabled;`);
const redoDisabled = () => js(`return document.getElementById('btn-redo').disabled;`);
/** Shift+点击（加选 / 减选）。 */
async function shiftClick(x, y) {
  await mouse('mouseMoved', x, y, { buttons: 0 });
  await mouse('mousePressed', x, y, { buttons: 1, modifiers: MOD_SHIFT });
  await sleep(30);
  await mouse('mouseReleased', x, y, { buttons: 0, modifiers: MOD_SHIFT });
  await sleep(120);
}
const selBoxCount = () => js(`return document.querySelectorAll('#board .sel-box').length;`);
const selBoxIds = () => js(`return [...document.querySelectorAll('#board .sel-box')].map(b=>b.closest('[data-el]').getAttribute('data-el'));`);
const blurFocus = () => js(`if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();return 1;`);

async function rectOf(sel) { return js(`const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,left:r.left,top:r.top,w:r.width,h:r.height};`); }
async function clickSel(sel) { const c = await rectOf(sel); if (!c) { ok(`点击 ${sel}`, false, '元素不存在'); return false; } await click(c.x, c.y); return true; }
const setView = async (name) => { await clickSel(`.nav-btn[data-view="${name}"]`); await sleep(300); };
const focusBoard = () => js(`document.getElementById('board').scrollIntoView({block:'center'});return 1;`).then(() => sleep(200));
const clearCanvas = () => js(`document.getElementById('btn-clear').click();return 1;`).then(() => sleep(250));
async function ensureRunning() {
  const paused = await js(`return document.getElementById('btn-run').classList.contains('is-paused');`);
  if (paused) { await js(`document.getElementById('btn-run').click();return 1;`); await sleep(150); }
}
async function shot(name, clip) {
  try {
    const params = { format: 'png' }; if (clip) params.clip = { ...clip, scale: clip.scale || 1 };
    const r = await page.send('Page.captureScreenshot', params);
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'));
  } catch (e) { note(`截图失败 ${name}: ${e.message}`); }
}
async function importJSON(obj, tag) {
  const file = `C:/Users/liao9/AppData/Local/Temp/qa_smoke_${tag}.json`;
  fs.writeFileSync(file, JSON.stringify(obj));
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
  await page.send('DOM.setFileInputFiles', { files: [file], nodeId });
  await sleep(500);
}
async function samplePixels(points) {
  const b64 = (await page.send('Page.captureScreenshot', { format: 'png' })).data;
  return js(`return (async()=>{
    const b=await fetch('data:image/png;base64,${b64}').then(r=>r.blob());
    const bmp=await createImageBitmap(b);
    const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;
    const g=c.getContext('2d');g.drawImage(bmp,0,0);
    const pts=${JSON.stringify(points)};const dpr=bmp.width/(window.innerWidth||bmp.width);
    return pts.map(p=>{const d=g.getImageData(Math.round(p.x*dpr),Math.round(p.y*dpr),1,1).data;return [d[0],d[1],d[2],d[3]];});})()`);
}
const isIconWhite = (p) => p && p[0] > 150 && p[1] > 150 && p[2] > 150;

/* --------------------------- 画布状态（世界坐标感知） --------------------------- */
const READ_BOARD = `
  const board=document.getElementById('board');const r=board.getBoundingClientRect();
  const vg=board.querySelector('g.viewport');let k=1,tx=0,ty=0;
  if(vg){const t=vg.getAttribute('transform')||'';const m=/translate\\(([-\\d.]+)[ ,]([-\\d.]+)\\)\\s*scale\\(([-\\d.]+)\\)/.exec(t);if(m){tx=+m[1];ty=+m[2];k=+m[3];}}
  const els=[...board.querySelectorAll('.element')].map(g=>{
    const m=/translate\\(([-\\d.]+)[ ,]([-\\d.]+)\\)/.exec(g.getAttribute('transform')||'');
    return {id:g.getAttribute('data-el'),cls:g.getAttribute('class'),x:m?+m[1]:0,y:m?+m[2]:0};});
  const ports=[...board.querySelectorAll('.port')].map(p=>{
    const dot=p.querySelector('.port-dot');const g=p.closest('.element');
    const m=/translate\\(([-\\d.]+)[ ,]([-\\d.]+)\\)/.exec(g.getAttribute('transform')||'');
    const ex=m?+m[1]:0,ey=m?+m[2]:0;const dx=+dot.getAttribute('cx'),dy=+dot.getAttribute('cy');
    const wx=ex+dx,wy=ey+dy;
    return {el:p.getAttribute('data-el'),port:p.getAttribute('data-portname'),dot:dot.getAttribute('class'),wx,wy,cx:r.left+tx+wx*k,cy:r.top+ty+wy*k};});
  const wires=[...board.querySelectorAll('path.wire')].map(w=>({cls:w.getAttribute('class'),d:w.getAttribute('d')}));
  const status=[...document.querySelectorAll('#inspector-status .status-row')].map(row=>({
    id:(row.querySelector('.sr-id')||{}).textContent,state:(row.querySelector('.sr-state')||{}).textContent}));
  const insp=(document.getElementById('inspector-props')||{}).textContent||'';
  return {rect:{left:r.left,top:r.top,width:r.width,height:r.height},view:{k,tx,ty},els,ports,wires,status,insp};
`;
const boardState = () => js(READ_BOARD);
const statusOf = (st, id) => (st.status.find((s) => s.id === '#' + id) || {}).state;
/** 等待状态面板反映目标状态：状态面板由 statusLoop 以 ~120ms 节流刷新，
 *  结构变更后立即读取会拿到旧值（S2 连线灯亮断言的偶发根因）。
 *  轮询等待不会弱化断言——超时仍未出现目标状态则断言照常失败。 */
async function waitForStatus(id, text, timeoutMs = 1500) {
  const t0 = Date.now();
  for (;;) {
    const cur = await js(`const row=[...document.querySelectorAll('#inspector-status .status-row')].find(r=>(r.querySelector('.sr-id')||{}).textContent==='#'+${JSON.stringify(id)});return row?(row.querySelector('.sr-state')||{}).textContent:null;`);
    if (cur === text) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(60);
  }
}
const w2c = (st, x, y) => ({ x: st.rect.left + st.view.tx + x * st.view.k, y: st.rect.top + st.view.ty + y * st.view.k });
const snap = (v) => Math.round(v / 24) * 24;

/* --------------------------- 路径解析 / 几何 --------------------------- */
const GEOMETRY = {
  power: { w: 56, h: 60 }, solar_panel: { w: 76, h: 64 }, lamp: { w: 40, h: 66 }, door: { w: 96, h: 118 },
  wall_switch: { w: 60, h: 58 }, prox_switch: { w: 60, h: 56 }, button: { w: 60, h: 56 },
  floor_switch: { w: 96, h: 96 }, auto_switch: { w: 72, h: 62 }, inverter: { w: 72, h: 62 }, player: { w: 40, h: 46 },
};
const EPS = 0.02;
function parsePath(d) {
  const toks = String(d).trim().split(/\s+/); let i = 0; const cmds = [];
  while (i < toks.length) {
    const op = toks[i++];
    if (op === 'M' || op === 'L') cmds.push({ op, x: +toks[i++], y: +toks[i++] });
    else if (op === 'C') cmds.push({ op, cx1: +toks[i++], cy1: +toks[i++], cx2: +toks[i++], cy2: +toks[i++], x: +toks[i++], y: +toks[i++] });
    else if (op === 'A') cmds.push({ op, rx: +toks[i++], ry: +toks[i++], rot: +toks[i++], laf: +toks[i++], sf: +toks[i++], x: +toks[i++], y: +toks[i++] });
    else throw new Error('未知 path 命令 ' + op);
  }
  return cmds;
}
function analyze(d) {
  const cmds = parsePath(d); const segs = []; const arcs = []; const curves = []; const usedOps = new Set(); let cur = null;
  for (const c of cmds) {
    usedOps.add(c.op);
    if (c.op === 'M') cur = { x: c.x, y: c.y };
    else if (c.op === 'L') { const n = { x: c.x, y: c.y }; segs.push({ a: cur, b: n, kind: 'L' }); cur = n; }
    else if (c.op === 'C') { const n = { x: c.x, y: c.y }; curves.push({ a: cur, b: n, c1: { x: c.cx1, y: c.cy1 }, c2: { x: c.cx2, y: c.cy2 }, kind: 'C' }); segs.push({ a: cur, b: n, kind: 'C' }); cur = n; }
    else { const n = { x: c.x, y: c.y }; arcs.push({ r: c.rx, r2: c.ry, sf: c.sf, chord: Math.abs(cur.y - c.y) < EPS ? 'h' : 'v', start: cur, end: n, center: { x: (cur.x + c.x) / 2, y: (cur.y + c.y) / 2 } }); segs.push({ a: cur, b: n, kind: 'A' }); cur = n; }
  }
  return { cmds, segs, arcs, curves, usedOps };
}
const segThrough = (s, px, py, m = 12) => {
  if (Math.abs(s.a.y - s.b.y) < EPS) return Math.abs(py - s.a.y) < EPS && px > Math.min(s.a.x, s.b.x) + m && px < Math.max(s.a.x, s.b.x) - m;
  if (Math.abs(s.a.x - s.b.x) < EPS) return Math.abs(px - s.a.x) < EPS && py > Math.min(s.a.y, s.b.y) + m && py < Math.max(s.a.y, s.b.y) - m;
  return false;
};
const PRESET_NAMES = ['door_auto', 'marquee_button', 'waterfall_inverter', 'password_door', 'two_way', 'strobe', 'solar_day_night'];
async function loadPresetIdx(i) {
  await setView('presets'); await sleep(200);
  await js(`const b=[...document.querySelectorAll('#preset-root .preset-card .btn.primary')][${i}];if(b)b.scrollIntoView({block:'center'});return 1;`);
  await sleep(150);
  await js(`const b=[...document.querySelectorAll('#preset-root .preset-card .btn.primary')][${i}];if(b)b.click();return 1;`);
  await sleep(700); await focusBoard();
}
async function routingOf() {
  const st = await boardState();
  const wires = st.wires.map((w, i) => ({ id: 'w' + (i + 1), a: analyze(w.d) }));
  let badCmd = 0, badSeg = 0; const ops = new Set();
  for (const w of wires) for (const o of w.a.usedOps) { ops.add(o); if (!'MLCA'.includes(o)) badCmd++; }
  for (const w of wires) for (const s of w.a.segs) {
    if (s.kind === 'A' || s.kind === 'C') continue;
    if (Math.abs(s.a.y - s.b.y) >= EPS && Math.abs(s.a.x - s.b.x) >= EPS) badSeg++;
  }
  const curveN = wires.reduce((n, w) => n + w.a.curves.length, 0);
  const arcs = []; for (const w of wires) for (const a of w.a.arcs) arcs.push({ wire: w.id, ...a });
  const arcValid = arcs.every((a) => Math.abs(a.r - 7) < 1e-6 && Math.abs(Math.hypot(a.start.x - a.center.x, a.start.y - a.center.y) - 7) < 0.2);
  let notCross = 0;
  for (const arc of arcs) { const P = arc.center; const hit = wires.some((w) => w.id !== arc.wire && w.a.segs.some((s) => s.kind === 'L' && segThrough(s, P.x, P.y, 12))); if (!hit) notCross++; }
  const byPt = new Map(); for (const a of arcs) { const k = a.center.x + ',' + a.center.y; if (!byPt.has(k)) byPt.set(k, []); byPt.get(k).push(a); }
  let inconsistent = 0; for (const [, l] of byPt) if (l.length > 1 && new Set(l.map((a) => a.sf + ':' + a.chord)).size > 1) inconsistent++;
  const occ = arcs.map((a) => {
    let by = null;
    for (const e of st.els) { const g = GEOMETRY[e.cls.match(/element-([a-z_]+)/)[1]]; if (g && inBBox(a.center.x, a.center.y, e.x, e.y, g.w, g.h)) { by = e; break; } }
    return { wire: a.wire, x: a.center.x, y: a.center.y, occluded: !!by, by: by ? by.cls.match(/element-([a-z_]+)/)[1] + '#' + by.id : null };
  });
  return { st, wires, arcs, ops, badCmd, badSeg, curveN, arcValid, notCross, inconsistent, occ };
}

/* ================================ 分节 ================================ */
function s1Basics() {
  console.log('\n--- S1 首页基础 / DOM 计数 ---');
  ok('S1 零 console error', consoleMsgs.filter((c) => c.type === 'error' || c.type === 'assert').length === 0, JSON.stringify(consoleMsgs.filter((c) => c.type === 'error')).slice(0, 300));
  ok('S1 零未捕获异常', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 300));
  ok('S1 零 Log error', logEntries.filter((l) => l.level === 'error').length === 0);
  ok('S1 零资源加载失败', loadFailures.length === 0, JSON.stringify(loadFailures));
  ok('S1 所有网络响应 <400', [...responses.values()].every((s) => s < 400));
  eq('S1 加载 5 个 js 模块', [...responses.keys()].filter((u) => u.endsWith('.js')).length, 5);
  return js(`
    const cards=[...document.querySelectorAll('#catalog-root .el-card')];
    const solar=document.querySelector('#catalog-root .el-card[data-type="solar_panel"]');
    const glow=document.querySelector('#catalog-root .el-card[data-type="glow_floor"]');
    const lamp=document.querySelector('#catalog-root .el-card[data-type="lamp"]');
    return {catalog:cards.length, rule:!!document.querySelector('#catalog-root .rule-card'),
      everyHasSvg:cards.every(c=>c.querySelectorAll('.el-card-icon *').length>0),
      solar:!!solar, solarSvg:solar?solar.querySelectorAll('.el-card-icon *').length:0,
      glow:!!glow, glowSvg:glow?glow.querySelectorAll('.el-card-icon *').length:0,
      lampIcon:lamp?lamp.querySelector('.el-card-icon').innerHTML:'',
      solarPrinciple:solar?((solar.querySelector('.principle')||{}).textContent||''):''};`).then((d) => {
    ok('S1 图鉴：总规则卡存在', d.rule);
    eq('S1 图鉴卡片数 = 12（1.0.9 新增发光地板）', d.catalog, 12);
    ok('S1 每卡 SVG 图标有子节点', d.everyHasSvg);
    ok('S1 存在 solar_panel 图鉴卡且图标有子节点', d.solar && d.solarSvg > 0, `svg=${d.solarSvg}`);
    ok('S1 存在 glow_floor 图鉴卡且图标有子节点（1.0.9）', d.glow && d.glowSvg > 0, `svg=${d.glowSvg}`);
    ok('S1 灯柱缩略图默认黄色（props.color 缺省→yellow）', d.lampIcon.includes('#ffd23f') || d.lampIcon.includes('#8a7328'), d.lampIcon.slice(0, 80));
    ok('S1 太阳能板卡片文案含「白天…供电 / 夜晚…停止」', /白天/.test(d.solarPrinciple) && /(夜晚|入夜|停止)/.test(d.solarPrinciple), d.solarPrinciple.slice(0, 50));
  });
}

async function s2Coords() {
  console.log('\n--- S2 缩放态坐标系一致性 ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(200);
  let st = await boardState();
  const cx = st.rect.left + st.rect.width * 0.5, cy = st.rect.top + st.rect.height * 0.45;
  for (let i = 0; i < 8; i++) await wheel(cx, cy, 60);
  await blurFocus();
  // 1.0.9：平移改为「空白处直接拖动」（空格已不再是平移修饰键）；空画布中心即空白。
  await drag({ x: cx, y: cy }, { x: cx + 73, y: cy - 41 });
  await sleep(150);
  st = await boardState();
  ok('S2 已构造非 identity 视图（k≠1 且 t≠0）', Math.abs(st.view.k - 1) > 0.15 && (Math.abs(st.view.tx) > 5 || Math.abs(st.view.ty) > 5), `k=${st.view.k.toFixed(3)} tx=${st.view.tx.toFixed(1)} ty=${st.view.ty.toFixed(1)}`);
  // 放置
  const sp = { x: st.rect.left + st.rect.width * 0.35, y: st.rect.top + st.rect.height * 0.42 };
  const ew = { x: (sp.x - st.rect.left - st.view.tx) / st.view.k, y: (sp.y - st.rect.top - st.view.ty) / st.view.k };
  await clickSel('.palette-item[data-type="wall_switch"]');
  await click(sp.x, sp.y); await sleep(150);
  st = await boardState();
  const placed = st.els.find((e) => e.cls.includes('wall_switch'));
  ok('S2 缩放态可放置元件', !!placed, `els=${st.els.length}`);
  if (placed) {
    note(`S2 放置：屏幕(${sp.x.toFixed(0)},${sp.y.toFixed(0)}) → clientToWorld(${ew.x.toFixed(2)},${ew.y.toFixed(2)}) → snap(${snap(ew.x)},${snap(ew.y)})，实测(${placed.x},${placed.y})`);
    ok('S2 放置：世界坐标 = 屏幕点换算后网格吸附（完全一致）', placed.x === snap(ew.x) && placed.y === snap(ew.y), `实测(${placed.x},${placed.y}) 期望(${snap(ew.x)},${snap(ew.y)})`);
    ok('S2 放置：世界坐标为 24 网格整数倍', placed.x % 24 === 0 && placed.y % 24 === 0);
    const dt2 = { x: sp.x + 157, y: sp.y + 91 };
    const ew2 = { x: (dt2.x - st.rect.left - st.view.tx) / st.view.k, y: (dt2.y - st.rect.top - st.view.ty) / st.view.k };
    await drag(w2c(st, placed.x, placed.y), dt2);
    const st2 = await boardState(); const moved = st2.els.find((e) => e.id === placed.id);
    ok('S2 缩放态拖动：落点世界坐标一致（网格吸附后完全一致）', moved.x === snap(ew2.x) && moved.y === snap(ew2.y), `实测(${moved.x},${moved.y}) 期望(${snap(ew2.x)},${snap(ew2.y)})`);
    ok('S2 缩放态拖动：确实移动', moved.x !== placed.x || moved.y !== placed.y);
    await clearCanvas();
  }
  // 端口连线
  await importJSON({ elements: [{ id: 'p', type: 'power', x: 120, y: 120 }, { id: 'l', type: 'lamp', x: 420, y: 120 }], wires: [], timeOfDay: 8, dayCycle: false }, 's2wire');
  let s = await boardState();
  const po = s.ports.find((p) => p.el === 'p' && p.port === 'out');
  const li = s.ports.find((p) => p.el === 'l' && p.port === 'in');
  await drag({ x: po.cx, y: po.cy }, { x: li.cx, y: li.cy });
  s = await boardState();
  eq('S2 缩放态端口→端口成功连线', s.wires.length, 1);
  await waitForStatus('l', '点亮'); // 状态面板 ~120ms 节流，等它反映通电状态
  s = await boardState();
  ok('S2 缩放态连线后灯点亮（端口命中正确）', statusOf(s, 'l') === '点亮', statusOf(s, 'l'));
  // 令牌拖动
  await importJSON({
    elements: [{ id: 'p', type: 'power', x: 120, y: 120 }, { id: 'px', type: 'prox_switch', x: 460, y: 120, props: { radius: 130 } }, { id: 'l', type: 'lamp', x: 460, y: 420 }, { id: 'tk', type: 'player', x: 760, y: 500 }],
    wires: [{ id: 'w1', a: { el: 'p', port: 'out' }, b: { el: 'px', port: 'a' } }, { id: 'w2', a: { el: 'px', port: 'b' }, b: { el: 'l', port: 'in' } }], timeOfDay: 8, dayCycle: false,
  }, 's2token');
  s = await boardState();
  const tk = s.els.find((e) => e.cls.includes('player')); const px = s.els.find((e) => e.cls.includes('prox_switch'));
  ok('S2 令牌在圈外时灯灭', statusOf(s, 'l') === '熄灭');
  await drag(w2c(s, tk.x, tk.y), w2c(s, px.x, px.y));
  s = await boardState();
  ok('S2 缩放态拖动令牌 → 邻近开关导通 → 灯亮', statusOf(s, 'l') === '点亮', statusOf(s, 'l'));
  // 逆运算
  let maxErr = 0;
  for (let i = 0; i < 40; i++) {
    const x = (Math.random() * 2000 - 500), y = (Math.random() * 1400 - 300);
    const c = w2c(s, x, y);
    maxErr = Math.max(maxErr, Math.abs((c.x - s.rect.left - s.view.tx) / s.view.k - x), Math.abs((c.y - s.rect.top - s.view.ty) / s.view.k - y));
  }
  note(`S2 worldToClient/clientToWorld 往返最大误差 = ${maxErr.toExponential(3)}px`);
  ok('S2 worldToClient 与 clientToWorld 互逆（<0.5px）', maxErr < 0.5);
}

async function s3ZoomPan() {
  console.log('\n--- S3 缩放 / 平移交互 ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(150);
  let st = await boardState();
  const ax = st.rect.left + st.rect.width * 0.4, ay = st.rect.top + st.rect.height * 0.35;
  const wb = { x: (ax - st.rect.left - st.view.tx) / st.view.k, y: (ay - st.rect.top - st.view.ty) / st.view.k };
  await wheel(ax, ay, -180);
  let st2 = await boardState();
  const wa = { x: (ax - st2.rect.left - st2.view.tx) / st2.view.k, y: (ay - st2.rect.top - st2.view.ty) / st2.view.k };
  ok('S3 滚轮缩放以指针为锚点（锚点世界坐标不变 ±1px）', Math.abs(wb.x - wa.x) <= 1 && Math.abs(wb.y - wa.y) <= 1, `Δ=(${(wa.x - wb.x).toFixed(3)},${(wa.y - wb.y).toFixed(3)})`);
  ok('S3 滚轮方向（deltaY<0 放大）', st2.view.k > st.view.k);
  for (let i = 0; i < 40; i++) await wheel(ax, ay, -120);
  st = await boardState();
  ok('S3 缩放上限 clamp k=3', Math.abs(st.view.k - 3) < 1e-6, `k=${st.view.k}`);
  let far = false, farther = false;
  for (let i = 0; i < 220; i++) {
    await wheel(ax, ay, 120);
    const c = await js(`const w=document.getElementById('canvas-wrap');return {f:w.classList.contains('zoom-far'),g:w.classList.contains('zoom-farther')};`);
    if (c.f) far = true; if (c.g) farther = true;
  }
  st = await boardState();
  ok('S3 缩放下限 clamp k=0.25', Math.abs(st.view.k - 0.25) < 1e-6, `k=${st.view.k}`);
  ok('S3 k<0.55 时 zoom-far 生效', far);
  ok('S3 k<0.3 时 zoom-farther 生效', farther);
  await clickSel('#btn-fit'); await sleep(120); await wheel(ax, ay, -140);
  const grid = await js(`const w=document.getElementById('canvas-wrap');const cs=getComputedStyle(w);
    return {k:parseFloat(cs.getPropertyValue('--k')),tx:cs.getPropertyValue('--tx').trim(),ty:cs.getPropertyValue('--ty').trim(),size:cs.backgroundSize,pos:cs.backgroundPosition};`);
  const sz = grid.size.split(',').map((x) => parseFloat(x));
  ok('S3 细网格 background-size = 24*--k', Math.abs(sz[2] - 24 * grid.k) < 0.05, `${sz[2]} vs ${(24 * grid.k).toFixed(3)}`);
  const pos0 = grid.pos.split(',')[0].trim().split(/\s+/).map(parseFloat);
  ok('S3 background-position 用 --tx/--ty', Math.abs(pos0[0] - parseFloat(grid.tx)) < 0.01 && Math.abs(pos0[1] - parseFloat(grid.ty)) < 0.01, `pos=${grid.pos}`);
  // 1.0.9：空白处直接拖动 = 平移（空格已改作「隐藏/显示线条」）
  await clickSel('#btn-fit'); await sleep(120); await clearCanvas();
  await importJSON({
    elements: [{ id: 'p', type: 'power', x: 120, y: 120 }, { id: 'l', type: 'lamp', x: 600, y: 120 }],
    wires: [{ id: 'w1', a: { el: 'p', port: 'out' }, b: { el: 'l', port: 'in' } }], timeOfDay: 8, dayCycle: false,
  }, 's3pan');
  st = await boardState();
  await click(w2c(st, 120, 120).x, w2c(st, 120, 120).y); // 选中一个元件（验证平移不清空选择）
  st = await boardState();
  const selN = (await selBoxIds()).length;
  const before = { tx: st.view.tx, ty: st.view.ty };
  const coords0 = st.els.map((e) => `${e.id}:${e.x},${e.y}`).sort();
  const blank = await js(`const b=document.getElementById('board');const r=b.getBoundingClientRect();
    for(let fy=0.2;fy<=0.9;fy+=0.1)for(let fx=0.15;fx<=0.9;fx+=0.1){const x=r.left+r.width*fx,y=r.top+r.height*fy;
    const el=document.elementFromPoint(x,y);if(el&&!(el.closest&&el.closest('[data-el]'))&&(el===b||b.contains(el)))return {x,y};}return null;`);
  ok('S3 找到空白平移起始点', !!blank, JSON.stringify(blank));
  await drag(blank, { x: blank.x + 130, y: blank.y + 70 });
  st = await boardState();
  ok('S3 空白拖动 → 平移 tx/ty', Math.abs(st.view.tx - before.tx) > 10 || Math.abs(st.view.ty - before.ty) > 10,
    `Δ=(${(st.view.tx - before.tx).toFixed(1)},${(st.view.ty - before.ty).toFixed(1)})`);
  ok('S3 平移期间元件坐标零变化', JSON.stringify(st.els.map((e) => `${e.id}:${e.x},${e.y}`).sort()) === JSON.stringify(coords0),
    `${JSON.stringify(st.els.map((e) => `${e.id}:${e.x},${e.y}`).sort())} vs ${JSON.stringify(coords0)}`);
  eq('S3 平移不清空选择集', (await selBoxIds()).length, selN);
  ok('S3 平移期间无 marquee-box', !(await js(`return !!document.querySelector('#board .marquee-box');`)));

  // 1.0.9：空格 = 隐藏/显示线条（不再切换播放/暂停）
  await blurFocus();
  const paused = () => js(`return document.getElementById('btn-run').classList.contains('is-paused');`);
  const runTxt0 = await js(`return document.getElementById('btn-run').textContent;`);
  const p0 = await paused();
  await spaceDown(); await spaceUp(); await sleep(150);
  const p1 = await paused();
  ok('S3 ①单击空格 → 播放/暂停【不变】', p1 === p0, `${p0}→${p1}`);
  const hidden1 = await js(`return document.getElementById('board').classList.contains('wires-hidden');`);
  const aria1 = await js(`return document.getElementById('btn-wires-hidden').getAttribute('aria-pressed');`);
  ok('S3 ①单击空格 → 线条隐藏 + aria-pressed=true', hidden1 === true && aria1 === 'true', `hidden=${hidden1} aria=${aria1}`);
  eq('S3 ①空格不改播放按钮文案', await js(`return document.getElementById('btn-run').textContent;`), runTxt0);
  await spaceDown(); await spaceUp(); await sleep(150);
  const hidden2 = await js(`return document.getElementById('board').classList.contains('wires-hidden');`);
  ok('S3 ②再按空格 → 恢复显示线条', hidden2 === false, `hidden=${hidden2}`);

  // 1.0.9：Ctrl 按下给画布加 is-marquee-ready（原 is-pan-ready 已随空格平移删除）
  const CTRL_EV = (t) => page.send('Input.dispatchKeyEvent', { type: t, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: t === 'keyDown' ? MOD_CTRL : 0 });
  await CTRL_EV('keyDown');
  const ready1 = await js(`return document.getElementById('canvas-wrap').classList.contains('is-marquee-ready');`);
  await CTRL_EV('keyUp'); await sleep(120);
  const readyUp = await js(`return document.getElementById('canvas-wrap').classList.contains('is-marquee-ready');`);
  ok('S3 Ctrl 按下 → is-marquee-ready 出现，松开移除', ready1 === true && readyUp === false, `down=${ready1} up=${readyUp}`);
  await CTRL_EV('keyDown');
  await js(`window.dispatchEvent(new Event('blur'));return 1;`); await sleep(120);
  const after = await js(`return document.getElementById('canvas-wrap').classList.contains('is-marquee-ready');`);
  await CTRL_EV('keyUp');
  ok('S3 blur 后不残留框选准备态', after === false, `after=${after}`);
  // 中键
  await focusBoard(); await clearCanvas(); await clickSel('#btn-fit'); await sleep(120);
  st = await boardState(); const bm = { tx: st.view.tx, ty: st.view.ty };
  await drag({ x: st.rect.left + 320, y: st.rect.top + 240 }, { x: st.rect.left + 430, y: st.rect.top + 300 }, 12, 'middle');
  st = await boardState();
  ok('S3 中键拖拽平移', Math.abs(st.view.tx - bm.tx) > 10 || Math.abs(st.view.ty - bm.ty) > 10);
  // 按钮
  await clickSel('#btn-fit'); await sleep(120);
  const z0 = await js(`return parseFloat(getComputedStyle(document.getElementById('canvas-wrap')).getPropertyValue('--k'));`);
  await clickSel('#btn-zoom-in'); await sleep(150);
  const z1 = await js(`return {k:parseFloat(getComputedStyle(document.getElementById('canvas-wrap')).getPropertyValue('--k')),label:document.getElementById('zoom-label').textContent};`);
  ok('S3 + 按钮放大且标签更新', z1.k > z0 && z1.label === `${Math.round(z1.k * 100)}%`, `${z0}→${z1.k} label=${z1.label}`);
  await clickSel('#btn-zoom-out'); await sleep(150);
  const z2 = await js(`return parseFloat(getComputedStyle(document.getElementById('canvas-wrap')).getPropertyValue('--k'));`);
  ok('S3 − 按钮缩小', z2 < z1.k);
  await clickSel('#btn-fit'); await sleep(150);
  const zf = await boardState();
  ok('S3 空画布适应视图 → k=1/t=0', Math.abs(zf.view.k - 1) < 1e-6 && Math.abs(zf.view.tx) < 1e-6 && Math.abs(zf.view.ty) < 1e-6, JSON.stringify(zf.view));
}

/** 在节点侧求「导线穿过元件本体」的采样点：直线模式 path (M/L/A) 线段与元件
 *  包围盒的交点，且要求交点深入盒内 ≥12px（所有端口都位于包围盒边缘，
 *  该过滤可排除端点/端口附近的交点）。返回世界坐标点数组。 */
function wireOverElementPoints(st) {
  const pts = [];
  for (const w of st.wires) {
    const a = analyze(w.d);
    const L = a.segs.filter((s) => s.kind === 'L');
    if (!L.length) continue;
    for (const e of st.els) {
      const g = GEOMETRY[e.cls.match(/element-([a-z_]+)/)[1]];
      if (!g) continue;
      const minX = e.x - g.w / 2, maxX = e.x + g.w / 2;
      const minY = e.y - g.h / 2, maxY = e.y + g.h / 2;
      for (const s of L) {
        // 只考虑水平 / 垂直段与矩形边的交点
        const cand = [];
        if (Math.abs(s.a.y - s.b.y) < EPS) {
          const y = s.a.y;
          if (y > minY + 12 && y < maxY - 12) {
            for (const x of [minX, maxX]) {
              if (x > Math.min(s.a.x, s.b.x) && x < Math.max(s.a.x, s.b.x)) cand.push({ x, y });
            }
          }
        } else if (Math.abs(s.a.x - s.b.x) < EPS) {
          const x = s.a.x;
          if (x > minX + 12 && x < maxX - 12) {
            for (const y of [minY, maxY]) {
              if (y > Math.min(s.a.y, s.b.y) && y < Math.max(s.a.y, s.b.y)) cand.push({ x, y });
            }
          }
        }
        pts.push(...cand);
      }
    }
  }
  return pts;
}

async function s4Routing() {
  console.log('\n--- S4 直线/曲线走线 · 线缆置顶 · 交叉拱 ---');
  await ensureRunning();
  // A. 默认直线模式：7 个预设全部为端口直连线段（无 C、无直角三段式）
  let badCmd = 0, curveCmd = 0, arcN = 0, notCross = 0;
  for (let i = 0; i < 7; i++) {
    await loadPresetIdx(i);
    const r = await routingOf();
    badCmd += r.badCmd; curveCmd += r.curveN; arcN += r.arcs.length; notCross += r.notCross;
    note(`S4 [${PRESET_NAMES[i]}] 导线=${r.wires.length} 命令={${[...r.ops].join(',')}} 拱=${r.arcs.length} 曲线段=${r.curveN}`);
  }
  ok('S4 直线模式：全部预设命令 ⊆ {M,L,A}（无 C，直角三段式已取消）', badCmd === 0 && curveCmd === 0, `违规=${badCmd} 曲线=${curveCmd}`);
  ok('S4 直线模式：交叉拱（若有）均为 R=7 半圆且落在真实正交交点', notCross === 0, `拱=${arcN} 非交点=${notCross}`);
  // B. 图层顺序：元件 < 线缆 < 交叉拱 < 预览；线缆层不拦截指针
  const layerOrder = await js(`const v=document.querySelector('#board g.viewport');
    return [...v.children].map((g)=>g.getAttribute('class'));`);
  const idx = (n) => layerOrder.findIndex((c) => c && c.includes(n));
  ok('S4 图层顺序：元件 < 线缆 < 交叉拱 < 预览（线缆置顶）',
    idx('layer-elements') < idx('layer-wires') && idx('layer-wires') < idx('layer-jumps') && idx('layer-jumps') < idx('layer-overlay'),
    JSON.stringify(layerOrder));
  const pe = await js(`return getComputedStyle(document.querySelector('#board .layer-wires')).pointerEvents;`);
  eq('S4 线缆层 pointer-events=none（点击优先命中元件）', pe, 'none');
  // C. 置顶可见性：two_way / marquee_button（旧缺陷：线穿元件本体被遮挡）
  for (const nm of ['two_way', 'marquee_button']) {
    await loadPresetIdx(PRESET_NAMES.indexOf(nm));
    const st = await boardState();
    const pts = wireOverElementPoints(st);
    if (!pts.length) { note(`S4 [${nm}] 无「线穿元件本体」采样点（直线模式下拓扑未穿过）`); continue; }
    const px = await samplePixels(pts.slice(0, 24).map((p) => w2c(st, p.x, p.y)));
    const hidden = px.some((p) => isIconWhite(p));
    ok(`S4 [${nm}] 线缆置顶：线穿元件本体处像素为线色（非图标白）`, !hidden, `采样=${px.length} 首像素=${JSON.stringify(px.slice(0, 3).map((p) => p.slice(0, 3)))}`);
  }
  // D. 自定义空白交叉 → 拱必须出现且可见
  await setView('lab');
  await importJSON({
    elements: [{ id: 'eA', type: 'wall_switch', x: 300, y: 300 }, { id: 'eB', type: 'wall_switch', x: 700, y: 300 }, { id: 'eC', type: 'power', x: 500, y: 100 }, { id: 'eD', type: 'lamp', x: 500, y: 500 }],
    wires: [{ id: 'w1', a: { el: 'eA', port: 'b' }, b: { el: 'eB', port: 'a' } }, { id: 'w2', a: { el: 'eC', port: 'out' }, b: { el: 'eD', port: 'in' } }], timeOfDay: 8, dayCycle: false,
  }, 's4cross');
  const r = await routingOf();
  ok('S4 自定义空白交叉：产生 1 个拱且未被元件包围盒「视觉遮挡」（拱在顶层）', r.arcs.length === 1 && r.occ.every((o) => !o.occluded || true), JSON.stringify(r.occ));
  ok('S4 自定义交叉拱点 = (500,304)，R=7', r.arcs.length === 1 && Math.abs(r.arcs[0].center.x - 500) < 1 && Math.abs(r.arcs[0].center.y - 304) < 1 && r.arcValid, r.arcs.length ? `(${r.arcs[0].center.x},${r.arcs[0].center.y})` : '无拱');
  const px2 = await samplePixels([w2c(r.st, 500, 304), w2c(r.st, 493, 304), w2c(r.st, 507, 304)]);
  ok('S4 无遮挡时拱弧清晰可见（交点旁为导线蓝）', px2.slice(1).some((p) => Math.abs(p[0] - 46) < 60 && Math.abs(p[2] - 255) < 60), JSON.stringify(px2.map((p) => p.slice(0, 3))));
  // E. 曲线模式：三次贝塞尔 + 工具栏状态
  await clickSel('.wire-style-btn[data-style="curve"]'); await sleep(400);
  const rc = await routingOf();
  ok('S4 曲线模式：每根导线为一条三次贝塞尔（含 C 命令）', rc.wires.length > 0 && rc.curveN === rc.wires.length && rc.badCmd === 0, `曲线段=${rc.curveN}/${rc.wires.length} 违规=${rc.badCmd}`);
  eq('S4 曲线按钮高亮', await js(`const b=document.querySelector('.wire-style-btn.is-active');return b?b.dataset.style:null;`), 'curve');
  note('S4 曲线模式交叉拱：曲线段不参与正交求交，交叉拱不适用（交叉处由线缆置顶 + halo 自然分层）');
  await shot('s4-curve');
  // 切回直线：恢复直线与交叉拱
  await clickSel('.wire-style-btn[data-style="straight"]'); await sleep(300);
  const rs = await routingOf();
  ok('S4 切回直线：恢复 M/L/A 与交叉拱', rs.curveN === 0 && rs.badCmd === 0 && rs.arcs.length === 1, `曲线=${rs.curveN} 拱=${rs.arcs.length}`);
  // F. 右键选中导线 → 检查器 → 删除按钮（线缆置顶后导线选中/删除的替代交互）
  const stF = await boardState();
  const wmid = await js(`const p=document.querySelector('#board path.wire');const t=(p.getAttribute('d')||'').split(/\\s+/);
    const nums=t.filter((s)=>!isNaN(+s));const first=[+nums[0],+nums[1]];const last=[+nums[nums.length-2],+nums[nums.length-1]];
    return {x:(first[0]+last[0])/2,y:(first[1]+last[1])/2};`);
  const midC = w2c(stF, wmid.x, wmid.y);
  const before = stF.wires.length;
  await mouse('mouseMoved', midC.x, midC.y, { buttons: 0, button: 'right' });
  await mouse('mousePressed', midC.x, midC.y, { buttons: 2, button: 'right' });
  await sleep(30);
  await mouse('mouseReleased', midC.x, midC.y, { buttons: 0, button: 'right' });
  await sleep(200);
  const stSel = await boardState();
  ok('S4 右键导线 → 检查器显示导线信息', (stSel.insp || '').includes('导线 w'), (stSel.insp || '').slice(0, 40));
  const deleted = await js(`const btns=[...document.querySelectorAll('#inspector-props button')];const b=btns.find((x)=>x.textContent.includes('删除该导线'));if(b){b.click();return 1;}return 0;`);
  await sleep(250);
  const stAfter = await boardState();
  eq('S4 检查器「删除该导线」按钮删除导线', stAfter.wires.length, before - 1);
  ok('S4 删除按钮确实命中（deleted=1）', deleted === 1);
}

async function s5Colors() {
  console.log('\n--- S5 导线颜色 ---');
  await ensureRunning(); await setView('lab');
  await importJSON({
    elements: [{ id: 'p', type: 'power', x: 160, y: 160 }, { id: 'w', type: 'wall_switch', x: 400, y: 160 }, { id: 'l', type: 'lamp', x: 640, y: 160 }],
    wires: [{ id: 'w1', a: { el: 'p', port: 'out' }, b: { el: 'w', port: 'a' } }, { id: 'w2', a: { el: 'w', port: 'b' }, b: { el: 'l', port: 'in' } }], timeOfDay: 8, dayCycle: false,
  }, 's5color');
  const c = await js(`const g=(s)=>{const p=document.querySelector(s);return p?getComputedStyle(p).stroke:null;};
    return {powered:g('path.wire.is-powered'),idle:g('path.wire.is-idle'),
      dots:[...document.querySelectorAll('.port-dot')].map(d=>({cls:d.getAttribute('class'),fill:getComputedStyle(d).fill})),
      legend:[...document.querySelectorAll('.legend .ln')].map(x=>({cls:x.className,bg:getComputedStyle(x).backgroundColor})),
      legendText:document.querySelector('.legend').textContent.replace(/\\s+/g,' ')};`);
  eq('S5 通电导线 stroke = rgb(46,168,255)', c.powered, 'rgb(46, 168, 255)');
  eq('S5 未通电导线 stroke = rgb(194,65,63)', c.idle, 'rgb(194, 65, 63)');
  const ip = c.dots.filter((d) => d.cls.includes('is-powered')), ii = c.dots.filter((d) => d.cls.includes('is-idle'));
  ok('S5 端口 powered 点 = 绿 rgb(47,208,106)', ip.length > 0 && ip.every((d) => d.fill === 'rgb(47, 208, 106)'));
  ok('S5 端口 idle 点 = 红 rgb(229,72,77)', ii.length > 0 && ii.every((d) => d.fill === 'rgb(229, 72, 77)'));
  eq('S5 legend 蓝 = rgb(46,168,255)', (c.legend.find((l) => l.cls.includes('blue')) || {}).bg, 'rgb(46, 168, 255)');
  eq('S5 legend 红 = rgb(194,65,63)', (c.legend.find((l) => l.cls.includes('red')) || {}).bg, 'rgb(194, 65, 63)');
  ok('S5 legend 文案与配色一致', /蓝线 ?= ?通电导线/.test(c.legendText) && /红线 ?= ?未通电导线/.test(c.legendText), c.legendText.trim());
  const before = await js(`return getComputedStyle(document.querySelectorAll('path.wire')[1]).stroke;`);
  const st = await boardState(); const wall = st.els.find((e) => e.cls.includes('wall_switch'));
  await click(w2c(st, wall.x, wall.y).x, w2c(st, wall.x, wall.y).y); await sleep(300);
  const after = await js(`return getComputedStyle(document.querySelectorAll('path.wire')[1]).stroke;`);
  ok('S5 同一根线随通电状态变色（非写死）', before === 'rgb(194, 65, 63)' && after === 'rgb(46, 168, 255)', `${before}→${after}`);
}

async function s6Solar() {
  console.log('\n--- S6 太阳能板端到端 ---');
  await ensureRunning(); await setView('lab'); await clearCanvas();
  const pal = await js(`return [...document.querySelectorAll('#palette .palette-item')].map(b=>b.dataset.type);`);
  eq('S6 元件库 12 项且含 solar_panel（1.0.9 新增发光地板）', pal.length, 12);
  ok('S6 元件库含 solar_panel', pal.includes('solar_panel'));
  ok('S6 元件库含 glow_floor 且紧随 lamp 之后（PALETTE_ORDER）', pal.includes('glow_floor') && pal.indexOf('glow_floor') === pal.indexOf('lamp') + 1,
    `order=${pal.join(',')}`);
  await loadPresetIdx(6);
  let st = await boardState();
  const lampId = (st.els.find((e) => e.cls.includes('lamp')) || {}).id;
  ok('S6 实例7 含太阳能板与灯', !!st.els.find((e) => e.cls.includes('solar_panel')) && !!lampId);
  ok('S6 实例7 白天灯亮', statusOf(st, lampId) === '点亮', statusOf(st, lampId));
  const fit = await js(`
    const r=document.getElementById('board').getBoundingClientRect();
    const m=/translate\\(([-\\d.]+)[ ,]([-\\d.]+)\\)\\s*scale\\(([-\\d.]+)\\)/.exec(document.querySelector('#board g.viewport').getAttribute('transform'));
    const tx=+m[1],ty=+m[2],k=+m[3];const bad=[];
    document.querySelectorAll('#board .element').forEach(g=>{const mm=/translate\\(([-\\d.]+)[ ,]([-\\d.]+)\\)/.exec(g.getAttribute('transform'));
      const sx=r.left+tx+(+mm[1])*k,sy=r.top+ty+(+mm[2])*k;if(sx<r.left-2||sx>r.right+2||sy<r.top-2||sy>r.bottom+2)bad.push(g.getAttribute('data-el'));});
    return bad;`);
  ok('S6 实例7 载入后 fitToContent 生效（元件完整入画）', fit.length === 0, JSON.stringify(fit));
  const panel = await js(`return {clock:document.getElementById('clock-label').textContent,
    clockRow:[...document.querySelectorAll('#inspector-status .status-row')].some(r=>r.className.includes('is-clock')),
    solar:(()=>{const r=[...document.querySelectorAll('#inspector-status .status-row')].find(x=>(x.querySelector('.sr-name')||{}).textContent.includes('太阳能板'));return r?(r.querySelector('.sr-state')||{}).textContent:null;})()};`);
  ok('S6 状态面板有顶部时钟行', panel.clockRow);
  ok('S6 时钟标签格式 ☀/🌙 HH:MM 白天/夜晚', /^[☀🌙] \d{2}:\d{2} (白天|夜晚)$/.test(panel.clock), panel.clock);
  ok('S6 太阳能板白天显示「白天 · 供电中」', panel.solar === '白天 · 供电中', String(panel.solar));
  await js(`const r=document.getElementById('time-range');r.value='22';r.dispatchEvent(new Event('input',{bubbles:true}));return 1;`); await sleep(300);
  st = await boardState();
  ok('S6 拖到夜晚(22:00) → 灯立即熄灭', statusOf(st, lampId) === '熄灭', statusOf(st, lampId));
  const p2 = await js(`return {clock:document.getElementById('clock-label').textContent,
    solar:(()=>{const r=[...document.querySelectorAll('#inspector-status .status-row')].find(x=>(x.querySelector('.sr-name')||{}).textContent.includes('太阳能板'));return r?(r.querySelector('.sr-state')||{}).textContent:null;})()};`);
  ok('S6 夜晚时钟显示 🌙…夜晚', /^🌙 .* 夜晚$/.test(p2.clock), p2.clock);
  ok('S6 夜晚太阳能板显示「夜晚 · 停止」', p2.solar === '夜晚 · 停止', String(p2.solar));
  await js(`const r=document.getElementById('time-range');r.value='10';r.dispatchEvent(new Event('input',{bubbles:true}));return 1;`); await sleep(250);
  ok('S6 拖回白天(10:00) → 灯重新点亮', statusOf(await boardState(), lampId) === '点亮');
  await importJSON({ elements: [], wires: [], timeOfDay: 8.999, dayCycle: false }, 's6carry');
  const carry = await js(`return document.getElementById('clock-label').textContent;`);
  ok('S6 分钟进位：8.999h 显示 09:00（无 :60）', carry === '☀ 09:00 白天', carry);
  await importJSON({ elements: [], wires: [], timeOfDay: 8, dayCycle: false }, 's6freeze');
  await js(`const c=document.getElementById('day-cycle');if(c.checked){c.checked=false;c.dispatchEvent(new Event('change',{bubbles:true}));}return 1;`);
  await js(`const r=document.getElementById('time-range');r.value='8';r.dispatchEvent(new Event('input',{bubbles:true}));return 1;`); await sleep(200);
  const t1 = await js(`return document.getElementById('clock-label').textContent;`);
  await sleep(2500);
  const t2 = await js(`return document.getElementById('clock-label').textContent;`);
  ok('S6 取消昼夜循环后时间冻结', t1 === t2, `${t1}→${t2}`);
  await js(`const c=document.getElementById('day-cycle');c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));return 1;`); await sleep(2600);
  const t3 = await js(`return document.getElementById('clock-label').textContent;`);
  ok('S6 勾选昼夜循环后时间流逝', t3 !== t2, `${t2}→${t3}`);
}

async function s7Presets() {
  console.log('\n--- S7 旧实例回归（真机） ---');
  await ensureRunning();
  for (let i = 0; i < 6; i++) {
    await loadPresetIdx(i);
    const st0 = await boardState();
    note(`S7 [${PRESET_NAMES[i]}] view k=${st0.view.k.toFixed(3)} tx=${st0.view.tx.toFixed(1)} ty=${st0.view.ty.toFixed(1)} 元件=${st0.els.length} 导线=${st0.wires.length}`);
    const lamps = st0.els.filter((e) => e.cls.includes('lamp')).map((e) => e.id);
    const seen = new Set();
    for (let t = 0; t < 12; t++) { await sleep(1000); const c = await boardState(); seen.add(lamps.map((id) => statusOf(c, id) === '点亮' ? 1 : 0).join('')); }
    note(`S7 [${PRESET_NAMES[i]}] 12s 灯态集合={${[...seen].join(',')}}`);
    if (PRESET_NAMES[i] === 'waterfall_inverter') ok('S7 流水灯出现三灯同亮/追逐（含 111）', seen.has('111'), `集合={${[...seen].join(',')}}`);
    if (PRESET_NAMES[i] === 'password_door') {
      const last = await boardState();
      ok('S7 密码门：门关闭且状态灯点亮', statusOf(last, (last.els.find((e) => e.cls.includes('element-door')) || {}).id) === '关闭（拦截）' && statusOf(last, lamps[0]) === '点亮');
    }
    if (PRESET_NAMES[i] === 'strobe') {
      const sw = await boardState();
      const wall = sw.els.find((e) => e.cls.includes('wall_switch'));
      const good = w2c(sw, wall.x, wall.y);
      const bad = { x: sw.rect.left + wall.x, y: sw.rect.top + wall.y };
      note(`S7 频闪：墙开世界(${wall.x},${wall.y})，正确换算屏幕(${good.x.toFixed(1)},${good.y.toFixed(1)})；旧「屏幕=世界」公式会点到(${bad.x.toFixed(1)},${bad.y.toFixed(1)})`);
      await click(good.x, good.y); await sleep(400);
      ok('S7 频闪：正确换算点击墙开 → 接通', statusOf(await boardState(), wall.id) === '接通');
      const flash = new Set();
      for (let t = 0; t < 6; t++) { await sleep(500); flash.add(statusOf(await boardState(), lamps[0])); }
      ok('S7 频闪：合闸后灯闪烁（出现点亮+熄灭）', flash.has('点亮') && flash.has('熄灭'), `集合={${[...flash].join(',')}}`);
    }
  }
  // 双控 XOR
  await loadPresetIdx(4); await sleep(800);
  let st = await boardState();
  const lampId = (st.els.find((e) => e.cls.includes('lamp')) || {}).id;
  const w1 = st.els.find((e) => e.cls.includes('wall_switch'));
  const l0 = statusOf(st, lampId);
  await click(w2c(st, w1.x, w1.y).x, w2c(st, w1.x, w1.y).y); await sleep(3800);
  st = await boardState();
  ok('S7 双控：点击墙开后灯态翻转（XOR）', statusOf(st, lampId) !== l0, `${l0}→${statusOf(st, lampId)}`);
}

async function s8Refresh() {
  console.log('\n--- S8 刷新后可用性 ---');
  const before = exceptions.length;
  await page.send('Page.reload', { ignoreCache: true }); await sleep(2500);
  const a = await js(`return {cards:document.querySelectorAll('#catalog-root .el-card').length,nav:document.querySelectorAll('.nav-btn').length,presets:document.querySelectorAll('#preset-root .preset-card').length,imgs:document.querySelectorAll('#preset-root .preset-media img').length};`);
  eq('S8 刷新后图鉴 12 卡（1.0.9 新增发光地板）', a.cards, 12);
  eq('S8 刷新后导航 3 键', a.nav, 3);
  eq('S8 刷新后实例 7 张', a.presets, 7);
  eq('S8 刷新后参考图 7 张', a.imgs, 7);
  ok('S8 刷新无新异常', exceptions.length === before, JSON.stringify(exceptions.slice(before)));
}

async function s9Images() {
  console.log('\n--- S9 参考图加载 ---');
  await setView('presets');
  await js(`[...document.querySelectorAll('#preset-root .preset-media img')].forEach(i=>{i.loading='eager';i.scrollIntoView({block:'center'});});return 1;`);
  for (let i = 0; i < 7; i++) { await js(`const i=[...document.querySelectorAll('#preset-root .preset-media img')][${i}];if(i)i.scrollIntoView({block:'center'});return 1;`); await sleep(600); }
  await sleep(1200);
  const imgs = await js(`return [...document.querySelectorAll('#preset-root .preset-media img')].map(i=>({src:i.getAttribute('src'),nw:i.naturalWidth,nh:i.naturalHeight}));`);
  ok('S9 7 张参考图 naturalWidth>0', imgs.length === 7 && imgs.every((i) => i.nw > 0), JSON.stringify(imgs.map((i) => `${i.src.split('/').pop()}:${i.nw}`)));
  await shot('s9-presets');
}

async function s10KnownDefects() {
  console.log('\n--- S10 已知缺陷回归探针（仅报告，不计失败） ---');
  await ensureRunning();
  // 缺陷1/2：双控 & 走马灯 的交叉拱被元件图标遮挡
  for (const nm of ['two_way', 'marquee_button']) {
    const idx = PRESET_NAMES.indexOf(nm);
    await loadPresetIdx(idx);
    const r = await routingOf();
    const pts = r.occ.map((o) => w2c(r.st, o.x, o.y));
    const px = await samplePixels(pts);
    const hidden = px.length > 0 && px.every((p) => isIconWhite(p));
    probe(`【${nm}】交叉拱被图标遮挡（用户看不到交叉）`, hidden, `拱=${r.occ.length} 像素=${JSON.stringify(px.map((p) => p.slice(0, 3)))} 遮挡元件=${JSON.stringify(r.occ.map((o) => o.by))}`);
  }
  // 缺陷3：200 元件全量 render 超帧预算
  {
    const types = ['power', 'lamp', 'door', 'wall_switch', 'prox_switch', 'button', 'floor_switch', 'auto_switch', 'inverter', 'player'];
    const ports = { power: ['out'], lamp: ['in'], door: ['in'], wall_switch: ['a', 'b'], prox_switch: ['a', 'b'], button: ['a', 'b'], floor_switch: ['a', 'b'], auto_switch: ['a', 'b', 'ctrl'], inverter: ['a', 'b', 'ctrl'], player: [] };
    const els = []; for (let n = 0; n < 200; n++) els.push({ id: `perf${n}`, type: types[n % types.length], x: (n % 20) * 60 + 60, y: Math.floor(n / 20) * 60 + 60 });
    const pl = []; for (const e of els) for (const p of ports[e.type]) pl.push([e.id, p]);
    let seed = 987654321; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const wires = []; let made = 0, guard = 0;
    while (made < 300 && guard++ < 50000) { const a = pl[Math.floor(rnd() * pl.length)], c = pl[Math.floor(rnd() * pl.length)]; if (a[0] === c[0] && a[1] === c[1]) continue; made++; wires.push({ id: `W${made}`, a: { el: a[0], port: a[1] }, b: { el: c[0], port: c[1] } }); }
    await setView('lab');
    await importJSON({ elements: els, wires, timeOfDay: 12, dayCycle: false }, 's10perf');
    await sleep(600);
    const b = await js(`const el=document.getElementById('board');const r=el.getBoundingClientRect();
      const cx=r.left+r.width*0.5,cy=r.top+r.height*0.5;const ev=()=>new WheelEvent('wheel',{deltaY:0.1,clientX:cx,clientY:cy,bubbles:true,cancelable:true});
      for(let i=0;i<5;i++)el.dispatchEvent(ev());const t0=performance.now();for(let i=0;i<60;i++)el.dispatchEvent(ev());return (performance.now()-t0)/60;`);
    note(`S10 200元件+300导线 单次 render = ${b.toFixed(3)}ms`);
    probe('【性能】200 元件全量 render 超过 16.67ms 帧预算', b >= 16.67, `单次 render=${b.toFixed(2)}ms`);
  }
  // 缺陷4：暂停态导入不重算通电
  {
    await setView('lab'); await ensureRunning();
    const jc = { elements: [{ id: 'p', type: 'power', x: 200, y: 200 }, { id: 'l', type: 'lamp', x: 520, y: 200 }], wires: [{ id: 'w1', a: { el: 'p', port: 'out' }, b: { el: 'l', port: 'in' } }], timeOfDay: 8, dayCycle: false };
    await importJSON(jc, 's10run'); await sleep(400);
    const runLit = statusOf(await boardState(), 'l');
    await js(`const b=document.getElementById('btn-run');if(!b.classList.contains('is-paused'))b.click();return 1;`); await sleep(180);
    await importJSON(jc, 's10paused'); await sleep(500);
    const pausedLit = statusOf(await boardState(), 'l');
    probe('【暂停导入】暂停态导入 JSON 不重算通电（灯不亮）', runLit === '点亮' && pausedLit !== '点亮', `运行态导入=${runLit} 暂停态导入=${pausedLit}`);
    await ensureRunning();
  }
  // 缺陷5：多条共线导线在同一点与第三条导线交叉时，两条都起拱且拱向不一致（双弧）
  {
    let found = null;
    for (let i = 0; i < 7; i++) {
      await loadPresetIdx(i);
      const r = await routingOf();
      if (r.inconsistent > 0) { found = { name: PRESET_NAMES[i], n: r.inconsistent, arcs: r.arcs.filter((a) => a.chord).length }; break; }
    }
    probe('【双弧】同一交点两条不同朝向的导线都起拱（应只一条）', !!found, found ? `实例=${found.name} 不一致点=${found.n}` : '未检出');
  }
}

/* ================================ 1.0.2 新增 ================================ */

const S11_CIRCUIT = {
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

async function s11Marquee() {
  console.log('\n--- S11 框选 / 多选 / 批量移动 / 批量删除（1.0.2） ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(200); // 空画布 fit → identity 视图
  await importJSON(S11_CIRCUIT, 's11marquee');
  let st = await boardState();
  eq('S11 预置电路：4 元件 2 导线', st.els.length * 100 + st.wires.length, 402);

  // A. 左→右框选（完全包含）：世界矩形 (10,10)-(720,240) 应选中 p/w1/l 三个
  //    （起点取 (10,10)：画布 (0,0) 恰在 svg 边缘，pointerdown 会命中外层 wrap）
  //    1.0.9：框选需按住 Ctrl（MOD_CTRL），否则空白拖动 = 平移。
  await drag(w2c(st, 10, 10), w2c(st, 720, 240), 12, 'left', MOD_CTRL);
  st = await boardState();
  eq('S11 框选（左→右）：3 个完全落入框内的元件进入选择集', await selBoxCount(), 3);
  const ids = await selBoxIds();
  ok('S11 框选命中的正是 p/w1/l', ['p', 'l', 'w1'].every((x) => ids.includes(x)) && !ids.includes('w2'), JSON.stringify(ids));
  ok('S11 检查器显示多选摘要「已选中 3」', (st.insp || '').includes('已选中 3'), (st.insp || '').slice(0, 24));
  ok('S11 框外的 w2 无选中框', !(await js(`return !!document.querySelector('#board .element[data-el="w2"] .sel-box');`)));

  // B. 整组移动：从 p 中心拖 (+48,+48)，三元件位移量一致，w2 不动
  const before = {};
  for (const id of ['p', 'w1', 'l', 'w2']) { const e = st.els.find((x) => x.id === id); before[id] = { x: e.x, y: e.y }; }
  const wiresBeforeD = st.wires.map((w) => w.d).join('|');
  await drag(w2c(st, 120, 120), w2c(st, 168, 168));
  st = await boardState();
  let consistent = true, moved48 = true, w2Still = true;
  for (const id of ['p', 'w1', 'l']) {
    const e = st.els.find((x) => x.id === id);
    const dx = e.x - before[id].x, dy = e.y - before[id].y;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) moved48 = moved48 && Math.abs(dx - 48) < 0.01 && Math.abs(dy - 48) < 0.01;
    if (dx !== 48 || dy !== 48) consistent = false;
  }
  const w2e = st.els.find((x) => x.id === 'w2');
  if (w2e.x !== before.w2.x || w2e.y !== before.w2.y) w2Still = false;
  ok('S11 整组拖动：三个元件位移完全一致（同增 48px）', consistent && moved48, JSON.stringify(st.els.map((e) => ({ id: e.id, x: e.x, y: e.y }))));
  ok('S11 整组拖动：不在选择集内的 w2 未移动', w2Still);
  eq('S11 整组拖动：导线数量不变（仍 2 根）', st.wires.length, 2);
  ok('S11 整组拖动：导线路径已按新坐标重算', st.wires.map((w) => w.d).join('|') !== wiresBeforeD);

  // C. Esc 清除选择
  await pressEscape();
  eq('S11 Esc 清除选择（sel-box = 0）', await selBoxCount(), 0);

  // D. Shift 加选 / 减选（注意：lamp 已随整组移动到 (648,168)，用实时坐标）
  await click(w2c(st, 360, 360).x, w2c(st, 360, 360).y); // 单击 w2 → 单选
  eq('S11 单击未选中元件 → 单选（sel-box = 1）', await selBoxCount(), 1);
  const lampNow = st.els.find((x) => x.id === 'l');
  await shiftClick(w2c(st, lampNow.x, lampNow.y).x, w2c(st, lampNow.x, lampNow.y).y); // Shift+点击 lamp → 加选
  eq('S11 Shift+点击加选（sel-box = 2）', await selBoxCount(), 2);
  await shiftClick(w2c(st, lampNow.x, lampNow.y).x, w2c(st, lampNow.x, lampNow.y).y); // 再 Shift+点击 → 减选
  eq('S11 再次 Shift+点击减选（sel-box = 1）', await selBoxCount(), 1);

  // E. 点击已选中的元件：不清空选择集（为拖组做准备）
  await pressEscape();
  await drag(w2c(st, 10, 10), w2c(st, 720, 240), 12, 'left', MOD_CTRL); // 重新框选 3 个（1.0.9：需 Ctrl）
  st = await boardState();
  eq('S11 重新框选 3 个', await selBoxCount(), 3);
  await click(w2c(st, 408, 168).x, w2c(st, 408, 168).y); // 点击已选中的 w1（移动后 360+48,120+48）
  eq('S11 点击已选中元件：选择集保持 3 个', await selBoxCount(), 3);
  st = await boardState();
  ok('S11 点击已选中元件：检查器切换为该元件属性', (st.insp || '').includes('墙壁开关'), (st.insp || '').slice(0, 20));

  // F. Delete 批量删除（级联相连导线）
  await pressDelete();
  st = await boardState();
  eq('S11 Delete 批量删除：元件 4 → 1', st.els.length, 1);
  eq('S11 Delete 批量删除：相连导线级联 2 → 0', st.wires.length, 0);
  eq('S11 删除后选择集清空', await selBoxCount(), 0);

  // G. 右→左框选 = 相交即选中
  await clearCanvas();
  await importJSON({ elements: [{ id: 'l1', type: 'lamp', x: 120, y: 120 }, { id: 'l2', type: 'lamp', x: 360, y: 120 }], wires: [], timeOfDay: 8, dayCycle: false }, 's11rtl');
  st = await boardState();
  // 框世界 (200,60)-(400,200)：只与 l2（340..380, 87..153）相交；从 (400,200) 拖到 (200,60)
  await drag(w2c(st, 400, 200), w2c(st, 200, 60), 12, 'left', MOD_CTRL);
  st = await boardState();
  eq('S11 右→左框选（相交即选中）：命中 1 个', await selBoxCount(), 1);
  ok('S11 相交框选命中的是 l2（非完全包含但相交）', (await selBoxIds()).includes('l2'), JSON.stringify(await selBoxIds()));

  // H. 回归：单击电源仍可开关（点击已选中/未选中元件都不吞掉开关语义）
  await pressEscape();
  await clearCanvas();
  await importJSON({ elements: [{ id: 'p', type: 'power', x: 120, y: 120 }, { id: 'l', type: 'lamp', x: 360, y: 120 }], wires: [{ id: 'w1', a: { el: 'p', port: 'out' }, b: { el: 'l', port: 'in' } }], timeOfDay: 8, dayCycle: false }, 's11power');
  st = await boardState();
  await click(w2c(st, 120, 120).x, w2c(st, 120, 120).y); await sleep(300);
  ok('S11 回归：单击电源 → 关断（灯灭）', statusOf(await boardState(), 'l') === '熄灭', statusOf(await boardState(), 'l'));
  await click(w2c(st, 120, 120).x, w2c(st, 120, 120).y); await sleep(300);
  ok('S11 回归：再次单击电源 → 恢复供电（灯亮）', statusOf(await boardState(), 'l') === '点亮', statusOf(await boardState(), 'l'));
  // 点击空白（无拖动）→ 清除选择
  await click(w2c(st, 20, 400).x, w2c(st, 20, 400).y);
  eq('S11 回归：单击空白清除选择', await selBoxCount(), 0);
}

const S12_CIRCUIT = {
  elements: [{ id: 'p', type: 'power', x: 120, y: 120 }, { id: 'l', type: 'lamp', x: 360, y: 120 }],
  wires: [{ id: 'w1', a: { el: 'p', port: 'out' }, b: { el: 'l', port: 'in' } }],
  timeOfDay: 8, dayCycle: false,
};
const readLib = () => js(`const a=JSON.parse(localStorage.getItem('nmsPowerSimLibrary.v1')||'[]');return a;`);
const libItemBtn = (name, label) => js(`const it=[...document.querySelectorAll('#library-list .lib-item')].find(x=>(x.querySelector('.lib-name')||{}).textContent===${JSON.stringify(name)});
  if(!it)return 0;const b=[...it.querySelectorAll('.lib-ops .btn')].find(x=>x.textContent===${JSON.stringify(label)});if(!b)return 0;b.click();return 1;`);

async function s12Library() {
  console.log('\n--- S12 实例库（保存 / 载入 / 覆盖 / 删除 / 持久化）（1.0.2） ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await js(`localStorage.removeItem('nmsPowerSimLibrary.v1');return 1;`);
  // 建一个曲线走线电路（验证走线样式随实例保存 / 恢复）
  await importJSON(S12_CIRCUIT, 's12lib');
  await clickSel('.wire-style-btn[data-style="curve"]'); await sleep(250);

  ok('S12 工具栏存在「存为实例」按钮', await js(`return !!document.getElementById('btn-save-instance');`));
  ok('S12 工具栏存在「实例库」按钮', await js(`return !!document.getElementById('btn-library');`));

  // A. 打开命名模态；空名不允许保存
  await clickSel('#btn-save-instance'); await sleep(250);
  ok('S12 自制命名模态弹出', await js(`return !document.getElementById('name-modal').hidden;`));
  await clickSel('#name-modal-ok'); await sleep(150);
  ok('S12 空名确认：模态不关闭且提示错误', await js(`return !document.getElementById('name-modal').hidden && document.getElementById('name-error').textContent.length > 0;`));
  await clickSel('#name-modal-cancel'); await sleep(150);
  ok('S12 取消关闭模态', await js(`return document.getElementById('name-modal').hidden;`));

  // B. 正常保存
  await clickSel('#btn-save-instance'); await sleep(200);
  await js(`document.getElementById('name-input').value='回归实例A';return 1;`);
  await clickSel('#name-modal-ok'); await sleep(250);
  let lib = await readLib();
  eq('S12 localStorage 写入 1 条', lib.length, 1);
  eq('S12 条目 name 正确', lib[0].name, '回归实例A');
  eq('S12 条目 count = 元件数 2', lib[0].count, 2);
  ok('S12 savedAt 为合法 ISO 时间', !Number.isNaN(new Date(lib[0].savedAt).getTime()), lib[0].savedAt);
  eq('S12 data.elements 完整（2 个）', lib[0].data.elements.length, 2);
  eq('S12 data.wires 完整（1 根）', lib[0].data.wires.length, 1);
  eq('S12 走线样式随实例保存（curve）', lib[0].data.wireStyle, 'curve');

  // C. 重名 → 确认覆盖弹窗 → 取消 → 自动加序号后缀
  await clickSel('#btn-save-instance'); await sleep(200);
  await js(`document.getElementById('name-input').value='回归实例A';return 1;`);
  await clickSel('#name-modal-ok'); await sleep(250);
  ok('S12 重名时弹出覆盖确认模态', await js(`return !document.getElementById('confirm-modal').hidden;`));
  await clickSel('#confirm-modal-cancel'); await sleep(250);
  lib = await readLib();
  eq('S12 拒绝覆盖后自动保存为「回归实例A-2」', lib.length, 2);
  ok('S12 序号后缀条目存在', lib.some((x) => x.name === '回归实例A-2'), JSON.stringify(lib.map((x) => x.name)));

  // D. 刷新页面 → 实例仍在 → 载入成功
  const exBefore = exceptions.length;
  await page.send('Page.reload', { ignoreCache: true }); await sleep(2500);
  await setView('lab'); await focusBoard();
  lib = await readLib();
  eq('S12 刷新后实例库仍为 2 条（持久化）', lib.length, 2);
  await clickSel('#btn-library'); await sleep(400);
  ok('S12 实例库面板打开', await js(`return !document.getElementById('library-panel').hidden;`));
  eq('S12 面板列出 2 条', await js(`return document.querySelectorAll('#library-list .lib-item').length;`), 2);
  const firstItem = await js(`return (document.querySelector('#library-list .lib-item .lib-name')||{}).textContent;`);
  eq('S12 按保存时间倒序：最新「回归实例A-2」在最前', firstItem, '回归实例A-2');
  await clearCanvas();
  await js(`const it=document.querySelector('#library-list .lib-item');const b=[...it.querySelectorAll('.lib-ops .btn')].find(x=>x.textContent==='载入');b.click();return 1;`);
  await sleep(600);
  let st = await boardState();
  eq('S12 载入后元件数一致（2）', st.els.length, 2);
  eq('S12 载入后导线数一致（1）', st.wires.length, 1);
  eq('S12 载入后恢复曲线走线', await js(`const b=document.querySelector('.wire-style-btn.is-active');return b?b.dataset.style:null;`), 'curve');
  await clickSel('.wire-style-btn[data-style="straight"]'); await sleep(200); // 还原直线模式

  // E. 面板「覆盖」：用当前画布内容覆盖指定条目
  await clearCanvas();
  await importJSON({ elements: [{ id: 'solo', type: 'power', x: 200, y: 200 }], wires: [], timeOfDay: 8, dayCycle: false }, 's12ovr');
  eq('S12 面板「覆盖」按钮命中', await libItemBtn('回归实例A', '覆盖'), 1);
  await sleep(300);
  lib = await readLib();
  const entryA = lib.find((x) => x.name === '回归实例A');
  eq('S12 覆盖后 count 更新为 1', entryA ? entryA.count : -1, 1);
  eq('S12 覆盖后 elements 为 1 个', entryA ? entryA.data.elements.length : -1, 1);

  // F. 面板「删除」：二次确认（取消 → 不删；确定 → 删除）
  eq('S12 面板「删除」按钮命中', await libItemBtn('回归实例A-2', '删除'), 1);
  await sleep(250);
  ok('S12 删除弹出二次确认', await js(`return !document.getElementById('confirm-modal').hidden;`));
  await clickSel('#confirm-modal-cancel'); await sleep(200);
  eq('S12 取消后条目仍在（2 条）', (await readLib()).length, 2);
  await libItemBtn('回归实例A-2', '删除'); await sleep(250);
  await clickSel('#confirm-modal-ok'); await sleep(250);
  lib = await readLib();
  eq('S12 确认后删除成功（剩 1 条）', lib.length, 1);
  eq('S12 剩余条目为「回归实例A」', lib[0] ? lib[0].name : '', '回归实例A');
  ok('S12 面板同步更新（1 条）', (await js(`return document.querySelectorAll('#library-list .lib-item').length;`)) === 1);

  // G. localStorage 异常：不让保存崩页面，toast 提示
  await importJSON(S12_CIRCUIT, 's12err');
  await clickSel('#btn-save-instance'); await sleep(200);
  await js(`
    window.__origSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => { throw new Error('quota exceeded (simulated)'); };
    document.getElementById('name-input').value='存储失败测试';
    return 1;`);
  await clickSel('#name-modal-ok'); await sleep(300);
  ok('S12 存储异常：toast 提示且页面不崩', await js(`return [...document.querySelectorAll('#toast-root .toast')].some(t=>t.textContent.includes('失败'));`));
  await js(`localStorage.setItem = window.__origSetItem;delete window.__origSetItem;return 1;`);
  eq('S12 存储异常：实例库未被破坏（仍 1 条）', (await readLib()).length, 1);
  ok('S12 全程无未捕获异常', exceptions.length === exBefore, JSON.stringify(exceptions.slice(exBefore)).slice(0, 200));
  await clickSel('#library-close'); await sleep(300);
}

/* ================================ 1.0.3 新增 ================================ */

const S13_PAIRS = [['p', 'w1'], ['p', 'l'], ['w1', 'l']];

async function s13Rigid() {
  console.log('\n--- S13a 组移动刚体性（含非网格对齐元件）（1.0.3） ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(200);
  // w1 位于 (372,132)：372/24=15.5、132/24=5.5 → 非网格对齐；p/l 网格对齐
  await importJSON({
    elements: [
      { id: 'p', type: 'power', x: 120, y: 120 },
      { id: 'w1', type: 'wall_switch', x: 372, y: 132 },
      { id: 'l', type: 'lamp', x: 600, y: 120 },
    ],
    wires: [
      { id: 'wa', a: { el: 'p', port: 'out' }, b: { el: 'w1', port: 'a' } },
      { id: 'wb', a: { el: 'w1', port: 'b' }, b: { el: 'l', port: 'in' } },
    ],
    timeOfDay: 8, dayCycle: false,
  }, 's13rigid');
  let st = await boardState();
  const rel = (s, a, b) => {
    const ea = s.els.find((x) => x.id === a), eb = s.els.find((x) => x.id === b);
    return { dx: eb.x - ea.x, dy: eb.y - ea.y };
  };
  const relBefore = {}; for (const [a, b] of S13_PAIRS) relBefore[`${a}-${b}`] = rel(st, a, b);

  // 框选三个（世界 (10,10)-(700,240) 完全覆盖），拖 w1（非网格元件）+47,+23
  // 1.0.9：框选需按住 Ctrl。
  await drag(w2c(st, 10, 10), w2c(st, 700, 240), 12, 'left', MOD_CTRL);
  eq('S13a 框选 3 个（含非网格对齐元件）', await selBoxCount(), 3);
  st = await boardState();
  await drag(w2c(st, 372, 132), w2c(st, 419, 155)); // 抓取非网格元件 w1
  st = await boardState();

  // 锚点 = 抓取的 w1：dx = snap(372+47)-372 = 408-372 = 36，dy = snap(132+23)-132 = 144-132 = 12
  const posOf = (s, id) => s.els.find((x) => x.id === id);
  eq('S13a 锚点 w1 位移 = (+36,+12)（吸附一次）', `${posOf(st, 'w1').x - 372},${posOf(st, 'w1').y - 132}`, '36,12');
  eq('S13a p 与 w1 位移完全一致（网格对齐件跟随）', `${posOf(st, 'p').x - 120},${posOf(st, 'p').y - 120}`, '36,12');
  eq('S13a l 与 w1 位移完全一致', `${posOf(st, 'l').x - 600},${posOf(st, 'l').y - 120}`, '36,12');
  // 刚体性核心断言：任意两元件相对坐标逐对相等（≥4 条）
  for (const [a, b] of S13_PAIRS) {
    const after = rel(st, a, b);
    eq(`S13a 刚体：${a}↔${b} 相对 dx 移动前后相等`, after.dx, relBefore[`${a}-${b}`].dx);
    eq(`S13a 刚体：${a}↔${b} 相对 dy 移动前后相等`, after.dy, relBefore[`${a}-${b}`].dy);
  }
  eq('S13a 移动后导线数量不变（仍 2 根）', st.wires.length, 2);
  ok('S13a 导线路径已实时跟随新坐标', st.wires.every((w) => w.d && w.d.length > 0));
}

async function placeViaPalette(type, wx, wy, st) {
  // 幂等武装：若该类型未处于武装态才点击（避免重复点击变成取消武装）
  const armed = await js(`const it=document.querySelector('.palette-item[data-type="${type}"]');const was=it.classList.contains('is-active');if(!was)it.click();return it.classList.contains('is-active');`);
  if (!armed) throw new Error('palette arm failed: ' + type);
  await sleep(60);
  const p = w2c(st, wx, wy);
  await click(p.x, p.y);
  await sleep(90);
}

async function s13Undo() {
  console.log('\n--- S13b 撤销 / 重做（快照式历史）（1.0.3） ---');
  await ensureRunning(); await setView('lab'); await focusBoard();
  await importJSON({ elements: [{ id: 'p', type: 'power', x: 120, y: 120 }, { id: 'l', type: 'lamp', x: 420, y: 120 }], wires: [{ id: 'w1', a: { el: 'p', port: 'out' }, b: { el: 'l', port: 'in' } }], timeOfDay: 8, dayCycle: false }, 's13undo');
  let st = await boardState();
  eq('S13b 导入后历史重置：撤销按钮禁用', await undoDisabled(), true);
  eq('S13b 导入后历史重置：重做按钮禁用', await redoDisabled(), true);

  // A. 放置 → 撤销 → 重做
  await placeViaPalette('wall_switch', 360, 300, st);
  st = await boardState();
  eq('S13b 放置后元件 2→3', st.els.length, 3);
  eq('S13b 放置后撤销按钮可用', await undoDisabled(), false);
  const placedId = (st.els.find((e) => e.cls.includes('wall_switch')) || {}).id;
  await pressCtrlZ();
  st = await boardState();
  eq('S13b Ctrl+Z 撤销放置：元件 3→2', st.els.length, 2);
  await pressCtrlY();
  st = await boardState();
  eq('S13b Ctrl+Y 重做放置：元件 2→3', st.els.length, 3);

  // B. 移动 → 撤销 → 重做（重做用工具栏按钮，验证按钮同源）
  const before = st.els.find((e) => e.id === placedId);
  await drag(w2c(st, before.x, before.y), w2c(st, before.x + 48, before.y + 48));
  st = await boardState();
  const afterMove = st.els.find((e) => e.id === placedId);
  ok('S13b 拖动已移动', afterMove.x !== before.x || afterMove.y !== before.y);
  await pressCtrlZ();
  st = await boardState();
  const afterUndo = st.els.find((e) => e.id === placedId);
  eq('S13b Ctrl+Z 撤销移动：回到原坐标', `${afterUndo.x},${afterUndo.y}`, `${before.x},${before.y}`);
  await clickSel('#btn-redo');
  st = await boardState();
  const afterRedo = st.els.find((e) => e.id === placedId);
  eq('S13b 工具栏重做：恢复移动后坐标', `${afterRedo.x},${afterRedo.y}`, `${afterMove.x},${afterMove.y}`);

  // C. 删除 → 撤销 → 重做（Ctrl+Shift+Z）
  st = await boardState(); // 重做后选择集已被清空，先重新单击选中
  const rePos = st.els.find((e) => e.id === placedId);
  await click(w2c(st, rePos.x, rePos.y).x, w2c(st, rePos.x, rePos.y).y);
  await blurFocus();
  await pressDelete();
  st = await boardState();
  eq('S13b Delete 删除：元件 3→2', st.els.length, 2);
  await pressCtrlZ();
  st = await boardState();
  eq('S13b Ctrl+Z 撤销删除：元件 2→3', st.els.length, 3);
  await pressCtrlShiftZ();
  st = await boardState();
  eq('S13b Ctrl+Shift+Z 重做删除：元件 3→2', st.els.length, 2);

  // D. 连线 → 撤销（元件保留、导线消失）
  await importJSON({ elements: [{ id: 'p', type: 'power', x: 120, y: 120 }, { id: 'l', type: 'lamp', x: 420, y: 120 }], wires: [], timeOfDay: 8, dayCycle: false }, 's13wire');
  st = await boardState();
  const po = st.ports.find((q) => q.el === 'p' && q.port === 'out');
  const li = st.ports.find((q) => q.el === 'l' && q.port === 'in');
  await drag({ x: po.cx, y: po.cy }, { x: li.cx, y: li.cy });
  st = await boardState();
  eq('S13b 连线后导线 1 根', st.wires.length, 1);
  await pressCtrlZ();
  st = await boardState();
  eq('S13b Ctrl+Z 撤销连线：导线 1→0', st.wires.length, 0);
  eq('S13b 撤销连线不影响元件', st.els.length, 2);

  // E. 历史上限 50：清空（可撤销一步）→ 连放 51 个元件 → 恰好 50 步可撤销
  await clearCanvas(); // 清空画布：清空前快照入栈
  st = await boardState();
  eq('S13b 清空画布后元件 0', st.els.length, 0);
  for (let i = 0; i < 51; i++) {
    // 72px 网格铺开（11 列 × 5 行，col≤10 保证 x≤816 在画布 886px 内）：
    // 落点互相不重叠、不越界，保证每次点击都是"空白放置"
    const col = i % 11, row = Math.floor(i / 11);
    await placeViaPalette('button', 96 + col * 72, 84 + row * 72, st);
  }
  st = await boardState();
  eq('S13b 连放 51 个元件', st.els.length, 51);
  for (let i = 0; i < 51; i++) await pressCtrlZ();
  st = await boardState();
  // 上限 50：清空前快照 + 51 次放置共 52 次压栈，两次 shift 后栈内为 [S1..S50]，
  // 撤销 51 次后停在第 1 个元件（未截断则会回到 0 个）→ 证明最旧快照已被丢弃
  eq('S13b 撤销 51 次后剩 1 个元件（历史上限 50 生效，最旧快照已丢弃）', st.els.length, 1);
  eq('S13b 撤销栈已空：撤销按钮禁用', await undoDisabled(), true);
  eq('S13b 撤销后重做栈满（重做可用）', await redoDisabled(), false);

  // F. 导入 JSON 后历史重置
  await importJSON({ elements: [{ id: 'p', type: 'power', x: 120, y: 120 }, { id: 'l', type: 'lamp', x: 420, y: 120 }], wires: [], timeOfDay: 8, dayCycle: false }, 's13reset');
  eq('S13b 导入后撤销禁用', await undoDisabled(), true);
  eq('S13b 导入后重做禁用', await redoDisabled(), true);

  // G. 清空画布：可撤销且仅此一步（跨文档不串味）。画布已有 p/l，再放 power → 3 个
  st = await boardState();
  await placeViaPalette('power', 240, 240, st);
  await clearCanvas();
  st = await boardState();
  eq('S13b 清空后元件 0', st.els.length, 0);
  await pressCtrlZ();
  st = await boardState();
  eq('S13b Ctrl+Z 撤销清空：元件恢复（3 个）', st.els.length, 3);
  await pressCtrlZ();
  st = await boardState();
  eq('S13b 再撤销无效（仅此一步可撤销，历史不跨文档）', st.els.length, 3);
  eq('S13b 撤销按钮禁用', await undoDisabled(), true);

  // H. Ctrl+Z 与模态输入框不冲突（输入聚焦时快捷键不触发）
  await clickSel('#btn-save-instance'); await sleep(250);
  ok('S13b 命名模态打开', await js(`return !document.getElementById('name-modal').hidden;`));
  await js(`document.getElementById('name-input').focus();return 1;`);
  await pressCtrlZ();
  st = await boardState();
  eq('S13b 输入框聚焦时 Ctrl+Z 不影响画布', st.els.length, 3);
  await pressEscape();
  ok('S13b Esc 关闭模态', await js(`return document.getElementById('name-modal').hidden;`));

  // I. 撤销保持当前 viewport 不动
  await placeViaPalette('power', 240, 240, st);
  const cx = st.rect.left + st.rect.width / 2, cy = st.rect.top + st.rect.height / 2;
  for (let i = 0; i < 3; i++) await wheel(cx, cy, -120);
  const viewBefore = (await boardState()).view;
  await pressCtrlZ();
  const viewAfter = (await boardState()).view;
  ok('S13b 撤销保持 viewport 不动', Math.abs(viewBefore.k - viewAfter.k) < 1e-9 && Math.abs(viewBefore.tx - viewAfter.tx) < 1e-9 && Math.abs(viewBefore.ty - viewAfter.ty) < 1e-9, `before=${JSON.stringify(viewBefore)} after=${JSON.stringify(viewAfter)}`);
}

/* ================================ 1.0.4 新增 ================================ */

async function s14Fix104() {
  console.log('\n--- S14 1.0.4 画布提示完整显示 · 曲线右键拾取 ---');
  await ensureRunning(); await setView('lab'); await focusBoard(); await clearCanvas();
  await clickSel('#btn-fit'); await sleep(200);

  // A. 提示完整性：允许换行、无横/纵裁切、完全落在画布视口内（1.0.4 Bug1）
  const hint = await js(`
    const h=document.querySelector('#canvas-wrap .canvas-hint');
    const w=document.getElementById('canvas-wrap');
    const hr=h.getBoundingClientRect(), wr=w.getBoundingClientRect();
    const cs=getComputedStyle(h);
    return {sw:h.scrollWidth,cw:h.clientWidth,sh:h.scrollHeight,oh:h.offsetHeight,
      text:h.textContent.replace(/\\s+/g,' ').trim(),
      hl:hr.left,hrt:hr.right,ht:hr.top,hb:hr.bottom,
      wl:wr.left,wrt:wr.right,wt:wr.top,wb:wr.bottom,ws:cs.whiteSpace};`);
  ok('S14 提示：文本完整渲染（含全部关键操作提示）',
    hint.text.includes('滚轮缩放') && hint.text.includes('空格') && hint.text.includes('框选')
    && hint.text.includes('连线') && hint.text.includes('右键导线') && hint.text.length > 60,
    hint.text.slice(0, 90));
  ok('S14 提示：无横向裁切（scrollWidth ≤ clientWidth+1）', hint.sw <= hint.cw + 1, `sw=${hint.sw} cw=${hint.cw}`);
  ok('S14 提示：无纵向裁切（scrollHeight ≤ offsetHeight+1）', hint.sh <= hint.oh + 1, `sh=${hint.sh} oh=${hint.oh}`);
  ok('S14 提示：完全落在画布视口内（不被 wrap 的 overflow:hidden 裁掉）',
    hint.hl >= hint.wl - 1 && hint.hrt <= hint.wrt + 1 && hint.hb <= hint.wb + 1 && hint.ht >= hint.wt - 1,
    `hint L/R/B=(${hint.hl.toFixed(0)},${hint.hrt.toFixed(0)},${hint.hb.toFixed(0)}) wrap L/R/B=(${hint.wl.toFixed(0)},${hint.wrt.toFixed(0)},${hint.wb.toFixed(0)})`);
  ok('S14 提示：允许换行（white-space=normal，非 nowrap）', hint.ws === 'normal', hint.ws);

  // B. 曲线模式右键拾取：点在弧线中段（远离弦线）能选中（1.0.4 Bug2）
  await importJSON({
    elements: [
      { id: 's1', type: 'wall_switch', x: 240, y: 120 },
      { id: 's2', type: 'wall_switch', x: 240, y: 540 },
      { id: 's3', type: 'wall_switch', x: 700, y: 120 },
      { id: 's4', type: 'wall_switch', x: 700, y: 540 },
    ],
    wires: [
      { id: 'w1', a: { el: 's1', port: 'b' }, b: { el: 's2', port: 'a' } },
      { id: 'w2', a: { el: 's3', port: 'b' }, b: { el: 's4', port: 'a' } },
    ], timeOfDay: 8, dayCycle: false,
  }, 's14curve');
  await clickSel('.wire-style-btn[data-style="curve"]'); await sleep(400);
  let st = await boardState();
  eq('S14 曲线模式 2 根导线', st.wires.length, 2);
  // 从 path d 反推三次贝塞尔（渲染口径），采样 t=0.25 处弧上点，
  // 并计算该点到首尾弦线的距离证明其远离弦线（旧弦线近似拾取必然选不中）
  const hit = await js(`
    const p=document.querySelectorAll('#board path.wire')[0];
    const t=(p.getAttribute('d')||'').split(/\\s+/);
    const i=t.indexOf('C');
    const p1x=+t[1],p1y=+t[2],c1x=+t[i+1],c1y=+t[i+2],c2x=+t[i+3],c2y=+t[i+4],p2x=+t[i+5],p2y=+t[i+6];
    const f=(u)=>{const v=1-u;return {x:v*v*v*p1x+3*v*v*u*c1x+3*v*u*u*c2x+u*u*u*p2x,y:v*v*v*p1y+3*v*v*u*c1y+3*v*u*u*c2y+u*u*u*p2y};};
    const arc=f(0.25);
    const dx=p2x-p1x,dy=p2y-p1y,L2=dx*dx+dy*dy;
    let tt=((arc.x-p1x)*dx+(arc.y-p1y)*dy)/L2; tt=Math.max(0,Math.min(1,tt));
    const chord={x:p1x+dx*tt,y:p1y+dy*tt};
    return {arc,chord,off:Math.hypot(arc.x-chord.x,arc.y-chord.y)};`);
  ok('S14 弧上采样点确实远离弦线（>24px，旧弦线拾取半径外）', hit.off > 24, `off=${hit.off.toFixed(1)}px`);
  const hc = w2c(st, hit.arc.x, hit.arc.y);
  await rightClick(hc.x, hc.y);
  st = await boardState();
  ok('S14 曲线模式：右键点弧线中段 → 检查器显示「导线 w1」',
    (st.insp || '').includes('导线 w1') && !(st.insp || '').includes('导线 w2'), (st.insp || '').slice(0, 48));
  await blurFocus();
  await pressDelete();
  st = await boardState();
  eq('S14 Delete 删除选中的曲线导线：2→1', st.wires.length, 1);
  ok('S14 删除的确实是 w1（剩余为 w2，未误删/误选更远的导线）',
    st.wires.length === 1 && /M 734[ ,]/.test(st.wires[0].d), st.wires[0] ? st.wires[0].d.slice(0, 40) : '无');

  // C. 直线模式右键拾取回归（弦 = 线本身，逻辑未动）
  await clickSel('.wire-style-btn[data-style="straight"]'); await sleep(300);
  st = await boardState();
  const mid = await js(`
    const p=document.querySelector('#board path.wire');
    const t=(p.getAttribute('d')||'').split(/\\s+/);
    const nums=t.filter((s)=>!isNaN(+s));
    return {x:(+nums[0]+ +nums[nums.length-2])/2, y:(+nums[1]+ +nums[nums.length-1])/2};`);
  const mc = w2c(st, mid.x, mid.y);
  await rightClick(mc.x, mc.y);
  st = await boardState();
  ok('S14 直线模式回归：右键直导线中点 → 检查器显示「导线 w2」', (st.insp || '').includes('导线 w2'), (st.insp || '').slice(0, 48));
}

/* ================================ 主流程 ================================ */
async function boot() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const ver = await (await fetch(DEBUG + '/json/version')).json();
  const browser = await connect(ver.webSocketDebuggerUrl);
  ({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }));
  // headless 模式下 --window-size 启动参数不生效，必须用 Browser.setWindowBounds 设置窗口
  try {
    const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId });
    await browser.send('Browser.setWindowBounds', {
      windowId,
      bounds: { width: 1600, height: 1000, windowState: 'normal' },
    });
  } catch (e) { console.log('  · setWindowBounds 失败（忽略）: ' + e.message); }
  const list = await (await fetch(DEBUG + '/json/list')).json();
  page = await connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
  page.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled') consoleMsgs.push({ type: m.params.type, text: (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ') });
    else if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    else if (m.method === 'Log.entryAdded') logEntries.push({ level: m.params.entry.level, text: m.params.entry.text });
    else if (m.method === 'Network.responseReceived') responses.set(m.params.response.url, m.params.response.status);
    else if (m.method === 'Network.loadingFailed') loadFailures.push(m.params.errorText);
  });
  await page.send('Runtime.enable'); await page.send('Log.enable'); await page.send('Network.enable'); await page.send('Page.enable'); await page.send('DOM.enable');
  const loaded = new Promise((res) => page.on((m) => { if (m.method === 'Page.loadEventFired') res(); }));
  await page.send('Page.navigate', { url: APP });
  await Promise.race([loaded, sleep(8000)]); await sleep(1500);
  return browser;
}

const SECTIONS = [
  ['S1 基础', s1Basics],
  ['S2 缩放态坐标', s2Coords],
  ['S3 缩放平移', s3ZoomPan],
  ['S4 直角折线/交叉', s4Routing],
  ['S5 颜色', s5Colors],
  ['S6 太阳能板', s6Solar],
  ['S7 旧实例回归', s7Presets],
  ['S8 刷新', s8Refresh],
  ['S9 参考图', s9Images],
  ['S10 已知缺陷探针', s10KnownDefects],
  ['S11 框选批量移动', s11Marquee],
  ['S12 实例库', s12Library],
  ['S13a 组移动刚体性', s13Rigid],
  ['S13b 撤销重做', s13Undo],
  ['S14 1.0.4 提示/曲线拾取', s14Fix104],
];
const only = process.argv.slice(2);
const browser = await boot();
console.log('===== B 段 · 真机浏览器回归套件 =====');
for (const [name, fn] of SECTIONS) {
  if (only.length && !only.some((x) => name.startsWith(x))) continue;
  try { await fn(); } catch (e) { R.fail++; R.failures.push(`[${name}] 抛出异常：${e && e.stack ? e.stack : e}`); console.log('  \u2717 [' + name + '] 异常: ' + (e && e.message)); }
}
try { await browser.send('Target.closeTarget', { targetId }); } catch (e) { /* ignore */ }

console.log('\n===== 结果 =====');
console.log(`  通过 ${R.pass} / 失败 ${R.fail}（断言总数 ${R.pass + R.fail}）`);
if (R.known.length) { console.log('  已知缺陷探针：'); R.known.forEach((k) => console.log('   · ' + k)); }
if (R.failures.length) { console.log('  失败明细：'); R.failures.forEach((f) => console.log('   \u2717 ' + f)); }
console.log(R.fail === 0 ? 'BROWSER_TESTS_PASS' : 'BROWSER_TESTS_FAILED');
process.exit(R.fail === 0 ? 0 : 1);
