import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LiveReader } from '../src/host/liveReader';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tv-')), 'f');

test('LiveReader: appends, partial lines, utf-8 split, truncation and rewrite', async () => {
  const f = tmp() + '.csv';
  fs.writeFileSync(f, '﻿name,val\nα,1\nβ,');
  const r = new LiveReader(f, { format: 'csv', delimiter: ',', hasHeader: true, flattenDepth: 2 });
  let b = (await r.read())!;
  assert.deepEqual(b.columns, ['name', 'val']);
  assert.deepEqual(b.rows, [['α', '1'], ['β', '']]);
  assert.equal(b.provisional, true);
  assert.equal(await r.read(), null, 'no change -> null');

  // finish the partial line and add a row whose multibyte char is cut in half
  const buf = Buffer.from('2\nγ,3\n€');
  fs.appendFileSync(f, buf.subarray(0, buf.length - 1));
  b = (await r.read())!;
  assert.equal(b.reset, false);
  assert.deepEqual(b.rows.slice(0, 2), [['β', '2'], ['γ', '3']]);
  assert.equal(b.provisional, true);
  fs.appendFileSync(f, Buffer.concat([buf.subarray(buf.length - 1), Buffer.from(',4\n')]));
  b = (await r.read())!;
  assert.deepEqual(b.rows, [['€', '4']]);
  assert.equal(b.provisional, false);

  // truncate -> reset
  fs.writeFileSync(f, 'a,b\n1,2\n');
  b = (await r.read())!;
  assert.equal(b.reset, true);
  assert.deepEqual(b.columns, ['a', 'b']);
  assert.deepEqual(b.rows, [['1', '2']]);

  // same-length-or-longer rewrite detected via anchor
  fs.writeFileSync(f, 'x,y\n9,9\n8,8\n');
  b = (await r.read())!;
  assert.equal(b.reset, true);
  assert.deepEqual(b.columns, ['x', 'y']);
  assert.equal(b.rows.length, 2);
});

test('LiveReader: jsonl growing file', async () => {
  const f = tmp() + '.jsonl';
  fs.writeFileSync(f, '{"t":"2024-01-01T00:00:00Z","msg":"a"}\n');
  const r = new LiveReader(f, { format: 'jsonl', delimiter: ',', hasHeader: true, flattenDepth: 2 });
  assert.equal((await r.read())!.rows.length, 1);
  fs.appendFileSync(f, '{"t":"2024-01-01T00:00:01Z","msg":"b","new":1}\n{"t":');
  const b = (await r.read())!;
  assert.deepEqual(b.columns, ['t', 'msg', 'new', '(unparsed)']);
  assert.equal(b.rows.length, 2);
  assert.equal(b.provisional, true);
});
