#!/usr/bin/env node
/**
 * tests/ab_tick_107.mjs — 1.0.7 tick CPU A/B 对照（排除环境噪声归因）
 * A = 1.0.6 engine（desktop/renderer 副本，sync-renderer 前的上一版）
 * B = 1.0.7 engine（当前源码）
 * 各跑 R 轮（默认 5 轮交替），输出每轮 tick CPU（ms/tick），判定两版均值差。
 */
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(PROJECT_ROOT, '..');
const JSON_PATH = path.join(WORKSPACE, 'moj-scroll-screen.json');
const ENGINE_A = path.join(WORKSPACE, 'nms-power-sim-desktop', 'renderer', 'js', 'engine.js'); // 1.0.6
const ENGINE_B = path.join(PROJECT_ROOT, 'js', 'engine.js');                                   // 1.0.7
const ROUNDS = Number(process.env.AB_ROUNDS) || 5;
const TICKS = 2000;

function pathToFileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
}

async function measure(enginePath, label) {
  const { createEngine } = await import(pathToFileUrl(enginePath));
  const engine = createEngine();
  const data = fs.readFileSync(JSON_PATH, 'utf8');
  if (engine.deserialize(data) !== true) throw new Error(label + ' deserialize failed');
  for (let i = 0; i < 500; i++) engine.tick(1 / 60); // JIT 预热
  const t0 = performance.now();
  for (let i = 0; i < TICKS; i++) engine.tick(1 / 60);
  const wall = performance.now() - t0;
  return wall / TICKS;
}

const rows = [];
const sum = { A: 0, B: 0 };
for (let r = 0; r < ROUNDS; r++) {
  const a = await measure(ENGINE_A, 'A(1.0.6)');
  const b = await measure(ENGINE_B, 'B(1.0.7)');
  rows.push(`round ${r + 1}: A(1.0.6)=${a.toFixed(4)}ms  B(1.0.7)=${b.toFixed(4)}ms  B/A=${(b / a).toFixed(3)}`);
  sum.A += a; sum.B += b;
}
const avgA = sum.A / ROUNDS, avgB = sum.B / ROUNDS;
console.log(rows.join('\n'));
console.log(`\nAVERAGE: A(1.0.6)=${avgA.toFixed(4)}ms  B(1.0.7)=${avgB.toFixed(4)}ms  B/A=${(avgB / avgA).toFixed(3)}`);
console.log(Math.abs(avgB - avgA) / avgA < 0.10 ? 'AB_TICK_NO_REGRESSION' : 'AB_TICK_DIFF_GT_10PCT');
