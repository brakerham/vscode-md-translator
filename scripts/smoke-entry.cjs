const { readFile } = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function run() {
  if (process.env.MDT_SMOKE !== '1') throw new Error('Set MDT_SMOKE=1 before starting the smoke test.');
  const extension = vscode.extensions.getExtension('brakerham.markdown-ai-translator');
  if (!extension) throw new Error('Development extension is missing.');
  const reportPath = path.join(extension.extensionPath, 'smoke-report.json');
  const startedAt = Date.now();
  await extension.activate();
  while (Date.now() - startedAt < 45000) {
    const reportText = await readFile(reportPath, 'utf8').catch(() => undefined);
    if (reportText) {
      const report = JSON.parse(reportText);
      const checks = Object.entries(report.results);
      if (Date.parse(report.ranAt) >= startedAt && checks.length > 0) {
        const failures = checks.filter(([, result]) => !result.ok);
        if (failures.length) throw new Error(JSON.stringify(failures));
        console.log('Markdown AI Translator smoke passed: ' + checks.map(([name]) => name).join(', '));
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Smoke report was not written before the deadline.');
};
