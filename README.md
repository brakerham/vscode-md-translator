# Markdown AI Translator

AI-powered immersive translation for Markdown documents in VS Code. Read
English technical documentation — README files, RFCs, API docs, architecture
notes — side by side with an AI translation, without ever touching the
original Markdown source.

- **Full-document translation** rendered in a dedicated preview panel next to
  your editor (like the built-in Markdown Preview, plus a translation).
- **Structure-preserving**: code blocks, inline code, URLs, link targets,
  file paths, HTML tags, math formulas, Mermaid sources and front matter are
  never translated, modified or broken.
- **Bilingual mode**: source and translation paired block by block
  (headings, paragraphs, list items, blockquotes, table cells).
- **Selection translation** inside the preview: select text, click the
  floating button, read the result in a floating card (copy / close).
- **Any OpenAI-compatible API**: OpenAI, Azure OpenAI, DeepSeek, Moonshot,
  Kimi, Ollama, LM Studio, and more.
- API key stored in VS Code **SecretStorage** — never in `settings.json`,
  never sent to the webview, never logged.

> This extension is an original product. It is not affiliated with any other
> translation tool; no third-party names, logos or brands are used.

## Requirements

- VS Code `1.95.0` or newer.
- Access to an OpenAI-compatible chat completions endpoint and an API key.

## Quick start

1. Install the extension (`markdown-ai-translator-*.vsix` → `Install from
   VSIX…`, or from the Marketplace once published).
2. Run **Markdown AI Translator: Set API Key** and paste your key.
3. (Optional) Adjust `markdownAiTranslator.apiBaseUrl` and
   `markdownAiTranslator.model` in Settings for your provider.
4. Open a Markdown file and click the **globe button** in the editor title
   bar — the translation preview opens beside your editor and starts
   translating.
5. Switch between **Source / Translated / Bilingual** in the preview
   toolbar; **Re-translate** re-runs the translation and bypasses the cache.

## Features in detail

### Full document translation

- Uses a Markdown AST (markdown-it), not string replacement: translatable
  text runs are extracted as segments with unique ids, sent to the model as
  structured JSON, and written back onto the same AST nodes.
- Long documents are **chunked** (configurable token budget) and translated
  with a bounded number of **concurrent requests**, with per-request
  timeouts, **exponential-backoff retries**, response validation and
  cancellation.
- Results are **cached locally** (configurable TTL). Editing the document
  re-extracts segments and only translates new or changed text — unchanged
  segments come from the cache, so typing never re-translates the whole
  document.
- The preview reuses one panel per document (opens in `ViewColumn.Beside`)
  and refreshes when the document changes.

### What is never translated

- Fenced code blocks and their language identifiers (including `mermaid`),
  inline code, URLs, link/image targets, file paths, HTML tags and their
  attributes, math formulas (`$…$`, `$$…$$`), Mermaid diagram sources and
  YAML front matter.
- Raw HTML blocks are sanitized before rendering.

### Selection translation

- In the preview: select text → floating **Translate** button appears near
  the selection → click → floating result card with **Copy** and **Close**.
  Selections inside code blocks are not offered a translate button.
- In the editor: run **Markdown AI Translator: Translate Selection**
  (context menu or Command Palette). If the selection looks like code, you
  are asked first. The result appears in the Translation sidebar and can be
  copied.

### Sidebar

An Activity Bar container (draggable to the Secondary Sidebar) shows API
status, the current document translation progress and your latest selection
translation.

## Commands

