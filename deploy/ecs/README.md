# 单ECS常驻部署准备

2026-10-02。这些是R8.14候选的待部署文件，不是已购买、已上线或已获正式短信资格。用户没有营业执照，正式短信审核暂缓。保留现有手机号登录契约，本地体验照常。

## 部署时由AI执行

1. 获得具体云采购预算和域名确认后，建立独立北京ECS与持久块盘；目标x86_64重新安装Python3.12、Node、ffmpeg／ffprobe并构建已验版本依赖。R8.13 ARM64包不能直接冒充x86结果，既有codec应在目标架构重建及复验。
2. 数据盘按UUID挂载到`/srv/ai-companion/data`，以`systemd-escape --path --suffix=mount /srv/ai-companion/data`核对挂载单元名称。本模板绑定该挂载单元，卸载或挂盘失败会阻止业务服务启动；不以创建空目录代替挂盘。
3. 实际确认卷身份后，在盘内创建`.ai-companion-volume`，内容为本项目独立卷标记，两个私有配置的`DATA_VOLUME_ID`与之对应。建立`uploads`和`ledger`目录，权限交给独立`aicompanion`用户。不自动导入本人的本地数据。
4. 后端源码和目标venv放`/srv/ai-companion/current/backend`；前端用`BACKEND_URL=http://127.0.0.1:8020`重新生产构建，把standalone内容及public／`.next/static`放到`current/frontend/standalone`。不可沿用代理8056的旧包。前端卷标记不保密，短信和模型凭证只放后端私有配置。
5. 合并`../backend.production.env.example`与本目录后端路径模板到`/etc/ai-companion/backend.env`，用本项目批准的真实短信／模型配置填写，文件由root管理且仅授权服务用户可读；前端同样单独配置。公开模板默认仍阻止正式启动。构建时清除开发码、预览和公开密钥，运行时改变量不能替代产物检查。
6. 核对systemd文件，安装后先运行启动检查和原发布预检，再启动单worker后端和回环前端。`ProtectSystem=strict`仅允许后端写业务数据盘；前端只读，原生库路径与目标Node实际位置需核对。依赖/配置不足时保持失败，不改宽权限凑通过。
7. 使用已备案域名和实际证书替换nginx模板，执行`nginx -t`后启用同源HTTPS。后端和前端回环端口不对公网开放。SSE关闭缓冲，180秒代理超时不代表8秒性能通过。日志不记录访问路径／查询值，错误日志按实际监控方案复核，模板尚未接告警平台。
8. 云端重新验证匿名／跨账号、真实短信、图片与语音、SSE、手机麦克风、重启、卷失联及备份恢复。取得实际证据前不标上线完成。

## 完整数据备份与恢复

维护命令从`current/backend`、在私有`DATA_VOLUME_ID`环境下执行。备份前暂停前端入口并停止`ai-companion-backend.service`，确认没有其他维护进程写业务盘；脚本检查后端已加载且inactive/dead。命令不会替你停／启动服务，不允许对正在写入的联合数据做“成功”备份。

```bash
python -m scripts.ecs_runtime backup --target /srv/ai-companion/backups/UNIQUE-SNAPSHOT --confirm-quiesced
python -m scripts.ecs_runtime restore --snapshot /srv/ai-companion/backups/UNIQUE-SNAPSHOT --target /srv/ai-companion/data/UNIQUE-RESTORE --confirm-quiesced
```

备份父目录必须事先建立并为本项目私有；快照／恢复目录必须不存在、互不重叠且不能经过符号链接。联合备份含`app.db`、`uploads`、`ledger`和数据根JSON，不含部署环境文件或卷标记。输出仅为数量和验证状态，完整manifest及数据是私有文件。失败保留新目录供排查，已有源和历史快照不覆盖。

恢复到新目录并校验原摘要后，生产切换仍需另行检查、保留现有数据的验证备份并审查激活步骤；脚本不会自动替换正在使用的数据根。本机快照不等于异地备份。R8.16已补下方非停服定时完整备份和本地告警；实际云负载一致性、保留策略与灾备生产激活仍待演练，不启用周期性停服任务充当在线备份。

