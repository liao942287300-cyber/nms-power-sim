#!/usr/bin/env node
/**
 * tests/qa_edward_104.mjs — QA Edward 独立回归脚本（1.0.4：画布提示完整显示 + 曲线右键拾取）
 * 断言全部自行设计、自行计数，与 browser.smoke.mjs / qa_edward_103.mjs 相互独立。
 * 运行前置：http.server 8900（cwd=项目根） + headless Edge CDP 9222（全新 user-data-dir）。
 * 可选参数：H C L（缺省全跑）。H=提示专项 C=曲线拾取专项 L=左键回归
 */
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';

const DEBUG = process.env.QA_CDP || 'http://127.0.0.1:9222';
const APP = process.env.QA_URL || 'http://127.0.0.1:8900/index.html';
const TMP = 'C:/Users/liao9/AppData/Local/Temp';

const R = { pass: 0, fail: 0, failures: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}
function eq(name, a, b) { return ok(name, Object.is(a, b), `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`); }

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
      else for (const h of this.handlers) h(m); }; }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(fn) { this.handlers.push(fn); }
}
async function connect(url) { const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new CDP(ws); }

let page;
const exceptions = [];
async function js(expr) {
  const r = await page.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
const mv = (x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: o.button ?? 'none', buttons: o.buttons ?? 0, clickCount: 1, pointerType: 'mouse', modifiers: o.modifiers ?? 0 });
const down = (x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: o.button ?? 'left', buttons: o.buttons ?? 1, clickCount: 1, pointerType: 'mouse', modifiers: o.modifiers ?? 0 });
const up = (x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: o.button ?? 'left', buttons: 0, clickCount: 1, pointerType: 'mouse', modifiers: o.modifiers ?? 0 });
async function click(x, y, o = {}) { await mv(x, y, o); await down(x, y, o); await sleep(40); await up(x, y, o); await sleep(140); }
/** 右键单击（导线拾取用） */
async function rclick(x, y) {
  await mv(x, y, { button: 'right' });
  await down(x, y, { button: 'right', buttons: 2 });
  await sleep(40);
  await up(x, y, { button: 'right' });
  await sleep(220);
}
async function drag(from, to, steps = 10, o = {}) {
  await mv(from.x, from.y, o); await down(from.x, from.y, o);
  for (let i = 1; i <= steps; i++) { await mv(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, { ...o, buttons: o.buttons ?? 1 }); await sleep(12); }
  await up(to.x, to.y, o); await sleep(160);
}
const kd = (k, code, vk, mod = 0) => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod });
const ku = (k, code, vk, mod = 0) => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod });
async function press(k, code, vk, mod = 0) { await kd(k, code, vk, mod); await ku(k, code, vk, mod); await sleep(160); }
const ESC = () => press('Escape', 'Escape', 27);
const DEL = () => press('Delete', 'Delete', 46);
async function wheel(x, y, dy) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, button: 'none', pointerType: 'mouse' }); await sleep(60); }

