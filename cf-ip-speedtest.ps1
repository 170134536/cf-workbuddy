# CF 优选 IP 本地测速脚本
#
# 在你自己电脑上跑，测的是「你的网络 → 各 CF 入口 IP」的真实延迟。
# 服务端测速只能筛掉不通的 IP，测不出你本地的速度，所以这一步必须在本地做。
#
# 用法:
#   .\cf-ip-speedtest.ps1                    # 测默认源
#   .\cf-ip-speedtest.ps1 -Extra 1.2.3.4     # 加测自定义 IP
#   .\cf-ip-speedtest.ps1 -Apply 104.17.69.173   # 测完直接写 hosts（需管理员）

param(
  [string[]]$Extra = @(),
  [string]$Apply = '',
  [string]$Domain = 'kz007.ccwu.cc',
  [int]$Rounds = 3
)

$ErrorActionPreference = 'Continue'
$sources = @(
  'cdns.doon.eu.org',
  'cf.877774.xyz',
  'cfvip.cf.3666888.xyz',
  'cfip.xxxxxxxx.tk',
  'cmcc.090227.xyz',
  'cloudflare.182682.xyz',
  'cfip.1323123.xyz'
)

Write-Host "目标域名: $Domain" -ForegroundColor Cyan
Write-Host "探测地址: 你的电脑 -> CF 入口 IP:443 (TLS 握手耗时)" -ForegroundColor Cyan
Write-Host ""

# 收集候选 IP
$cands = @{}
foreach ($s in $sources) {
  try {
    $ips = [System.Net.Dns]::GetHostAddresses($s) |
           Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
           ForEach-Object { $_.IPAddressToString }
    foreach ($ip in $ips) { if (-not $cands.ContainsKey($ip)) { $cands[$ip] = $s } }
    Write-Host ("  {0,-24} 解析出 {1} 个 IP" -f $s, $ips.Count)
  } catch {
    Write-Host ("  {0,-24} 解析失败" -f $s) -ForegroundColor DarkGray
  }
}
foreach ($ip in $Extra) { $cands[$ip] = '自定义' }

Write-Host ""
Write-Host "共 $($cands.Count) 个候选，开始测速（每个 $Rounds 次取最快）..." -ForegroundColor Cyan
Write-Host ""

$results = @()
foreach ($ip in $cands.Keys) {
  $times = @()
  $ok = $false
  for ($i = 0; $i -lt $Rounds; $i++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
      $tcp = New-Object System.Net.Sockets.TcpClient
      $iar = $tcp.BeginConnect($ip, 443, $null, $null)
      if ($iar.AsyncWaitHandle.WaitOne(3000, $false) -and $tcp.Connected) {
        $sw.Stop()
        $times += $sw.ElapsedMilliseconds
        $ok = $true
      }
      $tcp.Close()
    } catch { }
  }
  if ($ok -and $times.Count -gt 0) {
    $results += [pscustomobject]@{
      IP   = $ip
      ms   = ($times | Measure-Object -Minimum).Minimum
      avg  = [math]::Round(($times | Measure-Object -Average).Average, 0)
      Src  = $cands[$ip]
      OK   = $true
    }
  } else {
    $results += [pscustomobject]@{ IP = $ip; ms = 99999; avg = 99999; Src = $cands[$ip]; OK = $false }
  }
}

$sorted = $results | Sort-Object ms

Write-Host "════════ 结果（按最快延迟排序）════════" -ForegroundColor Green
Write-Host ("{0,-3} {1,-18} {2,8} {3,8}  {4}" -f '#', 'IP', '最快', '平均', '来源')
Write-Host ("-" * 66)
$n = 0
foreach ($r in $sorted) {
  $n++
  if (-not $r.OK) {
    Write-Host ("{0,-3} {1,-18} {2,8} {3,8}  {4}" -f $n, $r.IP, '超时', '-', $r.Src) -ForegroundColor DarkGray
  } else {
    $color = if ($n -le 3) { 'Green' } elseif ($n -le 8) { 'Yellow' } else { 'Gray' }
    Write-Host ("{0,-3} {1,-18} {2,7}ms {3,7}ms  {4}" -f $n, $r.IP, $r.ms, $r.avg, $r.Src) -ForegroundColor $color
  }
}

$best = $sorted | Where-Object { $_.OK } | Select-Object -First 1
if ($best) {
  Write-Host ""
  Write-Host "最快: $($best.IP)  ($($best.ms) ms)" -ForegroundColor Green
  Write-Host ""
  Write-Host "使用方法（三选一）：" -ForegroundColor Cyan
  Write-Host "  1) 改 hosts（全局生效，需管理员）："
  Write-Host "     $($best.IP) $Domain"
  Write-Host "  2) 本脚本自动写入：  .\cf-ip-speedtest.ps1 -Apply $($best.IP)"
  Write-Host "  3) 代理软件里给 $Domain 指定该 IP 作为连接地址"

  if ($Apply) {
    $hosts = "$env:WINDIR\System32\drivers\etc\hosts"
    Write-Host ""
    Write-Host "写入 hosts: $Apply $Domain" -ForegroundColor Yellow
    $lines = Get-Content $hosts -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch [regex]::Escape($Domain) }
    $lines += "$Apply $Domain"
    try {
      Set-Content -Path $hosts -Value $lines -Encoding ASCII -ErrorAction Stop
      Write-Host "  已写入。刷新 DNS: ipconfig /flushdns" -ForegroundColor Green
      & ipconfig /flushdns | Out-Null
    } catch {
      Write-Host "  写入失败（需要管理员权限）：$($_.Exception.Message)" -ForegroundColor Red
    }
  }
}
