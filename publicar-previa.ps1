#requires -Version 7.4

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$repository = $PSScriptRoot
$runtime = Join-Path $env:LOCALAPPDATA 'CadeAFalha\quick-tunnel'
$stateFile = Join-Path $runtime 'active.json'
$cloudflared = Join-Path $runtime 'cloudflared-2026.10.7.exe'
$cloudflaredHash = '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2'
$expectedRemote = 'https://github.com/gabmali/cade-a-falha.git'
$urlPattern = 'https://[a-z0-9-]+\.trycloudflare\.com'
$readmePattern = '(?m)^(\[\*\*Abrir a prévia pública do Cadê a Falha\?\*\*\]\()' + $urlPattern + '/?(\))(?=\r?$)'
$commitMessage = 'Atualiza link da prévia pública'

function Invoke-RepoGit([string[]]$GitArguments) {
    $result = & $git -c 'credential.interactive=never' -c 'core.askPass=' @GitArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Falha no git $($GitArguments[0]). Confira o erro acima. O comando usa a credencial já salva no Git."
    }
    $result
}

function Assert-ReadyRepository {
    if ((Invoke-RepoGit @('branch', '--show-current')) -ne 'main' -or
        (Invoke-RepoGit @('remote', 'get-url', '--push', 'origin')) -ne $expectedRemote) {
        throw 'Execute o script na branch main do repositório gabmali/cade-a-falha.'
    }
    if (Invoke-RepoGit @('status', '--porcelain', '--untracked-files=no')) {
        throw 'Há alterações locais. Salve ou faça commit delas antes de publicar a prévia.'
    }
    $readme = [IO.File]::ReadAllText((Join-Path $repository 'README.md'))
    if ([regex]::Matches($readme, $readmePattern).Count -ne 1) {
        throw 'O README precisa ter exatamente um link de prévia no formato esperado.'
    }

    Invoke-RepoGit @('fetch', '--no-tags', 'origin', 'main') | Out-Null
    if ((Invoke-RepoGit @('rev-parse', 'HEAD')) -ne (Invoke-RepoGit @('rev-parse', 'origin/main'))) {
        & $git merge-base --is-ancestor origin/main HEAD
        if ($LASTEXITCODE -ne 0) {
            throw 'A branch main local está atrás ou divergiu do GitHub. Sincronize-a antes de publicar.'
        }
        # A rerun can finish a previous README push, but must not send unrelated commits.
        $subjects = @(Invoke-RepoGit @('log', '--format=%s', 'origin/main..HEAD'))
        $paths = @(Invoke-RepoGit @('log', '--format=', '--name-only', 'origin/main..HEAD') | Where-Object { $_ })
        if (($subjects | Where-Object { $_ -cne $commitMessage }) -or
            ($paths | Where-Object { $_ -cne 'README.md' })) {
            throw 'Há commits locais pendentes de envio. Sincronize a branch main antes de publicar.'
        }
    }
}

function Test-Health([string]$Address, [hashtable]$Headers = @{}) {
    try {
        $response = Invoke-WebRequest -Uri "$Address/healthz" -Headers $Headers -TimeoutSec 4 -MaximumRedirection 0
        return $response.StatusCode -eq 200 -and $response.Content -ceq 'OK'
    } catch {
        return $false
    }
}

function Get-ActivePreview {
    if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) { return }
    try { $saved = Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json } catch { return }
    if ($saved.Origin -cnotmatch "^$urlPattern$" -or $saved.Port -lt 1 -or $saved.Port -gt 65535) { return }
    $app = Get-Process -Id $saved.NodeProcess -ErrorAction SilentlyContinue
    $tunnel = Get-Process -Id $saved.TunnelProcess -ErrorAction SilentlyContinue
    if (-not $app -or $app.Path -ne $node -or -not $tunnel -or $tunnel.Path -ne $cloudflared) { return }
    $listener = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $saved.Port -OwningProcess $app.Id -ErrorAction SilentlyContinue
    if ($listener -and (Test-Health "http://127.0.0.1:$($saved.Port)" @{Host=([uri]$saved.Origin).Host}) -and
        (Test-Health $saved.Origin)) {
        $saved
    }
}

