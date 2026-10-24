param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ttsRoot = [IO.Path]::GetFullPath($Root)
$ttsInstall = Join-Path $ttsRoot 'installer'
$ttsRuntime = Join-Path $ttsRoot 'runtime'
$ttsPython = Join-Path $ttsRuntime 'Scripts/python.exe'
New-Item -ItemType Directory -Path $ttsInstall -Force | Out-Null
function Status([string]$message) {
    $json = @{ status = 'installing'; message = $message } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $ttsRoot 'setup-status.tmp'), $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath (Join-Path $ttsRoot 'setup-status.tmp') -Destination (Join-Path $ttsRoot 'setup-status.json') -Force
}
function RunUv([string[]]$arguments) {
    & $script:ttsUv @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Voice component preparation failed. Please retry or check setup.log.' }
}
try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'Local voice requires Windows x64.' }
    if (-not (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue)) { throw 'No NVIDIA driver found. Please install an NVIDIA CUDA-capable driver first.' }
    Status '正在下载语音组件管理器…'
    $ttsArchive = Join-Path $ttsInstall 'uv.zip'
    $ttsChecksum = 'a86c9dc7bad9b03f388583b7187c05fe9951c2e0d392217e8fd43d97787f6ec2'
    $ttsUv = Join-Path $ttsInstall 'uv.exe'
    if (-not (Test-Path -LiteralPath $ttsUv)) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri 'https://releases.astral.sh/github/uv/releases/download/0.12.13/uv-x86_64-pc-windows-msvc.zip' -OutFile $ttsArchive
        if ((Get-FileHash -LiteralPath $ttsArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ttsChecksum) { throw 'Voice component checksum mismatch.' }
        Expand-Archive -LiteralPath $ttsArchive -DestinationPath $ttsInstall -Force
    }
    $env:UV_CACHE_DIR = Join-Path $ttsInstall 'cache'
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $ttsRoot 'python'
    $env:PYTHONUTF8 = '1'
    $env:PYTHONNOUSERSITE = '1'
    Status '正在准备独立语音运行环境…'
    RunUv -Arguments @('--no-config', 'python', 'install', '3.12.9')
    if (-not (Test-Path -LiteralPath $ttsPython)) { RunUv -Arguments @('--no-config', 'venv', '--python', '3.12.9', '--managed-python', $ttsRuntime) }
    Status '正在下载 CUDA 语音组件，首次准备可能需要较长时间…'
    $ttsCudaFile = Join-Path $ttsInstall 'cuda.txt'
    @(
        'torch @ https://download-r2.pytorch.org/whl/cu128/torch-2.9.1%2Bcu128-cp312-cp312-win_amd64.whl --hash=sha256:3a01f0b64c10a82d444d9fd06b3e8c567b1158b76b2764b8f51bfd8f535064b0',
        'torchaudio @ https://download-r2.pytorch.org/whl/cu128/torchaudio-2.9.1%2Bcu128-cp312-cp312-win_amd64.whl --hash=sha256:88896c7bfa486102439fab6c85ac834176617e9c06eb0be9074c07ee1183b47d'
    ) | Set-Content -LiteralPath $ttsCudaFile -Encoding ascii
    RunUv -Arguments @('--no-config', 'pip', 'install', '--link-mode', 'copy', '--python', $ttsPython, '--no-deps', '--require-hashes', '-r', $ttsCudaFile)
    $ttsConstraints = Join-Path $ttsInstall 'constraints.txt'
    @('torch==2.9.1+cu128', 'torchaudio==2.9.1+cu128') | Set-Content -LiteralPath $ttsConstraints -Encoding ascii
    Status '正在安装并检查语音组件…'
    RunUv -Arguments @('--no-config', 'pip', 'install', '--link-mode', 'copy', '--python', $ttsPython, '--constraint', $ttsConstraints, '-r', (Join-Path $PSScriptRoot 'requirements.txt'), '--index-url', 'https://mirrors.aliyun.com/pypi/simple')
    RunUv -Arguments @('--no-config', 'pip', 'check', '--python', $ttsPython)
    & $ttsPython -c "import torch, faster_qwen3_tts; assert torch.cuda.is_available(), 'No usable NVIDIA CUDA device. Please update the NVIDIA driver.'"
    if ($LASTEXITCODE -ne 0) { throw 'CUDA voice verification failed. Please update the NVIDIA driver and retry.' }
    [IO.File]::WriteAllText((Join-Path $ttsRuntime 'ready.json'), '{"version":1}', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $ttsRoot 'setup-status.json'), '{"status":"ready","message":""}', [Text.UTF8Encoding]::new($false))
} catch {
    $json = @{ status = 'error'; message = $_.Exception.Message } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $ttsRoot 'setup-status.json'), $json, [Text.UTF8Encoding]::new($false))
    Write-Error $_
    exit 1
}
