# AI万物伙伴 · 形象与动作演示

R8.21播放器修复：320px卡片与角色适配，动作图加载中有提示；失败或15秒超时可点“重新加载”。切换动作保持暂停状态，快速切换只显示最后选择。浏览器验证见[补验报告](../../docs/PRD/版本/V1.2/验收证据/阶段8/R8.20GitHub免费演示/播放器补验与修复报告.md)。

2026-10-02最新：Netlify账户暂停，按用户允许的免费GitHub路线发布独立公开静态仓库[ai-wanwu-companion-preview](https://github.com/Zkeery/ai-wanwu-companion-preview)。仅公开8份页面／生成图片文件；主项目不公开、不提交或推送。独立发布目录为本项目.runtime/github-pages-site，Pages为main根目录，平台HTTPS子域名为https://zkeery.github.io/ai-wanwu-companion-preview/，实际构建／访问核验见项目版本证据R8.20。此地址展示形象和动作，未接完整业务后端。Pages不应用_headers，仅页面适用CSP／Referrer元标签有效。

2026-10-02更新：用户采用Netlify Free。此目录保留既有路径；Netlify上传包单独整理到本项目.runtime/netlify-preview-publish，只复制HTML／CSS／JS、四张PNG和_headers，不上传本README、vercel.json、Git配置或其他目录。原Vercel配置可保留为备选，不代表Vercel已登录／发布。无构建、无API、无新增模型费；Netlify账号Free套餐／额度和实际HTTPS地址仍需核验。

此包独立于正式Next.js／FastAPI应用，仅展示已采用的蔓蔓静态形象和休息、散步、观察动作。未接聊天、上传生成、短信登录、用户数据或后台自动生活，不代表完整应用已上线。

无依赖、无构建命令、无环境变量。Vercel导入时选择Other框架、根目录为此包、构建命令留空、输出目录为`.`；仅使用免费的个人非商业Hobby及平台子域名。不得上传外层业务目录、数据库、密钥或原始照片。四张PNG是已采用生成资源的原字节，页面不发API或模型请求。

本地预览：先确认3071端口空闲，在此目录运行`python3 -m http.server 3071 --bind 127.0.0.1`，用浏览器打开`http://127.0.0.1:3071/`。切换三个动作并暂停／继续，检查320／390宽度和刷新。系统开启减少动态效果时默认暂停，可手动播放。开发者工具阻断某动作PNG时应显示错误和重试按钮，解除阻断后点“重新加载”恢复。公开Pages地址见上文，完整业务后端尚未接入。
