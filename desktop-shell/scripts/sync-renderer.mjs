import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

/*
 * ===========================================================================
 * scripts/sync-renderer.mjs
 * ---------------------------------------------------------------------------
 * 把源静态站点 ../nms-power-sim 同步到本工程的 renderer/ 目录。
 *   - 同步前彻底清空 renderer/（避免残留脏文件被打进 exe）；
 *   - 排除 tests/（测试不得进入发布产物）；
 *   - assets/ 完整带上（实例页要显示原图）；
 *   - 对每个 .js 做 ESM 语法检查（复制成 .mjs 后用 node --check）。
 * ===========================================================================
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(projectRoot, '..', 'nms-power-sim');
const targetRoot = path.resolve(projectRoot, 'renderer');

// 需要同步的根级文件与目录（相对 sourceRoot）
const ROOT_FILES = ['index.html'];
const ROOT_DIRS = ['css', 'js', 'assets'];
// 明确排除的路径（相对 sourceRoot）——测试绝不能进 exe
const EXCLUDE = ['tests'];
const EXCLUDE_FILES = ['start.bat', 'start.sh', 'README.md', 'package.json', 'package-lock.json'];

async function cleanDir(dir) {
  if (!existsSync(dir)) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await cleanDir(p);
    } else {
      await fs.rm(p, { force: true });
    }
  }
  await fs.rmdir(dir);
}

async function copyFile(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  const data = await fs.readFile(src);
  await fs.writeFile(dst, data);
  return data.length;
}

async function copyDir(rel) {
  const srcDir = path.join(sourceRoot, rel);
  const dstDir = path.join(targetRoot, rel);
  if (!existsSync(srcDir)) return { files: 0, bytes: 0 };

  let files = 0;
  let bytes = 0;
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const childRel = path.join(rel, entry.name);
    if (EXCLUDE.some((ex) => childRel === ex || childRel.startsWith(ex + path.sep))) continue;
    if (entry.isDirectory()) {
      const sub = await copyDir(childRel);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      bytes += await copyFile(path.join(sourceRoot, childRel), path.join(targetRoot, childRel));
      files += 1;
    }
  }
  return { files, bytes };
}

/** 用 node --check 做 ESM 语法检查（复制成 .mjs，避免 CommonJS 误判）。 */
async function syntaxCheck(jsFiles) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nms-synccheck-'));
  try {
    for (const f of jsFiles) {
      const tmp = path.join(tmpDir, path.basename(f, '.js') + '.mjs');
      await fs.copyFile(f, tmp);
      await new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ['--check', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`语法检查失败：${f}\n${err}`));
        });
      });
    }
  } finally {
    await cleanDir(tmpDir);
  }
}

async function sync() {
  if (!existsSync(sourceRoot)) {
    throw new Error(`渲染层源目录不存在：${sourceRoot}`);
  }

  // 1. 彻底清空目标目录，避免旧文件残留
  await cleanDir(targetRoot);
  await fs.mkdir(targetRoot, { recursive: true });

  let fileCount = 0;
  let totalBytes = 0;

  // 2. 复制根级文件
  for (const rel of ROOT_FILES) {
    const src = path.join(sourceRoot, rel);
    if (!existsSync(src)) throw new Error(`源文件缺失：${src}`);
    totalBytes += await copyFile(src, path.join(targetRoot, rel));
    fileCount += 1;
  }

  // 3. 递归复制目录（自动排除 EXCLUDE）
  for (const dir of ROOT_DIRS) {
    const stat = await copyDir(dir);
    fileCount += stat.files;
    totalBytes += stat.bytes;
  }

  // 4. 语法检查所有 .js（ESM）
  const jsFiles = [];
  const collectJs = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await collectJs(p);
      else if (entry.name.endsWith('.js')) jsFiles.push(p);
    }
  };
  await collectJs(path.join(targetRoot, 'js'));
  await syntaxCheck(jsFiles);

  // 5. 安全检查：assert 没有 tests/ 混入
  const leaked = existsSync(path.join(targetRoot, 'tests'));
  if (leaked) throw new Error('同步异常：renderer/ 中出现 tests/，已中止');

  const assetCount = (await fs.readdir(path.join(targetRoot, 'assets'))).length;
  console.log(`渲染层同步完成：${fileCount} 个文件，${totalBytes} 字节`);
  console.log(`  - js 文件：${jsFiles.length} 个`);
  console.log(`  - assets 文件：${assetCount} 个`);
  console.log(`  - tests 已排除：${!leaked}`);
}

sync().catch(err => {
  console.error(err.message);
  process.exit(1);
});
