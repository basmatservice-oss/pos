# DavinciPos Windows LAN host setup (RC)

The Windows installer can run the authoritative SQLite database and serve Android/browser terminals over the shop's private LAN/Wi-Fi without Internet access.

## Configure the Windows host

1. Install the DavinciPos Windows RC installer and run it once.
2. Give the host PC a reserved/static IPv4 address on the shop network (example: 192.168.1.10).
3. Open PowerShell. Run it as Administrator if you want the helper to add the Private-profile firewall rule.
4. Run the helper from the repository: powershell -ExecutionPolicy Bypass -File .\enable-lan-host.ps1 -LanIp 192.168.1.10. OpenSSL must be available on PATH (Git for Windows or Win64 OpenSSL).
5. The helper creates a private local CA and a server certificate with the host IP in its SAN, imports the CA into the current Windows user's trusted roots, and writes %APPDATA%\davincipos\lan-host.json.
6. Restart DavinciPos. The desktop app should open using the secure LAN address and show the mobile URL.
7. If the helper was not run as Administrator, allow inbound TCP 3187 on the Windows Firewall Private profile only. Do not create a Public-profile rule and do not configure router port forwarding.

## Connect an Android terminal

1. Copy only davincipos-ca.crt from the Windows host's %LOCALAPPDATA%\DavinciPos\certs directory to the Android device. Never copy either private key file.
2. Install the CA certificate in Android Settings > Security > Encryption & credentials > Install a certificate > CA certificate. Android may require a screen lock.
3. Open DavinciPos on Android. Press Back from the local POS screen to open the LAN connection dialog.
4. Enter https://192.168.1.10:3187/mobile (replace the sample IP with the Windows host IP).
5. The terminal and host must be on the same reachable Wi-Fi/Ethernet LAN. Internet access is not required.

## Operating modes and data authority

- Connect to store: the Android WebView uses the Windows host API and central SQLite database. Normal sales, purchases, stock and reports are shared with other terminals.
- Standalone on phone: the embedded Node.js service and SQLite database run inside the phone. This mode works without a computer or Internet.
- These two databases are separate. A sale made in the phone's standalone database is not automatically merged into the Windows host database. In Connect to store mode, the mobile shell, authenticated session and IndexedDB outbox are cached on the device; queued sales can survive an app restart while the LAN is down and are replayed to the central host when connectivity returns. This is a sale outbox, not a general-purpose two-way database merge. Do not switch to standalone mode as a substitute for reconnecting a remote session if you need those queued sales to post to the central host.

## Security and recovery

- The Windows host binds only to the configured LAN IP, not every network interface, and uses HTTPS.
- The CA private key and server private key remain on the Windows host. Protect the certificate directory and keep a separate encrypted backup.
- Trust the CA only on devices managed for this shop. Do not bypass certificate warnings.
- The SQLite database remains on the Windows host's local disk. Do not place it on a shared network folder.
- Back up the database while DavinciPos is stopped, or use a consistent SQLite backup procedure. Do not copy only the main SQLite file while WAL writes are active.
- This is an RC deployment. Physical multi-device testing, including Wi-Fi roaming and host restart/recovery, is still required before production approval.