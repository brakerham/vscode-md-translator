# One-off: push the committed tree to GitHub via the git data API.
# Used because sandboxed git cannot spawn credential helpers (pipe EPERM).
# The token never appears: gh authenticates from its keyring.
$ErrorActionPreference = 'Stop'
$root = 'E:\开发\CodeX\vscode-md-translator'
$owner = 'brakerham'
$repo = 'vscode-md-translator'
$branch = 'main'
$tmp = Join-Path $env:TEMP 'mdt-gh-push'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Set-Location $root
$files = git ls-files
Write-Output "[push] $($files.Count) files"

$authorName = git config user.name
$authorEmail = git config user.email

# 0) Empty repos reject the git-data endpoints (HTTP 409); seed one commit
#    through the contents API first (creates the default branch too).
$seedSha = gh api "repos/$owner/$repo/git/refs/heads/$branch" --jq '.object.sha' 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Output '[push] seeding initial commit via contents API'
  $seedBytes = [IO.File]::ReadAllBytes((Join-Path $root 'README.md'))
  $seedBody = @{
    message = 'Initial commit'
    content = [Convert]::ToBase64String($seedBytes)
    encoding = 'base64'
  } | ConvertTo-Json -Compress
  $seedFile = Join-Path $tmp 'seed.json'
  [IO.File]::WriteAllText($seedFile, $seedBody, [Text.UTF8Encoding]::new($false))
  $seedSha = (gh api --method PUT "repos/$owner/$repo/contents/README.md" --input $seedFile --jq '.commit.sha').Trim()
  Write-Output "[push] seed commit $seedSha"
} else {
  $seedSha = $seedSha.Trim()
  Write-Output "[push] existing branch tip $seedSha"
}

# 1) Blobs (one API call per file, body via --input to avoid arg-length limits).
$blobs = @{}
$i = 0
foreach ($f in $files) {
  $i++
  $full = Join-Path $root ($f -replace '/', '\')
  $bytes = [IO.File]::ReadAllBytes($full)
  $b64 = [Convert]::ToBase64String($bytes)
  $body = @{ content = $b64; encoding = 'base64' } | ConvertTo-Json -Compress
  $bodyFile = Join-Path $tmp ("blob-$i.json")
  [IO.File]::WriteAllText($bodyFile, $body, [Text.UTF8Encoding]::new($false))
  $sha = (gh api --method POST "repos/$owner/$repo/git/blobs" --input $bodyFile --jq '.sha').Trim()
  $blobs[$f] = $sha
  if ($i % 20 -eq 0) { Write-Output "[push] blobs $i/$($files.Count)" }
}
Write-Output '[push] blobs done'

# 2) Tree
$tree = @()
foreach ($f in $files) {
  $tree += @{ path = $f; mode = '100644'; type = 'blob'; sha = $blobs[$f] }
}
$treeBody = @{ tree = $tree } | ConvertTo-Json -Depth 5 -Compress
$treeFile = Join-Path $tmp 'tree.json'
[IO.File]::WriteAllText($treeFile, $treeBody, [Text.UTF8Encoding]::new($false))
$treeSha = (gh api --method POST "repos/$owner/$repo/git/trees" --input $treeFile --jq '.sha').Trim()
Write-Output "[push] tree $treeSha"

# 3) Commit (descends from the seed commit so the ref update fast-forwards)
$commitBody = @{
  message = "feat: Markdown AI Translator v0.1.0"
  tree = $treeSha
  parents = @($seedSha)
  author = @{ name = $authorName; email = $authorEmail; date = (Get-Date).ToUniversalTime().ToString('o') }
} | ConvertTo-Json -Depth 4 -Compress
$commitFile = Join-Path $tmp 'commit.json'
[IO.File]::WriteAllText($commitFile, $commitBody, [Text.UTF8Encoding]::new($false))
$commitSha = (gh api --method POST "repos/$owner/$repo/git/commits" --input $commitFile --jq '.sha').Trim()
Write-Output "[push] commit $commitSha"

# 4) Update the branch ref (create if missing, patch if the seed commit
#    already created it).
$refBody = @{ ref = "refs/heads/$branch"; sha = $commitSha } | ConvertTo-Json -Compress
$refFile = Join-Path $tmp 'ref.json'
[IO.File]::WriteAllText($refFile, $refBody, [Text.UTF8Encoding]::new($false))
$existing = gh api "repos/$owner/$repo/git/refs/heads/$branch" --jq '.ref' 2>$null
if ($LASTEXITCODE -eq 0) {
  $patchBody = @{ sha = $commitSha; force = $false } | ConvertTo-Json -Compress
  $patchFile = Join-Path $tmp 'ref-patch.json'
  [IO.File]::WriteAllText($patchFile, $patchBody, [Text.UTF8Encoding]::new($false))
  gh api --method PATCH "repos/$owner/$repo/git/refs/heads/$branch" --input $patchFile --jq '.ref'
} else {
  gh api --method POST "repos/$owner/$repo/git/refs" --input $refFile --jq '.ref'
}
Write-Output '[push] done'
