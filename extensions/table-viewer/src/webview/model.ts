// Pure data model: rows, column type inference, filtering and sorting. No DOM access.
import type { ColType } from '../shared/protocol';

const NUM_RE = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?\s*$/;
const DATE_RE = /^\s*\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?)?\s*$/i;
const DATE2_RE = /^\s*\d{4}\/\d{1,2}\/\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?\s*$/;
const BOOL_RE = /^(?:true|false)$/i;

export function parseNumber(s: string): number {
  return NUM_RE.test(s) ? Number(s) : NaN;
}

/** Epoch numbers are interpreted by magnitude: s, ms, µs or ns. */
export function epochToMs(n: number): number {
  const a = Math.abs(n);
  if (a < 1e11) return n * 1000;
  if (a < 1e14) return n;
  if (a < 1e17) return n / 1e3;
  return n / 1e6;
}

export function parseDate(s: string): number {
  if (NUM_RE.test(s)) return epochToMs(Number(s));
  if (DATE_RE.test(s)) return Date.parse(s.trim().replace(',', '.').replace(' ', 'T').replace(/\s+(?=[Z+-])/i, ''));
  if (DATE2_RE.test(s)) return Date.parse(s);
  const t = Date.parse(s);
  return t;
}

/** Range filter input: absolute date, `now`, or relative like `-15m`, `-2h`, `-1d`. */
export function parseDateInput(s: string, now = Date.now()): number {
  const t = s.trim();
  if (!t) return NaN;
  if (/^now$/i.test(t)) return now;
  const m = /^([-+])\s*(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i.exec(t);
  if (m) {
    const unit = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 }[m[3].toLowerCase() as 's']!;
    return now + (m[1] === '-' ? -1 : 1) * Number(m[2]) * unit;
  }
  return parseDate(t);
}

interface Stats {
  nonEmpty: number;
  num: number;
  date: number;
  bool: number;
}

export class Column {
  stats: Stats = { nonEmpty: 0, num: 0, date: 0, bool: 0 };
  override: ColType | undefined;
  constructor(readonly index: number, readonly name: string) {}

  get inferred(): ColType {
    const { nonEmpty, num, date, bool } = this.stats;
    if (!nonEmpty) return 'string';
    const t = nonEmpty * 0.95;
    if (bool === nonEmpty) return 'boolean';
    if (date >= t && date > 0) return 'date';
    if (num >= t) return 'number';
    return 'string';
  }
  get type(): ColType {
    return this.override ?? this.inferred;
  }
}

function classify(s: string): number {
  // bit 1 = numeric, 2 = date-looking, 4 = bool
  if (NUM_RE.test(s)) return 1;
  if (DATE_RE.test(s) || DATE2_RE.test(s)) return 2;
  if (BOOL_RE.test(s)) return 4;
  return 0;
}

interface NumCache {
  type: ColType;
  len: number;
  values: Float64Array;
}

export class Table {
  columns: Column[] = [];
  rows: string[][] = [];
  hasProvisional = false;
  private numCache = new Map<number, NumCache>();
  private lowerCache: (string | undefined)[] = [];

  clear() {
    this.columns = [];
    this.rows = [];
    this.hasProvisional = false;
    this.numCache.clear();
    this.lowerCache = [];
  }

  setColumns(names: string[]) {
    for (let i = this.columns.length; i < names.length; i++) this.columns.push(new Column(i, names[i]));
  }

