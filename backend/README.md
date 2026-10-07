# AI万物伙伴 · 后端（R1 场景与养成内核 + R2 账号与多场景接入）

2026-10-02 生成提速第一轮：生成图片下载继承`MODEL_HTTP_POOL_ENABLED`的有界连接复用；API密钥只随模型POST发送。`generation_timing`新增`image_http`／`image_download`／`image_store`，与外层任务标识一致；它们是分段诊断，8秒仍按前端上传到最终绘制计算。相关89／89通过，原模型、超时、重试、图片字节与费用逻辑不变。复验：在本目录运行`.venv/bin/python -m pytest -q tests/test_model_http.py tests/test_model_client.py tests/test_image_stage_timing.py tests/test_parallel_generation.py tests/test_creation_flow.py tests/test_real_web_budget.py tests/test_photos_api.py tests/test_generation_performance_audit.py`。本机HTTP端是替身，不耗模型额度；本轮不自动重启真实24小时服务。[结果与限制](../docs/PRD/版本/V1.2/验收证据/阶段3/生成提速第一轮/优化与验证报告.md)。

2026-10-01 C1.73三类真实生成、用户接受、制包绑定、播放和恢复完成。backend目录 `.venv/bin/python -m scripts.run_three_activity_acceptance status` 只读应为completed、三类ready、调用3次、人审待办false，不启动新请求。完成状态回归10／10，实付0.062800美元；本人前端现3057、后端8048。[最终报告与闸门](../docs/PRD/版本/V1.2/验收证据/阶段3/C1.73三类动作自动请求/真实批次/收尾验收报告.md)。以下待审图记录为当时状态。

2026-10-01 C1.73有限真实验收批次已生成三类候选，费用0.062800美元，用户审图及实际绑定／播放待验。当前仅用 `.venv/bin/python -m scripts.run_three_activity_acceptance status` 只读核对；一次性批次已启动并耗尽三次，不能重复prepare／start，私有回执和ledger保留。相关复验入口：`.venv/bin/python -m pytest -q tests/test_three_activity_acceptance.py tests/test_motion_generation.py tests/test_motion_generation_activities.py`。[真实结果与恢复证据](../docs/PRD/版本/V1.2/验收证据/阶段3/C1.73三类动作自动请求/真实批次/真实执行与待审图报告.md)。

## V1.2 R3.4：首页真实生活近况

GET `/characters/overview?include_life_activity=true`增加最多3条当前有效私人住处的用户操作摘要；旧请求不查事件表。批量4个SELECT，无写入或模型调用。只在8042隔离环境加载，主库未迁移；后端完整786/786通过。运行`.venv/bin/python -m pytest tests/test_overview_activity.py tests/test_character_overview.py tests/test_life_journal.py -q`可复验。见[R3.4报告](../docs/PRD/版本/V1.2/验收证据/阶段3/R3.4开发与验证报告.md)。

## V1.2 R3.3：私人生活记录

私人actions新增同事务事件，GET `/living/spaces/{id}/activity`分页读取；失败回滚、幂等不重复，不补旧记录。启动将创建living_activity_events表，本轮仅隔离8042加载，主库未迁移。主服务加载前先备份并验证恢复。backend目录运行`.venv/bin/python -m pytest tests/test_life_journal.py -q`。启动与验收边界见[R3.3报告](../docs/PRD/版本/V1.2/验收证据/阶段3/R3.3开发与验证报告.md)。

## V1.2 R3.2：私人生活规则模拟

实现测试专用`/living/spaces/{id}/life-simulation`读取／设置／单步执行；仅`APP_ENV=test`且`LIFE_SIMULATION_ENABLED=true`时开放和建独立模拟表。开发／生产均返回404，不改变正式数据库结构或启用调度器。规则与接口见[第3阶段手册第6节](../docs/PRD/版本/V1.2/技术文档/第3阶段技术开发文档.md)。

在本目录运行`.venv/bin/pytest -q tests/test_life_simulation.py`，最终15/15通过；覆盖时间、权限、幂等并发及失败回滚。在项目根目录运行`backend/.venv/bin/python backend/scripts/r32_life_preview.py`启动8042隔离服务，前端3042启动、测试账号及证据见[R3.2报告](../docs/PRD/版本/V1.2/验收证据/阶段3/R3.2开发与验证报告.md)。本轮没有真实模型调用、主库迁移或主服务重启。

## V1.2 R3.1：私人空间四季

新增私人场景四季读取、只读预览和幂等保存，独立存储季节设置及请求回执，不修改场景布置、成长或撤销版本。契约见[第3阶段后端手册](../docs/PRD/版本/V1.2/技术文档/第3阶段技术开发文档.md)。本模块无模型调用。

