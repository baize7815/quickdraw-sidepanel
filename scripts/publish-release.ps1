param([switch]$InspectOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
# Read credentials through Git's configured helper. Never write them to disk/output.
$credentialLines = "protocol=https`nhost=github.com`n`n" | git credential fill
if ($LASTEXITCODE -ne 0) { throw 'GitHub credentials unavailable' }
$credential = @{}
foreach ($line in $credentialLines) { if ($line -match '^([^=]+)=(.*)$') { $credential[$Matches[1]] = $Matches[2] } }
if (-not $credential.password) { throw 'GitHub credentials unavailable' }
$headers = @{ Authorization = "Bearer $($credential.password)"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'Quickdraw-release' }
$account = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers
if ($account.login -ne 'baize7815') { throw "Authenticated account is $($account.login), expected baize7815" }
Write-Output "Authenticated GitHub account: $($account.login)"
if ($InspectOnly) { exit 0 }
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json).version
$repo = 'https://api.github.com/repos/baize7815/quickdraw-sidepanel'
$tag = "v$version"
$archive = Join-Path $projectRoot "dist/quickdraw-sidepanel-v$version.zip"
if (-not (Test-Path -LiteralPath $archive)) { throw 'Run scripts/package.ps1 first' }
$release = $null
try { $release = Invoke-RestMethod -Uri "$repo/releases/tags/$tag" -Headers $headers }
catch { if ([int]$_.Exception.Response.StatusCode -ne 404) { throw } }
if (-not $release) {
  $body = @{ tag_name = $tag; name = "Quickdraw $tag"; draft = $true; prerelease = $false; body = (Get-Content -LiteralPath (Join-Path $projectRoot "releases/$tag.md") -Raw) } | ConvertTo-Json
  $release = Invoke-RestMethod -Method Post -Uri "$repo/releases" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
}
foreach ($file in @($archive, (Join-Path $projectRoot 'dist/SHA256SUMS.txt'))) {
  $name = [IO.Path]::GetFileName($file)
  $current = Invoke-RestMethod -Uri "$repo/releases/$($release.id)" -Headers $headers
  $asset = $current.assets | Where-Object name -eq $name
  $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($asset) { if ($asset.digest -ne "sha256:$hash") { throw "Existing release asset differs: $name" }; continue }
  $uploadUrl = $release.upload_url.Split('{')[0] + '?name=' + [Uri]::EscapeDataString($name)
  $uploaded = Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $headers -ContentType 'application/octet-stream' -InFile $file
  if ($uploaded.digest -ne "sha256:$hash") { throw "Uploaded checksum mismatch: $name" }
  Write-Output "Uploaded and SHA256 verified: $name"
}
$published = Invoke-RestMethod -Method Patch -Uri "$repo/releases/$($release.id)" -Headers $headers -ContentType 'application/json' -Body '{"draft":false,"make_latest":"true"}'
Write-Output "Published: $($published.html_url)"