| Command | Description |
|---|---|
| `markdownAiTranslator.translateDocument` | Translate the current Markdown document (editor title-bar globe button). |
| `markdownAiTranslator.retranslateDocument` | Re-translate, ignoring the cache. |
| `markdownAiTranslator.translateSelection` | Translate the selected text in a Markdown editor. |
| `markdownAiTranslator.setApiKey` | Store an API key in SecretStorage. |
| `markdownAiTranslator.clearApiKey` | Remove the stored API key. |
| `markdownAiTranslator.openSettings` | Open this extension's settings. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `markdownAiTranslator.apiBaseUrl` | `https://api.openai.com/v1` | OpenAI-compatible base URL (e.g. `http://localhost:11434/v1` for Ollama). |
| `markdownAiTranslator.model` | `gpt-4o-mini` | Model name. |
| `markdownAiTranslator.sourceLanguage` | `auto` | Source language (`auto` detects). |
| `markdownAiTranslator.targetLanguage` | `简体中文` | Target language. |
| `markdownAiTranslator.systemPrompt` | technical-translation prompt | Customizable multi-line system prompt. `{sourceLanguage}` and `{targetLanguage}` are replaced at request time. |
| `markdownAiTranslator.temperature` | `0.3` | Sampling temperature. |
| `markdownAiTranslator.translationMode` | `translated` | Default preview mode: `translated`, `bilingual`, `source`. |
| `markdownAiTranslator.requestTimeout` | `60000` | Per-request timeout in milliseconds. |
| `markdownAiTranslator.maxConcurrency` | `3` | Maximum concurrent API requests. |
| `markdownAiTranslator.maxTokensPerRequest` | `4000` | Approximate token budget per request (chunk size). |
| `markdownAiTranslator.maxRetries` | `2` | Retries for failed/invalid responses (exponential backoff). |
| `markdownAiTranslator.cacheEnabled` | `true` | Cache translations locally. |
| `markdownAiTranslator.cacheTtlDays` | `30` | Cache retention in days. |

## Security model

- The API key lives only in `ExtensionContext.secrets` (VS Code
  SecretStorage); it is never written to `settings.json`, never included in
  the webview HTML or messages, and never logged.
- All API requests are made by the extension host; the webview cannot reach
  the network (`connect-src 'none'`).
- The preview webview uses a strict CSP with per-session nonces, sanitized
  HTML output, and `asWebviewUri` for local resources.

## Development

```bash
npm install          # see note below
npm run compile      # tsc --noEmit
npm run lint         # eslint
npm run test         # vitest (no real API calls)
npm run build        # esbuild bundle -> dist/
npm run package      # build + vsce package -> .vsix
```

- Dev host: F5 (`Run Extension (Dev Host)`) in VS Code, or
  `code --extensionDevelopmentPath=<this folder> sample/demo.md`.
- Automated dev-host smoke test:
  `MDT_SMOKE=1 code --extensionDevelopmentPath=<this folder>` — the
  extension self-checks configuration, SecretStorage, the Markdown
  pipeline, the translation service (fake provider, no network), webview
  HTML security, writes `smoke-report.json` and closes the window.
- Note: if your environment cannot reach `registry.npmjs.org`, the
  generated `package-lock.json` may reference `registry.npmmirror.com`
  tarball URLs; installs work from any network with access to that mirror.
  Regenerate the lockfile against the default registry with
  `npm install --registry=https://registry.npmjs.org`.

## Local install & manual verification

1. `npm run package` → `markdown-ai-translator-0.1.0.vsix`.
2. In VS Code: Extensions → `…` → *Install from VSIX…*.
3. Verify:
   - the globe button appears in the editor title bar **only** for
     Markdown files;
   - Set API Key stores the key (check that `settings.json` contains no key
     and the Output channel never prints it);
   - full translation, bilingual mode, mode switching, re-translate and
     cancel work;
   - code blocks, inline code, links, images, tables and math survive the
     translation;
   - selection translation works in the preview and in the editor;
   - editing the document refreshes the preview and only re-translates
     changed text.

## Marketplace status (pending items)

- **Publisher id** (`brakerham`): used as a placeholder — must be confirmed
  against the actual Visual Studio Marketplace publisher account before
  publishing.
- **License**: MIT is the default choice; confirm before the first release.
- **Icon**: current artwork is a placeholder; final branding is pending.
- Publishing credentials (`vsce login`) and a Marketplace publisher are
  required; nothing will be published without explicit confirmation.

See [docs/PUBLISHING.md](docs/PUBLISHING.md) for the full release checklist.

## License

[MIT](LICENSE)
