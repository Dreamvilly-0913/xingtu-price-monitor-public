import { readdir, lstat, mkdir, copyFile, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 可指定本次交付名称，避免覆盖历史版本；只允许项目 outputs 内的 ZIP 文件名。
const archiveName = process.argv[2] ?? 'xingtu-price-monitor-source.zip';
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/.test(archiveName)) throw new Error('交付包名称必须为安全的 ZIP 文件名');
const output = resolve(root, 'outputs', archiveName);
const manifestName = archiveName === 'xingtu-price-monitor-source.zip'
  ? 'delivery-manifest.json' : `${archiveName.slice(0, -4)}-manifest.json`;
const stage = resolve(root, `work/package-${Date.now()}`);
if (!stage.startsWith(`${resolve(root, 'work')}\\`) && !stage.startsWith(`${resolve(root, 'work')}/`)) throw new Error('打包暂存目录越界');
await mkdir(stage, { recursive: true });
const files = [];
// 交付源码、构建成品与验收证据；排除本地密钥、数据库、依赖和临时文件。
const excludedDirectories = new Set(['node_modules', '.pnpm-store', '.git', '.agents', '.codex', '.aws', '.azure', '.ssh', 'work', '.cache']);
const privateFile = name =>
  (/^\.env/i.test(name) && !/\.example$/i.test(name))
  || /\.(?:db|sqlite|sqlite3)(?:-journal|-wal|-shm)?$/i.test(name)
  || /\.(?:zip|vhdx?|pem|key|pfx|p12|log)$/i.test(name)
  || /(?:^delivery-manifest|-manifest)\.json$/i.test(name);
async function copyTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const local = relative(root, path);
    if (entry.isSymbolicLink() || excludedDirectories.has(entry.name) || privateFile(entry.name)) continue;
    if (entry.isDirectory()) await copyTree(path);
    else if ((await lstat(path)).isFile()) {
      const target = resolve(stage, local);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(path, target);
      files.push(local.replaceAll('\\', '/'));
    }
  }
}
await copyTree(root);
if (process.platform !== 'win32') throw new Error('此交付打包脚本使用 Windows 自带 ZIP 库；其他系统可用 zip -r 并按 README 排除私人文件');
// 仅替换固定名称的本项目成品，不递归删除暂存目录。
await unlink(output).catch(error => { if (error.code !== 'ENOENT') throw error; });
const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem\n[System.IO.Compression.ZipFile]::CreateFromDirectory($env:XINGTU_ARCHIVE_STAGE, $env:XINGTU_ARCHIVE_TARGET, [System.IO.Compression.CompressionLevel]::Optimal, $false)`;
const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'inherit', env: { ...process.env, XINGTU_ARCHIVE_STAGE: stage, XINGTU_ARCHIVE_TARGET: output } });
if (result.status !== 0) throw new Error(`ZIP 创建失败，退出码 ${result.status}`);
const sha256 = createHash('sha256').update(await readFile(output)).digest('hex');
const manifest = { createdAt: new Date().toISOString(), projectPath: root, archive: `outputs/${archiveName}`, archiveBytes: (await stat(output)).size, sha256, fileCount: files.length, files: files.sort(), excluded: ['node_modules', '.env (except .example)', '*.db/sqlite/sqlite3 + sidecars', '.git/.agents/.codex', 'work/.cache', '*.zip/vhd/vhdx/pem/key/pfx/p12/log', '*-manifest.json'] };
await writeFile(resolve(root, 'outputs', manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ archive: output, bytes: manifest.archiveBytes, files: files.length, sha256 }));
