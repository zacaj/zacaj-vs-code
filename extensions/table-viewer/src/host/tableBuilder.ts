import type { Format } from '../shared/protocol';
import { cellString, parseDelimited, splitLines } from './parse';

export interface BuilderOptions {
  format: Format;
  delimiter: string;
  hasHeader: boolean;
  flattenDepth: number;
}

export interface IngestResult {
  rows: string[][];
  /** Present (last element of `rows`) if the text ended with an incomplete record. */
  provisional: boolean;
  /** Chars of input that formed complete records; the caller resumes from here next time. */
  consumed: number;
  /** Previously reported columns were renamed (e.g. header line was incomplete); caller must reset the view. */
  columnsReset: boolean;
}

/**
 * Turns text into rows of strings aligned to a growing list of columns. Columns are only ever
 * appended (unless `columnsReset`), so rows created earlier stay valid; short rows mean empty cells.
 */
export class TableBuilder {
  columns: string[] = [];
  private colIndex = new Map<string, number>();
  private headerDone = false;

  constructor(readonly opts: BuilderOptions) {}

  reset() {
    this.columns = [];
    this.colIndex.clear();
    this.headerDone = false;
  }

  /** Index for a column name; `fresh` always creates a new (uniquely named) column, for CSV headers. */
  private col(name: string, fresh = false): number {
    let i = fresh ? undefined : this.colIndex.get(name);
    if (i === undefined) {
      // Disambiguate duplicate header names.
      let unique = name;
      for (let n = 2; this.colIndex.has(unique); n++) unique = `${name} (${n})`;
      i = this.columns.length;
      this.columns.push(unique);
      this.colIndex.set(unique, i);
    }
    return i;
  }

  ingest(text: string): IngestResult {
    return this.opts.format === 'csv' ? this.ingestCsv(text) : this.ingestJsonl(text);
  }

  private ensureWidth(n: number) {
    for (let i = this.columns.length; i < n; i++) this.col(this.opts.hasHeader ? `Column ${i + 1}` : String(i + 1), true);
  }

  private ingestCsv(text: string): IngestResult {
    const { records, consumed, tail } = parseDelimited(text, this.opts.delimiter);
    let columnsReset = false;
    const rows: string[][] = [];
    let start = 0;
    const isBlank = (r: string[]) => r.length === 1 && r[0] === '';

    if (this.opts.hasHeader && !this.headerDone) {
      while (start < records.length && isBlank(records[start])) start++;
      const header = start < records.length ? records[start++] : tail;
      if (header && !isBlank(header)) {
        const prev = this.columns;
        if (prev.length && (prev.length !== header.length || prev.some((c, i) => c !== header[i]))) columnsReset = true;
        if (columnsReset || !prev.length) {
          this.reset();
          header.forEach((h, i) => this.col(h.trim() || `Column ${i + 1}`, true));
        }
        if (header !== tail) this.headerDone = true;
      }
      if (!this.headerDone) return { rows: [], provisional: false, consumed: 0, columnsReset };
    }

    for (let i = start; i < records.length; i++) {
      const r = records[i];
      if (isBlank(r)) continue;
      this.ensureWidth(r.length);
      rows.push(r);
    }
    const provisional = !!tail && !isBlank(tail);
    if (provisional) {
      this.ensureWidth(tail!.length);
      rows.push(tail!);
    }
    return { rows, provisional, consumed, columnsReset };
  }

  private ingestJsonl(text: string): IngestResult {
    const { records, consumed, tail } = splitLines(text);
    const rows: string[][] = [];
    for (const line of records) {
      const r = this.jsonRow(line);
      if (r) rows.push(r);
    }
    let provisional = false;
    if (tail !== null) {
      const r = this.jsonRow(tail);
      if (r) {
        rows.push(r);
        provisional = true;
      }
    }
    return { rows, provisional, consumed, columnsReset: false };
  }

  private jsonRow(line: string): string[] | null {
    const s = line.trim();
    if (!s) return null;
    const row: string[] = [];
    const set = (name: string, v: unknown) => {
      const i = this.col(name);
      while (row.length < i) row.push('');
      row[i] = cellString(v);
    };
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      set('(unparsed)', s);
      return row;
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const walk = (o: Record<string, unknown>, prefix: string, depth: number) => {
        for (const k of Object.keys(o)) {
          const v = o[k];
          const name = prefix + k;
          if (v && typeof v === 'object' && !Array.isArray(v) && depth < this.opts.flattenDepth && Object.keys(v).length) {
            walk(v as Record<string, unknown>, name + '.', depth + 1);
          } else set(name, v);
        }
      };
      walk(obj as Record<string, unknown>, '', 0);
    } else set('(value)', obj);
    return row;
  }
}