async function readBoard() {
  return js(`
    const b=document.getElementById('board');const r=b.getBoundingClientRect();
    const vg=b.querySelector('g.viewport');let k=1,tx=0,ty=0;
    if(vg){const m=/translate\\(([-\\d.eE+]+)[ ,]([-\\d.eE+]+)\\)\\s*scale\\(([-\\d.eE+]+)\\)/.exec(vg.getAttribute('transform')||'');if(m){tx=+m[1];ty=+m[2];k=+m[3];}}
    const els=[...b.querySelectorAll('.element')].map(g=>{const m=/translate\\(([-\\d.eE+]+)[ ,]([-\\d.eE+]+)\\)/.exec(g.getAttribute('transform')||'');
      return {id:g.getAttribute('data-el'),type:(g.getAttribute('class').match(/element-([a-z_]+)/)||[])[1],x:m?+m[1]:0,y:m?+m[2]:0};});
    const sel=[...b.querySelectorAll('.sel-box')].map(s=>s.closest('[data-el]')?s.closest('[data-el]').getAttribute('data-el'):null).filter(Boolean).sort();
    const wires=[...b.querySelectorAll('path.wire')].map(w=>w.getAttribute('d'));
    const ports=[...b.querySelectorAll('.port')].map(p=>{const g=p.closest('.element');
      const m=/translate\\(([-\\d.eE+]+)[ ,]([-\\d.eE+]+)\\)/.exec(g.getAttribute('transform')||'');
      const dot=p.querySelector('.port-dot');
      return {el:p.getAttribute('data-el'),port:p.getAttribute('data-portname'),wx:+m[1]+ +dot.getAttribute('cx'),wy:+m[2]+ +dot.getAttribute('cy')};});
    return {rect:{l:r.left,t:r.top,w:r.width,h:r.height},view:{k,tx,ty},els,sel,wires,ports,
      insp:(document.getElementById('inspector-props')||{}).textContent||'',
      status:[...document.querySelectorAll('#inspector-status .status-row')].map(x=>({id:(x.querySelector('.sr-id')||{}).textContent,st:(x.querySelector('.sr-state')||{}).textContent}))};
  `);
}
const w2c = (st, x, y) => ({ x: st.rect.l + st.view.tx + x * st.view.k, y: st.rect.t + st.view.ty + y * st.view.k });
const c2w = (st, x, y) => ({ x: (x - st.rect.l - st.view.tx) / st.view.k, y: (y - st.rect.t - st.view.ty) / st.view.k });
const posOf = (st, id) => { const e = st.els.find((x) => x.id === id); return e ? { x: e.x, y: e.y } : null; };
const stateOf = (st, id) => (st.status.find((s) => s.id === '#' + id) || {}).st;
/** 状态面板 ~120ms 节流：轮询等待目标状态 */
async function waitForState(id, want, timeout = 2500) {
  const t0 = Date.now();
  for (;;) {
    const st = await readBoard();
    if (stateOf(st, id) === want) return { okv: true, st };
    if (Date.now() - t0 > timeout) return { okv: false, st };
    await sleep(130);
  }
}

async function importJSON(obj, tag) {
  const file = `${TMP}/qa_edward_${tag}.json`;
  fs.writeFileSync(file, JSON.stringify(obj));
  const doc = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
  await page.send('DOM.setFileInputFiles', { files: [file], nodeId });
  await sleep(550);
}
const clearCanvas = async () => { await js(`document.getElementById('btn-clear').click();return 1;`); await sleep(260); };
const setView = async (n) => { await js(`document.querySelector('.nav-btn[data-view="${n}"]').click();return 1;`); await sleep(320); };
const fitView = async () => { await js(`document.getElementById('btn-fit').click();return 1;`); await sleep(220); };
const armPalette = async (type) => { await js(`const it=document.querySelector('.palette-item[data-type="${type}"]');if(!it.classList.contains('is-active'))it.click();return 1;`); await sleep(180); };
const clickSel = async (sel) => { await js(`document.querySelector(${JSON.stringify(sel)}).click();return 1;`); await sleep(200); };

/* ====================== H 提示专项（独立量 DOM） ====================== */
const HINT_PROBE = `
  const h=document.querySelector('#canvas-wrap .canvas-hint');
  if(!h) return {missing:true};
  const w=document.getElementById('canvas-wrap');
  const hr=h.getBoundingClientRect(), wr=w.getBoundingClientRect();
  const cs=getComputedStyle(h);
  const cx=(hr.left+hr.right)/2, cy=(hr.top+hr.bottom)/2;
  const under=document.elementFromPoint(cx,cy);
  return {missing:false,pe:cs.pointerEvents,ws:cs.whiteSpace,ow:cs.overflowWrap,
    sw:h.scrollWidth,cw:h.clientWidth,sh:h.scrollHeight,oh:h.offsetHeight,
    hl:hr.left,hrt:hr.right,ht:hr.top,hb:hr.bottom,wl:wr.left,wrt:wr.right,wt:wr.top,wb:wr.bottom,
    underTag:under?under.tagName:null,underCls:under?(under.getAttribute('class')||''):null,
    text:h.textContent.replace(/\\s+/g,' ').trim()};`;
