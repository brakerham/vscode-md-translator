# Marketplace Publishing Checklist

Checklist for publishing `markdown-ai-translator` to the Visual Studio
Marketplace. Nothing is published without explicit confirmation.

## Before the first release — confirm

- [ ] **Publisher id**: `package.json` currently uses the placeholder
      `"publisher": "brakerham"`. Confirm the real Marketplace publisher id
      (created at https://marketplace.visualstudio.com/manage) and update
      `package.json` and the extension id (`brakerham.markdown-ai-translator`).
- [ ] **License**: MIT is the current default — confirm the final choice and
      update `LICENSE` + `package.json` `license` field.
- [ ] **Name & branding**: display name "Markdown AI Translator" and all
      artwork are original placeholders. Confirm the final name, icon and
      gallery banner before publishing. Do not reuse third-party brands.
- [ ] **Screenshots**: capture real screenshots (light + dark) of the
      translation preview, bilingual mode and selection translation; add them
      to the README and the Marketplace listing.

## Automated checks (must all pass)

- [ ] `npm run compile` — no TypeScript errors.
- [ ] `npm run lint` — no lint errors.
- [ ] `npm run test` — all unit tests pass (no real API calls).
- [ ] Extension Development Host manual pass (see README "Local install &
      manual verification").
- [ ] `MDT_SMOKE=1 code --extensionDevelopmentPath=<repo>` produces a
      `smoke-report.json` where every check is `ok: true`.

## Packaging

- [ ] `npm run package` produces `markdown-ai-translator-<version>.vsix`
      without warnings about missing metadata.
- [ ] Inspect the VSIX contents (`vsce ls`): `dist/` (bundled extension +
      webview assets, KaTeX fonts, codicons), `package.json`, nls files,
      README/CHANGELOG/LICENSE, icons. No source, tests, node_modules or
      secrets.
- [ ] Install the VSIX locally and verify once more.

## Publishing

- [ ] Install credentials: `vsce login <publisherId>` (requires a personal
      access token with Marketplace publish scope for that publisher).
- [ ] Bump `version` in `package.json` + CHANGELOG entry per release.
- [ ] `vsce publish` (or `vsce publish minor`).
- [ ] Verify the listing on
      https://marketplace.visualstudio.com/items?itemName=<publisher>.markdown-ai-translator.

## GitHub

- [ ] Push the repository to https://github.com/brakerham/vscode-md-translator
      (source only; VSIX artifacts are gitignored).
- [ ] Optional: GitHub Actions CI running `npm run compile && npm run test`.

## Known limitations to document

- Translation quality depends on the configured model; small text runs are
  translated segment-by-segment (context is per request chunk).
- Raw HTML block *content* is protected (not translated) for safety.
- Selection translation of code is intentionally gated behind a warning.