  private stat(row: string[], sign: 1 | -1) {
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (!v) continue;
      const col = this.columns[c];
      if (!col) continue;
      const st = col.stats;
      st.nonEmpty += sign;
      const k = classify(v);
      if (k === 1) st.num += sign;
      else if (k === 2) st.date += sign;
      else if (k === 4) st.bool += sign;
    }
  }

  dropProvisional() {
    if (!this.hasProvisional) return;
    const r = this.rows.pop()!;
    this.stat(r, -1);
    this.hasProvisional = false;
    const n = this.rows.length;
    for (const c of this.numCache.values()) c.len = Math.min(c.len, n);
    this.lowerCache.length = Math.min(this.lowerCache.length, n);
  }

  append(rows: string[][], provisional: boolean) {
    for (const r of rows) {
      this.rows.push(r);
      this.stat(r, 1);
    }
    this.hasProvisional = provisional && rows.length > 0;
  }

  cell(row: number, col: number): string {
    return this.rows[row][col] ?? '';
  }

  /** Numeric view of a column (numbers, or epoch ms for dates); NaN where unparseable. */
  nums(col: number): Float64Array {
    const type = this.columns[col].type;
    let c = this.numCache.get(col);
    if (!c || c.type !== type) {
      c = { type, len: 0, values: new Float64Array(Math.max(16, this.rows.length)) };
      this.numCache.set(col, c);
    }
    const n = this.rows.length;
    if (c.values.length < n) {
      const v = new Float64Array(Math.max(n, c.values.length * 2));
      v.set(c.values.subarray(0, c.len));
      c.values = v;
    }
    const parse = type === 'date' ? parseDate : parseNumber;
    for (let i = c.len; i < n; i++) {
      const s = this.rows[i][col];
      c.values[i] = s ? parse(s) : NaN;
    }
    c.len = n;
    return c.values;
  }

  /** Lower-cased row text for fast case-insensitive whole-row search. */
  lowerRow(i: number): string {
    let s = this.lowerCache[i];
    if (s === undefined) s = this.lowerCache[i] = this.rows[i].join('\u0001').toLowerCase();
    return s;
  }
}

// ---------------------------------------------------------------- filters

export interface TextQuery {
  text: string;
  regex?: boolean;
  caseSensitive?: boolean;
}

export interface ColumnFilter {
  text?: string;
  /** include: only these values; exclude: everything but these. '' means empty cell. */
  values?: { mode: 'include' | 'exclude'; set: Set<string> };
  min?: string;
  max?: string;
}

export function isFilterActive(f: ColumnFilter | undefined): boolean {
  if (!f) return false;
  return !!(f.text || f.values || f.min?.trim() || f.max?.trim());
}

export type Matcher = (s: string) => boolean;

/**
 * Column text filter syntax: plain text = contains (case-insensitive), `=x` exact, `!x` not
 * containing, `/re/` regex, `""` or `=` empty, `!=` / `!""` non-empty.
 */
export function compileColumnText(q: string): Matcher | null {
  if (!q) return null;
  let neg = false;
  let t = q;
  if (t.startsWith('!')) {
    neg = true;
    t = t.slice(1);
  }
  let m: Matcher;
  if (t === '""' || t === '=') m = (s) => s === '';
  else if (t.length > 2 && t.startsWith('/') && t.lastIndexOf('/') > 0) {
    const last = t.lastIndexOf('/');
    let re: RegExp;
    try {
      re = new RegExp(t.slice(1, last), t.slice(last + 1).replace(/[gy]/g, '') || 'i');
    } catch {
      return () => false;
    }
    m = (s) => re.test(s);
  } else if (t.startsWith('=')) {
    const e = t.slice(1).toLowerCase();
    m = (s) => s.toLowerCase() === e;
  } else {
    const e = t.toLowerCase();
    m = (s) => s.toLowerCase().includes(e);
  }
  return neg ? (s) => !m(s) : m;
}

export function compileGlobal(q: TextQuery): RegExp | string | null {
  if (!q.text) return null;
  if (q.regex) {
    try {
      return new RegExp(q.text, q.caseSensitive ? '' : 'i');
    } catch {
      return null;
    }
  }
  return q.caseSensitive ? q.text : q.text.toLowerCase();
}

