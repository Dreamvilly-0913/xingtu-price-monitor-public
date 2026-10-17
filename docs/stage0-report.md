# 阶段 0：数据源探针与确定性游走验收

执行日期：2026-10-03。历史验收中的开发暂存目录与最终正式目录在本展示副本中均以 `<project-root>` 表示，原本机绝对路径已省略。

## 完成内容

1. 京东公开价格接口完成真实网络探针，包含常见浏览器 UA、商品页 Referer、15 秒超时；保留每次实际请求 URL、开始/结束时间、耗时、HTTP 状态、原始响应或完整错误链。请求失败时不产生价格。
2. 原 SKU `100014348672` 未能通过京东商品页或搜索索引核验商品身份，因此另外选择已核验的真实京东 SKU `100151490054`（小米15 12GB+512GB 丁香紫），官方商品页：[京东商品页](https://item.jd.com/100151490054.html)。核验依据是该官方商品页在搜索工具返回的商品标题；直接页面访问受限。京东帮助中心说明商品页面 URL 中的数字为商品编号：[查找商品编号](https://help.jd.com/user/issue/44-76.html)。
3. 演示序列直接复用正式后端 `server/src/collectors/demo.ts` 的 `nextDemoPrice`，没有另建独立价格计算逻辑。商品 ID + 日期决定 FNV-1a 种子，xorshift32 生成确定性随机数；同日重复采集由 `sequence` 选择同一种子的不同位置。基准、前价与结果均为整数分，单次限幅与总价区间向内取整。

## 京东探针结果与故障排查

三个方案各请求两个 SKU，共 **6 次真实请求**。所有请求均未收到 HTTP 响应，故 `status = null`，没有响应结构或响应正文可展示。不能据此判断公开接口在其他网络是否仍可用，也没有把已知格式示例伪称成实测返回。

| 方法 | SKU | 耗时 ms | 真实结果 |
|---|---|---:|---|
| 受限环境 HTTPS `fetch` | 100014348672 | 108 | `connect EACCES 198.18.2.186:443` |
| 受限环境 HTTPS `fetch` | 100151490054 | 4 | `connect EACCES 198.18.2.186:443` |
| 自动审核通过后的 HTTPS `fetch` | 100014348672 | 5113 | `ECONNRESET`，TLS 握手前连接断开 |
| 自动审核通过后的 HTTPS `fetch` | 100151490054 | 5012 | `ECONNRESET`，TLS 握手前连接断开 |
| 自动审核通过后的 HTTP 回退 | 100014348672 | 5121 | `UND_ERR_SOCKET`，`other side closed` |
| 自动审核通过后的 HTTP 回退 | 100151490054 | 5013 | `UND_ERR_SOCKET`，`other side closed` |

错误原文：

```text
TypeError: fetch failed
cause: Error: connect EACCES 198.18.2.186:443
code: EACCES

TypeError: fetch failed
cause: Error: Client network socket disconnected before secure TLS connection was established
code: ECONNRESET

TypeError: fetch failed
cause: SocketError: other side closed
code: UND_ERR_SOCKET
```

已检查运行进程没有 `PROXY` 环境变量，Windows WinINET `ProxyEnable = 0`。第三种方案后停止重复排查该外部连接问题。该失败已按真实结果记录，项目后续真实采集器同样会记失败原因，不补入演示价格。

原始证据：

- `outputs/stage0-jd-sandbox.json`
- `outputs/stage0-jd-unrestricted.json`
- `outputs/stage0-jd-http-fallback.json`
- 复验命令：`node scripts/probe-jd.mjs local`

## DemoCollector 验证数字

输入：商品 ID `stage0-jd-iphone16`，基准价 **¥5,999.00**，波动率 **2.5%**，日期 **2026-09-03 至 2026-10-02**。

| 检查项 | 实际数字 | 结果 |
|---|---:|---|
| 输出价格点 | 30 | 通过 |
| 变动检查步数（含基准价到第一点） | 30 | 通过 |
| 最大绝对单步变动 | 2.4586645693738705% | ≤2.5%，通过 |
| 最低价 | ¥6,110.13 | 区间内 |
| 最高价 | ¥7,781.46 | 区间内 |
| 最后一个价格点 | ¥7,397.17 | 正整数分 |
| 合法区间 | ¥3,599.40–¥7,798.70 | 全部30点在区间内 |
| 相同输入重跑 | 30/30 点及变动一致 | 通过 |
| 小金额边界样本 | 9/9 通过，每个30点 | 通过 |

小金额基准分别为 1、2、3、7、10、99、100、101、199 分，额外 **270 点**均满足正价格、区间和单步限幅。阶段0明确使用 2.5%，正式业务采集函数的可配置上限为 3%。

完整30天序列已实际打印并保存到 `outputs/stage0-demo.csv` 与 `outputs/stage0-demo.json`。所有点均标注“演示模拟”。复验命令：

```powershell
pnpm --filter @xingtu/server exec tsx ../scripts/probe-demo.mts
```

## 类型检查与构建

- `tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --types node --typeRoots server/node_modules/@types scripts/probe-demo.mts`：退出码 **0**。
- 相同 TypeScript 配置实际编译到 `work/stage0-build`：退出码 **0**。
- `node --check scripts/probe-jd.mjs`：退出码 **0**。
- 前次报告“无法直接调用 tsx/tsc”系工具入口判断不完整。已确认旧工作区与正式项目的 `server/node_modules/.bin` 有对应命令，正式项目使用 pnpm 调用。
- 受限环境执行旧 tsx 出现 `uv_os_get_passwd returned ENOMEM`，自动审核通过后可启动；随后根包没有 ESM 类型导致顶层 await 被当成 CommonJS，脚本改为显式 ESM `.mts` 后验收通过。完整后端与前端构建将在各实现阶段独立验证。

## 遗留问题

京东公开价格接口在当前网络无法获取 HTTP 响应。已实测并如实保留失败证据；部署网络可运行同一探针复验。本阶段没有验证任何商品的真实市场售价。种子基准价采用用户提供的参考金额，演示价格仅用于系统演示与验收。

用户后续已授权“后续不用问，直接做完”，因此完成本阶段报告后继续实施剩余阶段，保留各阶段自检及报告。
