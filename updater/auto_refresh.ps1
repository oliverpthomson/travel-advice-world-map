# Daily local auto-refresh for the AU Travel Advisory Map.
#
# Smartraveller's CDN read-times-out on cloud (GitHub Actions) IPs, so the
# published advisory data can only be refreshed from a normal residential IP.
# This script - run daily by Windows Task Scheduler on your own machine -
# scrapes both sources, commits any data changes, and pushes. The push
# triggers the GitHub Actions workflow, which redeploys the site.
#
# Register it with updater\register_task.ps1 (one-time). Logs to
# data\auto_refresh.log.

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$py  = Join-Path $repo '.venv\Scripts\python.exe'
$log = Join-Path $repo 'data\auto_refresh.log'

function Log($m) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    $line | Out-File -FilePath $log -Append -Encoding utf8
    Write-Host $line
}

Log "=== auto-refresh start ==="

# 1. Sync the daily CI commits first so our push fast-forwards cleanly.
(git pull --rebase --autostash 2>&1) | ForEach-Object { Log "git: $_" }

# 2. Scrape from this (residential) IP. Each keeps last-good data on failure,
#    so a transient error never wipes anything - we just commit what changed.
(& $py updater\scraper.py 2>&1)      | ForEach-Object { Log $_ }
(& $py updater\visa_scraper.py 2>&1) | ForEach-Object { Log $_ }

# 3. Stage the published data files.
git add data/advisories.json data/visas.json data/history.json data/status.json web/data/countries.geojson web/data/subregions.geojson

git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
    Log "no data changes; nothing to push"
} else {
    (git commit -m "data: local scheduled refresh" 2>&1) | ForEach-Object { Log "git: $_" }
    (git push 2>&1) | ForEach-Object { Log "git: $_" }
    if ($LASTEXITCODE -ne 0) {
        Log "push rejected; rebasing on origin and retrying once"
        (git pull --rebase --autostash 2>&1) | ForEach-Object { Log "git: $_" }
        (git push 2>&1) | ForEach-Object { Log "git: $_" }
    }
    Log "pushed refreshed data"
}

Log "=== auto-refresh done ==="
