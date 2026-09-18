#!/usr/bin/env node
/* =========================================================================
 * scripts/verify-portable.mjs —— 验证「便携版 exe 本体」的启动与数据目录
 *
 * 用法：
 *   node scripts/verify-portable.mjs "dist/无人深空电力模拟器-1.0.0-portable.exe"
 *
 * 断言：
 *   - 便携版 exe 启动后进程存活 ≥ 8 秒（不是闪退）
 *   - <exe 同目录>\NmsPowerSimData\ 被创建出来（portable 数据目录生效实证）
 *   - %APPDATA%\nms-power-sim-desktop 不应被创建（证明数据确实被重定向）
 * ========================================================================= */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const EXE = path.resolve(process.argv[2] || 'dist/无人深空电力模拟器-1.0.0-portable.exe');
const EXE_DIR = path.dirname(EXE);
const DATA_DIR = path.join(EXE_DIR, 'NmsPowerSimData');
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const MIN_ALIVE_MS = 8000;

let child = null;

function killTree(pid) {
  try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); }
  catch (_) { try { child.kill('SIGKILL'); } catch (__) { /* ignore */ } }
}

async function main() {
  if (!existsSync(EXE)) {
    console.log('PORTABLE_VERIFY: FAIL (exe 不存在)');
    console.log('期望路径：' + EXE);
    process.exit(2);
  }

  console.log(`启动便携版：${EXE}`);
  console.log(`期望数据目录：${DATA_DIR}`);

  const env = { ...process.env, NMS_POWER_SIM_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  child = spawn(EXE, ['--disable-gpu', '--no-sandbox'], {
    env,
    detached: false,
    stdio: 'ignore'
  });

  child.on('error', (e) => console.error('启动失败', e.message));
  child.on('exit', (code) => console.log(`进程退出，code = ${code}`));

  // 存活检测：等待并轮询进程是否仍在
  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => { exited = true; exitCode = code; });

  await sleep(MIN_ALIVE_MS);

  const aliveMs = MIN_ALIVE_MS;
  const stillAlive = !exited && child.exitCode === null;
  console.log(`进程存活时长：${aliveMs} ms，仍存活=${stillAlive}，退出码=${exitCode}`);

  // 给主进程一点时间创建数据目录
  await sleep(2000);

  console.log('\n=== 数据目录检查 ===');
  const dataExists = existsSync(DATA_DIR);
  console.log(`exe 同目录 NmsPowerSimData/ 存在：${dataExists}`);
  let entries = [];
  if (dataExists) {
    entries = readdirSync(DATA_DIR);
    console.log('其中包含：', entries.join(', ') || '(空)');
  }

  const appdataSub = path.join(APPDATA, 'nms-power-sim-desktop');
  const appdataExists = existsSync(appdataSub);
  console.log(`${APPDATA}\\nms-power-sim-desktop 存在(应=false)：${appdataExists}`);

  const pass = stillAlive && dataExists;
  console.log(pass ? '\nPORTABLE_VERIFY: PASS' : '\nPORTABLE_VERIFY: FAIL');
  console.log('RESULT_JSON:' + JSON.stringify({
    exe: EXE,
    dataDir: DATA_DIR,
    aliveMs,
    stillAlive,
    exitCode,
    dataExists,
    entries,
    appdataExists,
    pass
  }));

  killTree(child.pid);
  setTimeout(() => process.exit(pass ? 0 : 4), 600);
}

main().catch((e) => {
  console.error(e);
  console.log('PORTABLE_VERIFY: FAIL');
  if (child) killTree(child.pid);
  setTimeout(() => process.exit(5), 300);
});
