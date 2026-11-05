// Map between table cells and character ranges in the file's text, for jumping between the table
// view and the text editor. Row numbering matches TableBuilder: header and blank records/lines
// are skipped, and an incomplete last record still counts as a row.
import type { BuilderOptions } from './tableBuilder';

export interface Range {
  start: number;
  end: number;
}

/** A cell in table terms. `row` -1 = the header line. CSV columns are positional, JSONL by name. */
export interface CellRef {
  row: number;
  col?: number;
  colName?: string;
}

// ------------------------------------------------------------------ delimited

interface Rec {
  start: number;
  /** Offset of the record's terminating newline (or end of text). */
  end: number;
  /** Content range of each field (inside quotes for quoted fields). */
  fields: Range[];
  blank: boolean;
}

function* delimitedRecords(text: string, delim: string, quotes: boolean): Generator<Rec> {
  const n = text.length;
  const d = delim.charCodeAt(0);
  let i = 0;
  const unquotedEnd = (k: number) => {
    while (k < n) {
      const ch = text.charCodeAt(k);
      if (ch === d || ch === 10 || ch === 13) break;
      k++;
    }
    return k;
  };
  while (i < n) {
    const start = i;
    const fields: Range[] = [];
    let quotedAny = false;
    for (;;) {
      if (quotes && text.charCodeAt(i) === 34) {
        quotedAny = true;
        let q = i + 1;
        for (;;) {
          q = text.indexOf('"', q);
          if (q === -1) {
            q = n;
            break;
          }
          if (text.charCodeAt(q + 1) === 34) q += 2;
          else break;
        }
        fields.push({ start: i + 1, end: q });
        i = unquotedEnd(Math.min(n, q + 1));
      } else {
        const k = unquotedEnd(i);
        fields.push({ start: i, end: k });
        i = k;
      }
      if (i < n && text.charCodeAt(i) === d) {
        i++;
        if (i >= n) fields.push({ start: i, end: i });
        else continue;
      }
      break;
    }
    const end = i;
    if (i < n && text.charCodeAt(i) === 13) i++;
    if (i < n && text.charCodeAt(i) === 10) i++;
    const blank = fields.length === 1 && fields[0].start === fields[0].end && !quotedAny;
    yield { start, end, fields, blank };
  }
}

/** Data records with their row numbers (header = -1). */
function* delimitedRows(text: string, opts: BuilderOptions): Generator<{ row: number; rec: Rec }> {
  let row = opts.hasHeader ? -1 : 0;
  for (const rec of delimitedRecords(text, opts.delimiter, opts.quotes ?? true)) {
    if (rec.blank) continue;
    yield { row, rec };
    row++;
  }
}

// ------------------------------------------------------------------ JSON lines

function* jsonLines(text: string): Generator<{ row: number; start: number; end: number }> {
  let row = 0;
  let start = 0;
  while (start <= text.length) {
    let nl = text.indexOf('\n', start);
    if (nl === -1) nl = text.length;
    const end = nl > start && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
    if (text.slice(start, end).trim()) yield { row: row++, start, end };
    if (nl >= text.length) break;
    start = nl + 1;
  }
}

const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
function skipWs(t: string, i: number, end: number) {
  while (i < end && isWs(t.charCodeAt(i))) i++;
  return i;
}

/** End offset of the JSON value starting at i (lenient). */
function valueEnd(t: string, i: number, end: number): number {
  const c = t[i];
  if (c === '"') {
    for (let j = i + 1; j < end; j++) {
      if (t[j] === '\\') j++;
      else if (t[j] === '"') return j + 1;
    }
    return end;
  }
  if (c === '{' || c === '[') {
    let depth = 0;
    for (let j = i; j < end; j++) {
      const ch = t[j];
      if (ch === '"') j = valueEnd(t, j, end) - 1;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') if (--depth === 0) return j + 1;
    }
    return end;
  }
  let j = i;
  while (j < end && !',}]'.includes(t[j]) && !isWs(t.charCodeAt(j))) j++;
  return j;
}

interface Entry {
  key: string;
  start: number; // key start
  valStart: number;
  valEnd: number;
}

function objectEntries(t: string, i: number, end: number): Entry[] {
  const out: Entry[] = [];
  i = skipWs(t, i, end);
  if (t[i] !== '{') return out;
  i++;
  for (;;) {
    i = skipWs(t, i, end);
    if (i >= end || t[i] !== '"') break;
    const keyEnd = valueEnd(t, i, end);
    let key: string;
    try {
      key = JSON.parse(t.slice(i, keyEnd));
    } catch {
      break;
    }
    const start = i;
    i = skipWs(t, keyEnd, end);
    if (t[i] !== ':') break;
    const valStart = skipWs(t, i + 1, end);
    const valEnd = valueEnd(t, valStart, end);
    out.push({ key, start, valStart, valEnd });
    i = skipWs(t, valEnd, end);
    if (t[i] === ',') i++;
    else break;
  }
  return out;
}