在本目录运行 `.venv/bin/pytest -q tests/test_seasons.py`（39/39通过）。主库初次加载前停止8020，再从项目根目录运行 `backend/.venv/bin/python backend/scripts/backup_seasons_migration.py`，成功后按原命令启动后端；脚本备份数据库和图片并在隔离目录验证恢复。2026-09-22已完成一次，旧25表及10张图片哈希不变，备份位于 `data/backups/r31-seasons-20260922-170001/`，勿删除。

独立浏览器复验可运行 `backend/.venv/bin/python backend/scripts/r31_seasons_preview.py`，使用8041和独立测试库，所有AI调用被禁止；不会读写主用户数据。结果与边界见[阶段3报告](../docs/PRD/版本/V1.2/验收证据/阶段3/开发与验证报告.md)。

R7.4：用户确认生成全程硬上限改为8000ms。`scripts/audit_generation_performance.py`现按8秒逐次判定，报告明确`budget_ms`及`policy_id`；原始采样协议仍为1，旧报告保留。运行`.venv/bin/pytest -q tests/test_generation_performance_audit.py`验证边界。真实链路仍未通过；以下5秒记录为此前执行记录。

R7.3连接修复已加载本地8020：`MODEL_HTTP_POOL_ENABLED=true`复用识别／构思／生图POST连接；`VISION_ENABLE_THINKING=false`仅支持当前MaaS的`ling-3.0-flash-vl`，未知组合显式拒绝，与聊天思考开关无关。取消该配置恢复供应商默认，连接池置false恢复每次建连；重启后生效。下载保持独立无鉴权，聊天SSE不改。全量686/686通过，复验命令`.venv/bin/pytest -q tests/test_model_http.py tests/test_thinking_options.py tests/test_model_client.py tests/test_creation_flow.py tests/test_parallel_generation.py tests/test_scene_agent_chat.py`。这不表示5秒性能通过，真实结果见[报告](../docs/PRD/版本/V1.2/验收证据/阶段7/R7.3超时归因与修复.md)。

## V1.2 第1阶段：只读伙伴概览

新增`GET /api/v1/characters/overview`，沿用登录鉴权，返回本账号ready伙伴、有效当前住处和最近聊天时间，不返回消息内容、不初始化场景。无住处或近况为null；所有权／伙伴绑定失效不泄漏数据。原有角色列表与详情接口保持兼容，无迁移或新增模型调用。

在本目录运行`.venv/bin/python -m pytest -q -s tests/test_character_overview.py tests/test_characters_api.py tests/test_living_api.py tests/test_scene_api.py`，相关38/38通过。新接口已接入V1.2 R1.2正式首页，原型继续独立使用示例数据。本地8020已在备份和确认无进行中任务后重启加载新接口；旧进程未加载时会将overview当作角色ID而返回422。契约见[V1.2后端第1阶段手册](../docs/PRD/版本/V1.2/技术文档/第1阶段技术开发文档.md)，证据见[阶段1记录](../docs/PRD/版本/V1.2/验收证据/阶段1/README.md)。以下保留V1.1原验收记录，不代表其剩余事项已关闭。

## R6.1 只读上线预检

在项目根目录运行 `backend/.venv/bin/python backend/scripts/check_release_readiness.py --output .runtime/release-readiness.json`，或在 backend 中运行 `.venv/bin/python scripts/check_release_readiness.py --output ../.runtime/release-readiness.json`。父目录须存在，目标须是新文件；输出权限 0600，不覆盖旧报告。退出 0 全部通过，2 存在阻塞／待验，1 输入或写入错误。只读配置与源码，不启动应用、不访问数据库、不调用网络、不回显密钥。报告不是运行中服务或已构建产物的安全证明。

专项 28/28、完整后端 574/574 通过。当前本地预检为 6 通过／7 阻塞／7 待验，下一步修复私人图片访问与生产入口边界；不直接修改本地固定码或打开功能开关。见[第6阶段手册](../docs/PRD/版本/V1.1/技术文档/第6阶段技术开发文档.md)和[R6.1 报告](../docs/PRD/版本/V1.1/验收证据/阶段6/R6.1上线预检/开发与验证报告.md)。

## R4 场景 Agent、再创作与内测额度（2026-09-21）

已按[第4阶段技术开发文档](../docs/PRD/版本/V1.1/技术文档/第4阶段技术开发文档.md)完成运行器、现有模型适配、聊天接入与恢复、独立再创作及额度事务。账号初始 5 次，技术失败返还；重复请求不多扣，旧伙伴完整保留。后端 484/484 离线测试通过，真实模型契约与质量仍待验。

