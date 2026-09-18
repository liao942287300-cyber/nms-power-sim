# qa_run_106.ps1 - run one browser QA script with self-managed headless Edge.
# ASCII-only content (PS 5.1 ANSI pitfall); Chinese paths passed as parameters.
param(
  [Parameter(Mandatory=$true)][string]$ProjectDir,
  [Parameter(Mandatory=$true)][string]$OutDir,
  [Parameter(Mandatory=$true)][string]$TestScript,
  [string]$OutName = "qa_out.txt",
  [int]$CdpPort = 9222
)
$ErrorActionPreference = "Continue"
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
foreach ($v in @("HTTP_PROXY","HTTPS_PROXY","http_proxy","https_proxy","ALL_PROXY","all_proxy")) {
  Remove-Item Env:\$v -ErrorAction SilentlyContinue
}
$ud = Join-Path $env:TEMP ("nms_edge_" + $CdpPort)
if (Test-Path $ud) { Remove-Item -Recurse -Force $ud }
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
$edge = Start-Process -FilePath "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  -ArgumentList ('--headless=new', ('--remote-debugging-port=' + $CdpPort), '--remote-allow-origins=*', ('--user-data-dir=' + $ud), '--window-size=1600,1000', '--no-first-run', '--disable-gpu', 'about:blank') `
  -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 4
Push-Location $ProjectDir
& "C:\Users\liao9\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" $TestScript | Out-File -FilePath (Join-Path $OutDir $OutName) -Encoding utf8
$code = $LASTEXITCODE
Pop-Location
Stop-Process -Id $edge.Id -Force -ErrorAction SilentlyContinue
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
exit $code
