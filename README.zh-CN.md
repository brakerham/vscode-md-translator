# Markdown AI Translator

面向开发者的 Markdown AI 翻译 VS Code 扩展：在编辑器旁打开翻译预览，
用 AI 把英文技术文档翻译成中文（或任意目标语言），**完全不改动原始
Markdown 文件**。

- **全文翻译**：在独立预览面板中渲染译文，界面贴近 VS Code 原生
  Markdown Preview。
- **结构保护**：代码块、行内代码、URL、链接地址、文件路径、HTML 标签、
  数学公式、Mermaid 源码、Front Matter 一律不翻译、不修改、不破坏。
- **双语对照**：原文与译文按块配对展示（标题、段落、列表项、引用、
  表格单元格）。
- **划词翻译**：在预览中选中文本 → 出现浮动翻译按钮 → 浮动卡片展示
  结果（支持复制、关闭）；也支持在 Markdown 源码编辑器中翻译选区。
- **OpenAI 兼容 API**：兼容 OpenAI、Azure OpenAI、DeepSeek、Moonshot、
  Kimi、Ollama、LM Studio 等所有兼容服务。
- API Key 保存在 VS Code **SecretStorage** 中：绝不写入 `settings.json`、
  绝不发送给 Webview、绝不出现在日志里。

> 本扩展为独立原创产品，与任何其他翻译工具无关联，未使用任何第三方
> 名称、Logo 或品牌。

## 环境要求

- VS Code `1.95.0` 及以上。
- 可访问的 OpenAI 兼容 chat completions 接口及 API Key。

## 快速开始

1. 安装扩展（`markdown-ai-translator-*.vsix` →「从 VSIX 安装…」，发布后
   也可从 Marketplace 安装）。
2. 执行命令 **Markdown AI Translator: Set API Key**，粘贴你的 API Key。
3. （可选）在设置中修改 `markdownAiTranslator.apiBaseUrl` 和
   `markdownAiTranslator.model` 以适配你的服务商。
4. 打开一个 Markdown 文件，点击编辑器标题栏的**地球按钮**——翻译预览
   会在旁边打开并开始翻译。
5. 在预览工具栏切换 **原文 / 译文 / 双语** 模式；点击 **重新翻译**
   可绕过缓存强制重新翻译。

## 功能详解

### 全文翻译

- 基于 Markdown AST（markdown-it）而非字符串替换：将需要翻译的文本
  片段提取为带唯一 ID 的段，以结构化 JSON 发给模型，再把结果回填到
  相同的 AST 节点上。
- 长文档自动**分块**（可配置 token 预算），**并发受限**请求，带单请求
  超时、**指数退避重试**、响应校验与取消。
- 结果**本地缓存**（可配置有效期）。编辑文档时只翻译新增或变化的文本
  段，未变化的段落直接命中缓存——输入过程中不会重复翻译整篇文档。
- 同一文档复用同一个预览面板（在 `ViewColumn.Beside` 打开），文档变化
  时自动刷新。

### 永不翻译的内容

- 围栏代码块及其语言标识（含 `mermaid`）、行内代码、URL、链接/图片
  地址、文件路径、HTML 标签及其属性、数学公式（`$…$`、`$$…$$`）、
  Mermaid 图源码、YAML Front Matter。
- 原始 HTML 块在渲染前会经过安全清洗（sanitize）。

### 划词翻译

- 预览内：选中文本 → 选区附近出现**翻译**按钮 → 点击后浮动卡片展示
  译文，支持**复制**与**关闭**；代码块内的选区不提供翻译按钮。
- 编辑器内：运行 **Markdown AI Translator: Translate Selection**（右键
  菜单或命令面板）。若选区疑似代码会先确认。结果显示在翻译侧边栏中，
  可一键复制。

### 侧边栏

Activity Bar 图标（可拖到 Secondary Sidebar 与 Claude Code、Codex 等
并排）提供 API 状态、当前文档翻译进度与最近的划词翻译结果。

## 命令

| 命令 | 说明 |
|---|---|
| `markdownAiTranslator.translateDocument` | 翻译当前 Markdown 文档（编辑器标题栏地球按钮）。 |
| `markdownAiTranslator.retranslateDocument` | 忽略缓存重新翻译。 |
| `markdownAiTranslator.translateSelection` | 翻译 Markdown 编辑器中的选中文本。 |
| `markdownAiTranslator.setApiKey` | 将 API Key 存入 SecretStorage。 |
| `markdownAiTranslator.clearApiKey` | 清除已保存的 API Key。 |
| `markdownAiTranslator.openSettings` | 打开本扩展的设置。 |

