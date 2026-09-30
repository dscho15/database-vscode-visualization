const { spawn } = require('node:child_process');
const path = require('node:path');

function backendPath(extensionPath) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return path.join(extensionPath, 'bin', `${process.platform}-${process.arch}`, `sqlite-lens${suffix}`);
}

function requestDatabase(extensionPath, databasePath, request, options = {}) {
  const executable = options.backendPath || backendPath(extensionPath);
  const timeout = options.timeout || 15;
  const child = spawn(executable, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let cancelled = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const promise = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let failure;
    const timer = setTimeout(() => {
      failure = new Error('Query timed out. Add a filter or use an indexed column.');
      child.kill();
    }, (timeout + 1) * 1000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 8_000_000) {
        failure = new Error('Result exceeds the preview budget. Select fewer columns.');
        child.kill();
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.stdin.on('error', () => {}); // A cancelled worker may close stdin before reading.
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the SQLite reader: ${error.message}. Reinstall SQLite Lens or configure sqliteLens.backendPath.`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (cancelled) return reject(new Error('Query cancelled.'));
      if (signal) return reject(new Error('Query cancelled.'));
      if (code !== 0) return reject(new Error(stderr || `Database worker exited with code ${code}.`));

      try {
        const result = JSON.parse(stdout);
        if (!result.ok) return reject(new Error(result.error));
        resolve(result.data);
      } catch (error) {
        reject(new Error(`Invalid response from the SQLite reader: ${error.message}`));
      }
    });

    child.stdin.end(JSON.stringify({ ...request, path: databasePath, timeout }));
  });

  return { promise, cancel: () => { cancelled = true; child.kill(); } };
}

function displayCell(value) {
  if (value === null) return 'NULL';
  if (typeof value !== 'object') return String(value);
  if (value.type === 'blob') return `[BLOB: ${value.bytes} bytes]`;
  if (value.type === 'text') return `${value.preview}… [truncated]`;
  return value.value;
}

function toCsv(result) {
  const encode = (value) => {
    let text = value === null ? '' : displayCell(value);
    // Keep exported database text from becoming spreadsheet formulas.
    if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [result.columns, ...result.rows].map((row) => row.map(encode).join(',')).join('\r\n') + '\r\n';
}

module.exports = { backendPath, requestDatabase, toCsv };
