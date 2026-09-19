#!/usr/bin/env node
/**
 * tests/qa_110_dense.mjs — 1.0.10 密集灯阵专项（QA）
 * 问题：泛光从 1 层变 3 层后，MOJ 大屏这种密集排布里，相邻两盏同时亮时
 *       泛光会不会糊成一根亮条，导致单盏亮/灭无法分辨？
 * 方法：
 *   1) 通过应用自身的「导入 JSON」载入 examples/moj-scroll-screen.json（306 元件 / 160 灯，5×32）
 *   2) 用应用自身的「单步 +1s」按钮快进 45 秒（绕过 35s 开机瞬态）
 *   3) 读每盏灯的屏幕坐标 → 选一排相邻灯 → 沿该排取亮度剖面：
 *        - 相邻两盏「都亮」时，两盏中间点亮度必须显著低于灯心（局部极小值 → 没糊成一根亮条）
 *        - 「亮」与「灭」相邻时，灯心亮度差必须显著
 *   4) 截图存档供肉眼复核
 */
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';

const DEBUG = process.env.QA_CDP || 'http://127.0.0.1:9222';
const APP = process.env.QA_URL || 'http://127.0.0.1:8900/index.html';
const MOJ = 'C:/Users/liao9/WorkBuddy/我的工作1/github-publish/examples/moj-scroll-screen.json';
const SHOT = 'C:/Users/liao9/WorkBuddy/我的工作1/_qa110_dense.png';

const R = { pass: 0, fail: 0, failures: [], notes: [] };
const ok = (n, c, d = '') => { if (c) R.pass++; else { R.fail++; R.failures.push(n + (d ? ' :: ' + d : '')); } console.log(`${c ? ' ✓' : ' ✗'} ${n}${d ? ' :: ' + d : ''}`); return !!c; };

/* ---------- 极简 CDP 客户端 ---------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      else for (const h of this.handlers) h(m); }; }  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(fn) { this.handlers.push(fn); }
}
const connect = async (url) => { const ws = new WebSocket(url); await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws error')); }); return new CDP(ws); };

let page;
const js = async (expr) => {
  const r = await page.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const mouse = (type, x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: o.button ?? 'left', buttons: o.buttons ?? 0, clickCount: o.clickCount ?? 1, pointerType: 'mouse', modifiers: o.modifiers ?? 0 });
const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, { buttons: 1 }); await sleep(25); await mouse('mouseReleased', x, y); await sleep(60); };

const lum = (r, g, b) => { const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };

/** 截图 → 页内 createImageBitmap → 取像素（复用 browser.smoke 的成熟套路） */
const shotPixels = async (points) => {
  const b64 = (await page.send('Page.captureScreenshot', { format: 'png' })).data;
  return js(`return (async()=>{
    const pts = ${JSON.stringify(points)};
    const b = await fetch('data:image/png;base64,${b64}').then(r=>r.blob());
    const bmp = await createImageBitmap(b);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0);
    return pts.map(p => { const d = x.getImageData(p[0], p[1], 1, 1).data; return [d[0], d[1], d[2]]; });
  })()`);
};

