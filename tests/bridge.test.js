const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { createFixture } = require('./fixture');
const { requestDatabase, toCsv } = require('../src/bridge');

test('worker reports success, SQL errors, Unicode, cancellation and a missing binary', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sqlite-lens-'));
  const database = path.join(directory, 'test.sqlite3');
  const root = path.resolve(__dirname, '..');
  createFixture(database);

  try {
    const result = await requestDatabase(root, database, { action: 'query', sql: 'SELECT 42 AS answer' }).promise;
    assert.deepEqual(result.rows, [[42]]);
    const unicode = 'Ærø 🦆 '.repeat(400);
    const text = await requestDatabase(root, database, { action: 'query', sql: `SELECT '${unicode}'` }).promise;
    assert.equal(text.rows[0][0], unicode);
    await assert.rejects(requestDatabase(root, database, { action: 'query', sql: 'DELETE FROM t' }).promise, /authorized/);
    const slow = requestDatabase(root, database, { action: 'query', sql: 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n' });
    setTimeout(() => slow.cancel(), 100);
    await assert.rejects(slow.promise, /cancelled/);
    await assert.rejects(requestDatabase(root, database, { action: 'schema' }, { backendPath: '/no/such/sqlite-lens' }).promise, /backendPath/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CSV escapes quotes, newlines, previews and spreadsheet formulas', () => {
  const csv = toCsv({ columns: ['text', 'value'], rows: [['a,"b"\nc', 2], ['=SUM(1,2)', null], [{ type: 'blob', bytes: 100 }, -3]] });
  assert.match(csv, /"a,""b""\nc","2"/);
  assert.match(csv, /"'=SUM\(1,2\)",""/);
  assert.match(csv, /"\[BLOB: 100 bytes\]","-3"/);
});
