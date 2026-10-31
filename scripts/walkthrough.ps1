# Walk every call the three portals make, against a running marketplace.
#
# Notes that cost time to learn:
#  - -SessionVariable binds to the scope it runs in, so the logins happen at top level, never inside Step.
#  - A product can be "in stock" while its cheapest offer is not, so the walkthrough looks for an offer a
#    customer could actually buy; the page's buy button requires exactly the same two things.
#  - It removes what it creates, so two runs leave the marketplace as one run does.
param([string]$Base = "http://127.0.0.1:8080", [string]$Psql = "C:\Program Files\PostgreSQL\16\bin\psql.exe", [string]$Database = "equidron_live")

$fail = @()
function Step($name, $scriptBlock) {
  try {
    $r = & $scriptBlock
    if ($r -eq $false) { Write-Host "FAIL  $name"; $script:fail += $name; return $null }
    Write-Host "ok    $name"
    return $r
  } catch {
    $code = "ERR"
    if ($_.Exception.Response) { $code = $_.Exception.Response.StatusCode.value__ }
    Write-Host "FAIL  $name -> $code"
    $script:fail += $name
    return $null
  }
}

# ---------------------------------------------------------------- sessions
$null = Invoke-WebRequest "$Base/api/shop/login"   -Method POST -ContentType "application/json" -Body '{"email":"asha@example.com","password":"equidron-demo"}' -SessionVariable cust -UseBasicParsing -TimeoutSec 20
$null = Invoke-WebRequest "$Base/api/seller/login" -Method POST -ContentType "application/json" -Body '{"email":"sudhakargummepalli+seller@gmail.com","password":"equidron-demo"}' -SessionVariable sell -UseBasicParsing -TimeoutSec 20
$null = Invoke-WebRequest "$Base/api/ops/login"    -Method POST -ContentType "application/json" -Body '{"email":"sudhakargummepalli+ops@gmail.com","password":"equidron-demo"}' -SessionVariable ops -UseBasicParsing -TimeoutSec 20
Write-Host "logged in: customer=$($null -ne $cust) seller=$($null -ne $sell) ops=$($null -ne $ops)"

