import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const image = process.argv[2] || 'xingtu-price-monitor-app:latest';
function files(directory) { return readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(resolve(directory, item.name)) : [resolve(directory, item.name)]); }
// 与本机已构建代码逐文件对账；不启动服务器、不挂载业务卷、不读取凭证。
const inputs = [...files(resolve(root, 'server/dist')), ...files(resolve(root, 'client/dist')), ...['scripts/database.mjs', 'scripts/setup-env.mjs', 'scripts/backup-sqlite.mjs', 'server/prisma/schema.prisma'].map(file => resolve(root, file))];
const expected = inputs.map(file => { const bytes = readFileSync(file); return { file: `/app/${relative(root, file).replaceAll('\\', '/')}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; });
const entrypoint = readFileSync(resolve(root, 'scripts/docker-entrypoint.sh'));
expected.push({ file: '/usr/local/bin/xingtu-entrypoint', bytes: entrypoint.length, sha256: createHash('sha256').update(entrypoint).digest('hex') });
const program = `const fs=require('node:fs'),crypto=require('node:crypto');const paths=${JSON.stringify(expected.map(item => item.file))};const files=paths.map(file=>{const b=fs.readFileSync(file);return{file,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')}});const {Prisma}=require('/app/server/node_modules/@prisma/client');console.log(JSON.stringify({files,models:Prisma.dmmf.datamodel.models.map(m=>m.name)}));`;
const actual = JSON.parse(execFileSync('docker', ['run', '--rm', '--label', 'xingtu.qa=root-image-integrity', '--entrypoint', 'node', image, '-e', program], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }));
assert.deepEqual(actual.files, expected, '镜像应用文件字节数与SHA256必须和本机完整构建一致');
for (const name of ['AlertRuleState', 'CollectionRunItem', 'CollectionRecord', 'CollectionRun']) assert.ok(actual.models.includes(name), `Linux Prisma客户端缺少模型 ${name}`);
const imageId = execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
const result = { status: 'passed', generatedAt: new Date().toISOString(), image, imageId, matchedFiles: expected.length, totalBytes: expected.reduce((sum, file) => sum + file.bytes, 0), linuxPrismaModels: actual.models, files: expected };
mkdirSync(resolve(root, 'outputs/docker-fixes-2026-10-04'), { recursive: true });
writeFileSync(resolve(root, 'outputs/docker-fixes-2026-10-04/image-integrity.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: result.status, imageId, matchedFiles: result.matchedFiles, totalBytes: result.totalBytes, linuxPrismaModels: result.linuxPrismaModels }));