function checkHint(tag, p) {
  ok(`${tag} 提示元素存在`, !p.missing);
  if (p.missing) return;
  ok(`${tag} pointer-events=none（不挡画布交互）`, p.pe === 'none', p.pe);
  ok(`${tag} 无横向裁切 scrollWidth≤clientWidth+1`, p.sw <= p.cw + 1, `sw=${p.sw} cw=${p.cw}`);
  ok(`${tag} 无纵向裁切 scrollHeight≤offsetHeight+1`, p.sh <= p.oh + 1, `sh=${p.sh} oh=${p.oh}`);
  ok(`${tag} 完全落在画布视口内`, p.hl >= p.wl - 1 && p.hrt <= p.wrt + 1 && p.ht >= p.wt - 1 && p.hb <= p.wb + 1,
    `hint=(${p.hl.toFixed(0)},${p.ht.toFixed(0)},${p.hrt.toFixed(0)},${p.hb.toFixed(0)}) wrap=(${p.wl.toFixed(0)},${p.wt.toFixed(0)},${p.wrt.toFixed(0)},${p.wb.toFixed(0)})`);
  ok(`${tag} 允许换行 white-space=normal + overflow-wrap`, p.ws === 'normal' && p.ow === 'break-word', `${p.ws}/${p.ow}`);
  ok(`${tag} 文字完整（全部关键提示在）`,
    p.text.includes('滚轮缩放') && p.text.includes('空格') && p.text.includes('框选')
    && p.text.includes('连线') && p.text.includes('右键导线') && p.text.length > 60, p.text.slice(0, 60));
  ok(`${tag} elementFromPoint 不命中提示自身（点击可穿透）`, p.underTag !== null && p.underCls !== null && !String(p.underCls).split(/\\s+/).includes('canvas-hint'),
    `${p.underTag}.${p.underCls}`);
}
async function hHint() {
  console.log('\\n===== H 画布提示专项（独立量 DOM） =====');
  await setView('lab'); await clearCanvas();

  // H1 空画布默认态
  checkHint('H1 默认态', await js(HINT_PROBE));

  // H2 载入内容（fit 后非空态 opacity 0.55）
  await importJSON({
    elements: [
      { id: 'p', type: 'power', x: 120, y: 120 },
      { id: 's', type: 'wall_switch', x: 456, y: 240 },
      { id: 'l', type: 'lamp', x: 840, y: 120 },
    ],
    wires: [
      { id: 'wa', a: { el: 'p', port: 'out' }, b: { el: 's', port: 'a' } },
      { id: 'wb', a: { el: 's', port: 'b' }, b: { el: 'l', port: 'in' } },
    ], timeOfDay: 8, dayCycle: false,
  }, 'h104');
  await fitView();
  checkHint('H2 载入后', await js(HINT_PROBE));

  // H3 缩放后（缩小 5 档 → 放大 3 档）提示均不被裁切
  const st0 = await readBoard();
  const cc = { x: st0.rect.l + st0.rect.w / 2, y: st0.rect.t + st0.rect.h / 2 };
  for (let i = 0; i < 5; i++) await wheel(cc.x, cc.y, -240);
  await sleep(250);
  checkHint('H3a 缩小后', await js(HINT_PROBE));
  for (let i = 0; i < 3; i++) await wheel(cc.x, cc.y, 240);
  await sleep(250);
  checkHint('H3b 放大后', await js(HINT_PROBE));

  // H4 功能性穿透：在提示中心位置放置元件并可再次点击选中（提示不挡画布）
  await ESC(); await clearCanvas();
  const stA = await readBoard();
  const hintC = await js(`
    const h=document.querySelector('#canvas-wrap .canvas-hint');
    const r=h.getBoundingClientRect();
    return {x:(r.left+r.right)/2,y:(r.top+r.bottom)/2};`);
  const worldC = c2w(stA, hintC.x, hintC.y);
  const snap = (v) => Math.round(v / 24) * 24;
  await armPalette('lamp');
  await click(hintC.x, hintC.y);
  await ESC();
  let st = await readBoard();
  eq('H4 在提示中心放置元件成功（穿透放置）', st.els.length, 1);
  if (st.els.length === 1) {
    ok('H4 放置坐标 = 提示中心世界坐标的 24 网格吸附',
      st.els[0].x === snap(worldC.x) && st.els[0].y === snap(worldC.y),
      `实测(${st.els[0].x},${st.els[0].y}) 期望(${snap(worldC.x)},${snap(worldC.y)})`);
  }
  // 选中穿透：再点同一位置应命中该元件（若被提示挡住则 sel 为空）
  await click(hintC.x, hintC.y);
  st = await readBoard();
  eq('H4 点击提示中心可选中其下元件（穿透点击）', st.sel.length, 1);
  await ESC();
}

/* ====================== C 曲线拾取专项（自构造 + 独立采样） ====================== */
const CURVE_CIRCUIT = {
  elements: [
    { id: 'A1', type: 'wall_switch', x: 216, y: 120 },
    { id: 'A2', type: 'wall_switch', x: 216, y: 720 },
    { id: 'B1', type: 'wall_switch', x: 456, y: 120 },
    { id: 'B2', type: 'wall_switch', x: 456, y: 720 },
  ],
  wires: [
    { id: 'w1', a: { el: 'A1', port: 'b' }, b: { el: 'A2', port: 'a' } },
    { id: 'w2', a: { el: 'B1', port: 'b' }, b: { el: 'B2', port: 'a' } },
  ], timeOfDay: 8, dayCycle: false,
};
/** 页内几何工具：解析 path d（M/C 或 M/L/A），贝塞尔求值，点-折线最近距离 */
const GEO_FN = `
  function parseD(d){const t=d.trim().split(/\\s+/);const nums=t.filter(s=>!isNaN(+s)).map(Number);
    if(t.indexOf('C')>=0){return {kind:'C',p1:{x:nums[0],y:nums[1]},c1:{x:nums[2],y:nums[3]},c2:{x:nums[4],y:nums[5]},p2:{x:nums[6],y:nums[7]}};}
    return {kind:'L',p1:{x:nums[0],y:nums[1]},p2:{x:nums[nums.length-2],y:nums[nums.length-1]}};}
  function bez(g,t){const u=1-t;
    return {x:u*u*u*g.p1.x+3*u*u*t*g.c1.x+3*u*t*t*g.c2.x+t*t*t*g.p2.x,
            y:u*u*u*g.p1.y+3*u*u*t*g.c1.y+3*u*t*t*g.c2.y+t*t*t*g.p2.y};}
  function samplePoly(g,n){const pts=[];for(let i=0;i<=n;i++)pts.push(g.kind==='C'?bez(g,i/n):
    {x:g.p1.x+(g.p2.x-g.p1.x)*i/n,y:g.p1.y+(g.p2.y-g.p1.y)*i/n});return pts;}
  function distPoly(px,py,pts){let best=Infinity;
    for(let i=0;i<pts.length-1;i++){const a=pts[i],b=pts[i+1];const dx=b.x-a.x,dy=b.y-a.y;const L2=dx*dx+dy*dy;
      let t=L2>0?((px-a.x)*dx+(py-a.y)*dy)/L2:0;t=Math.max(0,Math.min(1,t));
      const d=Math.hypot(px-(a.x+dx*t),py-(a.y+dy*t));if(d<best)best=d;}
    return best;}
  function chordDist(pt,g){const dx=g.p2.x-g.p1.x,dy=g.p2.y-g.p1.y;const L2=dx*dx+dy*dy;
    let t=L2>0?((pt.x-g.p1.x)*dx+(pt.y-g.p1.y)*dy)/L2:0;t=Math.max(0,Math.min(1,t));
    return Math.hypot(pt.x-(g.p1.x+dx*t),pt.y-(g.p1.y+dy*t));}`;

