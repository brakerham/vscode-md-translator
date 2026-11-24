# mdt-dev.ps1 — Sandbox development helper for the Markdown AI Translator.
#
# The DSH sandbox throttles writes under the session workspace (~400 KB/s),
# which makes `npm install` into the project's node_modules impractically
# slow. The sandbox TEMP directory has no such throttle, so this script
# mirrors the project (excluding node_modules/dist) into TEMP, installs
# dependencies and runs compile/test/build there, then copies the small
# build outputs back to the workspace.
#
# Usage:
#   pwsh scripts/mdt-dev.ps1            # sync + install + compile + test + build
#   pwsh scripts/mdt-dev.ps1 test       # sync + install-if-needed + test
#   pwsh scripts/mdt-dev.ps1 build      # sync + install-if-needed + build
#
# In normal environments (no sandbox) simply use the npm scripts directly.
$ErrorActionPreference = 'Continue'
$src = 'E:\开发\CodeX\vscode-md-translator'
$proj = Join-Path $env:TEMP 'mdt-proj'
$stage = $args[0]

New-Item -ItemType Directory -Force -Path $proj | Out-Null

Write-Output "[mdt] syncing project to $proj"
robocopy $src $proj /MIR /XD node_modules dist .git .vscode .npm-cache sample /XF '*.vsix' 'smoke-report.json' 'install.log' 'wtest*' 'gen-assets.py' /NFL /NDL /NP /R:1 /W:1 | Out-Null
Write-Output "[mdt] sync done (exit $LASTEXITCODE)"
# vite bundles vitest.config.ts with its own esbuild, which spawns a child
# process; the CLI flags below replace the config entirely in this sandbox.
Remove-Item (Join-Path $proj 'vitest.config.ts') -ErrorAction SilentlyContinue

$cache = Join-Path $env:TEMP 'mdt-npm-cache'
$logs = Join-Path $env:TEMP 'mdt-npm-logs'

Push-Location $proj
try {
  $needInstall = !(Test-Path (Join-Path $proj 'node_modules\typescript\lib\tsc.js'))
  if ($needInstall -or $stage -eq 'install') {
    Write-Output '[mdt] npm install (temp)...'
    npm install --ignore-scripts --no-audit --no-fund --registry=https://registry.npmmirror.com --fetch-timeout=60000 --fetch-retries=2 --fetch-retry-maxtimeout=60000 --cache $cache --logs-dir $logs 2>&1 | Select-Object -Last 6 | Out-String | Write-Output
    if (!(Test-Path (Join-Path $proj 'node_modules\typescript\lib\tsc.js'))) {
      Write-Output '[mdt] FATAL: node_modules incomplete'
      exit 1
    }
  }

  if (!$stage -or $stage -eq 'compile') {
    Write-Output '[mdt] tsc --noEmit'
    node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
    if ($LASTEXITCODE -ne 0) { Write-Output '[mdt] compile FAILED' } else { Write-Output '[mdt] compile OK' }
  }

  if (!$stage -or $stage -eq 'test') {
    Write-Output '[mdt] tests via tsc-emit + node:test (sandbox)'
    # Vitest cannot run in the sandbox (Vite spawns esbuild helpers with pipe
    # stdio -> EPERM). Instead: compile src+test to JS with tsc (in-process),
    # shadow the 'vitest' import with the node:test shim, and run node --test.
    $testJs = Join-Path $proj '.sandbox-test-js'
    Remove-Item $testJs -Recurse -Force -ErrorAction SilentlyContinue
    node node_modules/typescript/bin/tsc -p scripts/sandbox-test/tsconfig.emit.json --outDir $testJs
    if ($LASTEXITCODE -ne 0) { Write-Output '[mdt] test-emit FAILED' } else {
      $shimDir = Join-Path $testJs 'node_modules\vitest'
      New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
      Copy-Item scripts/sandbox-test/vitest-shim/package.json (Join-Path $shimDir 'package.json') -Force
      Copy-Item scripts/sandbox-test/vitest-shim/index.js (Join-Path $shimDir 'index.js') -Force
      node --test --test-isolation=none (Join-Path $testJs 'test') 2>&1 | Select-Object -Last 70 | Out-String | Write-Output
    }
  }

  if (!$stage -or $stage -eq 'build') {
    Write-Output '[mdt] esbuild'
    node esbuild.mjs 2>&1 | Select-Object -Last 30 | Out-String | Write-Output
    if ($LASTEXITCODE -ne 0) { Write-Output '[mdt] build FAILED' } else { Write-Output '[mdt] build OK' }
  }

  if ($stage -eq 'package') {
    Write-Output '[mdt] vsce package'
    node node_modules/@vscode/vsce/vsce package --allow-missing-repository --no-dependencies 2>&1 | Select-Object -Last 15 | Out-String | Write-Output
    if ($LASTEXITCODE -ne 0) { Write-Output '[mdt] package FAILED' } else { Write-Output '[mdt] package OK' }
  }
} finally {
  Pop-Location
}

if (Test-Path (Join-Path $proj 'dist')) {
  Write-Output '[mdt] copying dist back to workspace'
  robocopy (Join-Path $proj 'dist') (Join-Path $src 'dist') /E /NFL /NDL /NP /R:1 /W:1 | Out-Null
  Write-Output "[mdt] dist copied (exit $LASTEXITCODE)"
}
if (Test-Path (Join-Path $proj 'package-lock.json')) {
  Copy-Item (Join-Path $proj 'package-lock.json') (Join-Path $src 'package-lock.json') -Force
}
Get-ChildItem (Join-Path $proj '*.vsix') -ErrorAction SilentlyContinue | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $src $_.Name) -Force
  Write-Output "[mdt] copied $($_.Name) back to workspace"
}
Write-Output '[mdt] done'
