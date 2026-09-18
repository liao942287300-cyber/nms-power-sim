#!/usr/bin/env node
/** 探针：定位 UI 点击/框选失效原因 */
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
const DEBUG = 'http://127.0.0.1:9222';
const APP = 'http://127.0.0.1:8900/index.html';
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } }; }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
}
const connect = async (url) => { const ws = new WebSocket(url); await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); }); return new CDP(ws); };
let page;
const js = async (expr) => {
  const r = await page.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const mouse = (type, x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: o.button ?? 'left', buttons: o.buttons ?? 0, clickCount: 1, pointerType: 'mouse', modifiers: 0 });

const out = [];
async function main() {
  const created = await (await fetch(`${DEBUG}/json/new?about:blank`, { method: 'PUT' })).json().catch(() => null);
  const list = await (await fetch(`${DEBUG}/json/list`)).json();
  const tab = created || list.find((t) => t.type === 'page');
  page = await connect(tab.webSocketDebuggerUrl);
  await page.send('Runtime.enable'); await page.send('Page.enable');
  await page.send('Page.navigate', { url: APP }); await sleep(2000);
  await js(`document.querySelector('.nav-btn[data-view="lab"]').click();return 1;`); await sleep(300);
  fs.copyFileSync('C:/Users/liao9/WorkBuddy/我的工作1/moj-scroll-screen.json', 'C:/Users/liao9/AppData/Local/Temp/qa105_moj.json');
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
  await page.send('DOM.setFileInputFiles', { files: ['C:/Users/liao9/AppData/Local/Temp/qa105_moj.json'], nodeId });
  await sleep(1000);
  await js(`document.getElementById('btn-fit').click();return 1;`); await sleep(500);

  const st = await js(`
    const board=document.getElementById('board');const r=board.getBoundingClientRect();
    const vg=board.querySelector('g.viewport');const t=vg.getAttribute('transform')||'';
    const m=/translate\\(([-\\d.]+)[ ,]([-=\\d.]+)\\)\\s*scale\\(([-\\d.]+)\\)/.exec(t);
    const els=[...board.querySelectorAll('.element')].map(g=>{const mm=/translate\\(([-\\d.]+)[ ,]([-=\\d.]+)\\)/.exec(g.getAttribute('transform')||'');
      return {id:g.getAttribute('data-el'),x:mm?+mm[1]:0,y:mm?+mm[2]:0};});
    const b=els.find(e=>e.id==='scroll_btn');
    return {rect:{left:r.left,top:r.top,w:r.width,h:r.height},view:t,k:m?+m[3]:null,tx:m?+m[1]:null,ty:m?+m[2]:null,
      btn:b,btnScreen:b?{x:r.left+(m?+m[1]:0)+b.x*(m?+m[3]:1),y:r.top+(m?+m[2]:0)+b.y*(m?+m[3]:1)}:null,
      viewportHidden:!!document.querySelector('#canvas-wrap.viewport-hidden'),
      labVisible:getComputedStyle(document.getElementById('board')).display};`);
  out.push(JSON.stringify(st, null, 1));

  // elementFromPoint 探测按钮中心
  const probe = await js(`const p=${JSON.stringify(st.btnScreen)};const el=document.elementFromPoint(p.x,p.y);return el?el.tagName+'.'+el.getAttribute('class'):'null';`);
  out.push('elementFromPoint@btn: ' + probe);

  // 点击按钮 → 查状态面板
  await mouse('mouseMoved', st.btnScreen.x, st.btnScreen.y, { buttons: 0 });
  await mouse('mousePressed', st.btnScreen.x, st.btnScreen.y, { buttons: 1 });
  await sleep(30);
  await mouse('mouseReleased', st.btnScreen.x, st.btnScreen.y, { buttons: 0 });
  await sleep(500);
  const btnState = await js(`const row=[...document.querySelectorAll('#inspector-status .status-row')].find(r=>(r.querySelector('.sr-id')||{}).textContent==='#scroll_btn');return row?(row.querySelector('.sr-state')||{}).textContent:'no-row';`);
  out.push('scroll_btn state after click: ' + btnState);
  const litProbe = await js(`return {
    litYellow: document.querySelectorAll('#board .element-lamp rect[fill="#ffd23f"]').length,
    lampEls: document.querySelectorAll('#board .element-lamp').length,
    anyRect: !!document.querySelector('#board .element-lamp rect'),
    firstLampHTML: (document.querySelector('#board .element-lamp')||{outerHTML:''}).outerHTML.slice(0,400)};`);
  out.push('lamp probe: ' + JSON.stringify(litProbe, null, 1));

  // 框选探针：起点 elementFromPoint
  const st2 = await js(`
    const board=document.getElementById('board');const r=board.getBoundingClientRect();
    const vg=board.querySelector('g.viewport');const t=vg.getAttribute('transform')||'';
    const m=/translate\\(([-\\d.]+)[ ,]([-=\\d.]+)\\)\\s*scale\\(([-\\d.]+)\\)/.exec(t);
    const k=m?+m[3]:1,tx=m?+m[1]:0,ty=m?+m[2]:0;
    return {start:{x:r.left+tx+60*k,y:r.top+ty+60*k},end:{x:r.left+tx+640*k,y:r.top+ty+430*k},
      atStart:(function(){const el=document.elementFromPoint(r.left+tx+60*k,r.top+ty+60*k);return el?el.tagName+'.'+el.getAttribute('class'):'null';})()};`);
  out.push('marquee probe: ' + JSON.stringify(st2));

  await fetch(`${DEBUG}/json/close/${tab.id}`).catch(()=>{});
  fs.writeFileSync('C:/Users/liao9/WorkBuddy/我的工作1/qa_probe_out.txt', out.join('\n\n'));
  console.log('PROBE_DONE');
}
main().catch((e) => { fs.appendFileSync('C:/Users/liao9/WorkBuddy/我的工作1/qa_probe_out.txt', 'ERROR: ' + (e.stack || e)); console.log('PROBE_ERR'); process.exit(1); });