async function cCurvePick() {
  console.log('\\n===== C 曲线右键拾取专项（自构造坐标） =====');
  await setView('lab'); await clearCanvas();
  await importJSON(CURVE_CIRCUIT, 'c104');
  await fitView();
  await clickSel('.wire-style-btn[data-style="curve"]'); await sleep(420);
  let st = await readBoard();
  eq('C1 曲线模式 2 根导线', st.wires.length, 2);

  // 独立采样：从两条渲染 path d 反推，各自取「离弦线最远」的弧上点
  const geo = await js(`
    ${GEO_FN}
    const ds=[...document.querySelectorAll('#board path.wire')].map(w=>w.getAttribute('d'));
    const g1=parseD(ds[0]),g2=parseD(ds[1]);
    let best=null;
    for(let t=0.05;t<=0.95;t+=0.01){const pt=bez(g1,t);const off=chordDist(pt,g1);
      if(!best||off>best.off)best={t,pt,off};}
    return {g1,g2,best,d1:ds[0],d2:ds[1]};`);
  ok('C2 渲染 d 为三次贝塞尔（M+C）', /C\s/.test(geo.d1) && /C\s/.test(geo.d2), geo.d1.slice(0, 40));
  ok('C3 w1 弧上最远点离弦线 ≥30px（远离旧弦线拾取半径）', geo.best.off >= 30, `off=${geo.best.off.toFixed(1)}px @t=${geo.best.t.toFixed(2)}`);
  // 点击点与 w2 弧线的距离（证明两条相近曲线可区分，不是碰运气）
  const sep = await js(`
    ${GEO_FN}
    const g1=${JSON.stringify(geo.g1)},g2=${JSON.stringify(geo.g2)},pt=${JSON.stringify(geo.best.pt)};
    return {d1:distPoly(pt.x,pt.y,samplePoly(g1,200)),d2:distPoly(pt.x,pt.y,samplePoly(g2,200))};`);
  ok('C4 点击点距 w1 弧 ≈0、距 w2 弧 ≥30px（两条相近曲线可区分）',
    sep.d1 < 6 && sep.d2 >= 30, `d(w1)=${sep.d1.toFixed(1)}px d(w2)=${sep.d2.toFixed(1)}px`);

  // C5 右键弧线中段 → 选中 w1（检查器），不得选中 w2
  const hc = w2c(st, geo.best.pt.x, geo.best.pt.y);
  ok('C5 屏幕落点在画布内', hc.x >= st.rect.l && hc.x <= st.rect.l + st.rect.w && hc.y >= st.rect.t && hc.y <= st.rect.t + st.rect.h,
    `(${hc.x.toFixed(0)},${hc.y.toFixed(0)})`);
  await rclick(hc.x, hc.y);
  st = await readBoard();
  ok('C5 右键弧线中段 → 检查器「导线 w1」', st.insp.includes('导线 w1') && !st.insp.includes('导线 w2'), st.insp.slice(0, 40));

  // C6 Delete 删除 w1：2→1，剩余的是 w2（未误删）
  await press('Delete', 'Delete', 46);
  st = await readBoard();
  eq('C6 Delete 删除后导线 2→1', st.wires.length, 1);
  ok('C6 剩余导线确为 w2（d 与初始 w2 一致）', st.wires.length === 1 && st.wires[0] === geo.d2,
    st.wires[0] ? st.wires[0].slice(0, 40) : '无');

  // C7 负例：右键离所有线都很远的位置 → 不误选（检查器无「导线」）
  const far = await js(`
    ${GEO_FN}
    const st=${JSON.stringify({ rect: st.rect, view: st.view })};
    const c={x:st.rect.l+st.rect.w*0.82,y:st.rect.t+st.rect.h*0.30};
    const wx=(c.x-st.rect.l-st.view.tx)/st.view.k, wy=(c.y-st.rect.t-st.view.ty)/st.view.k;
    const g1=${JSON.stringify(geo.g1)},g2=${JSON.stringify(geo.g2)};
    return {sx:c.x,sy:c.y,wx,wy,e1:distPoly(wx,wy,samplePoly(g1,200)),e2:distPoly(wx,wy,samplePoly(g2,200))};`);
  ok('C7 负例候选点距两弧均 ≥60px', far.e1 >= 60 && far.e2 >= 60, `e1=${far.e1.toFixed(0)} e2=${far.e2.toFixed(0)}`);
  await rclick(far.sx, far.sy);
  st = await readBoard();
  ok('C7 右键空白远处不误选导线（检查器无「导线」）', !st.insp.includes('导线 w'), st.insp.slice(0, 40));

  // C8 直线模式回归：切回直线，右键直导线中点 → 选中
  await clickSel('.wire-style-btn[data-style="straight"]'); await sleep(320);
  st = await readBoard();
  const sd = st.wires[0];
  ok('C8 切回直线后 d 无 C 命令', !/C\s/.test(sd), sd.slice(0, 40));
  const mid = await js(`
    ${GEO_FN}
    const g=parseD(${JSON.stringify(sd)});
    return {x:(g.p1.x+g.p2.x)/2,y:(g.p1.y+g.p2.y)/2};`);
  const mc = w2c(st, mid.x, mid.y);
  await rclick(mc.x, mc.y);
  st = await readBoard();
  ok('C8 直线模式右键直导线中点 → 检查器「导线 w2」', st.insp.includes('导线 w2'), st.insp.slice(0, 40));

  // C9 直线模式负例：按直线几何重新选远处点，先 Esc 清空选择（右键未命中不会清选择）
  await ESC();
  const farS = await js(`
    ${GEO_FN}
    const st=${JSON.stringify({ rect: st.rect, view: st.view })};
    const g=parseD(${JSON.stringify(sd)});
    const cands=[[0.82,0.30],[0.15,0.85],[0.85,0.80],[0.10,0.40]];
    for(const [fx,fy] of cands){
      const sx=st.rect.l+st.rect.w*fx, sy=st.rect.t+st.rect.h*fy;
      const wx=(sx-st.rect.l-st.view.tx)/st.view.k, wy=(sy-st.rect.t-st.view.ty)/st.view.k;
      const e=distPoly(wx,wy,samplePoly(g,200));
      if(e>=60) return {sx,sy,e};
    }
    return {sx:null,e:0};`);
  ok('C9 负例候选点距直导线 ≥60px', farS.sx !== null && farS.e >= 60, `e=${farS.e.toFixed(0)}`);
  // 左键空白清空选择（比 Esc 稳：右键未命中不会清选择，需先保证无选中）
  await click(farS.sx, farS.sy);
  st = await readBoard();
  ok('C9 左键空白已清空选择（sel=0 且检查器无「导线」）', st.sel.length === 0 && !st.insp.includes('导线 w'),
    `sel=${st.sel.length} insp=${st.insp.slice(0, 24)}`);
  await rclick(farS.sx, farS.sy);
  st = await readBoard();
  ok('C9 直线模式右键空白远处不误选', !st.insp.includes('导线 w'), st.insp.slice(0, 40));
  await ESC();
}

