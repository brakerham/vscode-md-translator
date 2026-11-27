# Windows entry point for the same checks used by GitHub Actions.
param(
  [ValidateSet('all', 'install', 'compile', 'lint', 'test', 'build', 'package')]
  [string]$Stage = 'all'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $repo
try {
  if ($Stage -in 'all', 'install' -or !(Test-Path -LiteralPath 'node_modules/.bin/vitest.cmd')) {
    npm ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  if ($Stage -eq 'install') { return }

  $checks = if ($Stage -eq 'all') { @('compile', 'lint', 'test', 'build') } else { @($Stage) }
  foreach ($check in $checks) {
    npm run $check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
} finally {
  Pop-Location
}
