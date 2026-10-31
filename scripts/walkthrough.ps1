$base = "http://127.0.0.1:8080"
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

# Sessions must be created at top level: -SessionVariable inside a script block binds to that scope.
$null = Invoke-WebRequest "$base/api/shop/login" -Method POST -ContentType "application/json" -Body '{"email":"asha@example.com","password":"equidron-demo"}' -SessionVariable cust -UseBasicParsing -TimeoutSec 20
$null = Invoke-WebRequest "$base/api/seller/login" -Method POST -ContentType "application/json" -Body '{"email":"sudhakargummepalli+seller@gmail.com","password":"equidron-demo"}' -SessionVariable sell -UseBasicParsing -TimeoutSec 20
$null = Invoke-WebRequest "$base/api/ops/login" -Method POST -ContentType "application/json" -Body '{"email":"sudhakargummepalli+ops@gmail.com","password":"equidron-demo"}' -SessionVariable ops -UseBasicParsing -TimeoutSec 20
Write-Host "logged in: customer=$($null -ne $cust) seller=$($null -ne $sell) ops=$($null -ne $ops)"

foreach ($p in @("/shop/","/seller/","/ops/","/shop/index.html","/seller/index.html","/ops/index.html","/img/p1-1.svg")) {
  Step "page $p" { (Invoke-WebRequest ($base + $p) -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
}

$meta = Step "shop meta" { (Invoke-WebRequest "$base/api/shop/meta" -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json }
$search = Step "search" { (Invoke-WebRequest "$base/api/shop/search?q=phone&limit=5" -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json }
$prod = Step "product detail" { (Invoke-WebRequest "$base/api/shop/products/$($search.results[0].id)?city=Bengaluru" -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json }
$offer = $prod.offers[0].id
Step "cart add" { (Invoke-WebRequest "$base/api/shop/cart" -Method POST -ContentType "application/json" -Body ("{`"offer_id`":$offer,`"qty`":1}") -WebSession $cust -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } | Out-Null
Step "cart update" { (Invoke-WebRequest "$base/api/shop/cart/$offer" -Method PUT -ContentType "application/json" -Body '{"qty":2}' -WebSession $cust -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } | Out-Null
$addr = Step "addresses" { (Invoke-WebRequest "$base/api/shop/addresses" -WebSession $cust -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json }
$preview = Step "checkout preview" { (Invoke-WebRequest "$base/api/shop/checkout/preview" -Method POST -ContentType "application/json" -Body ("{`"address_id`":$($addr[0].id)}") -WebSession $cust -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json }
$order = Step "place order cod" { (Invoke-WebRequest "$base/api/shop/orders" -Method POST -ContentType "application/json" -Body ("{`"address_id`":$($addr[0].id),`"payment_method`":`"cod`",`"fingerprint`":`"$($preview.fingerprint)`"}") -WebSession $cust -UseBasicParsing -TimeoutSec 25).Content | ConvertFrom-Json }
$detail = Step "order detail" { (Invoke-WebRequest "$base/api/shop/orders/$($order.id)" -WebSession $cust -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json }
Step "invoice pdf" { $r = Invoke-WebRequest "$base/api/shop/orders/$($order.id)/invoice" -WebSession $cust -UseBasicParsing -TimeoutSec 20; $r.Headers['Content-Type'] -like 'application/pdf*' } | Out-Null
Step "notifications" { (Invoke-WebRequest "$base/api/shop/notifications" -WebSession $cust -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
Step "my data" { (Invoke-WebRequest "$base/api/shop/my-data" -WebSession $cust -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } | Out-Null
$tickets = Step "open ticket" { (Invoke-WebRequest "$base/api/shop/support" -Method POST -ContentType "application/json" -Body '{"subject":"Click-through test","message":"Checking the support thread end to end."}' -WebSession $cust -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json }
$ticketId = ($tickets | Where-Object { $_.subject -eq 'Click-through test' } | Select-Object -First 1).id
Step "cart clear" { (Invoke-WebRequest "$base/api/shop/cart/$offer" -Method DELETE -WebSession $cust -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null

Step "seller me" { (Invoke-WebRequest "$base/api/seller/me" -WebSession $sell -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
Step "seller meta" { (Invoke-WebRequest "$base/api/seller/meta" -WebSession $sell -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
Step "seller dashboard" { (Invoke-WebRequest "$base/api/seller/dashboard" -WebSession $sell -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
Step "seller listings" { (Invoke-WebRequest "$base/api/seller/listings" -WebSession $sell -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
Step "seller orders" { (Invoke-WebRequest "$base/api/seller/orders" -WebSession $sell -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
Step "seller ledger" { (Invoke-WebRequest "$base/api/seller/ledger" -WebSession $sell -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
Step "seller notifications" { (Invoke-WebRequest "$base/api/seller/notifications" -WebSession $sell -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
$catalog = Step "seller catalog" { (Invoke-WebRequest "$base/api/seller/catalog?q=case" -WebSession $sell -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json }
$sub = Step "seller submit" { (Invoke-WebRequest "$base/api/seller/submissions" -Method POST -ContentType "application/json" -Body ("{`"product_id`":$($catalog[0].id),`"price_paise`":49900}") -WebSession $sell -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json }

Step "ops me" { (Invoke-WebRequest "$base/api/ops/me" -WebSession $ops -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null
foreach ($panel in @("/overview","/returns","/support","/audit","/outbox","/shipments","/submissions","/agent-runs","/guardrails","/incidents","/analytics","/system","/staff","/tasks","/settlement","/seller-applications","/approvals","/agents","/stuck-payments")) {
  Step "ops $panel" { (Invoke-WebRequest ($base + "/api/ops" + $panel) -WebSession $ops -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } | Out-Null
}
Step "ops approve listing" { (Invoke-WebRequest "$base/api/ops/submissions/$($sub.id)/decide" -Method POST -ContentType "application/json" -Body '{"approve":true,"note":"click-through"}' -WebSession $ops -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } | Out-Null
Step "ops reply ticket" { (Invoke-WebRequest "$base/api/ops/support/$ticketId/reply" -Method POST -ContentType "application/json" -Body '{"message":"Thanks, we are on it.","close":false}' -WebSession $ops -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } | Out-Null
Step "ops pause off" { (Invoke-WebRequest "$base/api/ops/agents/pause-all" -Method POST -ContentType "application/json" -Body '{"paused":false}' -WebSession $ops -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } | Out-Null

$after = Step "customer reads reply" { (Invoke-WebRequest "$base/api/shop/support" -WebSession $cust -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json }
$t = $after | Where-Object { $_.id -eq $ticketId } | Select-Object -First 1
if ($t -and $t.messages.Count -ge 2) { Write-Host "ok    ticket thread has both messages ($($t.messages.Count))" } else { Write-Host "FAIL  ticket thread"; $fail += "ticket thread" }

Write-Host ""
Write-Host ("failures: " + $(if ($fail.Count -eq 0) { "none" } else { $fail -join "; " }))
Write-Host ("created: order=$($order.id) submission=$($sub.id) ticket=$ticketId")