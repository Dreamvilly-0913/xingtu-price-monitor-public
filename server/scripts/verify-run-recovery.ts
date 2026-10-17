import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Prisma } from '@prisma/client';

const scriptFile = fileURLToPath(import.meta.url);
const serverRoot = dirname(scriptFile).replace(/[\\/]dist[\\/]scripts$/, '').replace(/[\\/]scripts$/, '');
const root = resolve(serverRoot, '..');
const childMode = process.argv.includes('--crash-child');
let database = process.env.DATABASE_URL?.replace(/^file:/, '') ?? '';
if (!childMode) {
  const work = resolve(root, 'work/run-recovery');
  await mkdir(work, { recursive: true });
  database = resolve(work, `recovery-${Date.now()}.db`);
  await writeFile(database, '');
  process.env.DATABASE_URL = `file:${database.replaceAll('\\', '/')}`;
  process.env.NODE_ENV = 'test';
  process.env.DEMO_ENABLED = 'true';
  execFileSync(process.execPath, [resolve(serverRoot, 'node_modules/prisma/build/index.js'), 'db', 'push', '--schema', resolve(serverRoot, 'prisma/schema.prisma'), '--skip-generate'], { cwd: serverRoot, env: process.env, stdio: 'pipe' });
}

const { prisma } = await import('../src/db.js');
const { CollectionScheduler } = await import('../src/scheduler.js');
const { collectProduct, beginCollectionShutdown, resumeCollectionQueues, waitForCollectionQueues } = await import('../src/collection-service.js');
const { finishRunItemOutsideCollection, finalizeCollectionRun, recoverInterruptedRuns } = await import('../src/run-progress.js');
const { createApp } = await import('../src/app.js');

if (childMode) {
  const childScheduler = new CollectionScheduler({ concurrency: 1, hostDelayMs: 0 });
  await childScheduler.run('hard-kill-verification');
  await childScheduler.stop();
  await prisma.$disconnect();
  process.exit(0);
}

