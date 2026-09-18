#!/usr/bin/env node
/** 诊断：逐秒核对滚动/周期成立性，输出 5-70s 每秒的 hash、滚动 OK、周期 OK */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(PROJECT_ROOT, '..');
const JSON_PATH = path.join(WORKSPACE, 'moj-scroll-screen.json');

const ROWS = 5, COLS = 32, DT = 1 / 60;
const main = async () => {
  const { createEngine } = await import('file:///' + path.join(PROJECT_ROOT, 'js', 'engine.js').replace(/\\/g, '/'));
  const engine = createEngine();
  engine.deserialize(fs.readFileSync(JSON_PATH, 'utf8'));
  engine.triggerButton('scroll_btn');
  const samples = [];
  for (let s = 1; s <= 80; s++) {
    for (let i = 0; i < 60; i++) engine.tick(DT);
    const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
    for (const v of engine.getElementViews()) {
      if (v.type !== 'lamp') continue;
      const m = /^lamp_r(\d+)c(\d+)$/.exec(v.id);
      if (m) grid[+m[1]][+m[2]] = !!v.state.lit;
    }
    samples.push(grid);
  }
  const hash = (g) => g.map((row) => row.map((v) => (v ? 1 : 0)).join('')).join('|');
  const eq = (a, b) => hash(a) === hash(b);
  const scrollOk = (t) => {
    for (let r = 0; r < ROWS; r++) for (let c = 1; c < COLS; c++)
      if (samples[t][r][c] !== samples[t - 1][r][c - 1]) return false;
    return true;
  };
  const lines = ['s | lit | scroll | period18 | hash16'];
  for (let t = 0; t < 80; t++) {
    const litCnt = samples[t].flat().filter(Boolean).length;
    const sc = t >= 1 ? scrollOk(t) : '-';
    const pd = t >= 18 ? eq(samples[t], samples[t - 18]) : '-';
    lines.push(`${t + 1}\t${litCnt}\t${sc}\t${pd}\t${hash(samples[t]).slice(0, 34)}`);
  }
  fs.writeFileSync(path.join(WORKSPACE, 'qa_moj_diag.txt'), lines.join('\n'));
  console.log('DIAG_DONE');
};
main().catch((e) => { console.error(e); process.exit(1); });