# ---------------------------------------------------------------- pages
foreach ($path in @("/shop/","/seller/","/ops/","/shop/index.html","/seller/index.html","/ops/index.html","/img/p1-1.svg")) {
  Step "page $path" { (Invoke-WebRequest ($Base + $path) -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
}

# ---------------------------------------------------------------- customer
Step "shop meta" { (Invoke-WebRequest "$Base/api/shop/meta" -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
$search = Step "search" { (Invoke-WebRequest "$Base/api/shop/search?limit=20" -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json }
if (-not $search.results.Count) { Write-Host "FAIL  nothing in the shop to buy"; $fail += "empty shop" }

$prod = $null; $buyable = $null
foreach ($candidate in $search.results) {
  $p = (Invoke-WebRequest "$Base/api/shop/products/$($candidate.id)?city=Bengaluru" -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json
  $b = $p.offers | Where-Object { $_.deliverable -and $_.available -ge 2 } | Select-Object -First 1
  if ($b) { $prod = $p; $buyable = $b; break }
}
if ($buyable) { Write-Host "ok    product detail ($($prod.title) · offer $($buyable.id) · $($buyable.available) in stock)" } else { Write-Host "FAIL  no product with buyable stock"; $fail += "buyable product" }
$offer = if ($buyable) { $buyable.id } else { 0 }

Step "cart add" { (Invoke-WebRequest "$Base/api/shop/cart" -Method POST -ContentType "application/json" -Body ("{`"offer_id`":$offer,`"qty`":1}") -WebSession $cust -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } | Out-Null
Step "cart update" { (Invoke-WebRequest "$Base/api/shop/cart/$offer" -Method PUT -ContentType "application/json" -Body '{"qty":2}' -WebSession $cust -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } | Out-Null
$addr = Step "addresses" { (Invoke-WebRequest "$Base/api/shop/addresses" -WebSession $cust -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json }
$preview = Step "checkout preview" { (Invoke-WebRequest "$Base/api/shop/checkout/preview" -Method POST -ContentType "application/json" -Body ("{`"address_id`":$($addr[0].id)}") -WebSession $cust -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json }
$order = Step "place order cod" { (Invoke-WebRequest "$Base/api/shop/orders" -Method POST -ContentType "application/json" -Body ("{`"address_id`":$($addr[0].id),`"payment_method`":`"cod`",`"fingerprint`":`"$($preview.fingerprint)`"}") -WebSession $cust -UseBasicParsing -TimeoutSec 25).Content | ConvertFrom-Json }
$orderId = if ($order) { $order.id } else { 0 }
Step "order detail" { (Invoke-WebRequest "$Base/api/shop/orders/$orderId" -WebSession $cust -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
Step "invoice pdf" { $r = Invoke-WebRequest "$Base/api/shop/orders/$orderId/invoice" -WebSession $cust -UseBasicParsing -TimeoutSec 20; $r.Headers['Content-Type'] -like 'application/pdf*' } | Out-Null
Step "notifications" { (Invoke-WebRequest "$Base/api/shop/notifications" -WebSession $cust -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
Step "my data" { (Invoke-WebRequest "$Base/api/shop/my-data" -WebSession $cust -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } | Out-Null
$tickets = Step "open ticket" { (Invoke-WebRequest "$Base/api/shop/support" -Method POST -ContentType "application/json" -Body '{"subject":"Click-through test","message":"Checking the support thread end to end."}' -WebSession $cust -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json }
$ticketId = ($tickets | Where-Object { $_.subject -eq 'Click-through test' } | Select-Object -First 1).id

# ---------------------------------------------------------------- seller
foreach ($path in @("/me","/meta","/dashboard","/listings","/orders","/ledger","/notifications")) {
  Step "seller $path" { (Invoke-WebRequest ($Base + "/api/seller" + $path) -WebSession $sell -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
}
$catalog = Step "seller catalog" { (Invoke-WebRequest "$Base/api/seller/catalog?q=case" -WebSession $sell -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json }
$sub = Step "seller submit" { (Invoke-WebRequest "$Base/api/seller/submissions" -Method POST -ContentType "application/json" -Body "{`"product_id`":$($catalog[0].id),`"price`":499}" -WebSession $sell -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json }
$subId = if ($sub) { $sub.id } else { 0 }
$subOfferId = if ($sub) { $sub.offer_id } else { 0 }

# ---------------------------------------------------------------- ops
Step "ops me" { (Invoke-WebRequest "$Base/api/ops/me" -WebSession $ops -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
foreach ($panel in @("/overview","/returns","/support","/audit","/outbox","/shipments","/submissions","/agent-runs","/guardrails","/incidents","/analytics","/system","/staff","/tasks","/settlement","/seller-applications","/approvals","/agents","/stuck-payments")) {
  Step "ops $panel" { (Invoke-WebRequest ($Base + "/api/ops" + $panel) -WebSession $ops -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } | Out-Null
}
Step "ops approve listing" { (Invoke-WebRequest "$Base/api/ops/submissions/$subId/decide" -Method POST -ContentType "application/json" -Body '{"approve":true,"note":"click-through"}' -WebSession $ops -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } | Out-Null
Step "ops reply ticket" { (Invoke-WebRequest "$Base/api/ops/support/$ticketId/reply" -Method POST -ContentType "application/json" -Body '{"message":"Thanks, we are on it.","close":false}' -WebSession $ops -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } | Out-Null
Step "ops pause off" { (Invoke-WebRequest "$Base/api/ops/agents/pause-all" -Method POST -ContentType "application/json" -Body '{"paused":false}' -WebSession $ops -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null

# ---------------------------------------------------------------- the customer reads the answer
$after = Step "customer reads reply" { (Invoke-WebRequest "$Base/api/shop/support" -WebSession $cust -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json }
$thread = $after | Where-Object { $_.id -eq $ticketId } | Select-Object -First 1
if ($thread -and $thread.messages.Count -ge 2) { Write-Host "ok    ticket thread has both messages ($($thread.messages.Count))" } else { Write-Host "FAIL  ticket thread"; $fail += "ticket thread" }

# ---------------------------------------------------------------- cleanup
$password = if ($env:DATABASE_PASSWORD) { $env:DATABASE_PASSWORD } else { "equidron-local" }
$cleanup = "UPDATE inventory SET reserved = GREATEST(0, reserved - COALESCE((SELECT SUM(qty) FROM order_items WHERE order_id = $orderId AND offer_id = inventory.offer_id), 0)) WHERE offer_id IN (SELECT offer_id FROM order_items WHERE order_id = $orderId); DELETE FROM events WHERE entity = 'order' AND entity_id = $orderId; DELETE FROM invoices WHERE order_id = $orderId; DELETE FROM payments WHERE order_id = $orderId; DELETE FROM order_items WHERE order_id = $orderId; DELETE FROM orders WHERE id = $orderId; DELETE FROM idempotency_keys WHERE user_id = (SELECT id FROM users WHERE email = 'asha@example.com'); DELETE FROM inventory WHERE offer_id = $subOfferId; DELETE FROM submissions WHERE id = $subId; DELETE FROM offers WHERE id = $($subOfferId) AND $($sub.created_offer); DELETE FROM support_messages WHERE ticket_id = $ticketId; DELETE FROM support_tickets WHERE id = $ticketId;"
$env:PGPASSWORD = $password
$cleanup | & $Psql -U equidron -h 127.0.0.1 -d $Database -q 2>&1 | Out-Null
Remove-Item Env:PGPASSWORD
Write-Host "cleaned up: order=$orderId submission=$subId ticket=$ticketId"

Write-Host ""
Write-Host ("failures: " + $(if ($fail.Count -eq 0) { "none" } else { $fail -join "; " }))
if ($fail.Count -gt 0) { exit 1 }