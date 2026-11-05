import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellAt, locateCell } from '../src/host/locate';
import { TableBuilder, type BuilderOptions } from '../src/host/tableBuilder';

const csv: BuilderOptions = { format: 'csv', delimiter: ',', hasHeader: true, flattenDepth: 2 };
const jsonl: BuilderOptions = { format: 'jsonl', delimiter: ',', hasHeader: true, flattenDepth: 1 };
const at = (text: string, s: string, nth = 0) => {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = text.indexOf(s, i + 1);
  return i;
};

test('csv: locate and reverse, with quotes, CRLF, blank lines, short rows', () => {
  const text = 'id,name,note\r\n1,ann,"multi\r\nline, with comma"\r\n\r\n2,"bo ""b""",x\r\n3,cy\r\n';
  // Rows must line up with what TableBuilder produces.
  const rows = new TableBuilder(csv).ingest(text).rows;
  assert.deepEqual(rows.map((r) => r[1]), ['ann', 'bo "b"', 'cy']);
  const sl = (r: { start: number; end: number } | null) => (r ? text.slice(r.start, r.end) : null);
  assert.equal(sl(locateCell(text, csv, { row: 0, col: 2 })), 'multi\r\nline, with comma');
  assert.equal(sl(locateCell(text, csv, { row: 1, col: 1 })), 'bo ""b""');
  assert.deepEqual(locateCell(text, csv, { row: 2, col: 2 }), { start: text.length - 2, end: text.length - 2 }); // missing cell -> end of record
  assert.equal(locateCell(text, csv, { row: 9, col: 0 }), null);

  assert.deepEqual(cellAt(text, csv, at(text, 'line')), { row: 0, col: 2 });
  assert.deepEqual(cellAt(text, csv, at(text, 'bo')), { row: 1, col: 1 });
  assert.deepEqual(cellAt(text, csv, at(text, ',x')), { row: 1, col: 1 }); // on a delimiter: nearest field
  assert.deepEqual(cellAt(text, csv, at(text, 'name')), { row: -1, col: 1 }); // header
  assert.deepEqual(cellAt(text, csv, at(text, '\r\n\r\n') + 3), { row: 0, col: 0 }); // blank line: previous row
});

test('jsonl: locate and reverse with flattening', () => {
  const text = '{"a":1,"o":{"x":"hi","deep":{"k":1}}}\n\nnot json\n{"b": "s\\"q", "a":2}\n[1,2]\n';
  const b = new TableBuilder(jsonl);
  assert.equal(b.ingest(text).rows.length, 4);
  const sl = (r: { start: number; end: number } | null) => (r ? text.slice(r.start, r.end) : null);
  assert.equal(sl(locateCell(text, jsonl, { row: 0, colName: 'o.x' })), 'hi');
  assert.equal(sl(locateCell(text, jsonl, { row: 0, colName: 'o.deep' })), '{"k":1}'); // beyond flattenDepth
  assert.equal(sl(locateCell(text, jsonl, { row: 1, colName: '(unparsed)' })), 'not json');
  assert.equal(sl(locateCell(text, jsonl, { row: 2, colName: 'b' })), 's\\"q');
  assert.equal(sl(locateCell(text, jsonl, { row: 3, colName: '(value)' })), '[1,2]');

  assert.deepEqual(cellAt(text, jsonl, at(text, 'hi')), { row: 0, colName: 'o.x' });
  assert.deepEqual(cellAt(text, jsonl, at(text, '"k"')), { row: 0, colName: 'o.deep' });
  assert.deepEqual(cellAt(text, jsonl, at(text, '"a":2') + 1), { row: 2, colName: 'a' });
  assert.deepEqual(cellAt(text, jsonl, at(text, ' "a"')), { row: 2, colName: 'a' }); // whitespace: nearest entry
  assert.deepEqual(cellAt(text, jsonl, at(text, 'json')), { row: 1, colName: '(unparsed)' });
});
