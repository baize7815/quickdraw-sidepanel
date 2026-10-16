$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$extensionRoot = Join-Path $projectRoot 'quickdraw-sidepanel'
$manifest = Get-Content -LiteralPath (Join-Path $extensionRoot 'manifest.json') -Raw | ConvertFrom-Json
$outputDir = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$archive = Join-Path $outputDir "quickdraw-sidepanel-v$($manifest.version).zip"
$files = @(Get-ChildItem -LiteralPath $extensionRoot -Force | Where-Object { $_.Name -ne 'log' -and $_.Name -ne 'VISUAL_EDITING_PLAN.md' -and $_.Name -notlike '*.test.js' -and $_.Name -notlike '*-ui-smoke.py' } | ForEach-Object FullName)
Compress-Archive -LiteralPath $files -DestinationPath $archive -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  foreach ($name in @('manifest.json','sidepanel.html','sidepanel.js','update-checker.js','help.html','help.css','background.js','ai-visual-editor.html','ai-visual-editor.css','ai-visual-editor.js','ai-visual-modal.css','ai-visual-core.js','ai-visual-mentions.js','ai-visual-transfer.js','ai-gemini-provider.js','gemini-content.js','vendor/koukoutu-recaptcha.wasm','vendor/opencv-4.13.0.js')) {
    if (-not ($zip.Entries | Where-Object { $_.FullName.Replace('\','/') -eq $name })) { throw "Missing ZIP entry: $name" }
  }
  if ($zip.Entries | Where-Object { $_.FullName -match '(^|/)(\.git|tests|node_modules|dist|log)(/|$)|\.test\.js$|\-ui-smoke\.py$|VISUAL_EDITING_PLAN\.md$' }) { throw 'Unexpected development files in ZIP' }
} finally { $zip.Dispose() }
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath (Join-Path $outputDir 'SHA256SUMS.txt') -Value "$hash  $([IO.Path]::GetFileName($archive))" -Encoding utf8
Write-Output "Package: $archive"
Write-Output "SHA256: $hash"
