# 桌面内测部署与邀请码维护

本次用户已批准邀请码替代短信。云端目标仍需独立持久块盘与常驻进程，沿用`ecs/`部署文件；Vercel仅能作为另行设计的前端托管，当前SQLite与后台worker不直接适用。资源预算未确认前不采购。

## 正式配置

后端 `APP_ENV=production`、`AUTH_MODE=invite`、`SMS_LIVE_ENABLED=false`。删除开发令牌、固定验证码、认领授权；真实模型、持久盘和独立用户仍按生产模板配置。前端构建设 `NEXT_PUBLIC_AUTH_MODE=invite`、真实`BACKEND_URL`，所有开发／预览开关关闭。启动时换变量不会更新已构建前端，必须重建。

初始新增两张表`login_invites`和`invite_login_windows`，应用启动时通过既有create_all流程创建，无需重建users表；原账号、数据、会话和短信契约保留。邀请码账号的内部兼容标识以i开头，不是手机号，也不能通过短信认领；对外phone为空。

邀请码为32随机字节编码，只在私有交付文件保留原文；数据库只存SHA256。默认30天、最多90天有效，可重复登录同一账号。生产仅绑定回环后端，代理统一提供HTTPS。登录每个直连来源每分钟最多20次，计数写入SQLite；目前同源Next代理会共用该来源限额，小规模内测适用，不能把客户端任意转发头当作真实IP。

## 维护者命令

由AI在实际生产环境加载配置、完成服务初始化后执行，不能对现有体验库盲目运行。创建默认新账号；为已有账号签发须准确提供已核对的user-id，不自动认领或导入本地数据。

```bash
python -m scripts.manage_invites create --days 30
python -m scripts.manage_invites create --days 30 --user-id VERIFIED-EXISTING-USER-ID
python -m scripts.manage_invites revoke --user-id VERIFIED-USER-ID
```

新邀请码写入数据库同目录的`private-invites/`，目录0700、文件0600；命令只返回文件路径与账号ID。文件不能放入源码、公开目录、日志或证据包。通过用户指定的私密方式交付，不在文档写邀请码。撤销使该账号全部邀请码和现有会话失效。用户数据不删除。备份数据库可恢复凭证摘要、归属与限流；私有明文交付目录不进入公开发布包，也不依赖它验证登录。

## 本地验证复现

```bash
cd backend
.venv/bin/python -m pytest -q tests/test_invite_auth.py tests/test_auth.py tests/test_release_security.py tests/test_release_readiness.py
```

本轮独立生产构建目录为`frontend/.next-desktop-release`，代理为8062，只用于本机验收，不直接上传。`scripts.rehearse_desktop_release`的start／exercise使用独占`.runtime/desktop-release-20261002`，拒绝覆盖；使用合成凭证并阻止外部模型连接，不能冒充真实模型验收。本轮13项实际HTTP、登出、备份、新目录恢复及持久会话检查已通过。

正式发布前还需云主机／域名与HTTPS、真实模型有限预算及供应商配置、后台生活额度和实际云端重启／备份验收。短信、≤8秒与手机不阻塞本次桌面内测；24小时与多人主观校准的旧结果仍按实际状态保存。
