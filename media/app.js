/* The webview only renders data. All filesystem access stays in the extension host. */
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const saved = vscode.getState() || {};
const state = {
  schema: null,
  table: saved.table || '',
  tab: 'data',
  offset: 0,
  history: [],
  sort: '',
  descending: false,
  filterColumn: '',
  filterValue: '',
  result: null,
  source: '',
  serial: 0,
  pending: null,
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function persist() {
  vscode.setState({ table: state.table, sql: $('sql').value });
}

function request(action, parameters = {}) {
  if (state.pending) state.pending.resolve(null);
  const id = ++state.serial;
  $('error').hidden = true;
  $('busy').hidden = false;
  $('export').disabled = true;
  $('previous').disabled = true;
  $('next').disabled = true;

  return new Promise((resolve) => {
    state.pending = { id, resolve };
    vscode.postMessage({ type: 'request', id, action, ...parameters });
  });
}

window.addEventListener('message', ({ data: message }) => {
  if (message.type !== 'response' || message.id !== state.pending?.id) return;
  const { resolve } = state.pending;
  state.pending = null;
  $('busy').hidden = true;
  $('export').disabled = !state.result;

  if (message.error) {
    $('error').textContent = message.error;
    $('error').hidden = false;
    updatePagination();
    resolve(null);
  } else {
    resolve(message.data);
  }
});

function bytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
}

function display(value) {
  if (value === null) return 'NULL';
  if (typeof value !== 'object') return String(value);
  if (value.type === 'blob') return `BLOB · ${bytes(value.bytes)}`;
  if (value.type === 'text') return `${value.preview}… [truncated]`;
  return value.value;
}

function selectedTable() {
  return state.schema?.tables.find((table) => table.name === state.table);
}

function renderTables() {
  const search = $('table-search').value.toLowerCase();
  const fragment = document.createDocumentFragment();
  for (const table of state.schema.tables.filter((item) => item.name.toLowerCase().includes(search))) {
    const button = element('button', `table-item${table.name === state.table ? ' active' : ''}`);
    button.title = `${table.name} (${table.type})`;
    button.setAttribute('aria-label', table.name);
    button.setAttribute('aria-current', String(table.name === state.table));
    button.append(element('span', 'table-symbol', table.type === 'view' ? '◇' : '▦'), element('span', 'table-name', table.name));
    button.addEventListener('click', () => selectTable(table.name));
    fragment.append(button);
  }
  if (!fragment.childNodes.length) fragment.append(element('p', 'empty', 'No matching tables.'));
  $('tables').replaceChildren(fragment);
}

function selectTable(name) {
  if (state.pending) {
    vscode.postMessage({ type: 'cancel' });
    state.pending.resolve(null);
    state.pending = null;
    $('busy').hidden = true;
  }
  state.result = null;
  state.source = '';
  $('export').disabled = true;
  $('grid').replaceChildren(element('div', 'empty', 'Select Data to load this table.'));
  $('result-label').textContent = 'TABLE PREVIEW';
  $('result-status').textContent = 'Ready';
  state.table = name;
  state.offset = 0;
  state.history = [];
  state.sort = '';
  state.descending = false;
  state.filterColumn = '';
  state.filterValue = '';
  $('filter-value').value = '';
  const table = selectedTable();
  $('title').textContent = name;
  $('subtitle').textContent = `${table.type === 'view' ? 'View' : 'Table'} · ${table.columns.length} columns · ${table.indexes.length} indexes · ${table.foreignKeys.length} foreign-key columns`;
  $('filter-column').replaceChildren(new Option('Choose column', ''), ...table.columns.map((column) => new Option(column.name, column.name)));
  renderTables();
  renderSchema();
  if (!$('sql').value) $('sql').value = `SELECT *\nFROM "${name.replaceAll('"', '""')}"\nLIMIT 100;`;
  persist();
  if (state.tab === 'schema') return;
  switchTab('data');
}