`SCENE_AGENT_ENABLED=false` 和 `GENERATION_QUOTA_ENABLED=false` 默认关闭。真实验证前保持此配置；前者控制 Agent 聊天，后者同时控制额度与再创作开放。关闭不会删除既有任务和额度记录，旧聊天与生成继续可用。不是付款开关，也不代表模型调用已获授权。

启动命令仍为下方 8020 的 `uvicorn`。首次加载新代码前备份 SQLite；启动自动幂等新增 5 张表，原数据不追溯扣减。中断任务标记失败并按预留记录返还，不自动调用模型；目前仍按单应用进程运行。当前主库已备份并更新，8 个伙伴与 8 个空间保持不变。

在本目录运行 `.venv/bin/python -m pytest -q`；R4 专项为 `tests/test_scene_agent_runtime.py`、`tests/test_scene_agent_chat.py`、`tests/test_recreation.py`。所有新增测试使用隔离库与模型替身，不产生付费调用。接口、证据与真实验收安排统一见第四阶段手册；以下各轮记录保留当时结果。

2026-09-21 真实测速补充：用户授权的 3 组已测完，42.6 秒／限流失败／51.9 秒；公开价估算 0.032 元，全程 5 秒未达标，尚未更换模型。结果见 V1.1 阶段 3《真实全链路测速报告》。此前“待授权／待验”为当时状态；本次授权已用完。

2026-09-21 最新增量：默认上传后自动为主要对象生成，完成后可纠正对象／特征（新建草稿与伙伴，保留原伙伴）；改名不重绘。仅为首位主体生成短构思，并显示上传到最终图片加载后的总时间。后端 382/382、前端 105/105、类型/Lint/构建通过。**真实全程 5 秒目标尚未达成，付费测速待授权。**

固定流程 C 端 AI 应用的后端。R1 打通「三场景 + 养成/收纳/撤销内核」；R2 接入「手机号验证码登录与会话、伙伴账号归属与后端隔离、独居/同住与成员、位置、多场景 HTTP API、旧花园迁移」。

## 当前生成优化（2026-09-21）

当前正常新照片链路为视觉分析并构思角色 → 用户确认 → 根据完整文字设定绘图；构思完整且未修改时，模型请求由此前三次减为两次。用户修改依据或旧结果无构思时补充一次文字构思。`CHARACTER_BUNDLE_ENABLED=true` 默认启用；设为 false 可恢复原分拆方式。合并结果仍必须通过字段与长度校验，失败不自动补发另一轮生成；只有完整文字和形象均保存成功才发布伙伴。

`VISION_MAX_EDGE=2048` 控制识别副本长边（512–4096），小图不放大，原图输入仍须满足 10MB/4096px 限制；设为 4096 恢复原像素上限。原图不落盘、元数据清除、最终形象 1024×1024 均保留。细小物件识别效果待真实样例验证。

识别/文字与图像请求不再自动重试读取超时、断连或确定的 4xx 错误；429/5xx/连接建立失败仍按 `MODEL_MAX_RETRIES` 有限重试。连接建立最多等待 10 秒，读取时间保留已有配置，避免把正常慢生成直接截断。普通聊天流沿用原有策略。

应用日志新增 `generation_timing` 结构化记录：阶段、内部操作 ID、毫秒数、成功/失败；不记录照片、提示词、用户文本、接口 URL 或密钥。阶段包括 `photo_prepare`、`recognition`、`profile`、`image`、`creation_total`；回退模式另有 `opening`。本地 8020 当前日志在项目 `.runtime/backend-8020.log`；其他启动方式记录在该进程标准输出。

提速优化时后端 335/335、前端 82/82 通过；当前含分析构思链路增量为后端 379/379、前端 101/101。离线验证：`.venv/bin/python -m pytest -q tests/test_generation_optimization.py`；完整验证仍运行 `pytest -q`。真实速度与合并输出质量尚未实测，付费调用继续暂停。详见[生成提速优化报告](../docs/PRD/版本/V1.1/验收证据/阶段3/生成提速优化报告.md)。

## 照片特征驱动形象（2026-09-21）

识别返回每个对象的 `visual_features`；创建请求可传同名字段（最多 500 字），省略保留原特征、空字符串清空。出图使用确认后的对象、可见特征与性格，名字仅作称呼。成功后保存生成依据快照，改名不会重绘。

启动时自动幂等补齐 `objects.visual_features` 和 `characters.generation_brief_json`，保留旧数据。正式数据变更前先备份 SQLite；本地本轮备份位于 `data/backups/before-photo-features-20260921-165930.db`。无需删除数据库。

