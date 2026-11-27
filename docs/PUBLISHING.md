# Release guide

This repository builds the Markdown AI Translator desktop extension. The GitHub Actions workflow builds and retains downloadable VSIX artifacts for Windows and Ubuntu CI runs.

## Release checks

- Run `npm ci --ignore-scripts`, `npm run compile`, `npm run lint`, `npm test` and `npm run package` with Node.js 24. Review `npm audit` findings against the lockfile and bundled code.
- Review the Windows and Ubuntu checks for the same candidate commit before tagging it.
- Install the exact candidate VSIX in an isolated VS Code profile. Check the current desktop version and the minimum version declared in `engines.vscode`. Open [sample/demo.md](../sample/demo.md) and verify the sidebar, title-bar command, all three display modes, selection translation, cancellation, edits and two simultaneous document previews.
- For a no-network Development Host check, run **Smoke Test (MDT_SMOKE=1)** in VS Code. Verify `smoke-report.json` contains seven successful checks. The smoke runner uses a separate SecretStorage probe and a fake provider. It closes the development window when finished.
- For provider integration checks, record the provider, server version where applicable, model, date, and outcome. A mocked adapter test or demonstration can verify the protocol and UI. Only a request completed by the selected provider validates the real service/model pair.
- Review the English and Chinese README links, screenshots and GIF after the candidate branch is on GitHub. The current screenshots depict a real extension session with a local fake server.

## Inspect the VSIX

- Review `npm exec -- vsce ls --no-dependencies` and the generated archive. Expect the bundled extension, preview and sidebar assets, KaTeX fonts, codicons, localization files, both READMEs, icon, changelog, project license and `dist/THIRD-PARTY-NOTICES.txt`.
- Check that test code, development scripts, workspace configuration, source maps, development reports and credential files are absent.
- Use a local SHA-256 digest to identify the build being tested and approved. Archive the matching VSIX and verification summary with the release record.

## First release approval

- Verify ownership of the Visual Studio Marketplace publisher ID `brakerham` and availability of `brakerham.markdown-ai-translator`. GitHub ownership alone does not grant Marketplace publisher access.
- Confirm the existing MIT license, repository identity, display name and PNG icon with the maintainer. The checked-in upstream license files supplement npm packages that omit their license text. [Mermaid source license](https://github.com/mermaid-js/mermaid/blob/v10.9.8/LICENSE) · [micromark source license](https://github.com/micromark/micromark/blob/3.2.0/license)
- Align the manifest, lockfile, changelog and release tag with the intended version. This candidate keeps `0.1.0`.
- Once approved, create the GitHub release for the reviewed tag and attach the verified artifact. Follow the current official Marketplace publishing instructions for the already built and verified VSIX. [VS Code Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) · [Publisher management](https://marketplace.visualstudio.com/manage)
