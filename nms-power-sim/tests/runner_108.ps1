# runner_108.ps1 - run one test script with managed static server + headless Edge.
# ASCII-only content; no `exit` (caller reads exitcode file).
param(
  [Parameter(Mandatory=$true)][string]$ProjectDir,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [Parameter(Mandatory=$true)][string]$TestScript,
  [string]$CodeFile = "",
  [int]$CdpPort = 9222,
  [string]$AppUrl = ""
)
$ErrorActionPreference = "Continue"
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
foreach ($v in @("HTTP_PROXY","HTTPS_PROXY","http_proxy","https_proxy","ALL_PROXY","all_proxy")) {
  Remove-Item Env:\$v -ErrorAction SilentlyContinue
}
$env:QA_CDP = 'http://127.0.0.1:' + $CdpPort
if ($AppUrl -ne "") { $env:QA_URL = $AppUrl }
# static server on 8900 (cwd = project parent, so moj JSON is reachable)
# NOTE: use a Node child to spawn python - in this sandbox, servers started
# via PowerShell Start-Process are NOT reachable from headless Edge
# (ERR_CONNECTION_REFUSED), while Node-spawned ones are (see serve8900.mjs).
$parent = Split-Path $ProjectDir -Parent
Get-Process python -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$env:SERVE_PARENT = $parent
$srv = Start-Process -FilePath "C:\Users\liao9\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" `
  -ArgumentList ('tests\serve8900.mjs') -WorkingDirectory $ProjectDir -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
$ud = Join-Path $env:TEMP ("nms_edge_" + $CdpPort)
if (Test-Path $ud) { Remove-Item -Recurse -Force $ud }
$edge = Start-Process -FilePath "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  -ArgumentList ('--headless=new', ('--remote-debugging-port=' + $CdpPort), '--remote-allow-origins=*', ('--user-data-dir=' + $ud), '--window-size=1600,1000', '--no-first-run', 'about:blank') `
  -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 4
Push-Location $ProjectDir
& "C:\Users\liao9\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" $TestScript 2>&1 | Out-File -FilePath $OutFile -Encoding utf8
$code = $LASTEXITCODE
Pop-Location
Stop-Process -Id $edge.Id -Force -ErrorAction SilentlyContinue
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if ($srv) { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue }
if ($CodeFile -ne "") { "exitcode=$code" | Out-File -Encoding utf8 $CodeFile }
