# 星图优选价格监控 API 合同

前缀 `/api`。公开入口为 `/health`、`/auth/status`、`/auth/bootstrap`、`/auth/login`；其它使用 `Authorization: Bearer <token>`。成功直接返回对象；失败统一 `{ error: { code, message, details? } }`。金额是元数值，前端用 `toFixed(2)` 或金额格式化展示。数据库保存整数分。价格与统计全部从成功采集流水计算。列表固定 `{items,total,page,pageSize}`。

平台：`jd`（京东）、`tmall`（天猫）、`pdd`（拼多多）。数据源：`demo` / `http`，返回 `sourceLabel`：演示模拟 / 真实采集。状态：`success` / `failure` / `never`。预警规则：`target` / `drop24h`。

## 基础接口

- `GET /health` → `{status:'ok',service}`
- `POST /auth/login` `{username,password}` → `{token,user:{id,username,displayName}}`
- `GET /dashboard` → `{monitoredProductCount,enabledProductCount,todayCollectionCount,todaySuccessCount,todaySuccessRate,activeAlertCount,todayTopDrops,platformDistribution,products,priceTrends}`。成功率、涨跌均为百分数（如5表示5%）。

`products` 为轻量商品摘要，每项包括身份、配置、来源、当前价、涨跌、采集状态和时效，不扫描全部历史。全历史 `minPrice,maxPrice,avgPrice,maxDrawdownPercent,pointCount` 在商品列表、详情及选中的走势图 `statistics` 提供。`GET /dashboard` 默认只取前三个商品的曲线；`productIds` 是最多10个逗号分隔ID，`days=7|30|90`，`summaryOnly=true` 不加载曲线。

`priceTrends` 每项 `{productId,name,platform,sourceLabel,statistics,pointCount,sampled,points:[{time,price,sourceLabel}]}`。`pointCount` 是范围内原始点数，`sampled` 表示是否采用保首尾/极值采样，最多1000个展示点；统计使用全部成功流水。
`todayTopDrops` 每项 `{productId,name,platform,currentPrice,previousPrice,previousPriceSourceLabel,dropPercent,sourceLabel}`，以昨天上海业务日期内的最后成功价对比今天最后成功价，缺少任一日成功点则不参与。
`platformDistribution` 每项 `{platform,count}`。

## 完整业务接口（阶段 2 已实现）

