#!/usr/bin/env node
/**
 * tests/qa_edward_exe_108.mjs — QA Edward 独立便携版验证（1.0.8）
 * ---------------------------------------------------------------------------
 * 基于 qa_edward_exe_107.mjs + qa107_asar_final.mjs（asar 内容解析法，避免
 * win-unpacked 并发误报）适配：
 *   A. asar 内容解析：renderer 7 文件与源码字节一致（隐含 wiresHidden/
 *      updateCulling 等 1.0.8 标记）+ main.js APP_VERSION '1.0.8' +
 *      package.json version 1.0.8 + 显式源码标记检查。
 *   B. 中文+空格目录启动：进程存活 / NmsPowerSimData 生成 / CDP 连通。
 *   C. 导入 376/620 大 JSON 耗时 < 3s。
 *   D. 开关在 exe 内可用：点击 #btn-wires-hidden → aria/svg 类/导线层隐藏。
 *   E. 开关状态持久化链路：存为实例（真实 UI 命名模态）→ 优雅退出 →
 *      leveldb 落盘更新 → 重启 → localStorage 数据含 wiresHidden:true →
 *      实例库「载入」→ 数据恢复 + 开关 UI 同步检查（对照 bug：load 路径
 *      已知不同步 UI，此处按数据层持久化断言 + UI 实况记录）。
 *   F. %APPDATA%\nms-power-sim-desktop 零写入。
 * ---------------------------------------------------------------------------
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';

const SRC_EXE = 'C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim-desktop/dist/无人深空电力模拟器-1.0.8-portable.exe';
const MOJ_JSON = 'C:/Users/liao9/WorkBuddy/我的工作1/moj-scroll-screen.json';
const TMP_DIR = 'C:/Users/liao9/AppData/Local/Temp/QA 便携验证 108';
const EXE = path.join(TMP_DIR, '无人深空电力模拟器-1.0.8-portable.exe');
const DATA_DIR = path.join(TMP_DIR, 'NmsPowerSimData');
const LS_DIR = path.join(DATA_DIR, 'Local Storage');
const APPDATA_DIR = path.join(process.env.APPDATA || '', 'nms-power-sim-desktop');
const RD = 'C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim-desktop';
const SRC = 'C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim';
const ASAR = `${RD}/dist/win-unpacked/resources/app.asar`;
const CDP_PORT = 9335;

const R = { pass: 0, fail: 0, failures: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
      else for (const h of this.handlers) h(m); }; }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
}
async function connect(url) { const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new CDP(ws); }
function lsSnapshot() {
  if (!existsSync(LS_DIR)) return [];
  return readdirSync(LS_DIR, { recursive: true }).map((f) => {
    const p = path.join(LS_DIR, String(f));
    try { return { f: String(f), m: statSync(p).mtimeMs }; } catch { return null; }
  }).filter(Boolean);
}
function dirSnapshot(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { recursive: true }).map((f) => {
      const p = path.join(dir, String(f));
      try { return { f: String(f), m: statSync(p).mtimeMs }; } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
function gracefulKill(pid) { try { execSync(`taskkill /pid ${pid}`, { stdio: 'ignore' }); } catch (_) {} }
const sha = (b) => createHash('sha256').update(b).digest('hex');

/* ---- asar 解析 ---- */
const buf = readFileSync(ASAR);
const headerSize = buf.readUInt32LE(4);
const jsonSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.slice(16, 16 + jsonSize).toString('utf8'));
const dataStart = 8 + headerSize;
function resolveEntry(root, segs) {
  let node = root;
  for (const s of segs) { if (!node.files || !node.files[s]) return null; node = node.files[s]; }
  return node;
}
function asarFile(rel) {
  const e = resolveEntry(header, rel.split('/'));
  if (!e || e.offset === undefined) return null;
  const off = dataStart + Number(e.offset);
  return buf.slice(off, off + e.size);
}