/** Whether TableBuilder would flatten this object value into dotted columns. */
const flattens = (t: string, e: Entry, depth: number, opts: BuilderOptions) =>
  t[e.valStart] === '{' && depth < opts.flattenDepth && objectEntries(t, e.valStart, e.valEnd).length > 0;

function lineKind(t: string, start: number, end: number): 'object' | 'value' | 'unparsed' {
  try {
    const v = JSON.parse(t.slice(start, end));
    return v && typeof v === 'object' && !Array.isArray(v) ? 'object' : 'value';
  } catch {
    return 'unparsed';
  }
}

function findPath(t: string, start: number, end: number, name: string, depth: number, opts: BuilderOptions): Range | null {
  const entries = objectEntries(t, start, end);
  for (const e of entries) if (e.key === name && !flattens(t, e, depth, opts)) return strip(t, e);
  for (const e of entries) {
    if (name.startsWith(e.key + '.') && flattens(t, e, depth, opts)) {
      const r = findPath(t, e.valStart, e.valEnd, name.slice(e.key.length + 1), depth + 1, opts);
      if (r) return r;
    }
  }
  return null;
}

/** Value range, without the quotes for strings (that's what the table shows). */
function strip(t: string, e: Entry): Range {
  return t[e.valStart] === '"' && e.valEnd - e.valStart >= 2 ? { start: e.valStart + 1, end: e.valEnd - 1 } : { start: e.valStart, end: e.valEnd };
}

// ------------------------------------------------------------------ public API

/** Text range of a cell's content, or null if not found. */
export function locateCell(text: string, opts: BuilderOptions, cell: CellRef): Range | null {
  if (opts.format === 'csv') {
    for (const { row, rec } of delimitedRows(text, opts)) {
      if (row < cell.row) continue;
      if (row > cell.row) break;
      const f = rec.fields[cell.col ?? 0];
      return f ?? { start: rec.end, end: rec.end }; // short row: end of record
    }
    return null;
  }
  for (const line of jsonLines(text)) {
    if (line.row !== cell.row) continue;
    const name = cell.colName ?? '';
    const kind = lineKind(text, line.start, line.end);
    if (kind !== 'object' || name === '(value)' || name === '(unparsed)') return { start: line.start, end: line.end };
    return findPath(text, line.start, line.end, name, 0, opts) ?? { start: line.start, end: line.start };
  }
  return null;
}

/** The cell containing (or nearest to, within its row) a text offset. */
export function cellAt(text: string, opts: BuilderOptions, offset: number): CellRef | null {
  if (opts.format === 'csv') {
    let last: CellRef | null = null;
    for (const { row, rec } of delimitedRows(text, opts)) {
      if (offset < rec.start) return last; // in a blank line between records: previous row
      const next = rec.end + 1;
      if (offset <= rec.end || offset < next) {
        let best = 0;
        let bestDist = Infinity;
        rec.fields.forEach((f, i) => {
          const dist = offset < f.start ? f.start - offset : offset > f.end ? offset - f.end : 0;
          if (dist < bestDist) {
            bestDist = dist;
            best = i;
          }
        });
        return { row, col: best };
      }
      last = { row, col: 0 };
    }
    return last;
  }
  let last: CellRef | null = null;
  for (const line of jsonLines(text)) {
    if (offset < line.start) return last;
    if (offset <= line.end + 1) {
      const kind = lineKind(text, line.start, line.end);
      if (kind !== 'object') return { row: line.row, colName: kind === 'value' ? '(value)' : '(unparsed)' };
      return { row: line.row, colName: jsonColumnAt(text, line.start, line.end, offset, '', 0, opts) };
    }
    last = { row: line.row };
  }
  return last;
}

function jsonColumnAt(t: string, start: number, end: number, offset: number, prefix: string, depth: number, opts: BuilderOptions): string | undefined {
  const entries = objectEntries(t, start, end);
  if (!entries.length) return undefined;
  let best = entries[0];
  let bestDist = Infinity;
  for (const e of entries) {
    const dist = offset < e.start ? e.start - offset : offset > e.valEnd ? offset - e.valEnd : 0;
    if (dist <= bestDist) { // ties (e.g. just after a comma) go to the following entry
      bestDist = dist;
      best = e;
    }
  }
  if (flattens(t, best, depth, opts)) {
    return jsonColumnAt(t, best.valStart, best.valEnd, offset, prefix + best.key + '.', depth + 1, opts) ?? prefix + best.key;
  }
  return prefix + best.key;
}
