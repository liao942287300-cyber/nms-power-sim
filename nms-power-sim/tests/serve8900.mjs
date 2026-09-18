#!/usr/bin/env node
/**
 * tests/serve8900.mjs — 以 Node 子进程方式拉起 python http.server:8900。
 * 说明：本环境的自动化沙箱里，PowerShell Start-Process 直接拉起的服务
 * headless Edge 无法连通；而 Node spawn 的进程可以（perf_scroll.mjs 等既有
 * 脚本验证过）。runner_108.ps1 用本脚本拉起静态服务。
 */
import { spawn } from 'node:child_process';

// 注意：Start-Process 传参会把带空格的路径截断，故通过环境变量传递目录。
const parent = process.env.SERVE_PARENT || process.cwd();
const py = spawn('python', ['-m', 'http.server', '8900', '--bind', '127.0.0.1'], {
  cwd: parent, stdio: 'ignore',
});
py.on('error', () => process.exit(1));
py.on('exit', (code) => process.exit(code || 0));
// 保活，等待被外部终止
setInterval(() => {}, 1 << 30);