let child = null;
async function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  child = spawn(EXE, ['--disable-gpu', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`], { env, stdio: 'ignore' });
  let exited = false, exitCode = null;
  child.on('exit', (c) => { exited = true; exitCode = c; });
  for (let i = 0; i < 20; i++) {
    if (exited) break;
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const pg = list.find((t) => t.type === 'page');
      if (pg) return { page: await connect(pg.webSocketDebuggerUrl), isAlive: () => !exited && child.exitCode === null, exitCode: () => exitCode };
    } catch (_) {}
    await sleep(1000);
  }
  return { page: null, isAlive: () => !exited && child.exitCode === null, exitCode: () => exitCode };
}
async function evalIn(page, expr) {
  const r = await page.send('Runtime.evaluate', { expression: `(async function(){${expr}})()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function main() {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  ok('V0 源 exe 存在（1.0.8）', existsSync(SRC_EXE), SRC_EXE);
  const st = statSync(SRC_EXE);
  ok('V0c 源 exe 体积合理（>80MB）', st.size > 80 * 1024 * 1024, String(st.size));
  ok('V0d 源 exe 为 24h 内新构建', (Date.now() - st.mtimeMs) < 24 * 3600 * 1000, st.mtime.toISOString());
  copyFileSync(SRC_EXE, EXE);
  ok('V0b 复制到中文+空格目录成功', existsSync(EXE), TMP_DIR);

  /* ---- A. asar 内容解析 ---- */
  try {
    let asarOk = true;
    const files = ['js/engine.js', 'js/board.js', 'js/app.js', 'js/catalog.js', 'js/presets.js', 'css/styles.css', 'index.html'];
    for (const rel of files) {
      const inAsar = asarFile('renderer/' + rel);
      const srcPath = `${SRC}/${rel}`;
      if (!inAsar || !existsSync(srcPath) || sha(inAsar) !== sha(readFileSync(srcPath))) { asarOk = false; ok(`A1 asar renderer/${rel} = 源码`, false, '缺失或哈希不一致'); }
    }
    if (asarOk) ok(`A1 asar renderer 全部 7 文件与源码字节一致`, true, files.join(','));
    const eng = asarFile('renderer/js/engine.js').toString('utf8');
    const brd = asarFile('renderer/js/board.js').toString('utf8');
    const appJs = asarFile('renderer/js/app.js').toString('utf8');
    ok('A2 asar engine.js 含 1.0.8 标记（wiresHidden 序列化）',
      eng.includes('getWiresHidden') && eng.includes('setWiresHidden') && eng.includes('wiresHidden === true'));
    ok('A3 asar board.js 含 1.0.8 标记（setWiresHidden / CULL_MIN_NODES / DECOR_HIDE_K / is-far-zoom）',
      brd.includes('setWiresHidden') && brd.includes('CULL_MIN_NODES') && brd.includes('DECOR_HIDE_K') && brd.includes('is-far-zoom'));
    /* Round 2：asar 内 app.js 须含修复后 loadInstanceEntry 的 setWiresHidden 同步 */
    const libSeg = appJs.slice(appJs.indexOf('function loadInstanceEntry'));
    ok('A2b asar app.js loadInstanceEntry 含 setWiresHidden 同步（修复已打包）',
      libSeg.includes('board.setWiresHidden(engine.getWiresHidden())') && libSeg.includes('syncWiresHiddenUI()'),
      libSeg.includes('board.setWiresHidden') ? 'ok' : '未找到同步调用');
    const mainJs = asarFile('main.js');
    ok('A4 asar main.js 含 APP_VERSION 1.0.8', !!mainJs && mainJs.toString('utf8').includes("APP_VERSION = '1.0.8'"));
    let ver = null;
    try { ver = JSON.parse(asarFile('package.json').toString('utf8')).version; } catch (_) {}
    ok('A5 asar package.json version = 1.0.8', ver === '1.0.8', `ver=${ver}`);
  } catch (e) {
    ok('A asar 内容解析', false, e.message);
  }

  const appdataBefore = dirSnapshot(APPDATA_DIR);

  /* ---- B. 启动 ---- */
  const s1 = await launch();
  await sleep(4000);
  ok('V1 进程存活 ≥8s（非闪退）', s1.isAlive(), s1.isAlive() ? 'alive' : `exit=${s1.exitCode()}`);
  ok('V2 exe 同目录生成 NmsPowerSimData/', existsSync(DATA_DIR));
  ok('V3 CDP 连接渲染进程成功', !!s1.page);

  if (s1.page) {
    /* ---- C. 导入大 JSON ---- */
    let importOk = null, importMs = -1;
    try {
      const qaJson = 'C:/Users/liao9/AppData/Local/Temp/qa108_moj_exe.json';
      copyFileSync(MOJ_JSON, qaJson);
      await evalIn(s1.page, `document.querySelector('.nav-btn[data-view="lab"]').click();return 1;`);
      await sleep(300);
      await s1.page.send('DOM.enable');
      const doc = await s1.page.send('DOM.getDocument');
      const { nodeId } = await s1.page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
      const t0 = Date.now();
      await s1.page.send('DOM.setFileInputFiles', { files: [qaJson], nodeId });
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        const n = await evalIn(s1.page, `return document.querySelectorAll('#board .element').length;`);
        if (n === 376) { importMs = Date.now() - t0; importOk = true; break; }
      }
      if (importOk === null) importOk = false;
      const wires = await evalIn(s1.page, `return document.querySelectorAll('#board path.wire').length;`);
      ok('V10 导入大 JSON（376/620）成功', importOk === true && wires === 620, `wires=${wires}`);
      ok('V10a 导入渲染耗时 < 3s（不卡）', importMs >= 0 && importMs < 3000, `${importMs}ms`);
    } catch (e) {
      ok('V10 导入大 JSON（376/620）成功', false, e.message);
      ok('V10a 导入渲染耗时 < 3s（不卡）', false, e.message);
    }

    /* ---- D. 开关在 exe 内可用 ---- */
    let toggle = null;
    try {
      toggle = await evalIn(s1.page, `
        const btn = document.getElementById('btn-wires-hidden');
        const svg = document.getElementById('board');
        btn.click();
        await new Promise((r) => setTimeout(r, 300));
        return {
          aria: btn.getAttribute('aria-pressed'),
          cls: svg.classList.contains('wires-hidden'),
          wires: getComputedStyle(svg.querySelector('.layer-wires')).display,
        };
      `);
    } catch (e) { toggle = { err: e.message }; }
    ok('V11 exe 内点击隐藏线条开关：aria-pressed=true', toggle.aria === 'true', JSON.stringify(toggle));
    ok('V11a svg 根 .wires-hidden 类', toggle.cls === true);
    ok('V11b 导线层 display:none', toggle.wires === 'none');

    /* ---- E. 持久化链路：存为实例（真实 UI） → 退出 → 重启 → 数据在 → 载入 ---- */
    let saved = false;
    try {
      saved = await evalIn(s1.page, `
        document.getElementById('btn-save-instance').click();
        await new Promise((r) => setTimeout(r, 300));
        const inp = document.getElementById('name-input');
        inp.value = 'QA108隐藏实例';
        document.getElementById('name-modal-ok').click();
        await new Promise((r) => setTimeout(r, 500));
        const raw = localStorage.getItem('nmsPowerSimLibrary.v1') || '';
        return raw.includes('QA108隐藏实例') && raw.includes('"wiresHidden":true');
      `);
    } catch (e) { saved = false; ok('E1 存为实例', false, e.message); }
    ok('E1 存为实例成功且数据含 wiresHidden:true', saved === true);

    const before = lsSnapshot();
    await sleep(1000);
    gracefulKill(child.pid);
    let dead = false;
    for (let i = 0; i < 6; i++) { if (child.exitCode !== null) { dead = true; break; } await sleep(1000); }
    if (!dead) { try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {} for (let i = 0; i < 10; i++) { if (child.exitCode !== null) { dead = true; break; } await sleep(1000); } }
    ok('V5 进程已结束（优雅或强制）', dead, `exit=${child.exitCode}`);
    const after = lsSnapshot();
    const updated = after.some((a) => { const b = before.find((x) => x.f === a.f); return !b || a.m > b.m; });
    ok('V8 退出后 NmsPowerSimData\\Local Storage\\leveldb 落盘更新', existsSync(LS_DIR) && updated,
      `before=${before.length} after=${after.length} 更新=${updated}`);

    const s2 = await launch();
    await sleep(2500);
    if (s2.page) {
      let back = null;
      for (let i = 0; i < 5 && back === null; i++) {
        try { back = await evalIn(s2.page, `return localStorage.getItem('nmsPowerSimLibrary.v1');`); } catch (_) { await sleep(1000); }
      }
      ok('V6 重启后实例数据仍可读且含 wiresHidden:true（持久化实证）',
        typeof back === 'string' && back.includes('QA108隐藏实例') && back.includes('"wiresHidden":true'),
        `value=${String(back).slice(0, 90)}`);
      /* 载入实例：数据恢复 + 开关 UI 实况记录 */
      let loadState = null;
      try {
        loadState = await evalIn(s2.page, `
          document.querySelector('.nav-btn[data-view="lab"]').click();
          await new Promise((r) => setTimeout(r, 300));
          document.getElementById('btn-library').click();
          await new Promise((r) => setTimeout(r, 400));
          const item = document.querySelector('.lib-item[data-name="QA108隐藏实例"]');
          if (!item) return { itemFound: false };
          const loadBtn = [...item.querySelectorAll('button')].find((b) => b.textContent === '载入');
          loadBtn.click();
          await new Promise((r) => setTimeout(r, 800));
          const btn = document.getElementById('btn-wires-hidden');
          const svg = document.getElementById('board');
          return {
            itemFound: true,
            nEls: svg.querySelectorAll('.element').length,
            aria: btn.getAttribute('aria-pressed'),
            cls: svg.classList.contains('wires-hidden'),
            wires: getComputedStyle(svg.querySelector('.layer-wires')).display,
          };
        `);
      } catch (e) { loadState = { err: e.message }; }
      ok('E2 重启后载入实例：电路恢复（元件已画）', loadState && loadState.itemFound && loadState.nEls >= 2, JSON.stringify(loadState).slice(0, 120));
      /* 修复后（Round 2）：载入实例应同步线条隐藏 UI（aria=true / 类 / 导线层隐藏） */
      ok('E3 载入实例后开关 UI 同步（aria-pressed=true）', loadState && loadState.aria === 'true', `aria=${loadState && loadState.aria}`);
      ok('E3a 载入实例后 svg 根含 .wires-hidden 类', loadState && loadState.cls === true);
      ok('E3b 载入实例后导线层 display:none', loadState && loadState.wires === 'none', `display=${loadState && loadState.wires}`);
    } else {
      ok('V6 重启后渲染进程可连接', false, 'CDP 连接失败');
    }
    gracefulKill(child.pid);
    await sleep(2500);
    try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
  }

  /* ---- F. %APPDATA% 零写入 ---- */
  const appdataAfter = dirSnapshot(APPDATA_DIR);
  const beforeSet = new Map(appdataBefore.map((x) => [x.f, x.m]));
  const newWrites = appdataAfter.filter((a) => { const b = beforeSet.get(a.f); return b === undefined || a.m > b; });
  ok('V9 %APPDATA%\\nms-power-sim-desktop 本次运行无新增写入', newWrites.length === 0,
    `新增/更新=${newWrites.length} ${newWrites.slice(0, 3).map((x) => x.f).join('|')}`);

  const pass = R.fail === 0;
  console.log(pass ? 'QA_EXE_108_PASS' : 'QA_EXE_108_FAILED');
  try { rmSync(TMP_DIR, { recursive: true, force: true }); console.log('已清理测试目录:', TMP_DIR); } catch (e) { console.log('清理失败:', e.message); }
  process.exit(pass ? 0 : 1);
}

main().catch(async (e) => {
  console.error('EXE_VERIFY_ERROR:', e.message);
  if (child) { try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {} }
  await sleep(1200);
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
