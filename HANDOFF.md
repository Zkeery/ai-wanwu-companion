# AI万物伙伴 · Cursor 开发交接

更新时间：2026-10-26。先读本文件，再读 `AGENTS.md`、`project.json` 和 `docs/项目状态.md`。本文件记录本次交接时的代码与发布状态；旧文档中的历史“已通过”不能用于关闭新的故障。

## 1. 项目是做什么的

把用户拍摄的日常物品转成有形象、名字和性格的 AI 伙伴，支持聊天与记忆、私人生活场景、多人共同住处和场景布置。共同住处包含三维伙伴、院子/客厅/卧室、生活动作、家具与楼层同步。

项目源码仓库：<https://github.com/Zkeery/ai-wanwu-companion>。

这台电脑上的完整项目目录：

```text
/Users/zoe/Documents/happy/项目开发必备文档/projects/AI万物伙伴
```

直接在 Cursor 选择“打开文件夹”并选择此目录，即可保留现有本地配置、数据和历史证据。重新克隆 GitHub 只取得源码，不包含本机或服务器数据库、上传文件、密钥及 `.runtime/`。

## 2. 技术栈与运行方式

| 部分 | 当前实现 |
| --- | --- |
| 前端 | Next.js 16.3.5、React 19.3.0、TypeScript 6、Tailwind CSS 4 |
| 三维场景 | Three.js 0.186.1，确定性导航、碰撞、动作/生活/楼层状态机 |
| 后端 | Python 3.12、FastAPI、Uvicorn、Pydantic Settings |
| 持久化 | SQLAlchemy、SQLite、上传文件及独立配额/任务账本 |
| 模型接入 | 后端 HTTP 适配；识别、生图、聊天、语音与动作各自受配置和授权约束 |
| 测试 | Vitest、Testing Library、pytest；本轮楼层回放使用合成渲染器及脱敏夹具 |
| 生产 | 火山引擎 ECS，Nginx、systemd、Next.js standalone；同服务器其他项目有独立目录和服务 |

不需要共享蓝图工具才能启动业务。模型调用不是运行前端场景或免费动作的必要条件。

## 3. 目录结构

```text
AI万物伙伴/
├── HANDOFF.md                 # 本次交接、运行及发布停点
├── AGENTS.md / project.json   # 开发规则与本项目端口
├── backend/
│   ├── app/api/               # 登录、伙伴、聊天、生活、共同住处、楼层等 API
│   ├── app/core/              # 配置、数据库及幂等结构补充
│   ├── app/living/            # 生活、共同住处、麻将、楼层和世界存档
│   ├── app/services/          # 模型/语音/动作、额度、恢复与验收约束
│   ├── scripts/              # ECS 入口、备份、维护与受限验收工具
│   ├── deploy/               # HTTPS、备份、通知和外部可用性模板
│   ├── tests/                # 后端回归测试
│   ├── requirements*.txt
│   └── .env / data/           # 本地私有配置与数据，不进 Git
├── frontend/
│   ├── app/                  # 页面、样式及 Next.js 路由
│   ├── components/           # 业务界面与生活场景接线
│   ├── lib/                  # 契约、状态、三维世界、导航与生活引擎
│   ├── public/               # 场景贴图、动作预览及本地声音资源
│   ├── tests/                # 前端回归及合成/脱敏夹具
│   └── package.json / package-lock.json
├── deploy/ecs/shared-host/   # 当前共用 ECS 布局的服务与 Nginx 模板
├── docs/PRD/版本/V1.2/       # 当前需求、技术文档及历史验收资料
├── docs/项目状态.md           # 历史状态与待验记录
├── .runtime/                # 本机执行记录、隔离候选、失败现场；不进 Git
└── data/、logs/              # 本机旧版资源及日志；不进 Git
```

本次先将已存在但未提交的应用源码、测试、资源和部署模板纳入 Git，再单独记录二楼修复。大量本地历史文档/现场证据仍保留在原目录，没有整体公开上传；引用 `.runtime/` 的记录只能在原电脑查看。

## 4. 本地启动

需要 Python 3.12 和 Node.js 22 或更高版本。先检查 `8020`、`3020` 是否已被现有进程使用，不结束其他项目服务。

后端，在项目根目录打开终端：

