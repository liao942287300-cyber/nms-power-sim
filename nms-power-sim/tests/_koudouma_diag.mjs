#!/usr/bin/env node
/**
 * 诊断脚本（寇豆码）— 分析 moj-scroll-screen.json 结构 + 仿真复现镜像。
 * 输出全部写入文件（本机 PowerShell 不回显 stdout）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(PROJECT_ROOT, '..');
const OUT = path.join(WORKSPACE, 'koudouma_diag_out.txt');
const L = [];
function out(s) { L.push(String(s)); }

const JSON_PATH = process.argv[2] || path.join('C:', 'Users', 'liao9', 'Desktop', '无人深空素材', 'moj-scroll-screen.json');

const main = async () => {
  const { createEngine } = await import('file:///' + path.join(PROJECT_ROOT, 'js', 'engine.js').replace(/\\/g, '/'));
  const data = fs.readFileSync(JSON_PATH, 'utf8');
  const obj = JSON.parse(data);

  out('=== 顶层字段 ===');
  for (const k of Object.keys(obj)) {
    if (Array.isArray(obj[k])) out(`${k}: Array(${obj[k].length})`);
    else out(`${k}: ${JSON.stringify(obj[k])}`);
  }

  out('\n=== 元件统计 ===');
  const byType = {};
  for (const e of obj.elements) byType[e.type] = (byType[e.type] || 0) + 1;
  out(JSON.stringify(byType));

  out('\n=== 非 lamp/auto_switch 元件 ===');
  for (const e of obj.elements) {
    if (e.type !== 'lamp' && e.type !== 'auto_switch') {
      out(`${e.id} ${e.type} @(${e.x},${e.y}) props=${JSON.stringify(e.props)} state=${JSON.stringify(e.state)}`);
    }
  }

  out('\n=== auto_switch 清单（含坐标）===');
  for (const e of obj.elements) {
    if (e.type === 'auto_switch') {
      out(`${e.id} @(${e.x},${e.y}) props=${JSON.stringify(e.props)} state=${JSON.stringify(e.state)}`);
    }
  }

  out('\n=== 端口连接图（wire 端点对，按类型分组统计）===');
  const elById = new Map(obj.elements.map((e) => [e.id, e]));
  // 统计每类连线的 port 组合
  const combo = {};
  for (const w of obj.wires) {
    const ta = elById.get(w.a.el)?.type || '?';
    const tb = elById.get(w.b.el)?.type || '?';
    const key = `${ta}.${w.a.port} -- ${tb}.${w.b.port}`;
    combo[key] = (combo[key] || 0) + 1;
  }
  out(JSON.stringify(combo, null, 1));

  out('\n=== 扫描环 / 移位链探测：每个 auto_switch 的 ctrl 驱动源 ===');
  // 建立邻接：wire 把两个节点合并为同一电气节点；先做 union-find
  const parent = new Map();
  const find = (k) => { let r = k; while (parent.get(r) !== r) r = parent.get(r); return r; };
  const union = (x, y) => { const a = find(x), b = find(y); if (a !== b) parent.set(a, b); };
  for (const e of obj.elements) {
    const ports = { auto_switch: ['a', 'b', 'ctrl'], lamp: ['in'], power: ['out'], button: ['a', 'b'] }[e.type] || [];
    for (const p of ports) parent.set(`${e.id}:${p}`, `${e.id}:${p}`);
  }
  for (const w of obj.wires) {
    const ka = `${w.a.el}:${w.a.port}`, kb = `${w.b.el}:${w.b.port}`;
    if (!parent.has(ka)) parent.set(ka, ka);
    if (!parent.has(kb)) parent.set(kb, kb);
    union(ka, kb);
  }
  // 对每个 auto_switch：ctrl 根节点由哪些其它端点组成（排除自身 ctrl）
  const ctrlSources = {};
  for (const e of obj.elements) {
    if (e.type !== 'auto_switch') continue;
    const root = find(`${e.id}:ctrl`);
    if (!ctrlSources[root]) ctrlSources[root] = [];
    ctrlSources[root].push(e.id);
  }
  out('ctrl 节点分组（同一电气节点的 ctrl 端）：');
  let gi = 0;
  for (const [root, ids] of Object.entries(ctrlSources)) {
    // 找到该节点上连接的非 ctrl 端点
    const members = new Set();
    for (const [k] of parent) { if (find(k) === root) members.add(k); }
    out(`  group#${gi++} root=${root} ctrls=${ids.length} members=${[...members].join(',')}`);
  }

  out('\n=== a/b 供电网络探测（每个 auto_switch 的 a、b 各连到哪些节点）===');
  for (const e of obj.elements) {
    if (e.type !== 'auto_switch') continue;
    for (const p of ['a', 'b']) {
      const root = find(`${e.id}:${p}`);
      const members = [...parent.keys()].filter((k) => find(k) === root && k !== `${e.id}:${p}`);
      out(`  ${e.id}.${p} -> ${members.slice(0, 12).join(',')}${members.length > 12 ? ` (+${members.length - 12})` : ''}`);
    }
  }

  out('\n=== 仿真 100s，取稳态模板 ===');
  const engine = createEngine();
  const okImport = engine.deserialize(JSON.stringify(obj));
  out(`deserialize: ${okImport} / ${engine.getElements().length} el / ${engine.getWires().length} wires`);
  const ROWS = 5, COLS = 32, DT = 1 / 60;
  const lit = () => {
    const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
    for (const v of engine.getElementViews()) {
      const m = /^lamp_r(\d+)c(\d+)$/.exec(v.id);
      if (m && v.type === 'lamp') grid[+m[1]][+m[2]] = !!v.state.lit;
    }
    return grid;
  };
  const g0 = lit();
  out(`初始亮灯数: ${g0.flat().filter(Boolean).length}`);
  engine.triggerButton('scroll_btn');
  const samples = [];
  for (let s = 1; s <= 100; s++) {
    for (let i = 0; i < 60; i++) engine.tick(DT);
    samples.push(lit());
  }
  const firstLit = samples.findIndex((g) => g.flat().some(Boolean));
  out(`首次点亮: 第 ${firstLit + 1} 秒`);
  // 找稳态：pattern(s)==pattern(s+18)
  const eq = (a, b) => a.every((row, r) => row.every((v, c) => v === b[r][c]));
  let steady = -1;
  for (let t = firstLit; t + 21 < 100; t++) {
    if (eq(samples[t], samples[t + 18]) && eq(samples[t + 1], samples[t + 19])) { steady = t; break; }
  }
  out(`稳态起点: ${steady + 1}s`);
  if (steady >= 0) {
    const template = Array.from({ length: ROWS }, () => new Array(18).fill(false));
    for (let k = 0; k < 18; k++) for (let r = 0; r < ROWS; r++) template[r][k] = samples[steady + k][r][0];
    out('\n稳定循环模板（每秒进入最左列 c=0 的内容，■=亮）:');
    for (let r = 0; r < ROWS; r++) out('  r' + r + ' ' + template[r].map((v) => (v ? '\u25A0' : '\u00B7')).join(''));
    out('\n第 steady 秒整幅画面（5 行 × 32 列）:');
    for (let r = 0; r < ROWS; r++) out('  r' + r + ' ' + samples[steady][r].map((v) => (v ? '\u25A0' : '\u00B7')).join(''));
    // 滚动方向核对
    let scrollOk = true;
    for (let t = steady + 1; t < 100; t++)
      for (let r = 0; r < ROWS; r++)
        for (let c = 1; c < COLS; c++)
          if (samples[t][r][c] !== samples[t - 1][r][c - 1]) scrollOk = false;
    out(`滚动右移核对（稳态后）: ${scrollOk}`);
  }

  fs.writeFileSync(OUT, L.join('\n'), 'utf8');
};

main().then(() => process.exit(0)).catch((e) => { fs.writeFileSync(OUT, 'ERROR: ' + (e && e.stack ? e.stack : e), 'utf8'); process.exit(1); });