(async () => {
  const list = await (await fetch(DEBUG + '/json/list')).json();
  const target = list.find((t) => t.type === 'page' && String(t.url || '').includes('127.0.0.1:8900')) || list.find((t) => t.type === 'page');
  page = await connect(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  if (!String(target.url || '').includes('127.0.0.1:8900')) { await page.send('Page.navigate', { url: APP }); await sleep(2500); }
  else await sleep(400);

  // 1) 切到实验室
  await js(`document.querySelector('.nav-btn[data-view="lab"]').click()`);
  await sleep(600);

  // 2) 导入 MOJ
  const obj = JSON.parse(fs.readFileSync(MOJ, 'utf8'));
  const tmpJson = 'C:/Users/liao9/AppData/Local/Temp/qa110_moj.json';
  fs.writeFileSync(tmpJson, JSON.stringify(obj));
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
  await page.send('DOM.setFileInputFiles', { files: [tmpJson], nodeId });
  await sleep(900);
  ok('MOJ 已导入（306 元件）', (await js(`return document.querySelectorAll('#board .element').length`)) === 306);

  // 3) 适应视图 + 快进 45 秒（应用自带「单步 +1s」按钮）
  await js(`document.getElementById('btn-fit').click()`);
  await sleep(400);
  for (let i = 0; i < 3; i++) { await js(`document.getElementById('btn-step').click()`); }
  // 按启动按钮（画面中央偏上的 scroll_btn）
  const btn = await js(`return (()=>{const e=document.querySelector('.element[data-el="scroll_btn"]');if(!e)return null;const r=e.getBoundingClientRect();return [r.left+r.width/2, r.top+r.height/2];})()`);
  if (btn) await click(btn[0], btn[1]); else R.notes.push('未找到 scroll_btn，跳过点击');
  for (let i = 0; i < 44; i++) { await js(`document.getElementById('btn-step').click()`); }
  await sleep(500);
  const litCount = await js(`return document.querySelectorAll('#board .element-lamp rect[fill="#ffd23f"]').length`);
  R.notes.push(`稳态采样：lit 相关 rect 数（含泛光层）= ${litCount}`);

  // 4) 读灯的屏幕坐标，按行分组
  const lamps = await js(`return (()=>{
    const out=[];
    for (const el of document.querySelectorAll('#board .element-lamp')) {
      const r = el.getBoundingClientRect();
      out.push({ id: el.getAttribute('data-el'), x: r.left + r.width/2, y: r.top + r.height/2, lit: !!el.querySelector('rect[fill="#ffd23f"]') });
    }
    return out;
  })()`);
  ok('读到 160 盏灯', lamps.length === 160, '实际 ' + lamps.length);
  // 按行分组（y 差 < 6px 视为同一行）
  const rows = [];
  for (const l of lamps.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
    const r = rows.find((rw) => Math.abs(rw.y - l.y) < 6);
    if (r) r.items.push(l); else rows.push({ y: l.y, items: [l] });
  }
  rows.forEach((r) => r.items.sort((a, b) => a.x - b.x));
  const pitch = rows.length ? (rows[0].items[rows[0].items.length - 1].x - rows[0].items[0].x) / (rows[0].items.length - 1) : 0;
  R.notes.push(`灯阵 ${rows.length} 行，列距约 ${pitch.toFixed(1)}px（屏幕坐标）`);

  // 5) 找「相邻两盏都亮」的一段，取剖面
  let picked = null;
  for (const r of rows) {
    for (let i = 0; i + 1 < r.items.length; i++) {
      if (r.items[i].lit && r.items[i + 1].lit) { picked = { row: r, i }; break; }
    }
    if (picked) break;
  }
  ok('找到相邻两盏同亮的样本', !!picked);
  if (picked) {
    const { row: rw, i } = picked;
    const a = rw.items[i], b = rw.items[i + 1];
    const mid = { x: (a.x + b.x) / 2, y: a.y };
    const px = await shotPixels([[a.x, a.y], [mid.x, mid.y], [b.x, b.y], [a.x, a.y - Math.round(pitch * 0.9)]]);
    const la = lum(...px[0]), lmid = lum(...px[1]), lb = lum(...px[2]), labove = lum(...px[3]);
    R.notes.push(`灯心A L=${la.toFixed(4)} 中点 L=${lmid.toFixed(4)} 灯心B L=${lb.toFixed(4)} 正上方 L=${labove.toFixed(4)}`);
    ok('相邻两亮灯之间仍是局部极小值（未糊成一根亮条）', lmid < Math.min(la, lb) * 0.75, `中点/灯心 = ${(lmid / Math.min(la, lb)).toFixed(2)}`);
    ok('相邻亮灯的灯心亮度彼此接近（同状态同观感）', Math.abs(la - lb) / Math.max(la, lb) < 0.35, `差 ${(((Math.abs(la - lb)) / Math.max(la, lb)) * 100).toFixed(0)}%`);
    // 正上方那盏是「灭」的话，与亮的灯心差
    const above = rw.items.length ? null : null;
    if (labove) R.notes.push(`正上方像素亮度 ${labove.toFixed(4)}（该处为上一行灯阵/画布底，仅作参考）`);
  }

  // 6) 找「亮 / 灭」相邻的一段
  let picked2 = null;
  for (const r of rows) {
    for (let i = 0; i + 1 < r.items.length; i++) {
      if (r.items[i].lit !== r.items[i + 1].lit) { picked2 = { row: r, i }; break; }
    }
    if (picked2) break;
  }
  if (picked2) {
    const { row: rw, i } = picked2;
    const litL = rw.items[i].lit ? rw.items[i] : rw.items[i + 1];
    const offL = rw.items[i].lit ? rw.items[i + 1] : rw.items[i];
    const px = await shotPixels([[litL.x, litL.y], [offL.x, offL.y]]);
    const lLit = lum(...px[0]), lOff = lum(...px[1]);
    R.notes.push(`相邻亮/灭：亮灯心 L=${lLit.toFixed(4)} 灭灯心 L=${lOff.toFixed(4)} 比 ${(lLit / Math.max(lOff, 1e-6)).toFixed(1)}×`);
    ok('相邻亮/灭灯心亮度比 ≥ 2（密集排布下仍可分辨）', lLit / Math.max(lOff, 1e-6) >= 2, `${(lLit / Math.max(lOff, 1e-6)).toFixed(1)}×`);
  } else R.notes.push('（该稳态帧没有亮灭相邻样本，跳过）');

  // 7) 截图存档
  const shot = (await page.send('Page.captureScreenshot', { format: 'png' })).data;
  fs.writeFileSync(SHOT, Buffer.from(shot, 'base64'));
  R.notes.push('截图: ' + SHOT);

  console.log(`\n=== qa_110_dense 结果 ===`);
  console.log(`通过 ${R.pass}  失败 ${R.fail}`);
  for (const f of R.failures) console.log('  ✗ ' + f);
  for (const n of R.notes) console.log('  · ' + n);
  console.log(R.fail === 0 ? 'QA110_DENSE_PASS' : 'QA110_DENSE_FAIL');
  process.exit(R.fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });
