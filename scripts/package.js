#!/usr/bin/env node
// Builds the Chrome Web Store upload: dist/repost-for-x-<version>.zip
// containing only the files the extension needs at runtime.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== version) {
  console.error(`Version mismatch: manifest.json ${version} vs package.json ${pkg.version}`);
  process.exit(1);
}

const INCLUDE = ['manifest.json', 'service-worker.js', 'content', 'popup', 'icons'];
const dist = path.join(root, 'dist');
const out = path.join(dist, `repost-for-x-${version}.zip`);
fs.mkdirSync(dist, { recursive: true });
fs.rmSync(out, { force: true });

execFileSync('zip', ['-r', '-X', out, ...INCLUDE, '-x', '*.DS_Store'], { cwd: root, stdio: 'inherit' });
console.log(`\nCreated ${path.relative(root, out)}`);
