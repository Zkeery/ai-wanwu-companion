# Google Apps Script 独立外部检测

2026-10-19：用户已授权并完成精确两项 OAuth 授权；真实初始化、一个五分钟触发器及两条隔离合成通知已完成。09:59:20 自动执行失败记录保留；推断与演练共用锁、原一秒等待有关，原 Cloud 日志不可得。锁等待已改为最多15秒，本地23项通过、真实网络0，刷新后代码一致；修复后10:14/10:19/10:24三轮真实时间驱动均健康通过，耗时1.900/1.971/2.137秒，最大间隔300.389秒；正式通知0，合成2条。限定本次独立监控验收通过，历史失败保持。2026-10-18原准备记录保留于私有快照与项目状态历史。GitHub 第一轮真实 schedule 已通过，但连续检查间隔超过 20 分钟；Netlify 原账号显示 suspended，未创建替代账号。

## 授权边界与费用

已获用户明确确认：用现有 Google 账号创建私有独立 Apps Script 项目，将现有仅能向本项目运维群发消息的飞书 Webhook 与签名密钥存入 Script Properties。Google 是新增凭证接收方；不复用 GitHub 授权。项目只由本人管理，不共享、不发布 Web App。

清单明确限定两项 OAuth scope：
- https://www.googleapis.com/auth/script.external_request：公开 HTTPS 检测与群机器人请求。
- https://www.googleapis.com/auth/script.scriptapp：创建/查询当前脚本的五分钟定时触发器。

不申请 Gmail、Drive、ECS、云监控或其他仓库权限；不启用付费 Google Cloud 账单。需额外权限、协议接受或费用时先停并告诉用户。私有 Google 项目已创建，授权和指定凭证接入已完成；未共享或发布 Web App。

Google 官方消费者额度：URL Fetch 20,000 次/日，定时器总运行 90 分钟/日，均为账号共享额度；五分钟一次、每次两个匿名请求约 576 次/日，另外计通知发送。288 次/日意味着平均每次耗时须小于 18.75 秒才可落在独占全部 90 分钟的理论预算内；真实账号其他脚本占用与跨网耗时尚未核验，不能保证永不耗尽额度或固定时延。

## 行为与记录

固定目标 https://101.96.210.187；仅 GET /partner（200 HTML 含产品名称）与 /partner/api/v1/auth/me（401 JSON error）。不携带登录态、不读消息/照片/邀请码、不调用模型、TOS、云管理接口，不改线上服务或备份。

连续两次异常发 PUBLIC_SERVICE_UNREACHABLE，连续两次正常发 PUBLIC_SERVICE_RECOVERED；间隔超过 20 分钟发 EXTERNAL_CHECK_DELAYED 并重新计算连续样本。该通知只能在平台恢复调度后发现漏检，不能覆盖 Google 自身永久停检。

Script Lock 串行，最多等待15秒，锁空闲时立即执行；超时保留实际失败。先写发送意图，再发通知，再写回执。发送失败或结果未知保留 pending 并停止自动重试；丢失/损坏状态、时钟倒退、重复定时器不自动初始化或替换。正式/演练状态隔离。演练仅在额外获准后执行一次，最多两条标注“合成演练”的消息，不中断生产。全局滚动 24 小时最多 24 次发送尝试。

样本按 UTC 天追加紧凑记录：毫秒偏移的 base36、结果码、down 位。结果码 0=正常，1=PUBLIC_PATH_UNEXPECTED，2=PUBLIC_PATH_NETWORK_OR_FORMAT，3=PROBE_RESPONSE_TOO_LARGE，4=PROBE_RESPONSE_INVALID，5=SYNTHETIC_UNREACHABLE。初始化、发送意图及回执另存独立审计属性。保留所有样本和旧审计，不自动删除或清零。23 项测试含正常五分钟采样 30 天共 8,640 次样本全部保留、处于保守存储上限内；这仅是容量模拟，不是 30 天真实稳定性验收。有限属性空间终会耗尽，达到保守阈值即停并留记录；实际使用需在满额前只读导出并制定下一阶段留存方案，不能称为无限运行。

UrlFetchApp 未提供本代码可设置的每请求 8 秒超时，平台运行上限也不能代替网络超时保证。保留证书验证与禁止重定向；真实 Google 对 IP HTTPS 的可达性和五分钟触发已确认；修复后的三轮连续真实样本均已验收通过，长期调度和共享额度不作保证。

## 配置与执行次序（接入验收已完成，不重复初始化/安装/演练）

仅通过私有 Script Properties 配置 WANWU_APPROVED、WANWU_ENABLED、WANWU_TARGET_ORIGIN、FEISHU_WEBHOOK、FEISHU_SIGNING_SECRET；代码或日志禁止写凭证。WANWU_TRIGGER_ID、状态、发送账本由脚本写入，不手填替换旧历史。

1. 核对用户授权与界面实际两项 scope；有偏差先停。
2. 只创建一次私有项目，上传 Code.gs 与 appsscript.json；配置私有属性。
3. initializeWanwuMonitor 进行一次真实匿名 HTTPS 初始化；失败保留证据，不自动重试。
4. installWanwuMonitorTrigger 安装一个五分钟触发器；检查真实自动事件，不用手动运行冒充自动。
5. 另获明确授权后 runWanwuSyntheticDrill 验证最多两条合成故障/恢复通知；核对群内真实接收与持久发送意图/回执。
6. 至少三轮真实自动样本、最大间隔不超过 20 分钟、正常静默与执行耗时/额度全部合格后，才记本备选自动验收通过；不放宽旧 GitHub 超时事实。

本地免费验证：node --test Code.test.mjs。VM 内 UrlFetchApp、PropertiesService、ScriptApp 和锁均为本地替身，未访问 Google、ECS、飞书或模型；23/23 通过。完整日志及修复前容量失败保留在本项目私有 .runtime 目录。

参考：[官方额度](https://developers.google.com/apps-script/guides/services/quotas)、[五分钟定时器](https://developers.google.com/apps-script/reference/script/clock-trigger-builder)、[URL Fetch](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app)、[清单](https://developers.google.com/apps-script/manifest)。