```bash
cd backend
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
test -e .env || cp .env.example .env
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8020
```

前端，另开终端，从项目根目录执行：

```bash
cd frontend
npm ci
test -e .env.local || cp .env.example .env.local
npm run dev
```

本地入口：<http://127.0.0.1:3020>。后端接口文档：<http://127.0.0.1:8020/docs>。按 `project.json` 保持本项目端口。

配置读取以代码为准：`backend/app/core/config.py` 的 Settings 默认读取 `backend/.env`，进程环境优先；根目录 `.env` 不会自动变成后端 Settings 的配置。前端由 Next.js 加载 `frontend/.env.local`。已有文件不要覆盖。未配置模型凭证时，普通识别/生成/聊天走模拟分支；已有本地配置可能包含真实模型凭证，运行前先核对模式。

本机模拟登录如需固定验证码，可在后端与前端分别配置 `DEV_SMS_FIXED_CODE` 和 `NEXT_PUBLIC_DEV_SMS_CODE`，两者一致。不要把开发登录提示或预览开关带进生产。可选语音识别、云存储、短信依赖分别见 `requirements-asr.txt`、`requirements-cloud.txt`、`requirements-sms.txt`，基础运行不要求安装全部可选依赖。

### 验证命令

```bash
cd frontend
npm run typecheck
npm test -- tests/floor-stair-courtesy-replay.test.ts --no-file-parallelism
npm run build
```

新克隆尚未生成 Next.js 类型时，先执行 `npx next typegen` 再做 TypeScript 检查。生产构建会拒绝开发登录提示和离线预览配置；应在独立候选目录按部署配置构建，不覆盖本机预览配置。

后端选定测试从 `backend/` 执行 `.venv/bin/python -m pytest -q tests/目标文件.py`。不要一边接真实生产配置，一边运行会写入数据的测试或启动恢复任务；测试使用独立数据和网络隔离。本次交接没有重新验证全部历史测试。

## 5. 部署到火山引擎 ECS

本次任务仅提交源码与交接文档，没有继续生产发布。当前生产布局以 `deploy/ecs/shared-host/` 为准；`deploy/ecs/` 中 `/srv/ai-companion` 的通用旧模板不等于当前服务器路径。

| 对象 | 当前部署布局 |
| --- | --- |
| 服务器 | `101.96.210.187` |
| 公网入口 | `https://101.96.210.187/partner` |
| 应用源码 | `/opt/wanwu-partner/app/backend`、`/opt/wanwu-partner/app/frontend` |
| 数据与文件 | `/opt/wanwu-partner/data` |
| 私有候选 / 回退副本 | `/opt/wanwu-partner/private`、`/opt/wanwu-partner/backups` |
| 后端私有配置 | `/etc/wanwu-partner/.env` |
| 前端配置 | `/etc/wanwu-partner/frontend.env` |
| 后端服务 | `wanwu-partner-backend.service`，本机回环 `8020` |
| 前端服务 | `wanwu-partner-frontend.service`，本机回环 `3020` |
| 后端生产入口 | `scripts.ecs_partner_serve:app` |
| 前端启动目录 | `/opt/wanwu-partner/app/frontend/.next/standalone` |
| 前端 Node | `/opt/wanwu-partner/runtime/node/bin/node` |

部署流程：

