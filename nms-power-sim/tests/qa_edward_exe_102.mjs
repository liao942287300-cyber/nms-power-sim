#!/usr/bin/env node
/**
 * tests/qa_edward_exe_102.mjs — QA Edward 独立便携版验证（1.0.2）v2
 * 流程：复制 exe 到中文+空格目录 → 启动（CDP）→ 存活/数据目录断言 →
 *   CDP 写入实例库 → 优雅退出（taskkill 无 /F）→ leveldb 落盘核对 →
 *   重启复读（持久化实证）→ %APPDATA% 无新增写入 → 清理。
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SRC_EXE = 'C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim-desktop/dist/无人深空电力模拟器-1.0.2-portable.exe';
const TMP_DIR = 'C:/Users/liao9/AppData/Local/Temp/QA 便携验证 102';
const EXE = path.join(TMP_DIR, '无人深空电力模拟器-1.0.2-portable.exe');
const DATA_DIR = path.join(TMP_DIR, 'NmsPowerSimData');
const LS_DIR = path.join(DATA_DIR, 'Local Storage');
const APPDATA_DIR = path.join(process.env.APPDATA || '', 'nms-power-sim-desktop');
const CDP_PORT = 9333;

const R = { pass: 0, fail: 0, failures: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name); }
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
function gracefulKill(pid) {
  try { execSync(`taskkill /pid ${pid}`, { stdio: 'ignore' }); } catch (_) {}
}

let child = null;
async function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  child = spawn(EXE, ['--disable-gpu', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`], { env, stdio: 'ignore' });
  let exited = false, exitCode = null;
  child.on('exit', (c) => { exited = true; exitCode = c; });
  // 等 CDP 页面可用
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
  const r = await page.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function main() {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  ok('V0 源 exe 存在', existsSync(SRC_EXE), SRC_EXE);
  copyFileSync(SRC_EXE, EXE);
  ok('V0b 复制到中文+空格目录成功', existsSync(EXE), TMP_DIR);

  const appdataBefore = dirSnapshot(APPDATA_DIR);
  console.log(`  · 测试前 %APPDATA%\\nms-power-sim-desktop 存在=${appdataBefore.length > 0} 文件数=${appdataBefore.length}`);

  // 第一次启动
  const s1 = await launch();
  await sleep(4000);
  ok('V1 进程存活 ≥8s（启动 4s + CDP 就绪等待，非闪退）', s1.isAlive(), s1.isAlive() ? 'alive' : `exit=${s1.exitCode()}`);
  ok('V2 exe 同目录生成 NmsPowerSimData/', existsSync(DATA_DIR));
  ok('V3 CDP 连接渲染进程成功', !!s1.page);

  if (s1.page) {
    const entry = JSON.stringify([{ name: 'QAexe写入', savedAt: new Date().toISOString(), count: 1, data: { elements: [], wires: [], simTime: 0, timeOfDay: 8, dayCycle: false, wireStyle: 'straight' } }]);
    const before = lsSnapshot();
    const w1 = await evalIn(s1.page, `localStorage.setItem('nmsPowerSimLibrary.v1', ${JSON.stringify(entry)}); return (localStorage.getItem('nmsPowerSimLibrary.v1') || '').includes('QAexe写入');`);
    ok('V4 渲染进程写入实例库成功', w1 === true);
    await sleep(1000);
    gracefulKill(child.pid);
    // 等优雅退出（最多 6s）；超时则强制结束（leveldb 已先行刷盘，V8 另行核对）
    let dead = false;
    for (let i = 0; i < 6; i++) { if (child.exitCode !== null) { dead = true; break; } await sleep(1000); }
    if (!dead) { try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {} for (let i = 0; i < 10; i++) { if (child.exitCode !== null) { dead = true; break; } await sleep(1000); } }
    ok('V5 进程已结束（优雅或强制）', dead, `exit=${child.exitCode}`);
    const after = lsSnapshot();
    const updated = after.some((a) => { const b = before.find((x) => x.f === a.f); return !b || a.m > b.m; });
    ok('V8 退出后 NmsPowerSimData\\Local Storage\\leveldb 落盘更新', existsSync(LS_DIR) && updated,
      `before=${before.length} after=${after.length} 更新=${updated} files=${after.map((x) => x.f).join('|').slice(0, 140)}`);

    // 第二次启动：复读持久化数据
    const s2 = await launch();
    await sleep(2500);
    if (s2.page) {
      let back = null, err = null;
      for (let i = 0; i < 5 && back === null; i++) {
        try { back = await evalIn(s2.page, `return localStorage.getItem('nmsPowerSimLibrary.v1');`); } catch (e) { err = e.message; await sleep(1000); }
      }
      ok('V6 重启后实例数据仍可读（持久化实证）', typeof back === 'string' && back.includes('QAexe写入'), `value=${String(back).slice(0, 90)} ${err ? 'err=' + err : ''}`);
    } else {
      ok('V6 重启后渲染进程可连接', false, 'CDP 连接失败');
    }
    gracefulKill(child.pid);
    await sleep(2500);
    try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
  }

  const appdataAfter = dirSnapshot(APPDATA_DIR);
  const beforeSet = new Map(appdataBefore.map((x) => [x.f, x.m]));
  const newWrites = appdataAfter.filter((a) => { const b = beforeSet.get(a.f); return b === undefined || a.m > b; });
  ok('V9 %APPDATA%\\nms-power-sim-desktop 本次运行无新增写入（数据重定向到 NmsPowerSimData）', newWrites.length === 0,
    `新增/更新=${newWrites.length} ${newWrites.slice(0, 3).map((x) => x.f).join('|')}`);

  const pass = R.fail === 0;
  console.log(pass ? 'QA_EXE_PASS' : 'QA_EXE_FAILED');
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
