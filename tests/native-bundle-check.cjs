const fs = require('node:fs');
const path = require('node:path');

const assetsDirectory = path.resolve('dist/assets');
if (!fs.existsSync(assetsDirectory)) {
  throw new Error('Native renderer assets were not produced');
}
const files = fs.readdirSync(assetsDirectory).filter((name) => name.endsWith('.js'));
if (!files.length) throw new Error('Native renderer JavaScript assets are missing');

const dexieSignatures = [
  /DexieError/,
  /DexiePromise/,
  /DexieTable/,
  /Dexie\.Version/,
  /dexie\.js/i,
];
const matches = [];
for (const name of files) {
  const source = fs.readFileSync(path.join(assetsDirectory, name), 'utf8');
  const isLegacyDexieChunk = /^db-[\w-]+\.js$/i.test(name);
  const matchedSignatures = dexieSignatures.filter((signature) => signature.test(source)).map((signature) => String(signature));
  if (isLegacyDexieChunk || matchedSignatures.length) {
    matches.push(name + (matchedSignatures.length ? ' [' + matchedSignatures.join(', ') + ']' : ''));
  }
}
if (matches.length) {
  throw new Error('Dexie runtime code was bundled into the native renderer: ' + matches.join(', '));
}
process.stdout.write('Native renderer bundle excludes the Dexie runtime and its database chunk.\n');