/* ====================== L 左键回归（contextmenu 改动不波及） ====================== */
async function lLeftClick() {
  console.log('\\n===== L 左键行为回归 =====');
  await setView('lab'); await clearCanvas();
  await importJSON({
    elements: [
      { id: 'p', type: 'power', x: 120, y: 120 },
      { id: 'l', type: 'lamp', x: 456, y: 120 },
    ],
    wires: [{ id: 'wa', a: { el: 'p', port: 'out' }, b: { el: 'l', port: 'in' } }],
    timeOfDay: 8, dayCycle: false,
  }, 'l104');
  await fitView();
  let st = await readBoard();
  ok('L1 导入 2 元件 1 导线', st.els.length === 2 && st.wires.length === 1, `els=${st.els.length} wires=${st.wires.length}`);

  // L2 左键点击开关（电源）→ 灯灭 → 再点 → 灯亮（轮询状态面板）
  const pp = posOf(st, 'p');
  st = await readBoard();
  await click(w2c(st, pp.x, pp.y).x, w2c(st, pp.x, pp.y).y);
  let r1 = await waitForState('l', '熄灭');
  ok('L2 左键点击电源 → 灯熄灭', r1.okv, r1.st ? stateOf(r1.st, 'l') : '无状态');
  await click(w2c(r1.st, pp.x, pp.y).x, w2c(r1.st, pp.x, pp.y).y);
  let r2 = await waitForState('l', '点亮');
  ok('L2 再次左键点击 → 灯恢复点亮', r2.okv, r2.st ? stateOf(r2.st, 'l') : '无状态');
  st = r2.st;

  // L3 左键框选（空白处拖拽）→ 命中 2 个元件
  await drag(w2c(st, 20, 20), w2c(st, 900, 300), 12);
  st = await readBoard();
  eq('L3 左键框选命中 2 个元件', st.sel.length, 2);
  await ESC();

  // L4 左键拖端口连线 → 导线 1→2
  st = await readBoard();
  const lp = posOf(st, 'l');
  // 找 l 的 in 端口（已占用）→ 改用放置新开关再连线：简化为直接从 l.in 拖到空白放置？端口已被 wa 占用。
  // 改为：放置一个新 lamp，从新 lamp 的 in 拖到原 lamp 的 in 不可行（占用）。
  // 最简可行连线回归：放置新 lamp M，从 M.in 拖到 l.in？l.in 已占用。
  // 方案：从新 lamp 的 in 端口拖到原 lamp 元件附近空白不构成连线。改为断言现有连线存在即可 + 放置行为已在 H4 验证。
  // 这里做「端口拖拽拉线」：先放一个新开关 S，再从 S.b 拖到 l.in —— l.in 已被占用则换 S.a ← p.out？p.out 已占用。
  // 最终方案：放置新 lamp M 于空白处，从 M 的 in 端口拖到 l 的元件主体（连线到元件自动选空闲端口）。
  await armPalette('wall_switch');
  const empty = c2w(st, st.rect.l + st.rect.w * 0.7, st.rect.t + st.rect.h * 0.45);
  const snap = (v) => Math.round(v / 24) * 24;
  await click(w2c(st, snap(empty.x), snap(empty.y)).x, w2c(st, snap(empty.x), snap(empty.y)).y);
  await ESC();
  st = await readBoard();
  eq('L4 放置新开关：元件 2→3', st.els.length, 3);
  const newEl = st.els[st.els.length - 1];
  const sp = posOf(st, newEl.id);
  const portB = st.ports.find((q) => q.el === newEl.id && q.port === 'b');
  const portA = st.ports.find((q) => q.el === newEl.id && q.port === 'a');
  if (portA && portB) {
    await drag(w2c(st, portA.wx, portA.wy), w2c(st, portB.wx, portB.wy), 10);
    st = await readBoard();
    eq('L4 左键从 a 端口拖到 b 端口 → 导线 1→2', st.wires.length, 2);
  } else {
    ok('L4 端口读取失败', false, JSON.stringify(st.ports));
  }
  await ESC();
}

