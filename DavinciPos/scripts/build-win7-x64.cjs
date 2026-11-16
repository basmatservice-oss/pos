const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sourceRoot = path.resolve(__dirname, '..');
const stagingRoot = path.join(os.tmpdir(), 'davincipos-win7-x64');
fs.rmSync(stagingRoot, { recursive: true, force: true });
fs.mkdirSync(stagingRoot, { recursive: true });

const excluded = new Set([
  '.git', 'node_modules', 'android', 'dist', 'release', 'win7',
  'coverage', '.env', '.env.local', '.env.production'
]);
for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
  if (excluded.has(entry.name) || entry.name.startsWith('.env.')) continue;
  fs.cpSync(path.join(sourceRoot, entry.name), path.join(stagingRoot, entry.name), {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(sourceRoot, source).split(path.sep);
      return !relative.some((part) => excluded.has(part)) &&
        !relative.some((part) => part === 'node_modules' || part === '.git');
    }
  });
}

const manifest = {
  name: 'davincipos-win7-x64',
  version: '0.1.0',
  private: true,
  type: 'module',
  description: 'DavinciPos legacy Windows 7 x64 build',
  main: 'desktop-shell/main.cjs',
  dependencies: {
    'better-sqlite3': '9.6.0',
    express: '4.21.2'
  },
  devDependencies: {
    electron: '22.3.27',
    'electron-builder': '24.13.3'
  },
  build: {
    appId: 'com.basmatservice.davincipos',
    productName: 'DavinciPos',
    asar: true,
    asarUnpack: ['node_modules/better-sqlite3/**'],
    files: [
      'desktop-shell/**',
      '*.js',
      '*.html',
      '*.css',
      'schema.sql',
      'package.json',
      '!**/*.test.js',
      '!**/README.md',
      '!**/.env*'
    ],
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      artifactName: 'DavinciPos-Windows-7-x64-Setup-${version}.${ext}'
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'DavinciPos'
    },
    extraResources: [
      { from: 'enable-lan-host.ps1', to: 'enable-lan-host.ps1' },
      { from: 'LAN-HOST-WINDOWS-RC.md', to: 'LAN-HOST-WINDOWS-RC.md' }
    ],
    directories: { output: 'dist-win7-x64' }
  }
};
fs.writeFileSync(path.join(stagingRoot, 'package.json'), JSON.stringify(manifest, null, 2));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' failed with exit code ' + result.status);
}
console.log('Installing isolated legacy dependencies (Electron 22 / Node 16 ABI)...');
run('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock'], stagingRoot);
console.log('Building the Windows 7 x64 NSIS installer...');
run('npx', ['electron-builder', '--win', 'nsis', '--x64'], stagingRoot);
const output = path.join(stagingRoot, 'dist-win7-x64');
const installers = fs.readdirSync(output).filter((name) => name.endsWith('.exe'));
if (installers.length !== 1) throw new Error('Expected exactly one Windows 7 x64 installer; found ' + installers.length);
const finalOutput = path.join(sourceRoot, 'dist', 'win7-x64');
fs.mkdirSync(finalOutput, { recursive: true });
fs.copyFileSync(path.join(output, installers[0]), path.join(finalOutput, installers[0]));
console.log('WIN7_X64_INSTALLER=' + path.join(finalOutput, installers[0]));
