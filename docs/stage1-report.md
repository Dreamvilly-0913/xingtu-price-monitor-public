# 阶段 1 报告

已完成 pnpm client/server 单仓库、React/Vite/TypeScript/Ant Design/ECharts/React Router 脚手架、Fastify、6 个 Prisma 模型、JWT+bcrypt 管理员登录、确定性 DemoCollector、seed 与最小仪表盘接口。

## 验证数字

- 前后端 typecheck、build 退出码均为 0；0 个类型错误、0 个构建错误。
- 前端转换 623 个模块；阶段1初版 JS 666.16 kB，gzip 216.24 kB，构建 6分59秒，有资源体积提示。
- 12 个商品：京东/天猫/拼多多各 4 个，2 个商品组。
- 372 条成功演示流水：每件商品 30 个历史点 + 今天 1 个点。
- 全部 372 点逐点复算一致；最大单步变动 2.494350%；12/12 当前价等于最新成功流水。
- 3 条目标价预警：京东 iPhone、京东 AirPods、美的空调。
- 抽查京东 iPhone：30 历史点 min=5226.54、max=5999.75、历史最新=5425.54；今日=5558.62。
- 31 点接口统计与流水逐项一致：min=5226.54、max=5999.75、avg=5651.53、current=5558.62、pointCount=31、maxDrawdown=12.8874%。
- PostgreSQL provider 副本执行 Prisma validate 通过；本阶段没有连接真实 PostgreSQL 实例。

完整抽查点与断言结果见 `outputs/stage1-verification.json`。这是阶段1的实测快照，后续阶段手动采集或重新seed后，实时数字可能不同；最终状态见最终验收报告。

## 已排查问题与遗留

Windows Prisma 首次 SQLite 文件创建返回无详情 Schema engine error；诊断后发现旧项目已有相同环境处理方式。初始化脚本只在文件不存在时创建空文件，随后 Prisma 建表与生成成功，不截断既有数据库。

阶段1已识别 seed 重跑会重置全部商品与密码、历史点04:00而合同写中午的问题，阶段2修复事务保护、保留自建资料与已修改密码、统一上海12:00。前端阶段3进行资源分包。京东外部接口网络失败仍按阶段0报告保留。用户已授权连续推进，因此报告后进入阶段2。