/* ====================== 主流程 ====================== */
const only = process.argv.slice(2);
fs.mkdirSync(TMP, { recursive: true });
const ver = await (await fetch(DEBUG + '/json/version')).json();
const browser = await connect(ver.webSocketDebuggerUrl);
const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
try {
  const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId });
  await browser.send('Browser.setWindowBounds', { windowId, bounds: { width: 1600, height: 1000, windowState: 'normal' } });
} catch (e) { console.log('· setWindowBounds 失败（忽略）: ' + e.message); }
const list = await (await fetch(DEBUG + '/json/list')).json();
page = await connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
await page.send('Runtime.enable'); await page.send('Page.enable');
const loaded = new Promise((res) => page.on((m) => { if (m.method === 'Page.loadEventFired') res(); }));
await page.send('Page.navigate', { url: APP });
await Promise.race([loaded, sleep(8000)]); await sleep(1600);

const SECTIONS = [['H', hHint], ['C', cCurvePick], ['L', lLeftClick]];
console.log('===== QA Edward 独立专项（1.0.4） =====');
for (const [name, fn] of SECTIONS) {
  if (only.length && !only.includes(name)) continue;
  try { await fn(); } catch (e) { R.fail++; R.failures.push(`[${name}] 异常: ${e && e.message}`); console.log(`  [FAIL] [${name}] 异常: ${e && e.message}`); }
}
try { await browser.send('Target.closeTarget', { targetId }); } catch (e) { /* ignore */ }
console.log('\\n===== 结果 =====');
console.log(`  通过 ${R.pass} / 失败 ${R.fail}（断言总数 ${R.pass + R.fail}）`);
if (exceptions.length) console.log(`  页面异常 ${exceptions.length} 条: ${exceptions[0]}`);
if (R.failures.length) { console.log('  失败明细:'); R.failures.forEach((f) => console.log('   [FAIL] ' + f)); }
console.log(R.fail === 0 ? 'QA_104_PASS' : 'QA_104_FAILED');
process.exit(R.fail === 0 ? 0 : 1);
