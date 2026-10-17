# 星图价格监控 · 接续入口

项目根目录：克隆后的 `xingtu-price-monitor-public/`。原项目的交付和历史验证数字见 [运营优化报告](docs/运营优化报告.md)，接入真实价格前先读 [真实运营指南](docs/真实运营指南.md)。本公开副本不包含旧 Git 历史；文档和 `outputs/` 中的 `<project-root>` 为历史项目或验收工作目录的代称，验收记录未在本副本重新执行。

Docker 验收发现的预警冷却、停止窗口和中断轮次问题，修复设计与后续复验见 [Docker 问题修复报告](docs/Docker问题修复报告.md)；修复前数字保留在原验收报告。

这是「嘉兴星图优选」虚构企业演示项目，已按阶段0–4实现前后端、双轨采集、调度、预警、比价和部署配置。运营版本补充强密码空库初始化、演示开关、配置试采、地址安全、报价时效、同口径预警与在线备份。先读 [README.md](README.md) 与 [真实运营指南](docs/真实运营指南.md)；原阶段交付证据在 [最终报告](docs/stage4-report.md)。

## 启动

```powershell
git clone https://github.com/Dreamvilly-0913/xingtu-price-monitor-public.git
cd xingtu-price-monitor-public
pnpm install --frozen-lockfile
pnpm db:init
pnpm dev
```

开发页面4173，API4010。已有数据库继续运营时跳过 `pnpm db:init`，避免重建演示商品。演示账号 admin / admin123，上线改密。生产可执行 `pnpm build` 后 `pnpm start`，同端口4010提供前后端。

正式运营用新的数据库、`DEMO_ENABLED=false`、生产随机JWT和初始化凭证，只执行 `pnpm db:push` 建表后在登录页创建强密码管理员，不seed。改密使旧JWT失效。`pnpm db:backup`在线生成SQLite一致快照到 `work/backups`，不碰seed；备份恢复前读运营指南。

## 继续开发应保持的业务约束

1. 所有价格只能来自成功采集流水，商品不缓存另一份价格或统计。
2. Demo 使用统一游走函数和输入快照，所有层标注演示模拟；失败 HTTP 不填假价格。
3. 数值使用整数分；最新价、min/max/avg/回撤跨页面一致。
4. 调度失败隔离，同一商品串行，全局只部署一个后端实例。
5. 目标及24小时跌幅预警遵守未处理去重和24小时冷却；24小时基线需接近时间、同来源、同采集配置，不能混用旧报价或模拟价。
6. 自检命令与证据在 README、scripts、server/scripts、outputs。
7. 有效比价排除过期、停用与配置失配报价，保留旧价格及其成功采集时间供审计。
8. 正式接口接入先预览并人工核对条件，预览不产生流水；不能因HTTP失败生成替代演示价。

## 已知验证范围

京东外部探针连接失败，原始错误见阶段0；HTTP功能已用实际本地响应验证。PostgreSQL仍只完成schema校验。Docker初验3个P1问题已修复并更新正式8080：原生732项、Docker功能300项、清理6项、正式只读21项全部通过，最终v3镜像healthy，演示关闭且原空库状态保留。原499/496/3初验结果见 [历史报告](docs/Docker部署验收报告.md)，本次设计、两轮关闭实测、恢复和磁盘故障过程见 [修复报告](docs/Docker问题修复报告.md)。证据集中在 `outputs/docker-fixes-2026-10-04`。源码、文档、成品集中在本目录；work为临时日志，outputs为证据与源码包。开发暂存路径仅保留过程资料，后续以本正式目录为准。
