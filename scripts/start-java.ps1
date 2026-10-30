# Start the Java marketplace with the settings it needs.
#
# Two things are easy to forget and both fail quietly:
#   - the environment in .env (Razorpay keys, SMTP), without which the shop hides the payment button and
#     email stops;
#   - the Windows root store, without which Gmail TLS fails on this machine.
# This script does both, stops any previous instance, and waits until /api/health answers.
param(
  [int]$Port = 8080,
  [string]$Database = "equidron_live"
)

$root = Split-Path -Parent $PSScriptRoot
$jar = Join-Path $root "java-backend\target\equidron-api-0.1.0.jar"
if (-not (Test-Path $jar)) { throw "Build first: cd java-backend; mvn -q package -DskipTests" }

Get-Process -Name java -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

Get-Content (Join-Path $root ".env") | Where-Object { $_ -match "^\s*[A-Z]" } | ForEach-Object {
  $k, $v = $_ -split "=", 2
  Set-Item -Path ("Env:" + $k.Trim()) -Value $v.Trim()
}
$env:DATABASE_URL = "jdbc:postgresql://127.0.0.1:5432/$Database"
$env:DATABASE_USER = "equidron"
$env:DATABASE_PASSWORD = "equidron-local"

Start-Process -FilePath "java" `
  -ArgumentList @("-Djavax.net.ssl.trustStoreType=WINDOWS-ROOT", "-jar", $jar, "--server.port=$Port") `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $env:TEMP "equidron-java.out") `
  -RedirectStandardError (Join-Path $env:TEMP "equidron-java.err")

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  try {
    $h = Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2
    if ($h.StatusCode -eq 200) { "up on :$Port  $($h.Content)"; exit 0 }
  } catch { }
}
Get-Content (Join-Path $env:TEMP "equidron-java.err") -Tail 15
throw "The server did not answer on port $Port"