# Bond Feature Integration Test
Write-Host "=== BOND FEATURE VALIDATION ===" -ForegroundColor Cyan

# 1. Check state endpoint
Write-Host "`n1. Checking control server state endpoint..."
try {
  $state = (Invoke-WebRequest -Uri 'http://127.0.0.1:39127/state' -UseBasicParsing).Content | ConvertFrom-Json
  Write-Host "OK - State endpoint responding"
  Write-Host "  Bond level: $($state.bond.levelName) (XP: $($state.bond.xp)/$($state.bond.nextXp))"
  Write-Host "  Daily care streak: $($state.bond.dailyCareStreak) days"
  Write-Host "  Treat available: $($state.bond.treatAvailable)"
}
catch {
  Write-Host "FAIL - State endpoint failed" -ForegroundColor Red
}

# 2. Check IPC wiring
Write-Host "`n2. Checking IPC wiring..."
$preloadOk = Select-String -Path C:\Users\Admin\Popcat\dist\preload.js -Pattern 'giveTreat' -Quiet
if ($preloadOk) {
  Write-Host "OK - Preload bridge has giveTreat method"
}
else {
  Write-Host "FAIL - Preload bridge missing giveTreat" -ForegroundColor Red
}

$mainOk = Select-String -Path C:\Users\Admin\Popcat\dist\main.js -Pattern 'ui-do' -Quiet
if ($mainOk) {
  Write-Host "OK - Main process has ui-do handler"
}
else {
  Write-Host "FAIL - Main process missing ui-do handler" -ForegroundColor Red
}

# 3. Check settings UI
Write-Host "`n3. Checking settings UI components..."
$htmlOk = Select-String -Path C:\Users\Admin\Popcat\dist\settings.html -Pattern 'bondProgress' -Quiet
if ($htmlOk) {
  Write-Host "OK - Settings HTML has bond display elements"
}
else {
  Write-Host "FAIL - Settings HTML missing bond elements" -ForegroundColor Red
}

$jsOk = Select-String -Path C:\Users\Admin\Popcat\dist\settings.js -Pattern 'treatAvailable' -Quiet
if ($jsOk) {
  Write-Host "OK - Settings JS has bond rendering logic"
}
else {
  Write-Host "FAIL - Settings JS missing bond rendering" -ForegroundColor Red
}

Write-Host "`n=== BOND FEATURE VALIDATION COMPLETE ===" -ForegroundColor Green
