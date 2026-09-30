const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createFixture } = require('./fixture');

test('custom editor wires the real worker, CSP, CSV export and disposal', async () => {
  const root = path.resolve(__dirname, '..');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-lens-host-'));
  const database = path.join(directory, 'test.sqlite3');
  createFixture(database);
  const uri = (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` });
  const messages = [];
  const notifications = [];
  let provider;
  let receive;
  let dispose;
  let listenerDisposed = false;
  let exportPath = uri(path.join(directory, 'result.csv'));
  const vscode = {
    Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    workspace: {
      getConfiguration: () => ({ get: () => undefined }),
      fs: { writeFile: (target, data) => fs.writeFile(target.fsPath, data) },
    },
    window: {
      registerCustomEditorProvider: (name, value) => {
        assert.equal(name, 'sqliteLens.database');
        provider = value;
        return { dispose() {} };
      },
      showSaveDialog: async () => exportPath,
      showInformationMessage: (message) => notifications.push(message),
      showErrorMessage: (message) => notifications.push(message),
    },
    commands: { registerCommand: () => ({ dispose() {} }) },
  };
  const entrypoint = path.join(root, 'src', 'extension.js');
  const nodeRequire = createRequire(entrypoint);
  const sandbox = {
    require: (name) => name === 'vscode' ? vscode : nodeRequire(name),
    module: { exports: {} },
    Buffer,
  };
  vm.runInNewContext(await fs.readFile(entrypoint, 'utf8'), sandbox, { filename: entrypoint });
  const context = { extensionUri: uri(root), extensionPath: root, subscriptions: [] };
  sandbox.module.exports.activate(context);
  const panel = {
    webview: {
      cspSource: 'vscode-webview://test',
      asWebviewUri: (value) => value,
      onDidReceiveMessage: (callback) => {
        receive = callback;
        return { dispose: () => { listenerDisposed = true; } };
      },
      postMessage: async (message) => messages.push(message),
    },
    onDidDispose: (callback) => { dispose = callback; },
  };

  try {
    const document = provider.openCustomDocument(uri(database));
    await provider.resolveCustomEditor(document, panel);
    assert.equal(panel.webview.options.enableScripts, true);
    assert.match(panel.webview.html, /default-src 'none'/);
    assert.doesNotMatch(panel.webview.html, /\{\{/);
    assert.equal(panel.webview.options.localResourceRoots[0].fsPath, path.join(root, 'media'));

    await receive({ type: 'request', id: 1, action: 'schema' });
    assert.ok(messages.at(-1).data.tables.some((table) => table.name === 't'));
    await receive({ type: 'request', id: 2, action: 'query', sql: 'SELECT 42 AS answer' });
    assert.deepEqual(messages.at(-1).data.rows, [[42]]);
    await receive({ type: 'export' });
    assert.equal(await fs.readFile(exportPath.fsPath, 'utf8'), '"answer"\r\n"42"\r\n');

    exportPath = uri(database);
    await receive({ type: 'export' });
    assert.match(notifications.at(-1), /different from the open database/);
    await receive({ type: 'request', id: 3, action: 'query', sql: 'DELETE FROM t' });
    assert.match(messages.at(-1).error, /authorized/);
    dispose();
    assert.equal(listenerDisposed, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
