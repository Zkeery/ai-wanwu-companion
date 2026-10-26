# 与造梦机共用 ECS 的万物伙伴部署

2026-10-15。使用独立 `/opt/wanwu-partner`、Python venv、Node 副本、数据和配置。原有 `/dream/` 路由与两个 dream 服务不更换、不重启；魔搭源站不 push、不重部署或删除。

- 后端：`wanwu-partner-backend.service`，回环 `8020`，入口 `scripts.ecs_partner_serve:app`。
- 前端：`wanwu-partner-frontend.service`，回环 `3020`，Next.js 生产 standalone，构建时 `NEXT_PUBLIC_BASE_PATH=/partner`。
- 模型配置：`/etc/wanwu-partner/.env`，root 所有、0600，由 systemd 注入后端；前端使用单独且不含模型密钥的 `frontend.env`。
- 数据：`/opt/wanwu-partner/data`；运行状态：`/opt/wanwu-partner/runtime`。Whisper 不安装、不启用。
- 每日模型请求上限：`PARTNER_DAILY_REQUEST_LIMIT`，本次默认全站 30 次。`daily-model-requests.db` 在外发前持久记一次，重启不清零，失败／未知结果不退回次数，上海时区午夜换日。一次用户操作可能包含多次模型请求。
- Nginx：HTTP 层加载 upgrade map，现有 server 内只增加 locations include。12 MiB 请求体容纳 10 MiB 照片及 multipart 头；保留 SSE、WebSocket 和 180 秒代理等待。

运维先检查 `systemctl status wanwu-partner-backend wanwu-partner-frontend` 和各自 journal；修改前端公开配置后须重新 build，不能仅重启。更换客户端网络时，只轮换 SSH 安全组和 UFW 的当前单一来源，不开放全网 SSH。

创空间 Git 仅包含程序，不包含其运行数据库、上传文件或账本。原站历史数据与新实例数据的实际迁移范围，以本次最终验收记录为准；不得把拉取源码当作数据迁移。

上线检查须包含：原站与新站可用性、回环监听、独立用户、邀请码、照片／生成／聊天、错误兜底、每日计数、进程重启恢复、前端静态资源子路径和实际内存。实体手机与浏览器手机尺寸检查分别记录。迁移不会关闭既有 8 秒性能和连续 24 小时待验事项。

## 2026-10-16 路由修正已发布

Next.js当前将`/partner/`规范化跳转到`/partner`，Nginx的精确`/partner`必须直接代理前端；反向重定向至`/partner/`会形成308循环。用户明确恢复后已发布并通过公网、生产资源、登录保护及造梦机健康检查。访问地址为http://101.96.210.187/partner；已通过的依赖、当前构建、账号与数据保留，历史完整迁移及真实模型链路仍待验。

## 2026-10-16 日额度库的备份范围

本地维护工具已修复，尚未同步生产。完整快照源目录包含`daily-model-requests.db`时，使用schema3清单绑定该独立库，通过SQLite backup复制含WAL的已提交记录；恢复与离线tar均验证该库，遗漏或内容变化拒绝。旧V2无日额度库快照只保留历史用途，不能当作新站日额度完整备份证明。只运行`backend/tests/test_daily_quota_backup_restore.py`新增7项，未重跑已通过项，见[本地修复报告](../../../docs/PRD/版本/V1.2/验收证据/阶段8/备份恢复与额度账本核验-20261016/fix-20261016T091955Z/日额度备份修复报告.txt)。生产恢复与定时备份生效仍需目标环境验收。

2026-10-16 动作切换修复：新站前端已发布，切换动作/准备状态更新保留已解码的静态伙伴图，只重载动作资源；首次等待区为浅色提示。9文件132项回归、构建/类型/零警告Lint通过。保留前一构建的哈希静态资源以支持已有标签页，回滚副本位于本项目服务器backups/action-black-screen-20261016。只重启伙伴前端，后端/Nginx/造梦机不变；未就绪素材仍显示静态图，不代表动作生成开放。


2026-10-16 当前植物伙伴三段视频动作已绑定：独立批次预算7元/最多3次，MaaS Prime 480P×5秒×3，返回用量计算6.75元（非账单核验）。用户审看采用后离线绑定，生成授权已耗尽，禁止重提/自动补发；runtime/motion-video-batch-20261016保留冻结计划、授权、采用记录、预算账本、原片、最终pack及绑定前备份。播放现有动作不调用模型。全局MOTION_GENERATION_ENABLED仍关闭，其他伙伴未自动开放。点击即播放与首帧等待保留形象补丁已发布，构建VqkgmkxNYuX0M8WhTwWzh，142项通过，后端未重启。


2026-10-16 手机卡片与图片并发修复已发布：构建kAmWRNuNKl3t2zFy9KqHY，仅更改占位提示CSS匹配和同token/URL在途图片合并。保留15秒超时、私有权限及取消边界，无完成后图片缓存。旧构建保留于backups/motion-image-dedupe-20261016/production-next-complete；第一发布SSH断开已在切换前回退，第二发布复用已验证构建成功。后端、造梦机和模型开关不变，新增付费0；iPhone实机完整切换/刷新仍待用户复验。


2026-10-16 放大预览动作复用已发布：构建YJQ2PmsHSKNGJss_3vvqi，3前端文件，仅同一预览内保留最多4个已加载资源，退出/换账号、伙伴、源图或动作状态修订清理，无后台预取/持久缓存；首次下载仍依赖网络。9文件112项及构建/类型/零警告Lint通过，仅重启伙伴前端，旧构建backups/motion-preview-reuse-20261016/production-next-complete可回退。新增付费0、日计数5/30；实机切换速度待反馈。

2026-10-16 手机收尾补记：用户iPhone Safari实测三种动作可播放、同窗二次切回更快，播放中刷新后重开头像可恢复播放，按本轮步骤通过。首次下载仍可能等待，未计实机毫秒，新增付费0、日计数5/30；详见上述预览内复用验收记录。
