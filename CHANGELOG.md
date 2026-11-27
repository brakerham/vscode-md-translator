# Changelog

## [0.1.0] — Release candidate

- Read Markdown in a dedicated VS Code preview with Source, Translated and Bilingual modes.
- Translate selections from the Markdown editor or the preview and copy results. Manage the current endpoint's key, view document progress and review the latest selection result from the Translation sidebar.
- Preserve Markdown structure with token-based extraction and rendering. Protect fenced and indented code, Mermaid source, recognized URLs and paths, front matter, and math from full-document translation.
- Translate through a configurable OpenAI-compatible Chat Completions endpoint. Bound concurrency within each document run with deadlines, retries and cancellation.
- Bind API keys to endpoints in VS Code SecretStorage. Users of earlier development builds need to enter their keys again for the endpoint they use.
- Isolate persistent cache entries by endpoint, model, prompt, language, segment kind, temperature and text. Discard partial results from failed or cancelled runs.
- Package the desktop extension, original icon and third-party notices as a local VSIX. Verify compilation, lint, Vitest and packaging in GitHub Actions.
