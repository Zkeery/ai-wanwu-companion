# 万物伙伴独立外部检测：部署合同与验证

2026-10-19当前状态：Google私有项目已启用五分钟独立检测、两条隔离合成通知已送达；保留09:59并发失败，已发布15秒锁等待修复（23项免费测试通过），修复后10:14/10:19/10:24三轮真实自动验收通过，最大间隔300.389秒；此为限定监控接入通过，无长期SLA保证。异地备份保持暂停，无付费模型或TOS调用。

2026-10-18 22:12历史状态：第一轮真实schedule已通过并送达飞书；首轮延迟4小时08分58秒，第二轮超过20分钟仍未到，持续时效未通过。加密状态、调度、演练记录保持，没有补跑或重置。Netlify现有账号suspended；[Google免费候选](apps-script/README.md)仅本地21项测试通过，未授权/启用，不能代替真实验收。

只检测本项目现有公网入口，不登录、不调用模型、不接触 ECS 管理权限。

## 运行方案

- 专用公开仓库：`Zkeery/wanwu-partner-uptime-monitor`，只发布这里的监测代码与加密状态，不复制应用源码、配置、备份或用户数据。
- GitHub 标准 `ubuntu-24.04` 运行器，计划每 5 分钟一次，错开整点；免费标准运行器，不使用收费大运行器、Actions artifacts、cache 或 LFS。
- 目标源地址放在 `WANWU_TARGET_ORIGIN` Secret。固定匿名请求 `/partner`（200 HTML，含产品名称）和 `/partner/api/v1/auth/me`（401 JSON，含 error）。不会把未登录的 401 误判为故障。
- 连续两次失败通知 `PUBLIC_SERVICE_UNREACHABLE`，持续故障不重复发送；连续两次正常通知 `PUBLIC_SERVICE_RECOVERED`。它表示公网业务路径不可达，不能单凭此码断言机器硬件故障。
- 间隔超过 20 分钟时重置连续样本计数，并发送 `EXTERNAL_CHECK_DELAYED`。只有调度恢复运行后才能发现此前的漏检；免费方案不提供固定延迟或平台自身故障的独立保障。
- 每次请求 8 秒超时，单次任务 3 分钟上限。调度可能延迟或被丢弃，实际告警延迟不承诺为固定 10 分钟；公开仓库长期无活动可能停用调度，应复查真实运行记录。

## 新增权限与凭证接收方（本次已获明确确认）

1. 只在专用仓库内授予临时 `GITHUB_TOKEN` 的 `contents: write`，用于 `monitor-state` 分支上的加密观察状态、发送意图和结果。该 token 的权限覆盖该专用仓库，不是文件级授权；没有其他仓库、云账号或 ECS 权限。
2. 将现有仅能向“万物伙伴运维通知群”发消息的 `FEISHU_WEBHOOK`、`FEISHU_SIGNING_SECRET` 保存为该仓库 Actions Secrets。GitHub 是新增凭证接收方；不把原有云监控授权视为对此的许可。
3. 随机生成 `STATE_ENCRYPTION_KEY`（32 字节），保存为 Actions Secret，并在本地项目私有目录保留恢复副本。状态使用 AES-256-GCM，绑定仓库和文件名，所有历史密文提交保留。失去密钥后不能解密旧证据。
4. 公开内容包括检测逻辑、加密记录、工作流执行时间及成功/失败元数据。通知正文和明文故障详情只进入现有私有飞书群，不打印目标、凭证或响应内容。

## 防重复与失败处理

并发组串行执行，写入使用 GitHub Contents API 的 SHA 比较。通知前先提交加密发送意图；请求失败、结果不明、最终状态写入失败时保留意图并阻断后续发送，不自动重试。24 小时最多 24 次发送尝试。这样会在结果不明时选择停发并待核，不能声称绝对不丢通知。工作流失败或未运行需要查看 GitHub 记录；不能假定飞书通道损坏时仍能用同一通道通知。

状态丢失、密文损坏、时钟倒退不会自动初始化。`bootstrap` 只允许手动一次，重复初始化拒绝，历史不重置。演练使用独立 `drill.enc`，模拟两次断开、两次恢复，最多发送两条带“合成演练”的消息；演练重复调用拒绝，不中断生产。

## 待授权后的部署顺序

1. 再核对专用仓库是否存在，存在时先读权限和内容，不覆盖。创建公开专用仓库，仅上传本目录审核过的文件。
2. 先上传不含 schedule 的同一工作流，创建 `monitor-state` 分支，再配置限定 Secrets。关闭仓库 Wiki/Discussions 等无关功能，不改账号全局设置。
3. 手动 `bootstrap`，确认 GitHub 运行器的真实 HTTPS 探测成功与密文落盘；失败不重建、不自动重试。
4. 手动 `check`，确认健康静默；手动一次 `drill`，验证两条真实飞书消息及合成标识，并核对生产状态不被演练覆盖。
5. 仅通过后启用每 5 分钟 schedule，读取至少一次真实定时运行与最新加密状态，才记自动检测已启用。若定时未出现，记待核，不以手动运行冒充自动运行。
6. 保存真实运行 ID、时间、代码 SHA、加密状态校验和及飞书消息核验结果；旧备份/旧失败/验收窗口全部保留。

若平台出现收费、大运行器、账户范围 token 或其他额外权限需求，停止并告知用户。不为演练停机或改生产服务。

## 验证

`node --test monitor.test.mjs`：全部网络接口使用内存替身，默认真实 fetch 被阻断并计数。覆盖断开/恢复、抖动、超时/重定向、发送结果不明、写入冲突、限流、丢失/损坏状态、签名、加密和独立演练。

## 官方依据（2026-10-18 核对）

- [GitHub Actions 费用与公开仓库免费标准运行器](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [定时任务延迟、丢弃与长期无活动停用](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [工作流 token 权限](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)
- [UptimeRobot 通用 Webhook 不在免费套餐](https://help.uptimerobot.com/en/articles/11361285-uptimerobot-integrations-basic-information-overview)
- [Cloudflare Workers fetch 不支持直接 IP](https://developers.cloudflare.com/workers/platform/known-issues/#fetch-to-ip-addresses)
- [Google Apps Script 免费配额与限制](https://developers.google.com/apps-script/guides/services/quotas)

本文件保留原 GitHub 接入合同与历史失败，Google 当前配置见 [Apps Script 说明](apps-script/README.md)，最终真实验收以项目阶段8证据为准。
