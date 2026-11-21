param([switch]$Portable)
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '../..')
try {
    & mvn -B package
    if ($LASTEXITCODE -ne 0) { throw 'Maven build failed.' }
    $version = ([xml](Get-Content -Raw pom.xml)).project.version
    $buildRoot = Join-Path (Resolve-Path target) ('windows-build-' + [guid]::NewGuid())
    $staging = New-Item -ItemType Directory -Force -Path (Join-Path $buildRoot 'input')
    Copy-Item -LiteralPath target/slidebranch.jar -Destination $staging.FullName
    $imageDir = Join-Path $buildRoot 'image'
    & "$env:JAVA_HOME/bin/jpackage.exe" --type app-image --name SlideBranch --app-version $version --input $staging.FullName --dest $imageDir --main-jar slidebranch.jar --main-class studio.slidebranch.DesktopLauncher --add-modules java.se,jdk.httpserver,jdk.crypto.ec,jdk.unsupported,jdk.charsets
    if ($LASTEXITCODE -ne 0) { throw 'jpackage failed.' }
    $image = Join-Path $imageDir 'SlideBranch'
    if ($Portable) {
        $zip = Join-Path (Resolve-Path target) 'SlideBranch-Windows-x64.zip'
        Compress-Archive -Path $image -DestinationPath $zip -Force
        Write-Host "Portable application: $zip"
        return
    }
    $compiler = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    $iscc = if ($compiler) { $compiler.Source } else { Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6/ISCC.exe' }
    if (!(Test-Path -LiteralPath $iscc)) { throw "Install Inno Setup 6 to build the setup EXE. The runnable application is at $image\SlideBranch.exe" }
    & $iscc "/DAppVersion=$version" "/DImageDir=$image" (Join-Path $PSScriptRoot 'SlideBranch.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup failed.' }
    Write-Host 'Installer: target\windows-installer\SlideBranch-Setup-x64.exe'
} finally {
    Pop-Location
}
