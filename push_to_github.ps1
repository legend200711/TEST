$token = "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"
$headers = @{ Authorization = "token $token"; "Content-Type" = "application/json" }
$repo = "legend200711/TEST"
$baseDir = "c:\Users\Legend\Desktop\websites\feed"
$msg = "Add push notifications and full admin panel"

function Push-File($localPath, $remoteName) {
    $content = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($localPath))
    $existing = $null
    try { $existing = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/contents/$remoteName" -Headers $headers -ErrorAction SilentlyContinue } catch {}
    $body = @{ message = $msg; content = $content }
    if ($existing -and $existing.sha) { $body.sha = $existing.sha }
    try {
        $result = Invoke-RestMethod -Method Put -Uri "https://api.github.com/repos/$repo/contents/$remoteName" -Headers $headers -Body ($body | ConvertTo-Json -Depth 3)
        Write-Host "OK: $remoteName"
    } catch {
        Write-Host "FAIL: $remoteName - $_"
    }
}

Push-File "$baseDir\feed.html"               "index.html"
Push-File "$baseDir\script.js"               "script.js"
Push-File "$baseDir\sw.js"                   "sw.js"
Push-File "$baseDir\firebase-messaging-sw.js" "firebase-messaging-sw.js"
Push-File "$baseDir\manifest.json"           "manifest.json"
Push-File "$baseDir\style.css"               "style.css"
Push-File "$baseDir\offline.html"            "offline.html"

Write-Host "Done! Check https://legend200711.github.io/TEST/"
