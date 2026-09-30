const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { writeNotices } = require('./notices');

const targets = [
  { platform: 'linux', arch: 'x64', goos: 'linux', goarch: 'amd64' },
  { platform: 'linux', arch: 'arm64', goos: 'linux', goarch: 'arm64' },
  { platform: 'darwin', arch: 'x64', goos: 'darwin', goarch: 'amd64' },
  { platform: 'darwin', arch: 'arm64', goos: 'darwin', goarch: 'arm64' },
  { platform: 'win32', arch: 'x64', goos: 'windows', goarch: 'amd64' },
  { platform: 'win32', arch: 'arm64', goos: 'windows', goarch: 'arm64' },
];
const selected = process.argv.includes('--all')
  ? targets
  : targets.filter((target) => target.platform === process.platform && target.arch === process.arch);

if (!selected.length) throw new Error(`Unsupported build host: ${process.platform}-${process.arch}`);
const root = path.resolve(__dirname, '..');
for (const target of selected) {
  const directory = path.join(root, 'bin', `${target.platform}-${target.arch}`);
  fs.mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, `sqlite-lens${target.platform === 'win32' ? '.exe' : ''}`);
  console.log(`Building ${target.platform}-${target.arch}`);
  execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', executable, './cmd/sqlite-lens'], {
    cwd: root,
    env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: '0' },
    stdio: 'inherit',
  });
}

if (process.argv.includes('--all')) writeNotices(root);
