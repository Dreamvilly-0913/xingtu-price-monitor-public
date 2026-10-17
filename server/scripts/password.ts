import bcrypt from 'bcrypt';
import { prisma } from '../src/db.js';
import { securePassword } from '../src/auth-service.js';

const argumentsList = process.argv.slice(2).filter((argument) => argument !== '--');
const getArgument = (key: string) => argumentsList[argumentsList.indexOf(key) + 1];
const username = argumentsList.includes('--username') ? getArgument('--username') : 'admin';
const password = process.env.ADMIN_PASSWORD ?? (argumentsList.includes('--password') ? getArgument('--password') : undefined);
try {
  if (!username || !password) throw new Error('用法：设置 ADMIN_PASSWORD 环境变量（至少12字符且最多72个UTF-8字节），然后 pnpm password -- --username admin');
  securePassword.parse(password);
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new Error(`管理员 ${username} 不存在，请先初始化数据库`);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 10), mustChangePassword: false, tokenVersion: { increment: 1 } } });
  console.log(`用户 ${username} 的密码已更新`);
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally { await prisma.$disconnect(); }
