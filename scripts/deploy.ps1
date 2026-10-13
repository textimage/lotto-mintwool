param(
    [Parameter(Mandatory=$true)][string]$SshHost,
    [Parameter(Mandatory=$true)][string]$SshUser,
    [string]$IdentityFile,
    [ValidateRange(1,65535)][int]$SshPort = 22,
    [string]$KnownHostsFile,
    [string]$Domain = 'lotto.mintwool.com',
    [string]$RemoteDirectory = '/opt/mintwool/lotto',
    [switch]$UseExistingProxy,
    [string]$DeployLockFile = ''
)
$ErrorActionPreference = 'Stop'
if ($SshHost -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' -or $SshUser -notmatch '^[a-zA-Z_][a-zA-Z0-9_-]*$') { throw 'Invalid SSH host or user.' }
if ($Domain -notmatch '^[a-zA-Z0-9.-]+$' -or $RemoteDirectory -notmatch '^/[a-zA-Z0-9_/-]+$') { throw 'Invalid domain or application directory.' }
if ($DeployLockFile -and ($DeployLockFile -notmatch '^/[a-zA-Z0-9_./-]+$' -or $DeployLockFile -match '//|/\.\.?(/|$)|/$')) { throw 'Invalid shared deployment lock.' }
$RemoteDirectory = '/' + (($RemoteDirectory.Split('/', [System.StringSplitOptions]::RemoveEmptyEntries)) -join '/')
if ($RemoteDirectory -in @('/','/opt','/home','/root','/tmp','/etc','/var','/usr')) { throw 'Choose a dedicated application directory.' }
if ($RemoteDirectory -like '/opt/mintwool/*' -or $RemoteDirectory -eq '/opt/mintwool') {
    if ($RemoteDirectory -cne '/opt/mintwool/lotto') { throw 'Managed Lotto directory must be /opt/mintwool/lotto.' }
}
$projectDirectory = Split-Path -Parent $PSScriptRoot
$rootValidation = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'deploy-root.sh')).Replace("`r", '')
$archivePath = Join-Path ([System.IO.Path]::GetTempPath()) ('lotto-' + [guid]::NewGuid().ToString('N') + '.tar.gz')
$sshArguments = @('-o','BatchMode=yes','-o','ConnectTimeout=15','-o','StrictHostKeyChecking=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=4')
if ($KnownHostsFile) { $hostsPath = (Resolve-Path -LiteralPath $KnownHostsFile).Path; $sshArguments += @('-o', ('UserKnownHostsFile=' + $hostsPath)) }
if ($IdentityFile) { $keyPath = (Resolve-Path -LiteralPath $IdentityFile).Path; $sshArguments += @('-o','IdentitiesOnly=yes','-i', $keyPath) }
$sshPortArguments = @('-p', [string]$SshPort)
$scpPortArguments = @('-P', [string]$SshPort)
$target = $SshUser + '@' + $SshHost
$releaseId = 'manual-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '-' + [guid]::NewGuid().ToString('N')
$releaseDirectory = $RemoteDirectory + '/releases/' + $releaseId
try {
    Push-Location $projectDirectory
    $sourceFiles = @('package.json','package-lock.json','tsconfig.json','tsconfig.server.json','vite.config.ts','index.html','Dockerfile','compose.yaml','Caddyfile','.dockerignore','.env.example','README.md','src','shared','server','scripts','tests','public')
    & tar -czf $archivePath @sourceFiles
    if ($LASTEXITCODE -ne 0) { throw 'Source packaging failed.' }
    $preflightCommand = "set -eu; umask 077`n$rootValidation`nvalidate_deploy_root '$RemoteDirectory' >/dev/null`ndocker compose version >/dev/null`nmkdir -p '$RemoteDirectory/releases'`nmkdir '$releaseDirectory'"
    & ssh @sshArguments @sshPortArguments $target $preflightCommand
    if ($LASTEXITCODE -ne 0) { throw 'SSH access, Docker Compose, or directory access is unavailable. Prepare an owned app directory first.' }
    & scp @sshArguments @scpPortArguments $archivePath ($target + ':' + $releaseDirectory + '/source.tar.gz')
    if ($LASTEXITCODE -ne 0) { throw 'Source upload failed.' }
    $localConfiguration = Join-Path $projectDirectory '.env'
    if (Test-Path -LiteralPath $localConfiguration) {
        & scp @sshArguments @scpPortArguments $localConfiguration ($target + ':' + $releaseDirectory + '/.env.bootstrap')
        if ($LASTEXITCODE -ne 0) { throw 'Initial configuration upload failed.' }
    }
    $proxyMode = if ($UseExistingProxy) { 'existing' } else { 'caddy' }
    $remoteCommand = "set -eu; cd '$releaseDirectory'; tar -xzf source.tar.gz --no-same-owner; rm -f source.tar.gz; sh scripts/deploy.sh '$Domain' '$proxyMode' '$RemoteDirectory' '$releaseId' '$DeployLockFile'"
    & ssh @sshArguments @sshPortArguments $target $remoteCommand
    if ($LASTEXITCODE -ne 0) { throw 'Remote deployment did not complete. Existing database volumes are retained.' }
    Write-Output ('Deployment completed: https://' + $Domain)
} finally {
    Pop-Location
    $resolvedArchive = [System.IO.Path]::GetFullPath($archivePath)
    if ($resolvedArchive.StartsWith([System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()), [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedArchive)) { Remove-Item -LiteralPath $resolvedArchive }
}
