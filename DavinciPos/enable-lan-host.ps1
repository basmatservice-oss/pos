param(
    [Parameter(Mandatory=$true)]
    [string]$LanIp,
    [int]$Port = 3187
)

$parsedIp = $null
if (-not [System.Net.IPAddress]::TryParse($LanIp, [ref]$parsedIp)) {
    throw "LanIp must be a valid IPv4 or IPv6 address."
}
if ($parsedIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw "Use an IPv4 address for this DavinciPos RC setup."
}

$opensslCommand = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $opensslCommand) {
    throw "OpenSSL was not found. Install Git for Windows (Git Bash/OpenSSL) or Win64 OpenSSL, then run this script from PowerShell again."
}
$openssl = $opensslCommand.Source
$certDir = Join-Path $env:LOCALAPPDATA "DavinciPos\certs"
$userData = Join-Path $env:APPDATA "davincipos"
New-Item -ItemType Directory -Force -Path $certDir, $userData | Out-Null

$caKey = Join-Path $certDir "davincipos-ca.key"
$caCert = Join-Path $certDir "davincipos-ca.crt"
$serverKey = Join-Path $certDir "davincipos-server.key"
$serverCsr = Join-Path $certDir "davincipos-server.csr"
$serverCert = Join-Path $certDir "davincipos-server.crt"
$extensions = Join-Path $certDir "davincipos-server.ext"

& $openssl req -x509 -newkey rsa:3072 -nodes -keyout $caKey -out $caCert -days 3650 -sha256 -subj "/CN=DavinciPos Local CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
if ($LASTEXITCODE -ne 0) { throw "Failed to create the local certificate authority." }

@"
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$LanIp,IP:127.0.0.1,DNS:localhost
"@ | Set-Content -Path $extensions -Encoding ascii

& $openssl req -new -newkey rsa:3072 -nodes -keyout $serverKey -out $serverCsr -sha256 -subj "/CN=$LanIp"
if ($LASTEXITCODE -ne 0) { throw "Failed to create the DavinciPos server certificate request." }

& $openssl x509 -req -in $serverCsr -CA $caCert -CAkey $caKey -CAcreateserial -out $serverCert -days 825 -sha256 -extfile $extensions
if ($LASTEXITCODE -ne 0) { throw "Failed to sign the DavinciPos server certificate." }

Import-Certificate -FilePath $caCert -CertStoreLocation Cert:\CurrentUser\Root | Out-Null

$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $certDir /inheritance:r /grant:r "$($account):(OI)(CI)F" | Out-Null

$config = @{
    enabled = $true
    hostIp = $LanIp
    port = $Port
    certPath = $serverCert
    keyPath = $serverKey
    caPath = $caCert
}
$configPath = Join-Path $userData "lan-host.json"
$config | ConvertTo-Json | Set-Content -Path $configPath -Encoding utf8

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $ruleName = "DavinciPos LAN TCP $Port"
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null
} else {
    Write-Warning "Run PowerShell as Administrator and allow inbound TCP port $Port on the Private profile in Windows Firewall."
}

Write-Host ""
Write-Host "DavinciPos secure LAN configuration created:"
Write-Host "  Server URL: https://$($LanIp):$Port/mobile"
Write-Host "  Config: $configPath"
Write-Host "  CA certificate for Android: $caCert"
Write-Host ""
Write-Host "Install the CA certificate on each Android device using Settings > Security > Encryption & credentials > Install a certificate > CA certificate."
Write-Host "Restart DavinciPos on Windows after this script completes. Do not share davincipos-ca.key or davincipos-server.key."
