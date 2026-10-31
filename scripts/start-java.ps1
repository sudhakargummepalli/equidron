# Start the Java marketplace with the settings it needs, from a COPY of the jar.
#
# Three things are easy to forget and all of them fail quietly:
#   - the environment in .env (Razorpay keys, SMTP, Telegram), without which the shop hides the payment
#     button and email stops;
#   - the Windows root store, without which Gmail TLS fails on this machine;
#   - that a running server holds target/equidron-api-0.1.0.jar, so `mvn package` cannot overwrite it.
# The last one is why the server runs from target/equidron-run.jar: the build stays possible while the
# marketplace serves.
param(
  [int]$Port = 8080,
  [string]$Database = "equidron_live",
  [switch]$Bot
)

$root = Split-Path -Parent $PSScriptRoot
$built = Join-Path $root "java-backend\target\equidron-api-0.1.0.jar"
$run = Join-Path $root "java-backend\target\equidron-run.jar"
if (-not (Test-Path $built)) { throw "Build first: cd java-backend; mvn -q package -DskipTests" }

Get-Process -Name java -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Copy-Item $built $run -Force

Get-Content (Join-Path $root ".env") | Where-Object { $_ -match "^\s*[A-Z]" } | ForEach-Object {
  $k, $v = $_ -split "=", 2
  Set-Item -Path ("Env:" + $k.Trim()) -Value $v.Trim()
}
$env:DATABASE_URL = "jdbc:postgresql://127.0.0.1:5432/$Database"
$env:DATABASE_USER = "equidron"
$env:DATABASE_PASSWORD = "equidron-local"
if ($Bot) { $env:TELEGRAM_POLLING = "true" } else { $env:TELEGRAM_POLLING = "false" }

Start-Process -FilePath "java" `
  -ArgumentList @("-Djavax.net.ssl.trustStoreType=WINDOWS-ROOT", "-jar", $run, "--server.port=$Port") `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $env:TEMP "equidron-java.out") `
  -RedirectStandardError (Join-Path $env:TEMP "equidron-java.err")

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  try {
    $h = Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2
    if ($h.StatusCode -eq 200) {
      "up on :$Port against $Database  (bot polling: $($env:TELEGRAM_POLLING))"
      exit 0
    }
  } catch { }
}
Get-Content (Join-Path $env:TEMP "equidron-java.err") -Tail 15
throw "The server did not answer on port $Port"