async function loadSchema() {
  const data = await request('schema');
  if (!data) return;
  state.schema = data;
  $('database-name').textContent = data.name;
  $('database-path').textContent = data.path;
  $('database-size').textContent = `${bytes(data.size)} on disk`;
  $('sqlite-version').textContent = `SQLite ${data.sqliteVersion}`;
  $('table-count').textContent = data.tables.length;

  if (data.tables.length) {
    selectTable(selectedTable()?.name || data.tables[0].name);
  } else {
    state.table = '';
    state.result = null;
    renderTables();
    renderSchema();
    $('title').textContent = 'Empty database';
    $('subtitle').textContent = 'No user tables or views found.';
    $('grid').replaceChildren(element('div', 'empty', 'This database has no tables or views.'));
    $('export').disabled = true;
  }
}

async function browse(offset = state.offset, history = state.history) {
  if (!state.table) return;
  const data = await request('browse', {
    table: state.table,
    limit: Number($('page-size').value),
    offset,
    sort: state.sort,
    descending: state.descending,
    filterColumn: state.filterColumn,
    filterValue: state.filterValue,
  });
  if (!data) return;
  state.offset = offset;
  state.history = history;
  showResult(data, 'table');
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
    button.setAttribute('aria-current', String(button.dataset.tab === tab));
  });
  for (const name of ['data', 'query', 'schema', 'chart']) $(name + '-pane').hidden = name !== tab;
  $('results-pane').hidden = ['schema', 'chart'].includes(tab);
  $('export').hidden = tab === 'schema';
  if (tab === 'data') browse();
  if (tab === 'chart') renderChart();
  updatePagination();
}

function showResult(result, source) {
  state.result = result;
  state.source = source;
  $('export').disabled = false;
  $('result-label').textContent = source === 'query' ? 'QUERY RESULT' : `TABLE PREVIEW · ${state.table}`;
  $('result-status').textContent = `${result.rows.length.toLocaleString()} rows · ${result.elapsedMs} ms${result.hasMore ? ' · more rows available' : ''}`;
  renderGrid();
  updatePagination();
  const columns = result.columns.map((name, index) => new Option(name, String(index)));
  $('chart-x').replaceChildren(...columns);
  const numeric = result.columns.flatMap((name, index) => result.rows.some((row) => typeof row[index] === 'number') ? [new Option(name, String(index))] : []);
  $('chart-y').replaceChildren(...numeric);
  if (numeric.length > 1 && numeric[0].value === $('chart-x').value) $('chart-y').selectedIndex = 1;
  if (state.tab === 'chart') renderChart();
}

function updatePagination() {
  $('pagination').hidden = state.tab !== 'data' || state.source !== 'table';
  $('previous').disabled = !!state.pending || state.history.length === 0;
  $('next').disabled = !!state.pending || !state.result?.hasMore;
  $('page-label').textContent = `Page ${state.history.length + 1}`;
}

