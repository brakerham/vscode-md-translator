# Changelog

All notable changes to the "Markdown AI Translator" extension are documented
in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-23

Initial release.

### Added

- Full-document Markdown translation rendered in a dedicated preview panel
  (opens in `ViewColumn.Beside`), reusing one panel per document.
- Structure-preserving translation pipeline built on a Markdown AST: code
  blocks, inline code, fence info strings, URLs, link targets, file paths,
  HTML tags, math formulas, Mermaid sources and front matter are never
  translated or modified.
- Bilingual mode with block-level pairing (paragraphs, headings, list items,
  blockquotes and table cells).
- Display modes: Source / Translated / Bilingual, switchable in the preview
  toolbar and configurable via the `translationMode` setting.
- Selection translation inside the preview webview: floating button near the
  selection and a floating result card with copy and close actions.
- "Translate Selection" command for Markdown source editors, with a
  code-block detection warning.
- OpenAI-compatible chat completions provider with configurable base URL,
  model, temperature, system prompt, source/target languages, timeout,
  concurrency, chunk size and retries.
- API key stored in VS Code SecretStorage (`Set API Key` / `Clear API Key`
  commands); never written to `settings.json`, never sent to webviews, never
  logged.
- Persistent translation cache (configurable TTL) so unchanged text is never
  re-translated; per-document re-extraction on edit only translates new or
  changed segments.
- Chunked translation with bounded concurrency, exponential-backoff retries,
  cancellation and per-request timeouts.
- Editor title-bar button (Markdown files only) and Command Palette commands.
- Activity Bar container with a lightweight sidebar view: API status, document
  translation progress and the latest selection translation.
- Mermaid diagram rendering (lazy-loaded bundle) and KaTeX math rendering in
  the preview.
- Sanitized HTML rendering, strict webview CSP with nonces, local image path
  resolution via `asWebviewUri`.
- Dark/light theme support via VS Code CSS variables; English and Simplified
  Chinese UI strings.
- Unit tests for Markdown extraction/rendering, translation service, provider
  request handling, caching, webview message routing, HTML template security
  and package.json consistency; automated Extension Development Host smoke
  test (`MDT_SMOKE=1`).
