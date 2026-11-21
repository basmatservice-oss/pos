const fs = require('node:fs');
const path = require('node:path');

const assetsDirectory = path.resolve('dist/assets');
if (!fs.existsSync(assetsDirectory)) {
  throw new Error('Native renderer assets were not produced');
}
const files = fs.readdirSync(assetsDirectory).filter((name) => name.endsWith('.js'));
if (!files.length) throw new Error('Native renderer JavaScript assets are missing');

const matches = [];
for (const name of files) {
  const source = fs.readFileSync(path.join(assetsDirectory, name), 'utf8');
  if (/dexie/i.test(name) || /dexie/i.test(source)) matches.push(name);
}
if (matches.length) {
  throw new Error('Dexie was bundled into the native renderer: ' + matches.join(', '));
}
process.stdout.write('Native renderer bundle is free of Dexie code.\n');
