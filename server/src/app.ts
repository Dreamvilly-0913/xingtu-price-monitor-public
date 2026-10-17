import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import staticFiles from '@fastify/static';
import { Prisma } from '@prisma/client';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import { z, ZodError } from 'zod';
import { prisma } from './db.js';
import { config } from './config.js';
import { ApiError } from './utils.js';
import { CollectionScheduler } from './scheduler.js';
import { registerPrivateRoutes } from './routes.js';
import { bootstrapSchema, dummyPasswordHash, LoginLimiter, publicUser, tokenPayload, verifyBootstrapToken, writeAudit } from './auth-service.js';
import { beginCollectionShutdown, resumeCollectionQueues } from './collection-service.js';
import { initializeAlertStates } from './alerts.js';

export async function createApp(options: { startScheduler?: boolean; serveStatic?: boolean; pluginTimeout?: number } = {}) {
  resumeCollectionQueues();
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', trustProxy: config.trustProxy, bodyLimit: 256 * 1024, pluginTimeout: options.pluginTimeout ?? 10_000 });
  let closing = false;
  await app.register(cors, { origin: config.corsOrigin });
  await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: '8h' } });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '请求参数校验失败', details: error.flatten() } });
    if (error instanceof ApiError) {
      if (error.statusCode === 429) reply.header('Retry-After', '900');
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') return reply.code(409).send({ error: { code: 'DUPLICATE_RECORD', message: '该名称或标识已存在' } });
      if (error.code === 'P2025') return reply.code(404).send({ error: { code: 'RECORD_NOT_FOUND', message: '记录不存在' } });
      if (error.code === 'P2003') return reply.code(400).send({ error: { code: 'INVALID_RELATION', message: '关联记录不存在或已被删除' } });
    }
    const candidateStatus = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
    const statusCode = typeof candidateStatus === 'number' && candidateStatus < 500 ? candidateStatus : 500;
    app.log.error(error);
    return reply.code(statusCode).send({ error: { code: statusCode === 401 ? 'UNAUTHORIZED' : statusCode < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', message: statusCode === 401 ? '请先登录或重新登录' : statusCode < 500 ? '请求内容或参数不合法' : '服务器内部错误' } });
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    // 停机期间的在途请求仍完整返回；响应完成后关闭连接，避免72秒keep-alive拖延退出。
    if (closing) reply.header('Connection', 'close');
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'strict-origin-when-cross-origin').header('X-Frame-Options', 'DENY');
    if (process.env.NODE_ENV === 'production') reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    if (_request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/api/health', async () => { await prisma.$queryRaw`SELECT 1`; return { status: 'ok', service: 'xingtu-price-monitor' }; });
  app.get('/api/auth/status', async () => ({ bootstrapRequired: (await prisma.user.count()) === 0, bootstrapTokenRequired: process.env.NODE_ENV === 'production', demoEnabled: config.demoEnabled }));
  const loginLimiter = new LoginLimiter();
  let bootstrapping = false;
  app.post('/api/auth/bootstrap', async (request, reply) => {
    const body = bootstrapSchema.parse(request.body);
    loginLimiter.check(request.ip, 'bootstrap');
    verifyBootstrapToken(body.bootstrapToken);
    if (bootstrapping) throw new ApiError(409, 'BOOTSTRAP_RUNNING', '管理员初始化正在进行');
    bootstrapping = true;
    try {
      if (await prisma.user.count()) throw new ApiError(409, 'ALREADY_INITIALIZED', '已有管理员，不能重复初始化');
      const user = await prisma.user.create({ data: { username: body.username, displayName: body.displayName, passwordHash: await bcrypt.hash(body.password, 10), mustChangePassword: false } });
      await writeAudit(user, 'admin.bootstrap', 'user', user.id);
      return reply.code(201).send({ token: app.jwt.sign(tokenPayload(user)), user: publicUser(user) });
    } finally { bootstrapping = false; }
  });
  app.post('/api/auth/login', async (request) => {
    const body = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(100) }).parse(request.body);
    loginLimiter.check(request.ip, body.username);
    const user = await prisma.user.findUnique({ where: { username: body.username } });
    const validPassword = await bcrypt.compare(body.password, user?.passwordHash ?? dummyPasswordHash);
    if (!user || !validPassword) throw new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
    loginLimiter.success(request.ip, body.username);
    const current = body.password === 'admin123' && !user.mustChangePassword ? await prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: true } }) : user;
    await writeAudit(current, 'auth.login', 'user', current.id);
    return { token: app.jwt.sign(tokenPayload(current)), user: publicUser(current) };
  });
  const scheduler = new CollectionScheduler();
  await app.register(async (privateApp) => {
    privateApp.addHook('onRequest', async (request) => {
      await request.jwtVerify();
      const payload = request.user as { sub?: string; ver?: number };
      const user = payload.sub ? await prisma.user.findUnique({ where: { id: payload.sub } }) : null;
      if (!user || payload.ver !== user.tokenVersion) throw new ApiError(401, 'SESSION_REVOKED', '登录状态已失效，请重新登录');
      const path = request.url.split('?')[0];
      if (!config.demoEnabled && user.mustChangePassword && !['/api/auth/me', '/api/auth/change-password', '/api/settings'].includes(path ?? '')) throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', '请先在系统设置中修改默认密码');
    });
    privateApp.addHook('onResponse', async (request, reply) => {
      if (request.method === 'GET' || reply.statusCode >= 400) return;
      const payload = request.user as { sub: string; username: string };
      const params = request.params as { id?: string };
      const path = request.url.split('?')[0] ?? '';
      await writeAudit({ id: payload.sub, username: payload.username }, `${request.method} ${path}`, path.split('/')[2] ?? 'system', params?.id, { status: reply.statusCode }).catch(error => app.log.error({ err: error }, '操作审计写入失败'));
    });
    await registerPrivateRoutes(privateApp, scheduler);
  });
  // 旧库先依据成功流水恢复当前规则状态，再启用采集调度，不补造提醒。
  if (options.startScheduler) { await initializeAlertStates(); await scheduler.start(); }
  // preClose 受 Avvio 插件超时限制（默认10秒），这里只停止派发，不能等待最长30秒的在途请求。
  app.addHook('preClose', () => { closing = true; beginCollectionShutdown(); void scheduler.stop().catch(error => app.log.error({ err: error }, '采集停止失败')); });
  // onClose 在 HTTP 请求收尾后执行且没有插件加载超时；复用同一个停止任务等待实际落库。
  app.addHook('onClose', async () => { await scheduler.stop(); });
  if (options.serveStatic) {
    const directory = fileURLToPath(new URL('.', import.meta.url));
    const serverRoot = directory.replace(/[\\/]dist[\\/]src[\\/]?$/, '').replace(/[\\/]src[\\/]?$/, '');
    const clientDist = resolve(serverRoot, '../client/dist');
    if (existsSync(resolve(clientDist, 'index.html'))) {
      await app.register(staticFiles, { root: clientDist, prefix: '/', wildcard: false });
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api/') || request.url.startsWith('/assets/') || request.method !== 'GET') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '地址不存在' } });
        return reply.sendFile('index.html');
      });
    }
  }
  return app;
}
