import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]dist[\\/]scripts$/, '').replace(/[\\/]scripts$/, '');
const projectRoot = resolve(serverRoot, '..');
const outputDir = resolve(projectRoot, 'outputs');
const workDir = resolve(projectRoot, 'work', 'operations-regression');
await mkdir(workDir, { recursive: true });
await mkdir(outputDir, { recursive: true });
const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const historicalReports = ['stage1-verification.json', 'stage2-verification.json'];
const before = Object.fromEntries(await Promise.all(historicalReports.map(async file => [file, await hash(resolve(outputDir, file))])));
const childOutput: Record<string, unknown> = {};
try {
  for (const stage of ['stage1', 'stage2']) {
    const reportPath = resolve(outputDir, `${stage}-current-verification.json`);
    const stdout = execFileSync(process.execPath, [resolve(serverRoot, 'node_modules/tsx/dist/cli.mjs'), resolve(serverRoot, `scripts/verify-${stage}.ts`)], { cwd: serverRoot, env: { ...process.env, VERIFICATION_OUTPUT_PATH: reportPath }, stdio: 'pipe', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    await writeFile(resolve(workDir, `${stage}.log`), stdout);
    const result = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
    assert.equal(result.passed, true, `${stage} 回归通过`);
    childOutput[stage] = result;
  }
  const after = Object.fromEntries(await Promise.all(historicalReports.map(async file => [file, await hash(resolve(outputDir, file))])));
  assert.deepEqual(after, before, '旧验收证据完整保留');
  const payload = { status: 'passed', generatedAt: new Date().toISOString(), isolatedDatabases: 2, originalReportsUnchanged: true, originalReportSha256: after, stages: childOutput };
  await writeFile(resolve(outputDir, 'operations-regression.json'), `${JSON.stringify(payload, null, 2)}\n`);
  const stage1 = childOutput.stage1 as { products: number; collections: number; replayedPoints: number; maximumMovementPercent: number; alerts: number };
  const stage2 = childOutput.stage2 as { apiRequests: number; assertionCount: number; collectorCases: unknown[]; scheduler: unknown };
  console.log(JSON.stringify({ status: payload.status, isolatedDatabases: 2, originalReportsUnchanged: true, stage1: { products: stage1.products, collections: stage1.collections, replayedPoints: stage1.replayedPoints, maximumMovementPercent: stage1.maximumMovementPercent, alerts: stage1.alerts }, stage2: { apiRequests: stage2.apiRequests, assertions: stage2.assertionCount, collectorCases: stage2.collectorCases.length, scheduler: stage2.scheduler } }, null, 2));
} catch (error) {
  const candidate = error as Error & { stdout?: Buffer; stderr?: Buffer };
  const details = { status: 'failed', generatedAt: new Date().toISOString(), stages: childOutput, error: candidate.stack, stdout: candidate.stdout?.toString(), stderr: candidate.stderr?.toString() };
  await writeFile(resolve(outputDir, 'operations-regression.json'), `${JSON.stringify(details, null, 2)}\n`);
  console.error(candidate.stderr?.toString() ?? candidate.message);
  process.exitCode = 1;
}