专项验证：`.venv/bin/python -m pytest -q tests/test_appearance_flow.py`；全量仍为 `.venv/bin/python -m pytest -q`。本轮为离线及 mock 联调，真实还原度与性格表现待验。见[开发与验证报告](../docs/PRD/版本/V1.1/验收证据/阶段3/照片特征生成开发与验证报告.md)。

## 首版 R1 场景与养成内核

模块位于 `app/living/`，提供确定性规则与事务存储。R1 仅内部验证，R2 已将其接到正式 HTTP（`app/api/living.py`），owner_id 来自会话。规则及契约见 [技术适配声明](../docs/PRD/版本/V1.1/技术文档/技术适配声明.md)。

在本目录运行 `.venv/bin/python -m pytest -q`：本轮 298/298 通过（原有 281 + R2 账号/多场景/迁移 17 项）。运行 `.venv/bin/python scripts/check_living.py`：临时库、两个独立进程检查成长/收纳/恢复，6/6 通过。报告见 [R1 证据](../docs/PRD/版本/V1.1/验收证据/阶段1/开发与验证报告.md)。

## R2 账号与多场景

- 手机号验证码登录：`POST /api/v1/auth/code`、`/auth/login`、`/auth/logout`、`/auth/me`。验证码只存哈希，5 分钟有效、60 秒限发、单日上限 10 次；短信发送走 `SmsProvider` 适配层，默认 mock，真实短信平台接入前需费用授权。
- 所有业务接口（characters/chat/scene/photos/living）统一要求 `Authorization: Bearer <token>`，按账号隔离；未登录 401，访问他人数据 404/403。
- 多场景 API：`/api/v1/living/spaces`（列表/创建/读取/操作/成员/删除）与 `/api/v1/characters/{id}/location`（位置）。详见 [第2阶段技术开发文档](../docs/PRD/版本/V1.1/技术文档/第2阶段技术开发文档.md)。
- 旧数据迁移：已有 `app.db` 先运行 `.venv/bin/python scripts/migrate_r2.py`（先备份再加列，幂等）；登录后 `POST /api/v1/auth/claim` 显式认领无主伙伴并转换旧花园为家庭庭院私人空间（不自动分配给首个登录用户）。
- 仅本地开发过渡：在 `.env` 设置 `DEV_AUTH_TOKEN` 后，可用该令牌访问一个本地开发账号；正式环境必须留空禁用。

## 启动

```sh
cd backend
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
test -f .env || cp .env.example .env  # 仅首次创建；保留已有模型配置
.venv/bin/python scripts/migrate_r2.py  # 已有库加账号列；新库可跳过
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8020
```

首次使用：登录（或配置 `DEV_AUTH_TOKEN` 过渡）后调用 `POST /api/v1/auth/claim` 认领历史无主数据并迁移旧花园。

## 验证

```sh
cd backend
.venv/bin/python -m pytest -q          # 后端测试（298 个，离线可跑）
node --test tests/test_ui.cjs          # 页面错误处理、提议恢复、并发与音效测试（13 个）
```

真实模型冒烟：配置真实 `MODEL_API_KEY` 后用真实照片走一遍验收界面，并记录模型、耗时、成本。

## 说明

- 第3子阶段最新工程验收：107项后端＋13项页面测试通过，Chrome确认/拒绝/撤销/刷新恢复通过。真实模型质量验收仍待完成，见`../docs/PRD/版本/V1.0/验收证据/阶段2-3/独立验收与修复报告.md`。
- 场景提议持久化于新增`scene_proposals`表（启动时自动建表），绑定角色和来源助手消息；新增`POST /characters/{id}/scene/proposals/{token}/confirm`及`.../reject`接口。`GET scene`和聊天`done`新增可空`proposal`字段，原`action`字段保留。
- 确认token只能执行一次，重复/失效返回409；拒绝不改变场景。撤销仅保留最近一步。小雨会解除氛围静音，Chrome需在用户点击时开启声音。