## 私有北京TOS传输

`backend/requirements-cloud.txt`将可选官方SDK固定为`tos==2.9.3`，本项目venv已安装并完成禁网初始化／API参数检查及依赖检查。默认业务运行不需要此依赖。依据[官方SDK源码](https://github.com/volcengine/ve-tos-python-sdk)，客户端使用HTTPS、零自动重试、连接10秒／socket30秒、私有对象ACL和禁止覆盖。

先由云预算和资源确认建立本项目独立私有北京桶、专用最小权限凭证；不复制其他项目凭证。维护私有配置见`cloud-backup.env.example`，默认开关false和空授权引用会在SDK初始化前拒绝。现实现保守要求桶ACL只含属主且没有桶策略；IAM权限单独核对。真实凭证、桶策略和云调用尚未验证。

```bash
python -m scripts.ecs_cloud_backup pack --snapshot /srv/ai-companion/backups/UNIQUE-SNAPSHOT --archive /srv/ai-companion/backups/UNIQUE.tar
python -m scripts.ecs_cloud_backup upload --archive /srv/ai-companion/backups/UNIQUE.tar --receipt /srv/ai-companion/backups/UNIQUE-transfer.json --approval-ref APPROVED-CLOUD-BACKUP-REF
python -m scripts.ecs_cloud_backup download --key ai-companion-backups/OBJECT-ID.tar --sha256 KNOWN-SHA256 --target /srv/ai-companion/backups/UNIQUE-download.tar --approval-ref APPROVED-CLOUD-BACKUP-REF
python -m scripts.ecs_cloud_backup unpack --archive /srv/ai-companion/backups/UNIQUE-download.tar --sha256 KNOWN-SHA256 --target /srv/ai-companion/backups/UNIQUE-unpacked
```

`pack`／`unpack`为免费离线操作。上传、下载另需`TOS_BACKUP_ENABLED=true`及与私有`CLOUD_BACKUP_AUTHORIZATION_REF`精确相同的已批准引用；模板文字不是授权。归档上限1GiB，解包最多100000普通文件；只包含已校验完整清单，额外.env排除。云上传先持久保存尝试回执，上传后下载逐字节摘要核对；任何失败保持未知尝试，不覆盖回执／对象或自动重传。核对未知结果应读取旧回执的对象键，不派发新上传。记录和归档均为私有文件，不放public目录。

真实备份可能产生存储、请求和下载流量费用，尚未批准或发生；该传输入口不创建桶、不设置生命周期、不定时停服、不自动替换生产数据。新17项替身检查证明本地边界，不能冒充真实TOS备份成功。

## R8.16 定时本地备份与告警

当前模板未安装或启用，maintenance.env.example默认false。只有本项目云资源／挂盘和生产配置具备后，由AI建立私有目录/srv/ai-companion/backups与/srv/ai-companion/monitor，权限0700、属主aicompanion；将独立卷身份和开关填入/etc/ai-companion/maintenance.env。此配置不含模型、短信或TOS凭证。

AI核对目标Linux的systemd和文件／网络限制后安装本目录backup及monitor两个.service／.timer文件，先手动验证，再启用timer。每日服务器时区03:15加最多5分钟错峰运行备份；每分钟巡检，两类任务都不重启或停服业务。macOS没有运行这四个Linux单位，不作为实际部署证据。

备份会保存唯一运行记录，数据库在线backup并复制uploads／ledger／根JSON；源前后及目标清单不一致就失败。归档实际解包恢复校验并fsync后才记录verified。默认5GiB本地总配额，另留至少2GiB磁盘余量；同时预留快照、归档和恢复检查空间。默认不删除历史，最多1000条运行记录；达到上限时告警并等待保留方案审查。失败／中断现场保留，旧成功快照不覆盖。

中断的running记录会阻止下一次自动复制。维护者从私有run-ID.json取得run_id后，仅核对已有材料：

```bash
python -m scripts.ecs_maintenance resolve --run-id EXACT-32-HEX-RUN-ID
python -m scripts.ecs_maintenance backup
python -m scripts.ecs_maintenance monitor
```

resolve不重新复制或上传；材料完整则记录verified，不完整则failed。随后backup新建另一个快照，原失败材料保留。单次备份限180秒、巡检限30秒；被终止时持久running记录和后续backup_interrupted告警保留。

巡检查看固定回环前后端响应、挂盘、两项systemd状态、26小时未成功／最近备份失败／中断以及低空间。私有monitor/status.json是当前结果，journal只记录状态和固定告警码。backend_unavailable／frontend_unavailable先查对应服务；data_volume_unavailable先核卷身份和挂载；backup_overdue／latest_backup_failed查私有run记录和快照；backup_interrupted先运行resolve；backup_disk_low核配额和剩余空间，不通过删除用户数据解压。

这些是本地告警记录，尚未接外部通知接收者。R8.17已补齐下方独立的定时TOS接入，默认关闭；本地backup／monitor任务仍不调用TOS。真实云存储、权限、留存与费用，以及外部通知通道仍待确认和实际验证。

相关111／111和独立合成数据新进程演练通过，详见[结果与待验项](../../docs/PRD/版本/V1.2/验收证据/阶段8/R8.16定时备份与本地告警/开发与验证报告.md)。

## R8.17 定时异地备份接入

当前offsite.service／.timer未安装或启用，cloud-schedule.env.example默认false，授权JSON模板的approved为false且额度为零。真实资源、专用凭证、存储／请求／下载流量报价和保留方案确认后，AI才准备本项目私有配置。原始语音7天留存、用户删除及恢复后的数据处理需纳入保留审查；本入口不设置生命周期或删除历史，也不自动延长已约定留存。

配置分别存于/etc/ai-companion/cloud-backup.env与cloud-schedule.env；授权存于/etc/ai-companion/cloud-schedule.json，必须为服务用户可读的0400或0600私有文件，不允许组或其他用户访问。JSON需要精确匹配本项目、北京桶、授权引用，给出有效期、归档数量／大小／累计字节上限、单次费用预留、累计预算，以及已审查的报价和留存记录引用。有效期最多31天、最多31份归档、单份最多1GiB；公开模板不能作为授权。单位预留和累计预算必须来自实际报价与批准结果，不能填写示例金额代替。

只读检查不创建费用账，也不联网：

```bash
python -m scripts.ecs_offsite status
```

实际授权齐备并在目标Linux完成检查后，先验证单次dispatch，再启用offsite.timer；当前不执行这一步。计划在服务器时区每日03:30加最多2分钟错峰处理最近24小时内最新的已验证本地归档，单次限240秒。本地备份尚未完成或持锁时拒绝；最新备份失败时不改用旧归档冒充当日成功。

派发前把完整费用和字节预留写入私有SQLite账。同一已验证归档不重复上传；到期或额度不足就拒绝。每次最多四次SDK方法调用：桶ACL、桶策略、上传、下载摘要核对；这个计数不是平台实际账单。客户端不自动重试；SDK初始化失败、网络结果未知或进程中断都保留预留并阻止下一批。维护者应核对私有cloud-transfer.json、原费用账及平台结果，另行审查处理方式；不能删除账本、修改原授权或重置预算后盲目重传。

相关155／155检查通过，包括新进程读取原费用账、未知结果阻止下一批、归档变化拒绝和关闭状态在SDK初始化前拒绝。全部为禁网替身验证，本轮实际TOS调用和新增费用均为零；真实跨机恢复、平台账单、Linux定时任务仍待验。详见[验证报告](../../docs/PRD/版本/V1.2/验收证据/阶段8/R8.17定时异地备份/开发与验证报告.md)。

## 本地验证命令

```bash
cd backend
.venv/bin/python -m pytest -q tests/test_ecs_offsite.py tests/test_ecs_maintenance.py tests/test_ecs_runtime.py tests/test_ecs_cloud_backup.py tests/test_release_readiness.py
```

合成测试覆盖数据盘拒绝、生产输入和完整恢复。macOS上的模拟挂载检查不代表Linux的systemd／nginx已启动，也不代表云磁盘／HTTPS／TOS已验收。生产发布仍需最新状态里的全部闸门。
