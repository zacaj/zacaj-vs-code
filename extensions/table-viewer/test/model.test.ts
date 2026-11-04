import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeView, facet, parseDate, parseDateInput, Table, compileColumnText } from '../src/webview/model';

function mk() {
  const t = new Table();
  t.setColumns(['id', 'level', 'ts', 'n']);
  t.append(
    [
      ['1', 'info', '2024-01-01T00:00:00Z', '10'],
      ['2', 'warn', '2024-01-02 00:00:00', '2.5'],
      ['3', 'error', '2024-01-03T00:00:00.5+01:00', ''],
      ['4', 'info', '1704412800', '-3'],
    ],
    false,
  );
  return t;
}

test('type inference', () => {
  const t = mk();
  assert.deepEqual(t.columns.map((c) => c.type), ['number', 'string', 'string', 'number']);
  // ts has an epoch value; 3/4 date-like < 95% -> string. override to date works with epochs
  t.columns[2].override = 'date';
  assert.equal(t.nums(2)[3], 1704412800000);
  assert.equal(t.nums(2)[0], Date.UTC(2024, 0, 1));
});

test('filters: text syntax, values, range, global, sort', () => {
  const t = mk();
  const q = (filters: [number, object][], extra = {}) => computeView(t, { filters: new Map(filters as never), ...extra });
  assert.deepEqual(q([[1, { text: 'in' }]]), [0, 3]);
  assert.deepEqual(q([[1, { text: '!info' }]]), [1, 2]);
  assert.deepEqual(q([[1, { text: '=WARN' }]]), [1]);
  assert.deepEqual(q([[1, { text: '/^(warn|error)$/' }]]), [1, 2]);
  assert.deepEqual(q([[3, { text: '""' }]]), [2]);
  assert.deepEqual(q([[1, { values: { mode: 'exclude', set: new Set(['info']) } }]]), [1, 2]);
  assert.deepEqual(q([[1, { values: { mode: 'include', set: new Set(['info']) } }]]), [0, 3]);
  assert.deepEqual(q([[3, { min: '0' }]]), [0, 1]);
  assert.deepEqual(q([[3, { min: '-5', max: '5' }]]), [1, 3]);
  assert.deepEqual(q([], { global: { text: 'ERR' } }), [2]);
  assert.deepEqual(q([], { global: { text: 'ERR', caseSensitive: true } }), []);
  assert.deepEqual(q([], { global: { text: '^wa', regex: true } }), [1]);
  assert.deepEqual(q([], { sort: { col: 3, dir: -1 } }), [0, 1, 3, 2]);
  assert.deepEqual(q([], { sort: { col: 1, dir: 1 } }), [2, 0, 3, 1]);
});

test('date range with override', () => {
  const t = mk();
  t.columns[2].override = 'date';
  const v = computeView(t, { filters: new Map([[2, { min: '2024-01-02', max: '2024-01-04' }]]) });
  assert.deepEqual(v, [1, 2]);
});

test('facet excludes own filter', () => {
  const t = mk();
  const filters = new Map([[1, { values: { mode: 'include' as const, set: new Set(['info']) } }], [3, { min: '0' }]]);
  const f = facet(t, { filters }, 1);
  assert.deepEqual(f.sort((a, b) => a.value.localeCompare(b.value)), [{ value: 'info', count: 1 }, { value: 'warn', count: 1 }]);
});

test('provisional rows are replaced and stats corrected', () => {
  const t = new Table();
  t.setColumns(['n']);
  t.append([['1'], ['x']], true);
  assert.equal(t.columns[0].type, 'string');
  t.nums(0);
  t.dropProvisional();
  t.append([['2']], false);
  assert.equal(t.columns[0].type, 'number');
  assert.equal(t.nums(0)[1], 2);
});

test('date parsing helpers', () => {
  assert.equal(parseDate('2024-01-01'), Date.UTC(2024, 0, 1));
  assert.equal(parseDate('2024-01-01 12:00:00Z'), Date.UTC(2024, 0, 1, 12));
  assert.equal(parseDateInput('-1h', 10_000_000), 10_000_000 - 3_600_000);
  assert.ok(isNaN(parseDateInput('garbage')));
  assert.equal(compileColumnText('/[/')!('x'), false);
});
