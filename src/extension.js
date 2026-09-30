const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { requestDatabase, toCsv } = require('./bridge');

function activate(context) {
  const provider = {
    openCustomDocument(uri) {
      return { uri, dispose() {} };
    },
    async resolveCustomEditor(document, panel) {
      const webview = panel.webview;
      const media = vscode.Uri.joinPath(context.extensionUri, 'media');
      webview.options = { enableScripts: true, localResourceRoots: [media] };

      let worker;
      let lastResult;
      let disposed = false;
      const listener = webview.onDidReceiveMessage(async (message) => {
        if (message.type === 'cancel') {
          worker?.cancel();
          return;
        }

        if (message.type === 'export') {
          if (!lastResult) return;
          const result = lastResult;
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(document.uri, '..', 'sqlite-preview.csv'),
            filters: { CSV: ['csv'] },
            title: 'Export displayed rows (BLOBs and long text remain previews)',
          });
          if (target) {
            if (target.toString() === document.uri.toString()) {
              vscode.window.showErrorMessage('Choose a CSV path different from the open database.');
              return;
            }
            try {
              await vscode.workspace.fs.writeFile(target, Buffer.from(toCsv(result), 'utf8'));
              vscode.window.showInformationMessage(`Exported ${result.rows.length} displayed rows.`);
            } catch (error) {
              vscode.window.showErrorMessage(`Export failed: ${error.message}`);
            }
          }
          return;
        }

        if (message.type !== 'request' || !['schema', 'browse', 'query'].includes(message.action)) return;
        worker?.cancel();
        const config = vscode.workspace.getConfiguration('sqliteLens');
        const current = requestDatabase(context.extensionPath, document.uri.fsPath, message, {
          backendPath: config.get('backendPath'),
          timeout: config.get('queryTimeout'),
        });
        worker = current;

        try {
          const data = await current.promise;
          if (worker !== current || disposed) return;
          if (data.rows) lastResult = data;
          await webview.postMessage({ type: 'response', id: message.id, data });
        } catch (error) {
          if (worker !== current || disposed) return;
          await webview.postMessage({ type: 'response', id: message.id, error: error.message });
        } finally {
          if (worker === current) worker = undefined;
        }
      });

      panel.onDidDispose(() => {
        disposed = true;
        worker?.cancel();
        listener.dispose();
      });

      const nonce = randomBytes(16).toString('hex');
      let html = await fs.readFile(path.join(context.extensionPath, 'media', 'index.html'), 'utf8');
      html = html.replaceAll('{{cspSource}}', webview.cspSource)
        .replaceAll('{{nonce}}', nonce)
        .replaceAll('{{styleUri}}', webview.asWebviewUri(vscode.Uri.joinPath(media, 'style.css')).toString())
        .replaceAll('{{scriptUri}}', webview.asWebviewUri(vscode.Uri.joinPath(media, 'app.js')).toString());
      webview.html = html;
    },
  };

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('sqliteLens.database', provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('sqliteLens.open', async (uri) => {
      if (!uri) {
        const selected = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Open SQLite database',
          filters: { SQLite: ['sqlite3', 'sqlite', 'db', 'db3'], 'All files': ['*'] },
        });
        uri = selected?.[0];
      }
      if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, 'sqliteLens.database');
    }),
  );
}

module.exports = { activate };
