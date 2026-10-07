# 果果的小花园 · H1 离线 Agent Demo

独立试验，未接入真实模型。`MockCompanionModel` 只覆盖推荐表达、部分同义词与否定/多动作样例；不能据此判断真实自由对话质量。运行器、工具分发、确认、SQLite 保存、重启恢复和撤销是真实执行的。

当前视觉按最新反馈采用淡紫淡粉背景、奶白卡片、柔和草绿花园；配色集中在 `static/warm-theme.css`。

## 打开

从项目根目录运行：

```sh
python3.12 demos/garden-agent/manage.py start
```

打开 <http://127.0.0.1:3030/>。需要本项目已有 `backend/.venv`，无需安装新依赖或填写 Key。仅监听本机，不用于正式多人上线。

## 单一入口体验

打开 [首页](http://127.0.0.1:3030/)，右上角只有一个“注册 / 登录”按钮。点击后出现轻量弹窗，选择“进入我的小世界”即可体验；没有独立注册页、登录页、昵称表单或体验验证码。弹窗可通过关闭按钮、Esc 或点击遮罩关闭。

进入后右上角变为“我的小世界”，点击可回到花园或退出。身份仅存在当前标签页 `sessionStorage` 中，刷新保留、退出清除，不创建后端用户，也不发送短信。花园继续按原 Demo Cookie 保存，退出不会删花园；前端显示体验区不构成真实权限控制。`account.html`、`account.css`、`account.js` 已按用户要求移除，旧直达链接不再使用。

首页视觉由 `dream.css` 补充：淡紫粉光晕、云朵、月牙、细小星点与伙伴主视觉；`access.js` 管理合并入口弹窗。沿用原场景与运行器。

## 试一遍

先按上面的流程进入花园。


1. 点击“添个能坐的地方”，看到果果查询花园并提出长椅建议，此时花园不变。
2. 选择“好，就这样做”，看到长椅出现，再展开“看看果果做了什么”。
3. 试试“添一点暖意”，选择“先不改”，营火不会出现。
4. 点击“撤销上一步”，长椅消失；也可在待确认时刷新页面继续。
5. “重新开始体验”只重置本 demo 花园，保留操作记录；正式伙伴数据不受影响。

树最多 7 棵、花丛最多 6、蘑菇最多 4，其余物件单份；沿用正式项目场景规则。雨只展示视觉效果，本原型不播放声音。

## 文件与接口

- `runtime.py`：可替换模型接口、受限循环、工具白名单、事务和状态恢复。
- `server.py`：独立 FastAPI 服务，所有输出错误采用 `{"error":{"code","message"}}`。
- `static/`：静态验收页面；苹果插画为本 demo 的 SVG 示意资产，不是付费模型生成。
- `.data/`：独立数据库、PID 与服务日志，已排除 Git。
- `demo.json`：端口和原型预算说明；运行器预算常量固定为 3 轮模型、3 次工具，每轮最多一项提议。

| 接口 | 请求 | 响应 |
| --- | --- | --- |
| GET `/api/state` | 浏览器会话 Cookie | 花园、版本、可撤销状态、最近运行和步骤 |
| POST `/api/chat` | `text`、`request_key` | 同上；请求标识防重复 |
| POST `/api/decide` | `run_id`、`proposal_id`、`decision: confirm/reject` | 同上；重复确认只回读 |
| POST `/api/garden` | `action: undo/reset` | 同上；旧待确认提议取消 |

工具只允许 `get_companion_context({})`、`get_garden_state({})`、`propose_garden_action({action,reason})`。确认执行不暴露为模型工具。JSON 请求立即完成，失败后用状态接口核对；不修改正式项目 SSE 接口。

## 检查

```sh
cd demos/garden-agent
../../backend/.venv/bin/python -m unittest -v test_runtime
node --check static/app.js
```

模拟适配器不访问网络且立即返回；运行器设置轮数、参数和回合耗时边界。将来接真实模型时必须在模型传输层另外实现可中断超时、token/费用上限并验证工具协议，不能直接将本 demo 作为生产调用器。

## 停止或撤回

```sh
python3.12 demos/garden-agent/manage.py stop
```

用户明确不认可后，由 AI 停止服务，删除本目录和本次 H1 demo 证据，更新导航与状态，再询问需要调整的方向。不要删除主项目 `backend/`、`frontend/` 或已有数据。用户未确认前不推进真实模型或正式集成。
