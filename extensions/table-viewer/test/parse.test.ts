import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDelimited, sniffDelimiter, splitLines } from '../src/host/parse';
import { TableBuilder } from '../src/host/tableBuilder';

test('parseDelimited: basic, quotes, escapes, embedded newlines, CRLF', () => {
  const r = parseDelimited('a,b,c\r\n1,"x,y","he said ""hi"""\n2,"multi\nline",\n', ',');
  assert.deepEqual(r.records, [
    ['a', 'b', 'c'],
    ['1', 'x,y', 'he said "hi"'],
    ['2', 'multi\nline', ''],
  ]);
  assert.equal(r.tail, null);
  assert.equal(r.consumed, r.records.length && 'a,b,c\r\n1,"x,y","he said ""hi"""\n2,"multi\nline",\n'.length);
});

test('parseDelimited: incomplete tail is reported, not committed', () => {
  const text = 'a,b\n1,2\n3,"unterminated\nstill';
  const r = parseDelimited(text, ',');
  assert.deepEqual(r.records, [['a', 'b'], ['1', '2']]);
  assert.equal(r.consumed, 'a,b\n1,2\n'.length);
  assert.deepEqual(r.tail, ['3', 'unterminated\nstill']);
  const r2 = parseDelimited('x,y\n4,5', ',');
  assert.deepEqual(r2.tail, ['4', '5']);
  // trailing \r might be half of \r\n
  assert.equal(parseDelimited('1,2\r', ',').consumed, 0);
  // closing quote at very end might be an escaped quote
  assert.equal(parseDelimited('1,"ab"', ',').consumed, 0);
});

test('parseDelimited: quotes off (plain TSV) treats " literally', () => {
  const r = parseDelimited('a\tb\n"open\tx\nsay "hi"\ty\n', '\t', false);
  assert.deepEqual(r.records, [['a', 'b'], ['"open', 'x'], ['say "hi"', 'y']]);
});

test('splitLines', () => {
  assert.deepEqual(splitLines('{"a":1}\n{"a":2}\n{"a"'), { records: ['{"a":1}', '{"a":2}'], consumed: 16, tail: '{"a"' });
});

test('sniffDelimiter', () => {
  assert.equal(sniffDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(sniffDelimiter('a\tb\tc'), '\t');
  assert.equal(sniffDelimiter('"x;y",b,c'), ',');
});

test('TableBuilder csv: header, extra columns, duplicate names', () => {
  const b = new TableBuilder({ format: 'csv', delimiter: ',', hasHeader: true, flattenDepth: 2 });
  const r = b.ingest('id,name,name\n1,a,b,EXTRA\n2,c\n');
  assert.deepEqual(b.columns, ['id', 'name', 'name (2)', 'Column 4']);
  assert.deepEqual(r.rows, [['1', 'a', 'b', 'EXTRA'], ['2', 'c']]);
  assert.equal(r.provisional, false);
});

test('TableBuilder csv: incomplete header is provisional and resets when completed differently', () => {
  const b = new TableBuilder({ format: 'csv', delimiter: ',', hasHeader: true, flattenDepth: 2 });
  let r = b.ingest('id,na');
  assert.deepEqual(b.columns, ['id', 'na']);
  assert.equal(r.consumed, 0);
  r = b.ingest('id,name\n1,x');
  assert.equal(r.columnsReset, true);
  assert.deepEqual(b.columns, ['id', 'name']);
  assert.deepEqual(r.rows, [['1', 'x']]);
  assert.equal(r.provisional, true);
});

test('TableBuilder jsonl: flattening, new keys, bad lines, primitives', () => {
  const b = new TableBuilder({ format: 'jsonl', delimiter: ',', hasHeader: true, flattenDepth: 1 });
  const r = b.ingest('{"a":1,"o":{"x":true,"deep":{"k":1}},"arr":[1,2]}\nnot json\n{"b":null,"a":"s"}\n42\n{"a":');
  assert.deepEqual(b.columns, ['a', 'o.x', 'o.deep', 'arr', '(unparsed)', 'b', '(value)']);
  assert.deepEqual(r.rows[0], ['1', 'true', '{"k":1}', '[1,2]']);
  assert.deepEqual(r.rows[1], ['', '', '', '', 'not json']);
  assert.deepEqual(r.rows[2], ['s', '', '', '', '', '']);
  assert.deepEqual(r.rows[3], ['', '', '', '', '', '', '42']);
  assert.equal(r.provisional, true); // '{"a":' shown as unparsed provisional row
});
