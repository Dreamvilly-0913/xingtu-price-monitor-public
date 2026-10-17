import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';

const app = await createApp({ startScheduler: true, serveStatic: true });
try { await app.listen({ port: config.port, host: config.host }); }
catch (error) { app.log.error(error); await prisma.$disconnect(); process.exit(1); }
// 多个停止信号共用收尾任务；明确记录关闭阶段，避免异步信号异常被静默丢失。
let shutdown: Promise<void> | undefined;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  shutdown ??= (async () => {
    app.log.info({ signal }, '开始停止服务');
    await app.close();
    app.log.info('HTTP请求和采集任务已收尾');
    await prisma.$disconnect();
    app.log.info('数据库连接已关闭');
    process.exit(0);
  })().catch(error => { app.log.error({ err: error }, '服务停止失败'); process.exit(1); });
});
