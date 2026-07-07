# One-time: register the daily auto-refresh as a Windows Scheduled Task.
# Runs as the current user, only when logged on (so it can use the git
# credentials stored in Windows Credential Manager). Re-run to update it.
#
#   powershell -ExecutionPolicy Bypass -File updater\register_task.ps1
#
# Remove it later with:
#   Unregister-ScheduledTask -TaskName 'AU Travel Advisory Map refresh' -Confirm:$false

$repo   = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo 'updater\auto_refresh.ps1'
$name   = 'AU Travel Advisory Map refresh'

$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $script) `
    -WorkingDirectory $repo

# Daily at 08:00 local time. StartWhenAvailable catches up if the machine was
# off/asleep at the scheduled moment.
$trigger  = New-ScheduledTaskTrigger -Daily -At 8:00am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
    -Settings $settings -Force `
    -Description 'Scrapes Smartraveller advisories + Wikipedia visa data from this residential IP and pushes, so the published site stays current (cloud CI cannot reach Smartraveller).' | Out-Null

Write-Host "Registered scheduled task: '$name' (daily 08:00, current user, when logged on)."
