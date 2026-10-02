param([string]$Model = 'qwen3:4b-instruct-2507-q4_K_M')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$portable = Join-Path $env:LOCALAPPDATA 'Programs/PeriferiaOllama/ollama.exe'
$standard = Join-Path $env:LOCALAPPDATA 'Programs/Ollama/ollama.exe'
$command = Get-Command ollama -ErrorAction SilentlyContinue
$ollamaExe = if (Test-Path -LiteralPath $portable) { $portable } elseif ($command) { $command.Source } elseif (Test-Path -LiteralPath $standard) { $standard } else { throw 'Instala Ollama desde https://ollama.com/download/windows y vuelve a ejecutar npm run local.' }
if ($Model -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' -or $Model -match '(?i)cloud') { throw 'Selecciona un modelo local, por ejemplo qwen3:4b-instruct-2507-q4_K_M.' }

# Estas variables pertenecen al proceso y sus hijos; no cambian la configuración global.
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
$env:OLLAMA_CONTEXT_LENGTH = '16384'
$env:OLLAMA_FLASH_ATTENTION = '1'
$env:OLLAMA_KV_CACHE_TYPE = 'q8_0'
$env:LLM_MODE = 'ollama'
$env:LLM_MODEL = $Model
$env:OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
$env:OLLAMA_NUM_CTX = '16384'
$env:LLM_TIMEOUT_MS = '120000'
$env:HOST = '127.0.0.1'
if (-not $env:PORT) { $env:PORT = '3000' }
if ($ollamaExe -eq $portable) {
    $env:OLLAMA_MODELS = Join-Path $env:LOCALAPPDATA 'PeriferiaOC/models'
}

$ready = $false
try { $version = Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2; $ready = [bool]$version.version } catch {}
if (-not $ready) {
    $logDirectory = Join-Path $env:LOCALAPPDATA 'PeriferiaOC/logs'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $process = Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory 'ollama.stdout.log') -RedirectStandardError (Join-Path $logDirectory 'ollama.stderr.log')
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Seconds 1
        try { $version = Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2; $ready = [bool]$version.version } catch {}
        if ($ready -or $process.HasExited) { break }
    }
    if (-not $ready) { throw "Ollama no inició. Consulta $logDirectory" }
}
$models = Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5
if (-not ($models.models | Where-Object { $_.name -eq $Model })) {
    Write-Host "Descargando $Model. La descarga inicial requiere internet."
    & $ollamaExe pull $Model
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo descargar el modelo.' }
}
Write-Host "Modelo local: $Model. Chat: http://localhost:$($env:PORT). Ctrl+C detiene el chat."
Push-Location $projectRoot
try { & npm.cmd run dev } finally { Pop-Location }
