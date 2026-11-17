// Patches the generated Capacitor Android project (run after `npx cap add android`).
// Goal: install on Android 8.0 (API 26) up to Android 16 (API 36) and allow plain-HTTP
// connections to the POS server on the local Wi-Fi / LAN (e.g. http://192.168.1.10:3000).
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('android');
if (!fs.existsSync(root)) {
  console.error('android/ folder not found. Run `npx cap add android` first.');
  process.exit(1);
}

// 1) SDK levels
const varsFile = path.join(root, 'variables.gradle');
let vars = fs.readFileSync(varsFile, 'utf8');
const setVar = (name, value) => {
  const re = new RegExp(`(${name}\\s*=\\s*)\\d+`);
  if (re.test(vars)) vars = vars.replace(re, `$1${value}`);
  else console.warn(`variables.gradle: ${name} not found`);
};
setVar('minSdkVersion', 26); // Android 8.0
setVar('compileSdkVersion', 35);
setVar('targetSdkVersion', 35); // runs unchanged on Android 16
fs.writeFileSync(varsFile, vars);

// 2) Cleartext (http) traffic to LAN servers
const resXml = path.join(root, 'app/src/main/res/xml');
fs.mkdirSync(resXml, { recursive: true });
fs.writeFileSync(
  path.join(resXml, 'network_security_config.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
`
);

const manifestFile = path.join(root, 'app/src/main/AndroidManifest.xml');
let manifest = fs.readFileSync(manifestFile, 'utf8');
if (!manifest.includes('networkSecurityConfig')) {
  manifest = manifest.replace(
    '<application',
    '<application android:usesCleartextTraffic="true" android:networkSecurityConfig="@xml/network_security_config"'
  );
}
for (const perm of ['ACCESS_NETWORK_STATE', 'ACCESS_WIFI_STATE', 'CAMERA']) {
  if (!manifest.includes(`android.permission.${perm}`)) {
    manifest = manifest.replace(
      '<application',
      `<uses-permission android:name="android.permission.${perm}" />\n    <application`
    );
  }
}
fs.writeFileSync(manifestFile, manifest);
console.log('Android project patched: minSdk 26, targetSdk 35, cleartext LAN traffic enabled.');