function renderGrid() {
  const { columns, rows } = state.result;
  const table = element('table');
  const header = element('tr');
  header.append(element('th', 'row-number', '#'));
  columns.forEach((column) => {
    const th = element('th');
    if (state.source === 'table') {
      const button = element('button', '', column + (state.sort === column ? state.descending ? ' ↓' : ' ↑' : ''));
      button.title = `Sort by ${column}`;
      button.addEventListener('click', () => {
        state.descending = state.sort === column && !state.descending;
        state.sort = column;
        state.offset = 0;
        state.history = [];
        browse();
      });
      th.append(button);
    } else {
      th.textContent = column;
    }
    header.append(th);
  });
  const head = element('thead');
  head.append(header);
  const body = element('tbody');
  rows.forEach((row, rowIndex) => {
    const tr = element('tr');
    tr.append(element('td', 'row-number', String((state.result.offset || 0) + rowIndex + 1)));
    row.forEach((value, index) => {
      const td = element('td', typeof value === 'number' ? 'number' : value === null || typeof value === 'object' ? 'special' : '', display(value));
      td.tabIndex = 0;
      const inspect = () => inspectCell(columns[index], value);
      td.addEventListener('click', inspect);
      td.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') inspect();
      });
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(head, body);
  $('grid').replaceChildren(table);
  if (!rows.length) $('grid').append(element('div', 'empty', 'No rows found. Try a different filter or query.'));
}

function inspectCell(column, value) {
  let text = display(value);
  if (typeof value === 'string') {
    try { text = JSON.stringify(JSON.parse(value), null, 2); } catch { /* Ordinary text. */ }
  }
  if (typeof value === 'number' && /timestamp_ms$/i.test(column)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) text += `\n\nUTC: ${date.toISOString()}`;
  }
  if (value?.type === 'blob') text = `Binary payload: ${value.bytes.toLocaleString()} bytes\n\nBLOB contents are not loaded into the grid. Use length(), hex(substr(...)), or a format-specific decoder in your own tooling to inspect the payload.`;
  $('cell-title').textContent = column;
  $('cell-value').textContent = text;
  $('cell-dialog').showModal();
}

function renderSchema() {
  const cards = state.schema.tables.map((table) => {
    const card = element('article', `schema-card${table.name === state.table ? ' selected' : ''}`);
    const title = element('button', '', table.name);
    title.addEventListener('click', () => selectTable(table.name));
    card.append(title, element('p', '', `${table.columns.length} columns · ${table.indexes.length} indexes`));
    const keys = table.columns.filter((column) => column.pk).map((column) => column.name);
    if (keys.length) card.append(element('p', '', `PK: ${keys.join(', ')}`));
    for (const foreign of table.foreignKeys) {
      const link = element('button', 'relationship', `${foreign.from} → ${foreign.table}.${foreign.to || '(primary key)'}`);
      link.disabled = !state.schema.tables.some((item) => item.name === foreign.table);
      link.addEventListener('click', () => selectTable(foreign.table));
      card.append(link);
    }
    if (!table.foreignKeys.length) card.append(element('p', '', 'No declared foreign keys'));
    return card;
  });
  $('relationship-map').replaceChildren(...cards);
  const selected = selectedTable();
  if (!selected) return;
  const heading = element('h2', '', `${selected.name} · definition`);
  const container = element('div', 'schema-columns');
  const table = element('table');
  const head = element('thead');
  const header = element('tr');
  ['Column', 'Type', 'Constraints', 'Default'].forEach((name) => header.append(element('th', '', name)));
  head.append(header);
  const body = element('tbody');
  for (const column of selected.columns) {
    const row = element('tr');
    const constraints = [column.pk ? `PK ${column.pk}` : '', column.notNull ? 'NOT NULL' : '', column.hidden > 1 ? 'GENERATED' : ''].filter(Boolean).join(' · ');
    [column.name, column.type || 'ANY', constraints || '—', column.default ?? '—'].forEach((value) => row.append(element('td', '', value)));
    body.append(row);
  }
  table.append(head, body);
  container.append(table);
  const indexes = element('div');
  for (const index of selected.indexes) indexes.append(element('p', '', `${index.unique ? 'UNIQUE ' : ''}INDEX ${index.name} (${index.columns.map((name) => name ?? '<expression>').join(', ')})${index.partial ? ' · partial' : ''}`));
  $('schema-detail').replaceChildren(heading, container, indexes, element('pre', 'ddl', selected.sql || 'No SQL definition available.'));
}

function svgNode(tag, attributes, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderChart() {
  const result = state.result;
  const xColumn = Number($('chart-x').value);
  const yColumn = Number($('chart-y').value);
  const type = $('chart-type').value;
  $('chart-note').textContent = '';
  if (!result?.rows.length || !$('chart-y').options.length) {
    $('chart').replaceChildren(element('div', 'empty', 'Choose a table or run a query with numeric columns to build a chart.'));
    return;
  }

  const rows = result.rows.filter((row) => typeof row[yColumn] === 'number' && row[xColumn] !== null && typeof row[xColumn] !== 'object');
  const maxPoints = type === 'bar' ? 80 : 1000;
  const points = rows.slice(0, maxPoints);
  if (!points.length) {
    $('chart').replaceChildren(element('div', 'empty', 'No plottable values for these axes.'));
    return;
  }
  const numericX = points.every((row) => typeof row[xColumn] === 'number');
  const xValues = points.map((row, index) => numericX ? row[xColumn] : index);
  const yValues = points.map((row) => row[yColumn]);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMin = Math.min(...yValues, ...(type === 'bar' ? [0] : []));
  const yMax = Math.max(...yValues, ...(type === 'bar' ? [0] : []));
  const x = (value) => 80 + (value - xMin) / (xMax - xMin || 1) * 780;
  const y = (value) => 325 - (value - yMin) / (yMax - yMin || 1) * 260;
  const svg = svgNode('svg', { viewBox: '0 0 920 390', role: 'img', 'aria-label': `${result.columns[yColumn]} by ${result.columns[xColumn]}` });

  for (let tick = 0; tick <= 4; tick++) {
    const value = yMin + (yMax - yMin) * tick / 4;
    const py = y(value);
    svg.append(svgNode('line', { x1: 75, x2: 870, y1: py, y2: py, class: 'axis' }));
    svg.append(svgNode('text', { x: 66, y: py + 4, 'text-anchor': 'end' }, value.toLocaleString(undefined, { maximumFractionDigits: 2, notation: 'compact' })));
  }
  if (type === 'line') svg.append(svgNode('polyline', { points: points.map((row, index) => `${x(xValues[index])},${y(row[yColumn])}`).join(' '), class: 'series' }));
  points.forEach((row, index) => {
    const mark = type === 'bar'
      ? svgNode('rect', { x: x(xValues[index]) - Math.min(22, 600 / points.length) / 2, y: Math.min(y(0), y(row[yColumn])), width: Math.min(22, 600 / points.length), height: Math.max(1, Math.abs(y(0) - y(row[yColumn]))), class: 'bar' })
      : svgNode('circle', { cx: x(xValues[index]), cy: y(row[yColumn]), r: type === 'scatter' ? 4 : 2.5, class: 'point' });
    mark.append(svgNode('title', {}, `${display(row[xColumn])}: ${row[yColumn]}`));
    svg.append(mark);
  });

  const ticks = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  for (const index of ticks) {
    const value = points[index][xColumn];
    const date = new Date(value);
    const label = numericX && /timestamp_ms$/i.test(result.columns[xColumn]) && !Number.isNaN(date.getTime())
      ? date.toISOString().slice(0, 16).replace('T', ' ')
      : display(value).slice(0, 25);
    svg.append(svgNode('text', { x: x(xValues[index]), y: 348, 'text-anchor': index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle' }, label));
  }
  svg.append(svgNode('text', { x: 80, y: 30 }, result.columns[yColumn]));
  svg.append(svgNode('text', { x: 470, y: 378, 'text-anchor': 'middle' }, result.columns[xColumn]));
  $('chart').replaceChildren(svg);
  $('chart-note').textContent = `${points.length} points from the current ${state.source === 'query' ? 'query result' : 'table page'} · ${numericX ? 'numeric X scale' : 'categories in result order'}${points.length < rows.length ? ` · first ${maxPoints} points shown` : ''}. Use SQL to filter, aggregate, and order your data. Missing values are omitted.`;
}

$('table-search').addEventListener('input', () => { if (state.schema) renderTables(); });
$('refresh').addEventListener('click', loadSchema);
$('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
$('export').addEventListener('click', () => vscode.postMessage({ type: 'export' }));
$('close-cell').addEventListener('click', () => $('cell-dialog').close());
document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
$('filter-form').addEventListener('submit', (event) => {
  event.preventDefault();
  state.filterColumn = $('filter-column').value;
  state.filterValue = $('filter-value').value;
  state.offset = 0;
  state.history = [];
  browse();
});
$('clear-filter').addEventListener('click', () => {
  $('filter-column').value = '';
  $('filter-value').value = '';
  state.filterColumn = '';
  state.filterValue = '';
  state.offset = 0;
  state.history = [];
  browse();
});
$('page-size').addEventListener('change', () => { state.offset = 0; state.history = []; browse(); });
$('previous').addEventListener('click', () => {
  browse(state.history.at(-1) ?? 0, state.history.slice(0, -1));
});
$('next').addEventListener('click', () => {
  browse(state.offset + state.result.rows.length, [...state.history, state.offset]);
});
async function runQuery() {
  if (!$('sql').value.trim()) return;
  persist();
  const data = await request('query', { sql: $('sql').value });
  if (data) showResult(data, 'query');
}
$('run-query').addEventListener('click', runQuery);
$('sql').value = saved.sql || '';
$('sql').addEventListener('input', persist);
$('sql').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); runQuery(); }
});
for (const id of ['chart-type', 'chart-x', 'chart-y']) $(id).addEventListener('change', renderChart);
loadSchema();