let assertions = 0, child: ChildProcess | undefined;
let startedScheduler: InstanceType<typeof CollectionScheduler> | undefined;
const results: Record<string, unknown> = {};
const check = (condition: unknown, message: string) => { assert.ok(condition, message); assertions++; };
const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); assertions++; };
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function within<T>(promise: Promise<T>, description: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${description} 超过 15 秒`)), 15000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

const crashRequest = gate(), shutdownRequest = gate(), releaseShutdown = gate(), queueRequest = gate(), releaseQueue = gate(), backgroundRequest = gate(), releaseBackground = gate();
const httpHits: string[] = [];
const fixture = createServer((request, response) => {
  const path = request.url ?? '';
  httpHits.push(path);
  if (path === '/crash-slow') { crashRequest.release(); return; }
  const write = () => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ price: path === '/fast-failure' ? 0 : 80 })); };
  if (path === '/shutdown-slow') { shutdownRequest.release(); void releaseShutdown.promise.then(write); }
  else if (path === '/background-shutdown') { backgroundRequest.release(); void releaseBackground.promise.then(write); }
  else if (path === '/queue-slow') { queueRequest.release(); void releaseQueue.promise.then(write); }
  else write();
});
await new Promise<void>(done => fixture.listen(0, '127.0.0.1', done));
const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
process.env.HTTP_ALLOWED_HOSTS = new URL(baseUrl).host;

async function product(id: string, sourceType = 'demo', path = '/fast-success', enabled = false) {
  return prisma.product.create({ data: { id, name: `轮次隔离夹具 ${id}`, platform: 'jd', sku: `fixture-${id}`, category: '隔离验证', basePriceCents: 10000, targetPriceCents: 5000, sourceType, enabled, url: `${baseUrl}${path}`, collectorConfig: sourceType === 'demo' ? '{}' : JSON.stringify({ mode: 'json', priceUrl: `${baseUrl}${path}`, jsonPath: 'price', timeoutMs: 30000 }) } });
}
async function runFor(productId: string) {
  const run = await prisma.collectionRun.create({ data: { trigger: 'isolated-atomic-fixture', total: 1, items: { create: { productId } } }, include: { items: true } });
  return { run, context: { runId: run.id, runItemId: run.items[0]!.id } };
}

try {
  await prisma.setting.create({ data: { id: 'global', lastScheduledAt: new Date() } });

  const atomic = await product('atomic-success');
  const { run: atomicRun, context: atomicContext } = await runFor(atomic.id);
  const result = await collectProduct(atomic.id, 'isolated-atomic-fixture', undefined, false, atomicContext);
  const saved = await prisma.collectionRecord.findUniqueOrThrow({ where: { id: result.collection.id } });
  const item = await prisma.collectionRunItem.findUniqueOrThrow({ where: { id: atomicContext.runItemId } });
  const committed = await prisma.collectionRun.findUniqueOrThrow({ where: { id: atomicRun.id } });
  equal(saved.runId, atomicRun.id, '采集流水保存轮次归属');
  equal(item.collectionRecordId, saved.id, '任务与实际采集流水关联');
  equal(item.status, 'success', '流水提交时任务已经完成');
  equal(committed.successCount, 1, '流水提交时轮次成功计数已经保存');
  equal(committed.failureCount, 0, '成功流水不计失败');
  check(item.startedAt && item.finishedAt, '任务实际开始与完成时间保存');
  equal(await finishRunItemOutsideCollection(atomicContext, 'failure', '提交后的 DTO 失败'), false, '已提交任务不会被后续错误改成失败');
  await assert.rejects(() => collectProduct(atomic.id, 'duplicate-context', undefined, false, atomicContext), /不能重复执行/); assertions++;
  equal(await prisma.collectionRecord.count({ where: { productId: atomic.id } }), 1, '重复任务不重复生成价格');
  await finalizeCollectionRun(atomicRun.id);
  results.atomicCommit = { savedRecords: 1, successCount: committed.successCount, duplicateRecords: 0, savedPriceCents: saved.priceCents };

  const rollbackProduct = await product('atomic-rollback');
  const rollback = await runFor(rollbackProduct.id);
  // 故障注入发生在真实采集事务的计数更新处；验证已创建的流水也随事务一起回滚。
  const originalTransaction = prisma.$transaction.bind(prisma);
  type TransactionMethod = (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => Promise<unknown>;
  const transactionTarget = prisma as unknown as { $transaction: TransactionMethod };
  transactionTarget.$transaction = callback => originalTransaction(tx => callback(new Proxy(tx, { get(target, property) {
    if (property !== 'collectionRun') return Reflect.get(target, property);
    return new Proxy(target.collectionRun, { get(delegate, method) {
      if (method === 'update') return () => { throw new Error('隔离故障：轮次计数写入失败'); };
      return Reflect.get(delegate, method);
    } });
  } })));
  try { await assert.rejects(() => collectProduct(rollbackProduct.id, 'isolated-rollback-fixture', undefined, false, rollback.context), /轮次计数写入失败/); assertions++; }
  finally { transactionTarget.$transaction = originalTransaction as TransactionMethod; }
  equal(await prisma.collectionRecord.count({ where: { productId: rollbackProduct.id } }), 0, '计数提交失败时价格流水回滚');
  equal((await prisma.collectionRunItem.findUniqueOrThrow({ where: { id: rollback.context.runItemId } })).status, 'running', '任务完成状态同事务回滚');
  equal((await prisma.collectionRun.findUniqueOrThrow({ where: { id: rollback.run.id } })).successCount, 0, '失败事务没有增加成功计数');
  await recoverInterruptedRuns();
  equal((await prisma.collectionRun.findUniqueOrThrow({ where: { id: rollback.run.id } })).interruptedCount, 1, '未提交价格的中断任务可恢复');
  results.atomicRollback = { savedRecords: 0, successCount: 0, interruptedCount: 1 };

  await prisma.product.updateMany({ data: { enabled: false } });
  const dtoProduct = await product('dto-after-commit', 'demo', '/fast-success', true);
  transactionTarget.$transaction = async callback => {
    const value = await originalTransaction(callback);
    if (value && typeof value === 'object' && 'record' in value) throw new Error('隔离故障：事务提交后的 DTO 组装失败');
    return value;
  };
  let dtoRound;
  try { dtoRound = await new CollectionScheduler({ hostDelayMs: 0 }).run('post-commit-dto-verification'); }
  finally { transactionTarget.$transaction = originalTransaction as TransactionMethod; }
  equal(dtoRound.successCount, 1, '提交后的返回值错误不改成功计数');
  equal(dtoRound.failureCount, 0, '提交后的返回值错误不误标失败');
  equal(dtoRound.status, 'completed', '已成功保存的轮次仍正确完成');
  equal(await prisma.collectionRecord.count({ where: { productId: dtoProduct.id } }), 1, 'DTO 错误不会重复或撤回已提交价格');
  results.postCommitError = dtoRound;

  await prisma.product.updateMany({ data: { enabled: false } });
  await product('spacing-1-delayed', 'http', '/fast-success', true);
  await product('spacing-2-fast', 'http', '/fast-success', true);
  const originalItemUpdate = prisma.collectionRunItem.updateMany.bind(prisma.collectionRunItem);
  type StartMethod = (args: Prisma.CollectionRunItemUpdateManyArgs) => Promise<Prisma.BatchPayload>;
  const itemDelegate = prisma.collectionRunItem as unknown as { updateMany: StartMethod };
  let delayedFirstStart = false;
  itemDelegate.updateMany = async (args) => {
    if (args?.data?.status === 'running' && !delayedFirstStart) { delayedFirstStart = true; await sleep(120); }
    return originalItemUpdate(args);
  };
  const spacedStarts: number[] = [];
  let spacedRound;
  try {
    spacedRound = await new CollectionScheduler({ concurrency: 2, hostDelayMs: 90, collect: async () => {
      spacedStarts.push(Date.now()); await sleep(5); return { collection: { status: 'success' } };
    } }).run('database-delay-spacing-verification');
  } finally { itemDelegate.updateMany = originalItemUpdate; }
  equal(spacedStarts.length, 2, '数据库启动延迟夹具实际执行两项任务');
  equal(spacedRound.successCount, 2, '前置数据库延迟不改变调度结果');
  const delayedStartGap = spacedStarts[1]! - spacedStarts[0]!;
  check(delayedStartGap >= 89, '首项前置DB等待120ms后，真实任务启动间隔仍至少89ms');
  equal(spacedRound.interruptedCount, 0, '站点冷却修复不误记中断');
  equal(await prisma.collectionRecord.count({ where: { runId: spacedRound.runId } }), 0, '派发stub夹具没有制造价格');
  results.hostSpacingUnderDatabaseDelay = { firstStartDatabaseDelayMs: 120, minimumConfiguredGapMs: 90, actualStartGapMs: delayedStartGap, ...spacedRound };

  await prisma.product.updateMany({ data: { enabled: false } });
  const crashFast = await product('crash-1-fast', 'http', '/fast-success', true);
  const crashSlow = await product('crash-2-slow', 'http', '/crash-slow', true);
  await product('crash-3-pending', 'http', '/fast-success', true);
  let childOutput = '';
  child = spawn(process.execPath, [resolve(serverRoot, 'node_modules/tsx/dist/cli.mjs'), scriptFile, '--crash-child'], { cwd: serverRoot, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', value => { childOutput += String(value); }); child.stderr?.on('data', value => { childOutput += String(value); });
  await within(crashRequest.promise, '强杀夹具第二个请求启动');
  const beforeKill = await prisma.collectionRun.findFirstOrThrow({ where: { trigger: 'hard-kill-verification' } });
  equal(beforeKill.successCount, 1, '强杀前首个价格及计数已提交');
  equal(beforeKill.status, 'running', '强杀发生在真实轮次运行中');
  const recordBeforeKill = await prisma.collectionRecord.findFirstOrThrow({ where: { productId: crashFast.id } });
  const childExit = once(child, 'exit');
  check(child.kill('SIGKILL'), '实际终止独立采集子进程');
  const exit = await within(childExit, '强杀子进程退出');
  equal(await prisma.collectionRecord.count({ where: { productId: crashSlow.id } }), 0, '未返回的真实请求没有生成价格');
  const restarted = new CollectionScheduler({ hostDelayMs: 0 });
  startedScheduler = restarted;
  await restarted.start();
  const recovered = await prisma.collectionRun.findUniqueOrThrow({ where: { id: beforeKill.id } });
  equal(recovered.status, 'interrupted', '启动把残留 running 明确结束为中断');
  equal(recovered.successCount, 1, '启动恢复保留已提交成功计数');
  equal(recovered.failureCount, 0, '未完成请求不伪造采集失败结果');
  equal(recovered.interruptedCount, 2, '正在请求与未派发任务均记录中断');
  check(recovered.finishedAt && recovered.error?.includes('启动恢复'), '恢复完成时间和说明保存');
  equal(await prisma.collectionRecord.findUnique({ where: { id: recordBeforeKill.id } }), recordBeforeKill, '恢复不修改已保存价格快照');
  equal(await prisma.collectionRunItem.count({ where: { runId: recovered.id, status: 'running' } }), 0, '恢复没有残留运行任务');
  equal(await recoverInterruptedRuns(), 0, '重复启动恢复幂等');
  await prisma.product.update({ where: { id: crashSlow.id }, data: { collectorConfig: JSON.stringify({ mode: 'json', priceUrl: `${baseUrl}/fast-failure`, jsonPath: 'price', timeoutMs: 1000 }) } });
  const afterRestart = await restarted.run('after-restart-verification');
  equal(afterRestart.total, 3, '恢复后下一轮完整派发');
  equal(afterRestart.successCount, 2, '恢复后新轮次正常保存成功价格');
  equal(afterRestart.failureCount, 1, '恢复后非正价格如实采集失败');
  equal(afterRestart.interruptedCount, 0, '恢复后新轮次不残留中断');
  equal(afterRestart.status, 'completed_with_errors', '恢复后失败不会终止整轮');
  await restarted.stop();
  startedScheduler = undefined;
  results.hardKillRecovery = { killedProcessExit: exit, childOutput, beforeKillSuccessCount: beforeKill.successCount, recovered: { status: recovered.status, successCount: recovered.successCount, failureCount: recovered.failureCount, interruptedCount: recovered.interruptedCount }, afterRestart };

  const legacy = await prisma.collectionRun.create({ data: { trigger: 'legacy-without-ledger', total: 12, successCount: 2, failureCount: 1 } });
  equal(await recoverInterruptedRuns(), 1, '识别老版本没有任务账本的残留轮次');
  const legacyRecovered = await prisma.collectionRun.findUniqueOrThrow({ where: { id: legacy.id } });
  equal(legacyRecovered.status, 'interrupted', '旧轮次不永久 running');
  equal(legacyRecovered.successCount, 2, '旧轮次保留已知成功计数');
  equal(legacyRecovered.failureCount, 1, '旧轮次保留已知失败计数');
  equal(legacyRecovered.interruptedCount, 0, '旧轮次不能猜测缺失任务数量');
  check(legacyRecovered.error?.includes('无法可靠还原'), '旧轮次明确说明恢复限制');
  results.legacyRecovery = { status: legacyRecovered.status, successCount: 2, failureCount: 1, unknownTaskCount: true };

  await prisma.product.updateMany({ data: { enabled: false } });
  await product('shutdown-1-slow', 'http', '/shutdown-slow', true);
  await product('shutdown-2-queued', 'http', '/fast-success', true);
  await product('shutdown-3-queued', 'http', '/fast-success', true);
  const user = await prisma.user.create({ data: { username: 'shutdown-fixture', displayName: '停机隔离验证', passwordHash: 'not-a-login-password' } });
  const app = await createApp({ startScheduler: true, pluginTimeout: 250 });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const token = app.jwt.sign({ sub: user.id, ver: user.tokenVersion, username: user.username });
    const response = fetch(`http://127.0.0.1:${port}/api/scheduler/run`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    await within(shutdownRequest.promise, '优雅关闭前慢请求启动');
    const hitsBeforeClose = httpHits.length;
    const stopStarted = performance.now();
    let closeCompleted = false;
    const close = app.close().then(() => { closeCompleted = true; });
    // 故意超过插件超时3倍，验证关闭等待不再占用preClose的加载预算。
    await sleep(750);
    check(!closeCompleted, '超过插件预算后仍等待在途请求，不提前退出');
    releaseShutdown.release();
    const body = await within(response.then(async response => ({ status: response.status, connection: response.headers.get('connection'), body: await response.json() as { successCount: number; interruptedCount: number; status: string } })), '在途整轮 HTTP 请求返回');
    await within(close, 'Fastify preClose 完成');
    equal(body.status, 200, '在途 HTTP handler 在优雅关闭时正常返回');
    equal(body.connection, 'close', '停机中的在途响应结束后关闭keep-alive连接');
    check(performance.now() - stopStarted < 5000, '关闭不等待默认72秒keep-alive');
    equal(body.body.successCount, 1, '优雅关闭保存已经开始的慢请求');
    equal(body.body.interruptedCount, 2, '同站点队列里未开始的两项记为中断');
    equal(body.body.status, 'interrupted', '主动停止的轮次显示中断');
    equal(httpHits.length, hitsBeforeClose, 'preClose 后同站点队列不再发出网络请求');
    check(performance.now() - stopStarted < 10000, '优雅关闭不会等待执行整轮剩余任务');
    results.gracefulPreClose = { ...body, elapsedMs: Math.round(performance.now() - stopStarted), additionalHttpRequests: httpHits.length - hitsBeforeClose };
  } finally { releaseShutdown.release(); await app.close(); }

  const backgroundProduct = await product('background-shutdown', 'http', '/background-shutdown');
  const backgroundApp = await createApp({ pluginTimeout: 250 });
  try {
    await backgroundApp.listen({ host: '127.0.0.1', port: 0 });
    const job = collectProduct(backgroundProduct.id, 'background-shutdown-fixture', undefined, false);
    await within(backgroundRequest.promise, '无HTTP请求的后台采集启动');
    let closed = false;
    const startedAt = performance.now();
    const close = backgroundApp.close().then(() => { closed = true; });
    await sleep(750);
    check(!closed, '没有HTTP handler时也等待后台采集落库，不受250ms插件预算影响');
    releaseBackground.release();
    const result = await within(job, '后台采集正常落库');
    await within(close, '后台采集后关闭完成');
    equal(result.collection.status, 'success', '后台在途采集正常成功');
    equal(await prisma.collectionRecord.count({ where: { productId: backgroundProduct.id } }), 1, '后台停止只保存1条实际价格');
    check(performance.now() - startedAt < 5000, '无HTTP后台关闭无需等待长连接超时');
    results.backgroundShutdown = { elapsedMs: Math.round(performance.now() - startedAt), pluginTimeoutMs: 250, gatedWaitMs: 750, savedRecords: 1 };
  } finally { releaseBackground.release(); await backgroundApp.close(); }

  resumeCollectionQueues();
  const queued = await product('manual-queue', 'http', '/queue-slow');
  const first = collectProduct(queued.id, 'manual-queue-verification', undefined, false);
  await within(queueRequest.promise, '手动队列首个请求启动');
  const second = collectProduct(queued.id, 'manual-queue-verification', undefined, false).then(value => ({ value, error: null }), error => ({ value: null, error }));
  beginCollectionShutdown();
  releaseQueue.release();
  await first;
  const canceled = await second;
  check(canceled.error instanceof Error && canceled.error.message.includes('尚未开始'), '尚未开始的手动商品队列明确取消');
  equal(httpHits.filter(path => path === '/queue-slow').length, 1, '停止后不执行排队中的第二次手动请求');
  equal(await prisma.collectionRecord.count({ where: { productId: queued.id } }), 1, '取消队列不伪造采集价格或失败流水');
  results.manualQueueCancellation = { startedRequests: 1, savedRecords: 1, canceledQueuedRequests: 1 };

  const payload = { status: 'passed', generatedAt: new Date().toISOString(), assertions, groups: Object.keys(results).length, isolation: '独立 SQLite、真实本地 HTTP 故障夹具和强杀子进程；不访问运营数据库、不代表市场报价', database, results };
  await mkdir(resolve(root, 'outputs'), { recursive: true });
  await writeFile(resolve(root, 'outputs/run-recovery.json'), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ status: payload.status, assertions, groups: payload.groups, results }, null, 2));
} catch (error) {
  await mkdir(resolve(root, 'outputs'), { recursive: true });
  await writeFile(resolve(root, 'outputs/run-recovery.json'), `${JSON.stringify({ status: 'failed', assertions, results, error: error instanceof Error ? error.stack : String(error) }, null, 2)}\n`);
  throw error;
} finally {
  child?.kill('SIGKILL');
  await startedScheduler?.stop();
  releaseShutdown.release(); releaseQueue.release();
  fixture.closeAllConnections();
  await new Promise<void>(done => fixture.close(() => done()));
  await waitForCollectionQueues();
  resumeCollectionQueues();
  await prisma.$disconnect();
}
