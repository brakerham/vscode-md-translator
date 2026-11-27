# 发布前审计报告

审计基线为 brakerham/vscode-md-translator 的 main，提交 5f7e831，目标版本 0.1.0。

| 范围 | 基线发现 | 优先级 |
| --- | --- | --- |
| 发布清单 | 版本、最低 VS Code、仓库链接和 MIT 文件已存在，发布者归属待确认，图标仍标为占位，无 GitHub Actions，锁文件引用第三方镜像，已跟踪编辑器临时文件 | 发布前 |
| 配置和凭据 | 服务地址及缓存 TTL 在激活时固定。地址允许工作区配置，凭据为全局单一条目，HTTP 错误和无效响应内容可能进入日志或界面 | 必须修 |
| Markdown | markdown-it token 保留块结构与链接目标，但自动链接标签和普通正文中的路径会进入翻译。Markdown 链接显示文本、图像 alt 属于可翻译内容。紧凑列表的隐藏段落不能提供预览配对标记 | 必须修 |
| 并发与取消 | 每文档一面板，但取消吞掉状态更新，关闭回调可重入，首次强制刷新会丢失，重试期间取消分类不稳，失败后同批请求可继续写缓存 | 必须修 |
| 缓存 | 文本、模型、系统提示和语言参与键，服务地址、段落种类、温度和内置提示版本缺失 | 必须修 |
| Webview | 两套 CSP 与 HTML 清洗已存在。侧栏 nonce 使用 Math.random，预览允许远程图片发出 HTTP 请求。需约束本地链接及原始样式 | 必须修 / 文档 |
| 提供商 | 通用 Bearer Chat Completions 客户端，默认尝试 JSON 模式。README 将接口兼容性写成广泛已支持，源码无供应商端到端证明 | 必须修 |
| 测试 | 基线类型检查通过，85 个 Vitest 测试通过。Lint 因 no-unsafe-finally 两处失败。基线 VSIX 可构建 | 必须修 |
| 文档与演示 | 中英文文档、MIT LICENSE、变更日志和发布指南已有，范围、隐私和发布状态需纠正，缺实拍演示 | 发布前 |

## 修复与验证结果

| 事项 | 处理与证据 |
| --- | --- |
| README 功能核对 | 中英文 README 记录全文预览、三种显示模式、列表/引用/表格双语配对、划词、侧栏、编辑刷新、重译、取消、快捷入口和全部 13 项配置。自动检测由模型执行。并发上限按单个文档任务计算。无凭据的本地服务仍需提供一次性占位值供现有 Bearer 方式使用。 |
| Markdown 回填 | 用同一 token 树渲染原文和译文，按 ID 及文本范围回填并做 HTML 转义。结构保护覆盖围栏代码、链接目标、自动链接、常见路径、原始 HTML 块、YAML、数学和 Mermaid 源。紧凑列表保留双语配对标记。模型只接收预算估算内的段落批次，单个超长段单发，仍可能超出提供商上下文。 |
| 面板和并发 | URI 维持面板复用。新面板能保留强制重译选项。编辑、取消和关闭使旧任务失效，返回后检查运行代次。失败后取消同一任务的兄弟批次，其它文档可以继续。新启动的预览划词会取消该面板上一次未完成的划词请求。侧栏展示最近一次状态事件，多个文档的总体请求数可超过单任务上限。 |
| 缓存 | 缓存键使用 SHA-256 编码正文、段类型、地址、模型、温度、源/目标语言及提示词和内置协议版本。配置或文本变化会产生新键。整次任务后才写回，失败与取消不会写入半批次。TTL 配置即时读取，关闭缓存不立即擦除旧磁盘条目。 |
| 凭据与传输 | 地址仅应用用户级机器设置。HTTPS 支持远程服务，HTTP 仅允许环回。URL 不接受内嵌凭据、查询参数或片段。Key 按规范化端点写入 SecretStorage，请求按捕获的端点选择 Key，禁止 HTTP 重定向。旧未绑定凭据无法安全推断归属，需要用户重新录入。提供商原始错误响应和异常文本不会转发给日志或 Webview。 |
| CSP 和消息 | 两个 Webview 均使用随机 nonce 和 connect-src none。侧栏命令按允许列表。预览限制选区长度、模式值、打开链接的协议及相对路径范围。原始 HTML 与译文通过 HTML 清洗，限制允许的 CSS 属性和数据图片类型。远程图片仍可从预览直接请求，其网络行为已写入隐私说明。 |
| 依赖和可分发资产 | 更新 markdown-it、KaTeX、Vitest、esbuild 及打包间接依赖，数学插件替换为 markdown-it-texmath，保留 markdown-it、KaTeX 和 Mermaid 渲染结构。依赖安装使用官方 npm registry，构建收集实际打包依赖的许可证。保留项目 MIT LICENSE。正式 PNG 为 256×256。两张截图和五帧 GIF 采自 VS Code，译文来自本机固定响应。 |
| 清单与 CI | VSIX 清单为 brakerham.markdown-ai-translator 0.1.0，engines.vscode ^1.95.0，Other 分类。修复 Webview 侧栏贡献的 id/type，核对图标、仓库、Issues、许可证、语言资源、入口文件和演示资源。GitHub Actions 在 Windows/Ubuntu 上安装、类型检查、Lint、运行 Vitest 和构建 VSIX，产物保留在 Actions，发布需要独立批准。 |

