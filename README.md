# 星图优选 · 电商价格监控

面向虚构演示企业「嘉兴星图优选」的完整电商运营工具，监控京东、天猫、拼多多的数码家电价格。支持登录、商品管理、进程内定时采集、价格曲线、同款比价、采集日志和两种降价预警。本项目是独立演示项目，未声称服务过真实客户。

公开展示仓库：[Dreamvilly-0913/xingtu-price-monitor-public](https://github.com/Dreamvilly-0913/xingtu-price-monitor-public)。本副本不包含原仓库的 Git 提交历史。文档与 `outputs/` 中的验收记录保留原项目的日期和结果，并非对本公开副本重新运行的测试；其中 `<project-root>` 代指当时对应的项目或验收工作目录，后缀为相对路径。

**种子数据全部标注「演示模拟」，不能作为真实市场报价。** HTTP 采集失败只记录失败原因，不生成价格，不自动切换为模拟数据。

运营版本入口：[真实运营指南](docs/真实运营指南.md)。正式部署使用空库、强密码初始化与 `DEMO_ENABLED=false`，采集配置先试采，过期或配置失配报价不参与有效比价；改密撤销旧JWT，操作留审计，SQLite可在线一致备份。**当前未成功实测接通任何平台线上报价**，真实运营需配置你有权使用的接口并在目标网络验收。

## 演示快速启动

环境：Node.js **22.12 或更新版本**、pnpm **11.19.0**。默认 SQLite，无需安装数据库。首次需要联网下载依赖。

Windows PowerShell，逐行执行：

```powershell
git clone https://github.com/Dreamvilly-0913/xingtu-price-monitor-public.git
cd xingtu-price-monitor-public
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm db:init
pnpm dev
```

Linux / macOS，逐行执行：

```sh
git clone https://github.com/Dreamvilly-0913/xingtu-price-monitor-public.git
cd xingtu-price-monitor-public
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm db:init
pnpm dev
```

- 开发页面：<http://localhost:4173>
- 后端健康检查：<http://127.0.0.1:4010/api/health>
- 演示管理员：**admin / admin123**。**上线必须修改密码。** 可在系统设置页面修改。
- Windows 也可在完成安装、初始化后双击 `start.cmd`。
- `pnpm db:init` 自动生成 `server/.env` 和随机 JWT 密钥，不覆盖已有环境配置。默认数据库为 `server/prisma/dev.db`。
- 端口严格检测；如 4173 已占用，可设置 `WEB_PORT`、相应 `CORS_ORIGIN`，后端端口变更时同时设置 `API_PROXY_URL`。前端默认代理至 4010。
- 只执行 `pnpm dev` 不会创建演示商品；空库会显示管理员初始化入口。演示首次使用 `pnpm db:init`；正式运营使用指南中的建表和强口令初始化流程。

## 功能

| 页面 | 可用功能 |
|---|---|
| 登录 | 空库初始化管理员、JWT 登录、改密撤销旧会话、登录限流；bcrypt 密码存储 |
| 仪表盘 | 商品数、今日采集及成功率、当前预警、今日降价 Top 5、勾选多商品曲线、平台分布 |
| 监控商品 | 完整增删改查、平台/分类/状态筛选、基准及目标价、配置试采、关闭监控、立即采集、连续失败和报价时效 |
| 商品详情 | 7/30/90 天 ECharts 曲线；当前/最低/最高/均价/最大跌幅；该商品采集及预警记录 |
| 同款比价 | 商品组管理、同组各平台当前及历史最低价、有效报价最低标记；过期/配置失配排除，同价并列 |
| 采集记录 | 商品/状态/来源筛选、分页、实际来源、成功价格、失败原因 |
| 预警中心 | 达到目标价与 24 小时跌幅预警、已读处理、状态筛选、24 小时冷却 |
| 系统设置 | 全局间隔、演示波动率、默认跌幅阈值、手动全轮、调度状态、数据源说明、改密及运营检查 |

## 技术栈与目录

React 18 + Vite + TypeScript + Ant Design 5 + ECharts + React Router；Node.js + Fastify + TypeScript；Prisma 6；SQLite / PostgreSQL；JWT + bcrypt；node-cron；pnpm 双目录单仓库。React 与 Ant Design 使用兼容版本，依赖由锁文件固定。

```text
client/                     前端页面、路由、接口层、真实数据图表
server/src/                 API、校验、采集服务、统计、调度、预警
server/src/collectors/      统一接口、DemoCollector、HttpCollector
server/prisma/             统一模型、seed、默认 SQLite 文件
server/scripts/            独立数据库接口自测、历史核对、改密
scripts/                   环境初始化、数据库 provider 选择、探针、浏览器及联调脚本
docs/                      分阶段报告、上报素材和接口说明
outputs/                   可对账 JSON/CSV、验收截图、交付压缩包
work/                      临时日志与隔离测试数据库（不进入交付包）
assets/                    输入素材目录（本项目未使用外部素材）
Dockerfile / compose.yaml   单进程部署、持久化 SQLite
```

## 数据源双轨设计

### 统一接口与价格来源

采集器输入监控商品的平台、链接、SKU、配置及采集上下文，输出价格、时间、状态、来源及失败原因。只有成功的采集结果能产生价格流水。商品表没有 `currentPrice` 或另一份统计缓存；各接口从成功流水计算同一套价格。失败流水的价格为 `null`。

```mermaid
flowchart LR
  A[启用商品 / 手动采集] --> B[统一采集服务]
  B --> C[DemoCollector]
  B --> D[HttpCollector]
  C --> E[采集流水：价格与来源 / 失败原因]
  D --> E
  E --> F[实时统计与历史曲线]
  E --> G[预警判断与冷却]
  F --> H[仪表盘 / 列表 / 详情 / 比价]
```

### DemoCollector：演示模拟

从基准价开始确定性伪随机游走。商品 ID + 上海业务日期生成 FNV-1a 种子，xorshift32 生成随机数；同日第几次采集用 `sequence` 区分。默认波动率 2.5%，配置范围 0–3%；单次变化不超过 ±3%，价格处于基准价 60%–130%。金额使用整数分并向区间内部取整。

每条记录保存算法版本、商品 ID、日期、基准价、前价、波动率、序号的输入快照，修改配置后仍能重放旧记录。数据库、接口、统计来源、曲线点、价格卡、预警统一展示「演示模拟」。若改动基准价使限幅区间与总价区间没有交集，采集如实失败，避免跨越限幅。

### HttpCollector：真实采集

使用 `fetch`，含常见浏览器 UA、端到端超时和 HTTP 状态检查。可以配置 JSON 价格接口或普通 HTML 网页；HTML 仅解析返回的静态页面，不执行网站 JavaScript，也不绕过登录或验证码。默认只请求公网80/443，DNS校验后固定连接地址，最多3次逐跳校验的跳转，解压后正文上限1 MB；内网网关须部署管理员通过 `HTTP_ALLOWED_HOSTS` 精确审核。

JSON 示例配置（在商品表单选择「真实采集 / JSON 接口」）：

```json
{"mode":"json","priceUrl":"https://your-price-api.example/product/123","jsonPath":"$.data.price","timeoutMs":10000}
```

网页示例配置：

```json
{"mode":"html","priceUrl":"https://your-shop.example/product/123","cssSelector":".product-price","timeoutMs":10000}
```

以上 URL 是配置结构说明，不能当作可用采集地址。JSON 路径支持对象和数组，如 `$.data.price`、`$[0].p`。网页未填价格 URL 时使用商品链接。

JSON字段必须是完整数值/金额，CSS必须匹配一个唯一元素。促销、库存、运费或多个售价不会默认提取第一个数字；复杂文案须缩小选择器或使用限定的安全 `priceRegex` 模板。表单「配置试采」和 `/api/collectors/preview` 使用正式采集器但 `persisted=false`，不生成价格流水或预警。真实采集保存脱敏请求元数据、响应结构摘要与哈希，便于追查失败。

京东真实源未填写价格接口 URL 时，默认尝试 `https://p.3.cn/prices/mgets?skuIds=J_<SKU>`，默认路径 `$[0].p`。超时、拦截、HTTP 错误、解析失败、0 或负价均写入失败日志；当前价保持最后一次成功采集值及其实际来源。切换采集配置不会改变旧价格的来源标签。

**本机京东探针未收到 HTTP 响应**：HTTPS 出现 EACCES / ECONNRESET，HTTP 回退出现连接关闭。已保存原始错误，未伪造返回结构或市场价格。部署网络可以执行 `pnpm probe:jd` 再测，详细见 [阶段 0 报告](docs/stage0-report.md)。

## 价格、统计、调度与预警口径

- 金额在数据库保存整数分，API 返回元数值，页面统一两位小数；非正价格视为失败。
- `currentPrice` 恒等于按采集时间、入库时间及记录 ID 排序的最新成功流水价格。最低、最高、均价、最大跌幅实时计算；均价按分四舍五入。
- 最大跌幅为时间顺序上的历史峰值至其后低点的最大回撤百分比；详情统计卡覆盖全部成功历史，曲线按 7/30/90 天筛选。30 天范围含今日及向前 30 个上海业务日期，初始 seed 因此为 31 点。
- 「较昨日」使用昨日上海业务日期内最后一次成功价；缺少昨日数据时展示空值。今日最大降幅按当前价与昨日最后成功价计算，只展示下降商品，最多 5 件。
- 比价展示同组最新成功价格，但有效最低只比较启用、报价未过期且与当前采集配置一致的商品；失败/未采集商品不伪造为0，并列最低全部标记。默认30分钟间隔下报价超过90分钟即陈旧，旧价保留成功采集时间与来源供对账。
- node-cron 每分钟检查持久化到期时间，默认每 30 分钟一轮；设置可改为 1–1440 分钟。只采集启用商品，每件失败单独捕获；全轮不重叠，同一商品采集串行。进程停止时不采集，重启保留调度锚点，手动全轮不移动定时计划。
- 每轮任务持久化状态，采集流水和完成计数在同一事务保存。停机不派发新任务，Compose 等待最多 45 秒；启动把遗留运行轮次恢复为“已中断”，未完成商品可手动或下一轮重试。同站点请求串行，并在上一项结束后等待冷却间隔。
- 预警规则为价格 ≤ 目标价、相对24小时前附近的同来源同采集配置成功点跌幅 ≥ 阈值（默认5%，单商品可覆盖）。参考时间误差为全局间隔、最多60分钟；缺少合格基线时不触发，72小时前旧价或模拟价不充当真实基线。预警保存基线记录、价格、时间和来源。
- 同商品同规则在未读且仍触发时不重复；无论是否已读，距上次触发24小时内均不新建同规则预警。价格恢复、过期或配置失配时解除当前状态；修改目标/阈值/启用状态会直接重评已有流水，不制造新价格。
- 当前规则状态独立于历史提醒：冷却期间再次达到目标仍显示“触发中”，但不新增提醒；标记已读不解除规则，历史触发价和解除时间保留。当前报价始终取最新成功流水。
- 业务日期统一 Asia/Shanghai；调度必须部署为**一个后端进程 / 一个实例**，避免多实例各自重复采集。

## 一键种子数据

```sh
pnpm db:init
```

首次建立 admin、2 个商品组、12 件商品，每件过去 30 天每天中午一个演示点，再加当前时刻一点，共 **372 条**。基准价取自用户给定的真实世界参考金额，不宣称是本日在线售价。目标价为基准价的 95%。

| 平台 | 商品 | 基准价 | 目标价 | 商品组 |
|---|---|---:|---:|---|
| 京东 | iPhone 16 128G | 5999.00 | 5699.05 | iPhone 16 128G |
| 京东 | AirPods Pro 2 | 1899.00 | 1804.05 | AirPods Pro 2 |
| 京东 | 小米 15 | 4499.00 | 4274.05 | — |
| 京东 | Switch OLED | 2599.00 | 2469.05 | — |
| 天猫 | iPhone 16 128G | 5999.00 | 5699.05 | iPhone 16 128G |
| 天猫 | 索尼 WH-1000XM5 | 2299.00 | 2184.05 | — |
| 天猫 | 戴森 V12 | 4290.00 | 4075.50 | — |
| 天猫 | 华为 MatePad 11.5 | 1899.00 | 1804.05 | — |
| 拼多多 | iPhone 16 128G | 5399.00 | 5129.05 | iPhone 16 128G |
| 拼多多 | AirPods Pro 2 | 1549.00 | 1471.55 | AirPods Pro 2 |
| 拼多多 | 海尔冰箱 BCD-216 | 1499.00 | 1424.05 | — |
| 拼多多 | 美的空调 1.5 匹 | 2299.00 | 2184.05 | — |

seed 搜索满足形态的商品 ID，再由同一 DemoCollector 生成整段历史，不直接修改价格。保证至少 2 件当前价达到目标且预警落库、至少 1 件最大回撤 >10%。不同运行日期会生成不同但可复算的数据；验收数字应以相应 JSON 快照时间为准。

京东种子链接为演示配置，天猫/拼多多为对应商品搜索入口；其 SKU 不是已核验的真实采集授权。切换真实采集前需填入实际监控商品和可访问的接口/选择器。

重跑 seed 会重新建立约定前缀的 12 件演示商品及其流水/预警，保留用户自建商品、已有密码、设置和采集轮次。生产环境默认拒绝重建演示数据，必须显式设 `ALLOW_DEMO_RESET=true`。不要用 seed 导入正式运营数据。

## 校验命令与证据

```sh
pnpm typecheck
pnpm build
pnpm verify:stage0
pnpm verify:stage1
pnpm verify:stage2
pnpm verify:docker-fixes
```

`verify:stage2` 自建隔离 SQLite 和本地 HTTP 测试服务，覆盖登录、CRUD、参数校验、采集、预警冷却、失败不中断调度和最低平台；测试夹具价格不代表电商价格。

运行开发服务后可做实际浏览器验收：

```sh
pnpm verify:browser
```

需要本机 Edge 或 Chrome。Windows 自动检测常见安装路径；其他系统可设置 `BROWSER_EXECUTABLE_PATH`。测试执行登录、图表、筛选、详情、手动采集、预警、比价、商品 CRUD、采集记录/设置和窄屏检查。它会新增一次采集并标记预警已读，临时新建的测试商品随后删除。

生产服务运行后，执行 `pnpm verify:system`，独立从全部流水重算统计、重放所有演示点、核对三处接口与曲线，并检查生产 SPA 和静态资源。生产浏览器只读检查脚本为 `scripts/verify-production-browser.mjs`。

阶段报告及原始证据见 [docs](docs/)、[outputs](outputs/)。第一轮浏览器失败证据保留，兼容性修复后的通过结果单独保存。最终汇总见 [整体交付报告](docs/stage4-report.md)。

## 本机生产模式

在项目根目录：

```powershell
pnpm typecheck
pnpm build
$env:NODE_ENV = 'production'
$env:DEMO_ENABLED = 'false'
pnpm start
```

Linux / macOS：

```sh
pnpm typecheck
pnpm build
NODE_ENV=production DEMO_ENABLED=false pnpm start
```

访问 <http://localhost:4010>；同一个Fastify端口同时提供前端、API、SPA路由。生产要求至少32字符 `JWT_SECRET`；空库首次管理员初始化还需至少32字符随机 `BOOTSTRAP_TOKEN`。正式部署先 `pnpm db:push` 建表、设置 `DEMO_ENABLED=false`，通过登录页初始化强密码管理员，不使用seed。已有演示库只可用于演示，详见 [真实运营指南](docs/真实运营指南.md)。

CLI 改密（也可在设置页改密）：

```powershell
$env:ADMIN_PASSWORD = '替换为至少12字符的独立强密码'
pnpm password -- --username admin
Remove-Item Env:ADMIN_PASSWORD
```

Linux：

```sh
ADMIN_PASSWORD='替换为至少12字符的独立强密码' pnpm password -- --username admin
```

新密码最多72个UTF-8字节，CLI或页面改密均会撤销旧JWT。不要提交 `server/.env`、数据库、备份或私人密钥。正式部署设置 `HOST=0.0.0.0`，`CORS_ORIGIN` 为实际页面来源；使用HTTPS反向代理，持久化数据库目录，以系统服务或容器保证进程常驻。

SQLite在线备份执行 `pnpm db:backup`，使用 `VACUUM INTO` 生成一致快照、完整性校验和SHA256清单，保存在独立 `work/backups`，不重建原库、不跑seed。恢复先停后端，核对哈希，把快照复制到新的数据库文件并修改 `DATABASE_URL`，保留原库；详见运营指南。PostgreSQL使用其原生备份工具。

## Docker 部署

本机 Docker Desktop 的 Linux/SQLite 实例已修复并部署：原生732项、隔离Docker功能300项、清理6项、正式只读21项验收全部通过，详见 [Docker问题修复报告](docs/Docker问题修复报告.md)。原499/496/3初验结果保留在 [历史验收报告](docs/Docker部署验收报告.md)。正式8080保持原空库初始化状态且关闭模拟；首次管理员使用私有部署凭证创建。具备足够磁盘空间的主机可从项目根目录执行：

镜像的构建和运行阶段均安装 OpenSSL，参照 [Prisma 官方 Docker 说明](https://docs.prisma.io/docs/guides/deployment/docker) 处理 slim 基础镜像的引擎依赖。

本机已部署的最终镜像可用 `docker compose -p xingtu-price-monitor up -d --no-build` 继续运行。曾满盘的环境重建前先释放空间并使用无缓存构建，避免复用损坏层；专用低空间应用层修复构建见 `Dockerfile.hotfix` 和修复报告，常规新主机从零部署使用 `Dockerfile`。

```sh
export JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
export BOOTSTRAP_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
export DEMO_ENABLED=false
export CORS_ORIGIN='http://localhost:8080'
docker compose -p xingtu-price-monitor up -d --build
docker compose exec app pnpm db:backup
```

访问 <http://localhost:8080>，使用初始化凭证创建强密码管理员；正式域名上线时改为HTTPS来源。随机密钥保存至私有部署环境，不输出到日志，重启沿用JWT密钥。Compose默认 `DEMO_ENABLED=false`，`xingtu-data` 挂载 `/data`，`xingtu-backups` 挂载 `/app/work/backups`；容器启动只建表、不自动seed。健康检查 `/api/health`，不要扩容为多个采集实例。专用演示部署才显式开启演示并授权seed；默认演示账号上线必须改密。

## PostgreSQL

Prisma 的 provider 不能从连接串直接插值；脚本根据 `DATABASE_URL` 从同一个 `server/prisma/schema.prisma` 生成 provider 副本，字段/关系保持一致。无需手动维护两套模型。连接串写入 `server/.env`：

```dotenv
DATABASE_URL="postgresql://user:password@localhost:5432/xingtu?schema=public"
```

停止后端，执行：

```sh
pnpm db:push
pnpm db:generate
pnpm build
pnpm start
```

首次演示库可在非生产环境执行 `pnpm db:seed`，生产需显式允许。切换数据库不会自动迁移 SQLite 数据；正式迁移需另行备份、导入并核对。本项目已验证 PostgreSQL schema 合法，当前环境没有实际 PostgreSQL 实例，连接与运行尚未实测。后续模型更新上线建议建立 Prisma migrations，并先在备份与测试库验证。

## 环境变量

| 变量 | 默认/用途 |
|---|---|
| DATABASE_URL | `file:./dev.db`；相对路径基于 `server/prisma`，支持 PostgreSQL 连接串 |
| JWT_SECRET | 首次初始化随机生成；生产必填且至少 32 字符 |
| BOOTSTRAP_TOKEN | 生产空库首次管理员初始化凭证，至少32字符随机值；已有管理员不能重复初始化 |
| DEMO_ENABLED | 本地演示true；正式运营false，禁用模拟采集及运营商品/比价参与 |
| HTTP_ALLOWED_HOSTS | 默认空，公网80/443；经审核内部网关按精确hostname:port允许，不支持通配符 |
| TRUST_PROXY | 默认false；只在受控反向代理并阻止绕过代理直连后启用 |
| PORT / HOST | 4010 / 127.0.0.1；容器为 0.0.0.0 |
| CORS_ORIGIN | 开发 `http://localhost:4173`；上线实际来源 |
| APP_TIMEZONE | Asia/Shanghai |
| NODE_ENV | 本地 development；部署 production |
| WEB_PORT / API_PROXY_URL | 开发 Vite 端口与后端代理地址，仅自定义端口时设置 |
| ALLOW_DEMO_RESET | 生产演示 seed 必须显式 `true` |
| ADMIN_PASSWORD | 改密 CLI 的输入，非应用默认密码 |
| BROWSER_EXECUTABLE_PATH | 浏览器验收可执行文件路径 |

接口合同见 [server/API-CONTRACT.md](server/API-CONTRACT.md)。上报素材见 [docs/项目说明素材.md](docs/项目说明素材.md)。正式运营步骤与备份恢复见 [真实运营指南](docs/真实运营指南.md)，本次具体改动和验收数字见 [运营优化报告](docs/运营优化报告.md)。`pnpm verify:operations` 使用一次性数据库重跑全部运营后端及备份验证，不重建现有业务库；浏览器验收独立运行。