## 设置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `markdownAiTranslator.apiBaseUrl` | `https://api.openai.com/v1` | OpenAI 兼容接口地址（Ollama 用 `http://localhost:11434/v1`）。 |
| `markdownAiTranslator.model` | `gpt-4o-mini` | 模型名称。 |
| `markdownAiTranslator.sourceLanguage` | `auto` | 源语言（`auto` 自动检测）。 |
| `markdownAiTranslator.targetLanguage` | `简体中文` | 目标语言。 |
| `markdownAiTranslator.systemPrompt` | 技术翻译提示词 | 可自定义的多行 System Prompt；请求时替换 `{sourceLanguage}` 与 `{targetLanguage}`。 |
| `markdownAiTranslator.temperature` | `0.3` | 采样温度。 |
| `markdownAiTranslator.translationMode` | `translated` | 预览默认模式：`translated` / `bilingual` / `source`。 |
| `markdownAiTranslator.requestTimeout` | `60000` | 单请求超时（毫秒）。 |
| `markdownAiTranslator.maxConcurrency` | `3` | API 请求最大并发数。 |
| `markdownAiTranslator.maxTokensPerRequest` | `4000` | 每次请求的近似 token 预算（分块大小）。 |
| `markdownAiTranslator.maxRetries` | `2` | 失败/无效响应的重试次数（指数退避）。 |
| `markdownAiTranslator.cacheEnabled` | `true` | 本地缓存翻译结果。 |
| `markdownAiTranslator.cacheTtlDays` | `30` | 缓存保留天数。 |

## 安全模型

- API Key 仅保存在 `ExtensionContext.secrets`（VS Code SecretStorage）中：
  不写入 `settings.json`、不进入 Webview 的 HTML 或消息、不写入日志。
- 所有 API 请求由扩展宿主发起；Webview 无法联网
  （`connect-src 'none'`）。
- 预览 Webview 使用带一次性 nonce 的严格 CSP、渲染前 HTML 清洗、
  `asWebviewUri` 处理本地资源。

## 开发

```bash
npm install          # 见下方说明
npm run compile      # tsc --noEmit
npm run lint         # eslint
npm run test         # vitest（不消耗真实 API 额度）
npm run build        # esbuild 打包 -> dist/
npm run package      # 构建 + vsce 打包 -> .vsix
```

- 开发宿主：VS Code 中按 F5（`Run Extension (Dev Host)`），或
  `code --extensionDevelopmentPath=<本目录> sample/demo.md`。
- 自动冒烟测试：
  `MDT_SMOKE=1 code --extensionDevelopmentPath=<本目录>`——扩展会自动
  检查配置、SecretStorage、Markdown 管线、翻译服务（假 Provider，无网络）、
  Webview HTML 安全，写出 `smoke-report.json` 后关闭窗口。
- 说明：若你的网络无法访问 `registry.npmjs.org`，生成的
  `package-lock.json` 中的 tarball 地址可能指向 `registry.npmmirror.com`
  镜像；可访问该镜像的任何网络都能安装。需要时可用
  `npm install --registry=https://registry.npmjs.org` 重新生成。

## 本地安装与手动验证

1. `npm run package` → 生成 `markdown-ai-translator-0.1.0.vsix`。
2. VS Code：扩展面板 → `…` →「从 VSIX 安装…」。
3. 验证清单：
   - 地球按钮**仅**在 Markdown 文件的编辑器标题栏出现；
   - Set API Key 后密钥被安全保存（`settings.json` 中没有密钥、输出
     日志中不出现密钥）；
   - 全文翻译、双语对照、模式切换、重新翻译、取消均正常；
   - 代码块、行内代码、链接、图片、表格、数学公式在翻译后完好无损；
   - 预览内划词翻译与编辑器选区翻译正常；
   - 编辑文档后预览刷新，且只重译变化的部分。

## 发布状态（待确认事项）

- **Publisher**（当前占位为 `brakerham`）：发布前须与实际的 Marketplace
  发布者账号核对。
- **许可证**：暂用 MIT，首次发布前请确认。
- **图标**：当前为占位设计，正式品牌视觉待定。
- 发布需要 `vsce login` 与 Marketplace 发布者权限；未经最终确认不会
  向 Marketplace 发布。

完整发布清单见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 许可证

[MIT](LICENSE)