- 无 Key 时全部走 mock（占位结果），仅用于开发推进，不冒充真实模型验证。
- 数据存 `backend/data/app.db`（SQLite），角色图存 `backend/data/uploads/characters/`，均不入 Git。相对路径按后端目录解析，不随启动目录改变。
- 当前 MVP 使用单个服务进程，启动时将未完成的 `generating` 记录转为 `failed`，允许用户重试；不宣称自动续跑。暂不使用多 worker。
- 每个角色图使用独立文件名；旧版共享图片只有在最后一个引用删除后才清理。
- 原图只用于识别、不持久化，符合 PRD「原图临时用后删」。
- 角色图通过 `/uploads/` 路径访问；删除角色时同步删除其图片文件。
- 当前配置使用蚂蚁 MaaS：识别 `ling-3.0-flash-vl`、人设/开场白 `qwen3.8-flash`、文生图 `wan2.6-t2i`。Key 必须属于配置的服务商；不能把蚂蚁 Key 用到百炼地址。
- 文生图从 `IMAGE_BASE_URL` 调用 OpenAI 兼容 `/images/generations`；地址留空时回退到 `MODEL_BASE_URL`，当前两者均为 `https://maas-api.antdigital.com/v1`。配置文件仍为 `backend/.env`，修改后重启后端。
- 2026-09-18：文生图单次真实冒烟成功，1024×1024 PNG 保存成功，耗时 13.94 秒。平台标价 ¥0.016/张（不是实际账单）；记录及样图位于 `../docs/PRD/版本/V1.0/验收证据/阶段2-1/image-smoke/`。另一终端随后完成真实照片完整链路，角色「瓷暖」已保存；本次浏览器复核图片与收藏正常显示。
- 聊天与记忆：`messages`、`memories` 表随角色级联删除；聊天历史取最近 20 条注入上下文；手动记忆逐条注入 system；删除记忆/清空历史即生效。
- 聊天页面提供“清空历史”，保留手动记忆；生成中的旧回复在历史清空后不会写回。清空、返回收藏时会取消页面的旧请求；发送期间回车与按钮均不能重复发送。
- 模型流必须收到 `[DONE]` 才视为完成；断流/截断会报错，未完成的助手回复不落库。已输出文本后不自动重试，避免回复拼接重复；尚未输出文本的网络失败仍按配置重试。
- 本轮代码复验：68 项后端、7 项页面测试及 9 项独立探针通过；真实 8 条样例与人工质量评分待补齐，不能据此声明整体质量验收通过。见 `../docs/PRD/版本/V1.0/验收证据/阶段2-2/修复复验报告.md`。
- 建表当前用 `Base.metadata.create_all`（全新库无迁移历史）；Alembic 已在依赖中，后续表结构变更时再启用迁移。

## 分析构思与绘图（2026-09-21）

视觉模型在识别阶段返回每个对象的完整构思，保存在 `objects.character_concept_json`。缓存与对象描述、可见特征绑定；修改后失配则重新构思，绘图失败重试复用已持久化构思。图片只接收文字，生成依据包含形象设计描述；不以名称查找或拼接固定图片。

启动自动幂等补充可空列，不删除旧数据。主数据库迁移前备份为 `data/backups/before-photo-concept-20260921-173443.db`。旧识别记录不含构思，仍能通过补构思路径生成。`CHARACTER_BUNDLE_ENABLED=false` 可回退原分拆模式。

专项：`.venv/bin/python -m pytest -q tests/test_concept_pipeline.py tests/test_generation_errors.py`；全量 379 项通过。明确失败的安全日志标记为 `generation_failure`，包含阶段／原因分类／可选 HTTP 状态，不含异常原文。真实新链路效果待验，见[链路报告](../docs/PRD/版本/V1.1/验收证据/阶段3/分析构思链路开发与验证报告.md)。


## R3 场景一致性修复验证

开发规则见 V1.1《第3阶段技术开发文档》第 17 节。服务启动会幂等添加提议绑定列；living v1 完整存档显式兼容读取，下一次写入保存为 v2。旧 JSON 不删除，首次建立或读取私人庭院时导入一次，原有物件位置／收纳／成长保留。备份路径为项目 `.runtime/backups/`（不提交）。

本地打开 `http://127.0.0.1:3020/`，登录后进入伙伴 → 生活场景 → 家庭庭院。回聊天发送“种一棵树”并确认，再进场景应看到同一棵树。在庭院点击“下点小雨”及“开启声音”；“安静一会”停止雨声，“撤销一步”恢复上一步氛围。切换住处后，旧提议不能继续执行。

后端运行 `.venv/bin/python -m pytest -q`；前端运行 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build`。本轮分别 397／131 项测试通过，真实模型调用 0 次；上传到最终图片 5 秒目标仍未通过，不能据此启动 R4。


### V1.2 R7.5 候选性能评测准备

` .venv/bin/python scripts/compare_generation_candidates.py `默认仅输出计划，无网络调用。` .venv/bin/pytest -q tests/test_candidate_pilot.py `验证预算及证据保护。用户本轮选择仅手册和离线验证，未授权运行`--run`；真实调用和候选接入均未执行。详见[验证报告](../docs/PRD/版本/V1.2/验收证据/阶段7/R7.5性能评测准备与离线验证.md)。