- `GET /auth/status` → `{bootstrapRequired,bootstrapTokenRequired,demoEnabled}`。`POST /auth/bootstrap` `{username,displayName,password,bootstrapToken?}` → HTTP201 `{token,user}`；生产空库需至少32字符的有效随机部署凭证，已有用户返回409。新密码至少12字符且不超过72 UTF-8字节。
- `GET /auth/me` → `{id,username,displayName,mustChangePassword}`；`POST /auth/change-password` `{oldPassword,newPassword}` → `{success:true,token,user}`，所有旧令牌立即失效，前端须采用新令牌。运营模式默认口令账号仅允许查看自身和设置、修改密码，其它业务接口403。
- `GET /categories` → `{items:[string]}`，独立查询全部可见商品分类，不受商品首页100条限制。
- `GET /products` query `page,pageSize,search,platform,category,status(enabled/disabled/failing),sourceType,groupId` → 列表。产品字段同上。
- `POST /products`、`PUT /products/:id` body `{name,platform,url,sku,category,basePrice,targetPrice,sourceType,collectorConfig,enabled,groupId?}` → 产品对象。
- `DELETE /products/:id` → `{success:true}`。
- `GET /products/:id?days=7|30|90` → `{product,statistics,history:[{id,time,price,sourceType,sourceLabel}],historyPointCount,historySampled,collections:[Collection],alerts:[Alert]}`。统计覆盖全历史；history按范围并限制展示量。
- `POST /products/:id/collect` → `{collection,product,alertsCreated}`，采集失败也返回200且collection.status=failure。
- `GET /groups` query `page,pageSize,search` → `{items:[{id,name,productCount}],total,page,pageSize}`；`POST /groups` `{name}` → `{id,name}`；`PUT /groups/:id` / `DELETE /groups/:id`。
- `GET /comparison` → `{groups:[{id,name,cheapestPlatform,cheapestProductId,cheapestProductIds,cheapestPrice,freshCheapestPlatform,freshCheapestProductId,freshCheapestProductIds,freshCheapestPrice,lastKnownCheapestPrice,lastKnownCheapestPlatform,mixedSources,products:[Product]}]}`。`cheapest*` 与 `freshCheapest*` 相同，仅比较启用、匹配当前配置且未陈旧的报价；全部无效时返回null/空ID数组。`lastKnownCheapest*` 只供历史复核，不能代表当前最低。
- `GET /collections` query `page,pageSize,productId,runId,status,sourceType` → 列表。`runId` 可用于采集轮次与真实流水逐项对账。
- `GET /alerts` query `page,pageSize,productId,rule,status(unread/read/active)` → 列表，额外返回 `currentRules,activeRuleCount`。`items/total` 始终只描述真实历史提醒；`status=active` 按关联当前规则的 `active` 筛选，不按历史 `resolvedAt` 推测。`currentRules` 为商品/规则筛选后的当前触发规则，使用同一分页参数，不受已读筛选影响；`activeRuleCount` 是其总数。
- `PATCH /alerts/:id/read` → Alert；`POST /alerts/read-all` → `{updatedCount}`。
- `GET /settings` → `{collectionIntervalMinutes,demoVolatilityPercent,dropThresholdPercent,scheduler:{running,lastRunAt,nextRunAt},productionReadiness:{demoEnabled,defaultPasswordDetected,enabledRealProductCount,validRealProductCount,blockers,warnings},dataSources:[...]}`。只配置HTTP商品但没有成功有效报价仍有阻塞提示。
- `PUT /settings` body `{collectionIntervalMinutes,demoVolatilityPercent,dropThresholdPercent}` → 设置对象。
- `POST /scheduler/run` → `{runId,total,successCount,failureCount}`；`GET /scheduler/runs` → 列表。
- `POST /collectors/preview`：body同商品创建，必须为http；返回 `{status,price,collectedAt,sourceLabel,failureReason,requestUrl,collectorSnapshot,persisted:false}`。使用真实请求，成功或失败均不写采集流水，不改变当前价或预警。
- `GET /audit-logs`：分页管理动作，记录账号、动作、对象及状态，不记录密码、令牌、接口密钥。

Collector config：JSON方式 `{mode:'json',priceUrl,jsonPath,timeoutMs?}`；网页方式 `{mode:'html',priceUrl?,cssSelector,priceRegex?,timeoutMs?}`；京东http未设置priceUrl时用公开价格接口以及默认jsonPath `$[0].p`。允许单商品 `dropThresholdPercent` 覆盖默认跌幅规则。`priceRegex` 只允许一个标准金额捕获组及字面量前后缀，禁止任意正则执行。金额歧义、促销/运费/无报价、零/负值按失败处理。地址校验、防重绑定、跳转重验、超时、响应1MB上限均用于采集及试采。

Collection：`id,productId,productName,platform,sourceType,sourceLabel,status,price,failureReason,collectedAt,createdAt,trigger,runId`。
Alert：`id,productId,productName,platform,rule,price,threshold,message,sourceType,sourceLabel,triggeredAt,readAt,resolvedAt,baselineRecordId,baselinePrice,baselineCollectedAt,baselineSourceType,isActive,activePrice,activeThreshold,activeMessage,activeSince,stateEvaluatedAt`。`price/threshold/message/triggeredAt/resolvedAt` 是原提醒的历史快照，不因冷却重入改写；`isActive` 只在当前规则触发且 `lastAlertId` 对应该提醒时为 true，`activePrice` 来自最新成功流水。24小时规则采用同来源、同配置身份且接近24小时前的成功点，容差为采集间隔且最多60分钟；缺基线不触发。目标规则无需历史基线。