/** RegExp (global) used for highlighting matches inside cells. */
export function highlightRegex(q: TextQuery | string | undefined): RegExp | null {
  if (!q) return null;
  if (typeof q === 'string') {
    let t = q;
    if (!t || t.startsWith('!') || t.startsWith('=')) return null;
    if (t.length > 2 && t.startsWith('/') && t.lastIndexOf('/') > 0) {
      const last = t.lastIndexOf('/');
      try {
        return new RegExp(t.slice(1, last), 'g' + (t.slice(last + 1).replace(/[gy]/g, '') || 'i'));
      } catch {
        return null;
      }
    }
    return new RegExp(escapeRe(t), 'gi');
  }
  if (!q.text) return null;
  try {
    return new RegExp(q.regex ? q.text : escapeRe(q.text), q.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

export function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ViewQuery {
  filters: Map<number, ColumnFilter>;
  global?: TextQuery;
  sort?: { col: number; dir: 1 | -1 };
}

type RowPred = (row: number) => boolean;

function compileColumnFilter(table: Table, col: number, f: ColumnFilter, now: number): RowPred[] {
  const preds: RowPred[] = [];
  const rows = table.rows;
  const tm = f.text ? compileColumnText(f.text) : null;
  if (tm) preds.push((r) => tm(rows[r][col] ?? ''));
  if (f.values) {
    const { mode, set } = f.values;
    preds.push(mode === 'include' ? (r) => set.has(rows[r][col] ?? '') : (r) => !set.has(rows[r][col] ?? ''));
  }
  const type = table.columns[col]?.type;
  const parse = type === 'date' ? (s: string) => parseDateInput(s, now) : (s: string) => parseFloat(s);
  const min = f.min?.trim() ? parse(f.min) : NaN;
  const max = f.max?.trim() ? parse(f.max) : NaN;
  if (!isNaN(min) || !isNaN(max)) {
    const nums = table.nums(col);
    const lo = isNaN(min) ? -Infinity : min;
    const hi = isNaN(max) ? Infinity : max;
    preds.push((r) => {
      const v = nums[r];
      return v >= lo && v <= hi;
    });
  }
  return preds;
}

export function compileQuery(table: Table, q: ViewQuery, exceptCol = -1): RowPred {
  const now = Date.now();
  const preds: RowPred[] = [];
  for (const [col, f] of q.filters) {
    if (col === exceptCol || !isFilterActive(f)) continue;
    preds.push(...compileColumnFilter(table, col, f, now));
  }
  const g = q.global ? compileGlobal(q.global) : null;
  if (typeof g === 'string') {
    if (q.global!.caseSensitive) preds.push((r) => table.rows[r].some((c) => c.includes(g)));
    else preds.push((r) => table.lowerRow(r).includes(g));
  } else if (g) preds.push((r) => table.rows[r].some((c) => g.test(c)));
  if (!preds.length) return () => true;
  if (preds.length === 1) return preds[0];
  return (r) => {
    for (const p of preds) if (!p(r)) return false;
    return true;
  };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortRows(table: Table, idx: number[], sort: { col: number; dir: 1 | -1 }) {
  const { col, dir } = sort;
  const type = table.columns[col]?.type;
  if (type === 'number' || type === 'date') {
    const nums = table.nums(col);
    idx.sort((a, b) => {
      const x = nums[a];
      const y = nums[b];
      const xn = x !== x;
      const yn = y !== y;
      if (xn || yn) return xn === yn ? a - b : xn ? 1 : -1; // NaN/empty always last
      return (x - y) * dir || a - b;
    });
  } else {
    const rows = table.rows;
    idx.sort((a, b) => {
      const x = rows[a][col] ?? '';
      const y = rows[b][col] ?? '';
      if (!x || !y) return !x === !y ? a - b : !x ? 1 : -1;
      return collator.compare(x, y) * dir || a - b;
    });
  }
}

/** Indices of rows passing the query, sorted. */
export function computeView(table: Table, q: ViewQuery, from = 0, into?: number[]): number[] {
  const pred = compileQuery(table, q);
  const out = into ?? [];
  for (let r = from, n = table.rows.length; r < n; r++) if (pred(r)) out.push(r);
  if (q.sort) sortRows(table, out, q.sort);
  return out;
}

export interface Facet {
  value: string;
  count: number;
}

/** Distinct values of a column (with counts) among rows passing every filter except this column's own. */
export function facet(table: Table, q: ViewQuery, col: number): Facet[] {
  const pred = compileQuery(table, q, col);
  const counts = new Map<string, number>();
  const rows = table.rows;
  for (let r = 0, n = rows.length; r < n; r++) {
    if (!pred(r)) continue;
    const v = rows[r][col] ?? '';
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const out: Facet[] = [];
  for (const [value, count] of counts) out.push({ value, count });
  return out;
}

export function columnRange(table: Table, col: number): { min: number; max: number } | null {
  const nums = table.nums(col);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0, n = table.rows.length; i < n; i++) {
    const v = nums[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min <= max ? { min, max } : null;
}
