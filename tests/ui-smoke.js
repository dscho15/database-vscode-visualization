// Real Chromium + the shipped webview + the shipped Go reader.
// Run against a fixture by default, or SQLITE_LENS_TEST_DB for a read-only live check.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createFixture } = require('./fixture');
const { chromium } = require('playwright');
const { requestDatabase } = require('../src/bridge');

async function main() {
  const root = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-lens-ui-'));
  const database = process.env.SQLITE_LENS_TEST_DB || path.join(temporary, 'demo.sqlite3');
  if (!process.env.SQLITE_LENS_TEST_DB) {
    createFixture(database);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const name = request.url === '/' ? 'index.html' : request.url.slice(1);
      if (!['index.html', 'style.css', 'app.js'].includes(name)) { response.writeHead(404).end(); return; }
      let content = await fs.readFile(path.join(root, 'media', name), 'utf8');
      if (name === 'index.html') content = content.replaceAll('{{cspSource}}', "'self'")
        .replaceAll('{{nonce}}', 'test-nonce').replace('{{styleUri}}', '/style.css').replace('{{scriptUri}}', '/app.js');
      response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html');
      response.end(content);
    } catch (error) { response.writeHead(500).end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: ['--no-sandbox'],
  }).catch(async (error) => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  const workers = new Set();
  let active;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

  await page.exposeFunction('hostMessage', async (message) => {
    if (message.type === 'cancel') { active?.cancel(); return; }
    if (message.type !== 'request') return;
    active?.cancel();
    const worker = requestDatabase(root, database, message);
    active = worker;
    workers.add(worker);
    let response;
    try { response = { type: 'response', id: message.id, data: await worker.promise }; }
    catch (error) { response = { type: 'response', id: message.id, error: error.message }; }
    finally { workers.delete(worker); }
    if (!page.isClosed()) await page.evaluate((data) => window.postMessage(data, '*'), response);
  });
  await page.addInitScript(() => {
    let state;
    window.acquireVsCodeApi = () => ({
      postMessage: (message) => window.hostMessage(message),
      getState: () => state,
      setState: (value) => { state = value; },
    });
  });

  const waitReady = () => page.locator('#busy').waitFor({ state: 'hidden' });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.table-item').first().waitFor();
    await waitReady();
    const table = process.env.SQLITE_LENS_TEST_DB ? 'context_days' : 'samples';
    await page.getByRole('button', { name: table, exact: true }).first().click();
    await waitReady();
    assert.equal(await page.locator('#grid tbody tr').count(), 100);
    assert.match(await page.locator('#grid').innerText(), /BLOB/);

    await page.locator('#next').click();
    await waitReady();
    assert.match(await page.locator('#page-label').innerText(), /Page 2/);
    await page.locator('#previous').click();
    await waitReady();
    assert.match(await page.locator('#page-label').innerText(), /Page 1/);
    const filterColumn = process.env.SQLITE_LENS_TEST_DB ? 'project_id' : 'label';
    await page.locator('#filter-column').selectOption(filterColumn);
    await page.locator('#filter-value').fill('no-such-value');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await waitReady();
    assert.equal(await page.locator('#grid tbody tr').count(), 0);
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await waitReady();

    await page.locator('#grid tbody tr').first().locator('td').nth(1).click();
    assert.equal(await page.locator('#cell-dialog').isVisible(), true);
    await page.locator('#close-cell').click();
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts', 'data.png'), fullPage: true });

    await page.getByRole('button', { name: 'Schema', exact: true }).click();
    assert.ok(await page.locator('.schema-card').count() >= 2);
    assert.ok(await page.locator('.relationship').count() > 0);
    await page.locator('.relationship').first().click();
    await page.screenshot({ path: path.join(root, 'artifacts', 'schema.png'), fullPage: true });

    await page.getByRole('button', { name: 'SQL editor', exact: true }).click();
    await page.locator('#sql').fill('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20) SELECT x, x*x AS squared FROM n');
    await page.locator('#run-query').click();
    await waitReady();
    assert.equal(await page.locator('#grid tbody tr').count(), 20);
    await page.getByRole('button', { name: 'Chart', exact: true }).click();
    assert.equal(await page.locator('#chart circle').count(), 20);
    await page.locator('#chart-type').selectOption('bar');
    assert.equal(await page.locator('#chart rect').count(), 20);
    await page.screenshot({ path: path.join(root, 'artifacts', 'chart.png'), fullPage: true });

    await page.getByRole('button', { name: 'SQL editor', exact: true }).click();
    await page.locator('#sql').fill('PRAGMA user_version=1');
    await page.locator('#run-query').click();
    await waitReady();
    assert.match(await page.locator('#error').innerText(), /authorized/);
    await page.locator('#sql').fill('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n');
    await page.locator('#run-query').click();
    await page.locator('#cancel').click();
    await waitReady();
    assert.match(await page.locator('#error').innerText(), /cancelled/);

    await page.setViewportSize({ width: 800, height: 850 });
    await page.getByRole('button', { name: 'Data', exact: true }).click();
    await waitReady();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(root, 'artifacts', 'narrow.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`UI smoke passed: browse, pagination, filtering, cells, schema links, query, chart, write denial, cancellation, narrow layout (${database}).`);
  } finally {
    for (const worker of workers) worker.cancel();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