## 兼容性证据

| 提供商 | 证据状态 |
| --- | --- |
| OpenAI | 已核对 Chat Completions 协议，实服务未测。[官方接口](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) |
| DeepSeek | 已核对 Chat Completions 和 JSON 模式，实服务未测。[官方接口](https://api-docs.deepseek.com/api/create-chat-completion) |
| Moonshot / Kimi | 已核对开发平台，兼容候选，实服务未测。[官方平台](https://platform.kimi.ai/) |
| Ollama | 已核对 OpenAI 兼容接口，实际服务和模型未测。[官方接口](https://docs.ollama.com/api/openai-compatibility) |
| LM Studio | 已核对 OpenAI 兼容端点，实际服务和模型未测。[官方接口](https://lmstudio.ai/docs/developer/openai-compat) |
| Azure OpenAI | 需要查询参数、Azure 专用请求头或令牌刷新的部署超出当前适配器范围。实服务未测。[官方接口](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle) |

通用请求协议通过 Vitest 的注入 fetch 和 VS Code 1.147.0 到本机模拟服务的真实 HTTP 请求验证。未使用真实 API Key。

## 测试执行记录

| 检查 | 结果 |
| --- | --- |
| npm ci --ignore-scripts | 通过，干净安装 547 个包 |
| npm audit | 通过，基线 11 条已知公告，最终锁文件 0 条 |
| TypeScript / ESLint | 均通过 |
| Vitest 5.1.1 | 11 个测试文件，95 个测试通过 |
| VS Code 1.147.0 开发宿主 smoke | 7/7 通过，包含 SecretStorage 探针、Markdown 提取与渲染、模拟翻译服务和 Webview 检查 |
| VS Code 1.147.0 真实窗口 | 已观察侧栏、标题栏预览入口、全文翻译、原文/译文/双语切换和预览划词。模拟服务记录全文和划词请求 |
| Windows VSIX 构建、压缩包验证、隔离安装 | 通过。85 个文件，4,410,141 字节。最终 SHA-256 为 607e594b9aed356dc83be6f100b8b895d9bc236dd50f4c9c3164647a17852642 |
| 文档相对链接、截图、GIF | 本地链接目标存在。PNG 及五帧 GIF 已检查 |
| VS Code 1.95.0 实机 | 2026-11-27 通过。官方 ZIP 经 SHA-256 核验，候选 VSIX 隔离安装成功，开发宿主 smoke 7/7 通过 |
| GitHub Actions 托管运行 | 未运行，改动仅在本地 |
| 实际提供商及模型 | 未运行，支持范围按协议核对记录 |
| Mermaid 图形实机专项及多面板手工复验 | 未运行，已有 bundle/结构检查和面板集成测试 |

## Release 判定

**可交付本地候选版本。正式 Marketplace 发布条件尚未全部满足。**

发布前应由维护者核对 Marketplace 发布者归属与扩展 ID 可用性，并获得同一候选提交的托管 CI 结果。最低声明版本已完成隔离安装和 smoke 验收。真实供应商联调尚未形成证据，发布文案保留这一限制。候选版代码和 VSIX 留在本地，未推送、未打 Tag、未上传。VSIX 的 Marketplace README 会链接 GitHub 默认分支上的截图和演示资源。默认分支公开可访问这些资源后，再检查上架页面链接。

## 仓库工具备注

Windows 本地开发入口已改用当前检出路径及原版 npm 脚本，失败退出码会传给调用方。历史 Git Data API 一次性推送脚本仍有固定路径和远端，既未执行，也不在 CI、VSIX 或发布指南的执行链中。Marketplace 发布者的归属仍需从管理页确认。