function Start-Preview {
    if (-not (Test-Path -LiteralPath $cloudflared -PathType Leaf)) {
        $release = 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-windows-amd64.exe'
        $download = Join-Path $runtime 'cloudflared.download'
        Invoke-WebRequest -Uri $release -OutFile $download -TimeoutSec 120
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash -ine $cloudflaredHash) {
            throw 'O download do Cloudflare não coincide com o checksum oficial.'
        }
        Move-Item -LiteralPath $download -Destination $cloudflared
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $cloudflared).Hash -ine $cloudflaredHash) {
        throw 'O executável do Cloudflare não coincide com o checksum oficial.'
    }

    $runDirectory = Join-Path $runtime ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $runDirectory | Out-Null
    $tunnelLog = Join-Path $runDirectory 'cloudflared.stderr.log'
    $appLog = Join-Path $runDirectory 'node.stderr.log'
    $reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $tunnel = $null
    $app = $null
    try {
        $reservation.ExclusiveAddressUse = $true
        $reservation.Start()
        $port = $reservation.LocalEndpoint.Port
        $tunnelArgs = @('tunnel', '--no-autoupdate', '--protocol', 'http2', '--metrics', '127.0.0.1:0', '--url', "http://127.0.0.1:$port")
        $tunnel = Start-Process -FilePath $cloudflared -ArgumentList $tunnelArgs -WindowStyle Hidden -PassThru `
            -WorkingDirectory $runDirectory -Environment @{TUNNEL_TOKEN=$null; TUNNEL_TOKEN_FILE=$null} `
            -RedirectStandardOutput (Join-Path $runDirectory 'cloudflared.stdout.log') -RedirectStandardError $tunnelLog
        $origin = $null
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        while ([DateTime]::UtcNow -lt $deadline -and -not $tunnel.HasExited) {
            $match = Select-String -LiteralPath $tunnelLog -Pattern ($urlPattern + '\b') -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($match) { $origin = $match.Matches[0].Value; break }
            Start-Sleep -Milliseconds 350
        }
        if (-not $origin) { throw 'O Cloudflare não retornou um endereço público.' }

        # The public server inherits only Windows runtime settings and the preview configuration.
        $appEnvironment = @{}
        Get-ChildItem Env: | ForEach-Object { $appEnvironment[$_.Name] = $null }
        $appEnvironment['SystemRoot'] = $env:SystemRoot
        $appEnvironment['windir'] = $env:windir
        $appEnvironment['TEMP'] = $runDirectory
        $appEnvironment['TMP'] = $runDirectory
        $appEnvironment['PORT'] = [string]$port
        $appEnvironment['PUBLIC_ORIGIN'] = $origin
        $reservation.Stop()
        $app = Start-Process -FilePath $node -ArgumentList 'server.mjs' -Environment $appEnvironment -WindowStyle Hidden -PassThru `
            -WorkingDirectory $repository -RedirectStandardOutput (Join-Path $runDirectory 'node.stdout.log') -RedirectStandardError $appLog

        $healthy = $false
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        while ([DateTime]::UtcNow -lt $deadline -and -not $app.HasExited -and -not $tunnel.HasExited) {
            if (Test-Health "http://127.0.0.1:$port" @{Host=([uri]$origin).Host}) {
                $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -OwningProcess $app.Id -ErrorAction SilentlyContinue)
                if ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -eq '127.0.0.1' -and (Test-Health $origin)) {
                    $healthy = $true
                    break
                }
            }
            Start-Sleep -Milliseconds 600
        }
        if (-not $healthy) { throw 'O túnel ou o servidor local não ficou pronto.' }

        $state = [pscustomobject]@{Origin=$origin; Port=$port; NodeProcess=$app.Id; TunnelProcess=$tunnel.Id; RunDir=$runDirectory}
        $pendingState = Join-Path $runDirectory 'active.json'
        $state | ConvertTo-Json -Compress | Set-Content -LiteralPath $pendingState -Encoding utf8
        Move-Item -LiteralPath $pendingState -Destination $stateFile -Force
        $state
    } catch {
        if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id -ErrorAction SilentlyContinue }
        if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue }
        throw "Falha ao abrir a prévia. $($_.Exception.Message) Logs em $runDirectory"
    } finally {
        $reservation.Stop()
    }
}

function Assert-PublicPreview([string]$Origin) {
    $homePage = Invoke-WebRequest -Uri "$Origin/" -TimeoutSec 10 -MaximumRedirection 0
    if ($homePage.StatusCode -ne 200 -or $homePage.Content -notmatch 'Cadê a Falha\?') {
        throw 'A página inicial não abriu pelo endereço público.'
    }
    $request = @{
        Uri = "$Origin/api/analisar"
        Method = 'POST'
        Headers = @{Origin=$Origin}
        ContentType = 'application/json'
        TimeoutSec = 23
        MaximumRedirection = 0
        SkipHttpErrorCheck = $true
    }
    $report = Invoke-WebRequest @request -Body '{"address":"example.com"}'
    if ($report.StatusCode -eq 429) {
        $retryAfter = [int]($report.Headers['Retry-After'] | Select-Object -First 1)
        Start-Sleep -Seconds ([Math]::Clamp($retryAfter, 1, 60))
        $report = Invoke-WebRequest @request -Body '{"address":"example.com"}'
    }
    if ($report.StatusCode -ne 200 -or ($report.Content | ConvertFrom-Json).httpStatus -ne 200) {
        throw 'O teste público com example.com não retornou HTTP 200. O link do README continua como estava.'
    }
    $blocked = Invoke-WebRequest @request -Body '{"address":"http://127.0.0.1"}'
    if ($blocked.StatusCode -ne 400 -or ($blocked.Content | ConvertFrom-Json).error -notmatch 'privados ou reservados') {
        throw 'O teste de bloqueio de destino privado falhou.'
    }
}

$lock = [Threading.Mutex]::new($false, 'Local\CadeAFalhaPublicarPrevia')
$locked = $false
$previousPrompt = $env:GIT_TERMINAL_PROMPT
$previousInteractive = $env:GCM_INTERACTIVE
$previousAskPass = $env:GIT_ASKPASS
Push-Location -LiteralPath $repository
try {
    try { $locked = $lock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Já existe uma publicação da prévia em andamento.' }
    $git = (Get-Command git -CommandType Application | Select-Object -First 1).Source
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'Never'
    $env:GIT_ASKPASS = $null

    $node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $node) {
        $node = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    }
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Node.js 22 ou superior é necessário.' }
    $nodeVersion = & $node --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        throw 'Node.js 22 ou superior é necessário.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repository 'node_modules/parse5'))) {
        throw 'As dependências estão ausentes. Rode pnpm install --frozen-lockfile na pasta do projeto.'
    }

    Assert-ReadyRepository
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    $preview = Get-ActivePreview
    if (-not $preview) {
        Write-Host 'Abrindo um novo túnel público...'
        $preview = Start-Preview
    }
    Write-Host "Testando sem login em $($preview.Origin)/"
    Assert-PublicPreview $preview.Origin

    $readmePath = Join-Path $repository 'README.md'
    if (Invoke-RepoGit @('status', '--porcelain', '--untracked-files=no')) {
        throw 'A pasta mudou durante o teste. Confira as alterações e execute novamente.'
    }
    $current = [IO.File]::ReadAllText($readmePath)
    $updated = [regex]::Replace($current, $readmePattern, ('${1}' + $preview.Origin + '/${2}'))
    if ($updated -cne $current) {
        [IO.File]::WriteAllText($readmePath, $updated, [Text.UTF8Encoding]::new($false))
        Invoke-RepoGit @('add', '--', 'README.md') | Out-Null
        Invoke-RepoGit @('commit', '--only', '-m', $commitMessage, '--', 'README.md') | Out-Host
    }
    if ((Invoke-RepoGit @('rev-parse', 'HEAD')) -ne (Invoke-RepoGit @('rev-parse', 'origin/main'))) {
        Invoke-RepoGit @('push', 'origin', 'main') | Out-Host
    }
    $published = Invoke-RepoGit @('ls-remote', 'origin', 'refs/heads/main')
    $head = Invoke-RepoGit @('rev-parse', 'HEAD')
    if ($published -notcontains "$head`trefs/heads/main") { throw 'O GitHub ainda não confirmou a atualização do README.' }
    Write-Host "Prévia pública confirmada: $($preview.Origin)/"
    Write-Host 'README confirmado em https://github.com/gabmali/cade-a-falha#readme'
} finally {
    Pop-Location
    $env:GIT_TERMINAL_PROMPT = $previousPrompt
    $env:GCM_INTERACTIVE = $previousInteractive
    $env:GIT_ASKPASS = $previousAskPass
    if ($locked) { $lock.ReleaseMutex() }
    $lock.Dispose()
}