AlertRuleState：`id,productId,productName,platform,rule,active,price,threshold,message,sourceType,sourceLabel,activeSince,evaluatedAt,lastAlertId,baselineRecordId,baselinePrice,baselineCollectedAt,baselineSourceType`。当前条件状态独立于历史提醒冷却；旧库升级时只从已有成功流水回填状态，不制造提醒，故满足条件但从未有提醒的状态允许 `lastAlertId=null`。商品详情额外返回其 `currentRules`；仪表盘 `activeAlertCount` 按当前活动规则计数。

演示种子每日采集时间采用Asia/Shanghai，默认每天中午；今天额外点采用seed实际执行时刻。30历史点与今天额外点合计31点，仪表盘统计涵盖所有成功点。

详情 `statistics` 字段：`currentPrice,minPrice,maxPrice,avgPrice,maxDrawdownPercent,pointCount,sourceLabels`，均覆盖该商品全部成功采集记录。商品 DTO、仪表盘摘要与走势图 `statistics` 也提供全部成功记录来源去重后的 `sourceLabels`；混合历史可以同时包含演示模拟与真实采集。`history` 默认近 30 天及今日，即从上海业务日期零点向前 30 天开始，seed 初始为 31 个点；7/90 档位同理。详情展示最近 50 条采集与预警记录；完整流水使用分页接口。

商品时效字段：`currentPriceCollectedAt,priceAgeMinutes,maxPriceAgeMinutes,isCurrentPriceCompatible,currentPriceMatchesConfiguration,isPriceStale`。当前价永远为最新成功流水；最近失败不会改写当前价或报价时间。新鲜度阈值为采集间隔×2 + min(max(间隔,5),60) 分钟。跨来源或配置身份变化即标无效；陈旧成功价仍留存展示。修改商品、设置会重评预警而不创建价格，每分钟清理过期活动预警。运营模式 `DEMO_ENABLED=false` 的商品/分类/仪表盘/比价及预警排除模拟来源；历史流水保留明确的演示标注。

最新成功价、走势图与最大回撤都按 `collectedAt → createdAt → id` 升序确定价格时间线，最后一项为当前价；流水分页采用完全相反的降序。API 的 Collection `createdAt` 为 ISO 写入时间，允许验收脚本独立重建相同顺序。金额均价按整数分平均并舍入到分，不另外保存统计字段。

设置 `dataSources` 是 `{type:'demo'|'http',label,description}` 数组；`scheduler` 是 `{enabled,running,lastRunAt,nextRunAt}`。无已持久化调度时间时后两项可为 null。进程启动持久化第一次调度时间，此后 node-cron 每分钟检查到期，重启保留原时间，调度轮次不重叠。手动全轮不移动定时计划。

产品来源字段：`sourceType/configuredSourceLabel` 表示商品配置；`sourceLabel/currentPriceSourceType/currentPriceSourceLabel` 表示当前价对应最新成功流水的实际来源。切换到真实源但采集失败，旧演示价格继续标注演示模拟。图表每个点都有自己的来源。全部成功数据来自采集器，失败不会更改当前价。

比价增加 `cheapestProductIds:string[]` 用于同价并列最便宜，`cheapestProductId/cheapestPlatform` 以商品 ID 排序选一个稳定代表；无成功价格时最便宜字段均为 null，ID 数组为空。商品组 PUT body 是 `{name}`。

采集流水增加 `collectorSnapshot`。演示快照保存 `algorithmVersion,productId,date,basePriceCents,previousPriceCents,volatilityPercent,sequence`，配置变更后旧记录仍可独立复算；该快照为采集输入。

预警 `readAt` 表示提醒已读，`resolvedAt` 保留原提醒因价格恢复、配置失配、报价过期或新提醒归档的时间。标记已读不会解除当前规则。规则未读且持续触发时不重复；同商品同规则且同采集来源/配置身份，自上次提醒起 24 小时内不新建记录。价格恢复后当前规则解除；冷却期间再次达标会立即恢复当前规则，关联原提醒并保留其原解除时间。当前规则价格、基线和复核时间均可由成功采集流水核对。