1. 使用已授权的 SSH 身份连接，核对主机和伙伴服务。SSH 私钥不在 Git 内，不能上传或从其他项目复制凭证。先只读确认当前构建、源码清单、数据完整性、业务表/结构、后端服务身份和配置哈希。
2. 为本次发布建立唯一候选目录，保存完整旧源码、完整旧构建及已校验的数据快照。SQLite 使用 backup API 处理 WAL，不在活跃库上直接拷贝主文件，也不通过恢复旧库来发布前端。相关工具见 `backend/scripts/ecs_verified_snapshot.py`、`ecs_backup_once.py` 和 `ecs_runtime.py`，先读其帮助和前置条件。
3. 在隔离候选目录准备源码与依赖，不覆盖生产数据目录。前端执行 `npm ci`，加载专用于前端的部署配置后执行 `npm run build`。`NEXT_PUBLIC_BASE_PATH` 必须匹配上表公网前缀；`BACKEND_URL` 指向本项目后端。Next.js 的公开配置在构建时固化，仅改 systemd 环境并重启不能更新前端包。
4. standalone 运行包需要同时包含 `standalone`、`public` 和对应构建的静态资源。用合成数据、隔离网络及候选端口检查 Linux 启动、楼层回放、页面和资源；候选检查不能触发真实模型。
5. 重新采集稳定数据基线，将候选文件哈希、构建 ID、通过的检查及回退副本绑定为同一发布记录。校验不一致时停止，不能删除保护条件或套用旧基线。
6. 只切换已审核的前端候选，然后重启 `wanwu-partner-frontend`。本次二楼修复不需要替换后端、Nginx、数据库或配置。保留旧静态资源，避免已打开标签页引用的资源丢失。若以后有独立后端变更，另行设计数据迁移与发布范围。
7. 切换后核对公网 `/partner`、当前构建及所有脚本/贴图资源，确认业务数据、结构、后端和配置保持；模型调用增量应为零。技术检查通过后，再做手机同页连续上楼、长椅恢复与双方刷新保持的真人验收。

常用只读检查：

```bash
systemctl status wanwu-partner-backend wanwu-partner-frontend --no-pager
journalctl -u wanwu-partner-frontend -n 80 --no-pager
curl -fsS http://127.0.0.1:8020/healthz
curl -I http://127.0.0.1:3020/partner
```

服务器同时运行其他项目。只处理 `/opt/wanwu-partner` 和伙伴单元；保留其他项目、原魔搭源站及全部数据。付费模型、短信、自动生活与异地备份有独立授权，提交或部署前端不构成这些授权。

## 6. 环境变量（仅列名称，不列值）

后端核心字段来自 `backend/app/core/config.py`；其他变量来自应用、ECS 入口与部署示例。不是所有变量都要设置，可选能力按对应模块启用。实际私有配置由本机/服务器持有，Git 中仅有示例。任何凭证都不得使用 `NEXT_PUBLIC_` 前缀。

| 用途 | 变量名 |
| --- | --- |
| 基础与存储 | `APP_ENV`、`DATABASE_URL`、`UPLOAD_DIR` |
| 识别/生图/聊天 | `MODEL_BASE_URL`、`IMAGE_BASE_URL`、`MODEL_API_KEY`、`VISION_MODEL`、`IMAGE_MODEL`、`CHAT_MODEL`、`MODEL_TIMEOUT_SECONDS`、`MODEL_MAX_RETRIES`、`MODEL_ENABLE_THINKING`、`CHAT_ENABLE_THINKING`、`VISION_ENABLE_THINKING`、`MODEL_HTTP_POOL_ENABLED`、`GENERATION_TIMING_LOG`、`CHARACTER_BUNDLE_ENABLED`、`VISION_MAX_EDGE`、`SCENE_AGENT_ENABLED`、`GENERATION_QUOTA_ENABLED` |
| 登录与短信 | `AUTH_MODE`、`SESSION_TTL_SECONDS`、`CODE_TTL_SECONDS`、`CODE_RESEND_SECONDS`、`CODE_DAILY_LIMIT`、`CODE_MAX_ATTEMPTS`、`DEV_AUTH_TOKEN`、`DEV_SMS_FIXED_CODE`、`LEGACY_CLAIM_USER_ID`、`SMS_PROVIDER`、`SMS_LIVE_ENABLED`、`SMS_ACCESS_KEY_ID`、`SMS_SECRET_ACCESS_KEY`、`SMS_ACCOUNT`、`SMS_SIGN`、`SMS_TEMPLATE_ID`、`SMS_DAILY_LIMIT`、`SMS_TIMEOUT_SECONDS` |
| 生活与预览 | `LIFE_SIMULATION_ENABLED`、`LIFE_RUNTIME_ENABLED`、`LIFE_RUNTIME_PREVIEW_ENABLED`、`LIFE_LIVE_PLANNER_PREVIEW_ENABLED`、`GATHERING_DIALOGUE_ENABLED`、`GATHERING_DIALOGUE_AUTOMATIC_ENABLED`、`COMPETITION_AI_ENABLED` |
| 动作与语音 | `MOTION_ATLAS_BASE_URL`、`MOTION_ATLAS_API_KEY`、`MOTION_GENERATION_ENABLED`、`MOTION_PREVIEW_ENABLED`、`VOICE_LOCAL_MODEL_PATH`、`VOICE_LIVE_REPLY_ENABLED`、`QWEN_TTS_API_KEY`、`QWEN_TTS_MODEL`、`WALK_WORKFLOW_ROOT` |
| 前端与构建 | `BACKEND_URL`、`NEXT_DIST_DIR`、`NEXT_PUBLIC_BASE_PATH`、`NEXT_PUBLIC_AUTH_MODE`、`NEXT_PUBLIC_AUTH_HEADER`、`NEXT_PUBLIC_DEV_SMS_CODE`、`NEXT_PUBLIC_OFFLINE_PREVIEW`、`NEXT_PUBLIC_LIFE_SIMULATION`、`NEXT_PUBLIC_LIFE_JOURNAL`、`NEXT_PUBLIC_LIFE_RUNTIME_ENABLED`、`NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW`、`NEXT_PUBLIC_LIFE_LIVE_PLANNER_PREVIEW`、`NEXT_PUBLIC_REAL_AI_LOCAL`、`NEXT_PUBLIC_GENERATION_DIAGNOSTICS`、`NODE_ENV`、`HOSTNAME`、`PORT`、`NODE_OPTIONS` |
| ECS 配额与受限验收 | `PARTNER_DAILY_QUOTA_DB`、`PARTNER_DAILY_REQUEST_LIMIT`、`PARTNER_ACCEPTANCE_MAAS_KEY`、`PARTNER_VOICE_TRIAL_LEDGER`、`PARTNER_LIFE_TRIAL_LEDGER`、`PARTNER_TRIAL_EVIDENCE_FILE`、`PARTNER_SHARED_DIALOGUE_TRIAL_LEDGER`、`PARTNER_SHARED_DIALOGUE_TRIAL_EVIDENCE_FILE` |
| 备份与维护 | `DATA_VOLUME_ID`、`LOCAL_MAINTENANCE_ENABLED`、`LOCAL_BACKUP_QUOTA_BYTES`、`CLOUD_SCHEDULE_ENABLED`、`CLOUD_BACKUP_AUTHORIZATION_REF`、`TOS_BACKUP_ENABLED`、`TOS_ACCESS_KEY_ID`、`TOS_SECRET_ACCESS_KEY`、`TOS_REGION`、`TOS_ENDPOINT`、`TOS_BUCKET` |
| 其他部署/可选工具 | `CLOUD_SERVICE_MODE`、`LD_LIBRARY_PATH`、`OPENAI_API_KEY`、`AIHUBMIX_API_KEY`、`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`MODEL_ID` |
| 本地 QA 假服务 | `QA_PORT`、`QA_STAGE1_FIXTURES`、`QA_PERSONA_DELAY`、`QA_ASSET_DELAY`、`QA_CHAT_CHUNK_DELAY` |

根目录的蓝图示例属于可选开发工具，不是当前业务运行依赖。通知、授权、账务等模块还会读取私有 JSON 文件，这些字段不是环境变量，不应把真实内容写进本交接文档。

## 7. 已有功能与验证边界

| 功能 | 当前代码状态与边界 |
| --- | --- |
| 物品转伙伴 | 已有上传、识别、形象/性格生成、保存、错误与刷新恢复路径；真实模型质量和耗时需按具体配置验收 |
| 账号与权限 | 已有登录、会话、邀请入口、私人资源与共同住处所有权限制；生产使用专门入口和额度约束 |
| 聊天与记忆 | 已有持续对话、流式回复、记忆管理、请求恢复与历史记录；未做本轮真实模型验证 |
| 私人及共同生活 | 已有三类场景、伙伴活动、布置/收纳/照料、持久世界、成员与事件记录 |
| 三维家园 | 已有院子、室内房间、门、家具、上下楼、服务端楼层同步、镜头/选择和生活动作；仍有本轮线上卡住故障待发布修复 |
| 休闲与社交 | 已有喝茶、长椅、电视、相聚和麻将等规则/动画；确定性对白与本地回放不能等同真实 AI 交流 |
| 动作与语音 | 可播放已有绑定素材，已有可选离线 ASR 和语音接口；正式语音回复、模型动作生成仍受独立验收与费用授权限制 |
| 运维 | 已有健康检查、额度保护、备份/恢复/通知等工具和模板；代码存在不证明每个任务已安装或启用 |

不把现有功能清单当成全产品验收通过。真实 AI 连续生活 24 小时、多人独立复核、自然音色和部分手机完整流程仍有待验项。旧的全链路 8 秒硬门槛已经撤销；当前需求以 V1.2 PRD 第 21 节为准，生图阶段约 10 秒的目标也不能冒充已实测达标。

## 8. 本次二楼修复

故障：共同住处发出上二楼睡觉指令后，楼层请求已保存，但接近楼梯的路线被长椅休闲伙伴和其他伙伴相互挡住，画面可能停住且没有等候提示。

运行代码改动仅在 `frontend/lib/living-world-engine.ts`：

- 连续目的旅程使用庭院真实可行走边界，同时保留墙体、家具碰撞和完整身体半径。
- 楼梯候梯请求复用双人礼让规划，先验证两位伙伴依次让路与请求者后续路线，再移动。
- 长椅伙伴可暂时让路；不取消其休闲安排，通行完成后返回原长椅。
- 上楼规划纳入坐定伙伴占位，并显示交通受阻时的等候提示；保留既有喝茶礼让入口。

新增：`frontend/tests/floor-stair-courtesy-replay.test.ts`、`frontend/tests/fixtures/floor-no-motion-shape-20261026.json`。测试从脱敏三伙伴/三物件布局回放，断言上楼到达、长椅伙伴回座、原休闲安排保留，并断言未调用外部传输。

本轮既有结果：网络隔离的 19 个指定前端测试文件共 108 项、楼层相关 19 项、资源检查 3 项，共 130 项通过；TypeScript 与生产构建通过。该结论仅覆盖选定范围，不是全量测试通过或手机真人通过。验证构建 ID：`a10ePXlWlJ0Jbt4KdJ6iS`。

## 9. 已知问题和下一步

1. **二楼补丁尚未上线。** 上次已部署构建为 `iwbNZ7dQsTGZHsXstqLqa`，本次交接没有重新在线核验或切换它。先修发布基线，再做候选验证和前端发布，不能直接宣布线上问题已解决。
2. **发布基线模板过期。** 两次只读基线在 `frontend_215_input_changed` 停止，未上传候选或切换服务。只读诊断显示当前远端 215 项前端运行文件与已部署清单一致，但复制的脚本内 `living-villa-life-plan.ts`、`living-world-engine.ts` 两条预期哈希仍旧。第二次尝试又取了旧的辅助清单，未真正纠正。下一步须从已部署 payload 清单重建新尝试并先在本地核对完整清单；保留两次失败，不取消保护断言。遵守同一步失败两次即停，后续发布需在新一轮明确授权范围内进行。
3. **源码提交不等于数据迁移。** 本机配置、SQLite、上传与额度账本以及服务器数据不进 Git。继续使用原目录可保留本机数据；换电脑需另做受控迁移与恢复验证。
4. **真实模型及付费能力仍待各自验收。** 不自动启用语音正式回复、真实交流/自动生活、24 小时任务或异地备份，也不重试已耗尽的授权。
5. 发布后依次检查：同页点击上楼并连续到床；其他伙伴安全让路并回到原休闲；双方账号同步；普通刷新恢复；手机实际画面。保留原失败和用户逐项判断，技术回放不能代替真人结论。

本机关键记录（均为保留现场，不是可直接运行的通用部署脚本）：

- `.runtime/floor-courtesy-fix-20261026/local-validation-plan.json`
- `.runtime/floor-courtesy-fix-20261026/isolated-validation-final-status.json`
- `.runtime/floor-courtesy-fix-20261026/release/` 与 `release-attempt-2/`
- `.runtime/floor-courtesy-fix-20261026/release-stop-20261026.md`
- 已部署清单：`.runtime/same-day-closeout-20261026/release/payload/runtime-expected.json`

Cursor 接手后的第一项建议：读完本文件，确认当前 Git 状态和上述失败记录；当前请求是源码交接，不包含恢复生产发布的授权。
