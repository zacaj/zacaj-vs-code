// Pure, stateless parsers. Each call parses text that starts on a record boundary and reports how
// much of it consisted of complete records, so a live reader can re-parse only the incomplete tail.

export interface ParseResult<T> {
  records: T[];
  /** Char index just past the last complete (newline-terminated) record. */
  consumed: number;
  /** Incomplete trailing record (no terminating newline yet), if any. */
  tail: T | null;
}

/** RFC 4180-ish delimited parser: quoted fields, "" escapes, embedded newlines, CRLF/LF. */
export function parseDelimited(text: string, delim: string): ParseResult<string[]> {
  const records: string[][] = [];
  const n = text.length;
  const d = delim.charCodeAt(0);
  let i = 0;
  let row: string[] = [];
  let recordStart = 0;

  const scanUnquoted = (from: number): number => {
    let k = from;
    while (k < n) {
      const ch = text.charCodeAt(k);
      if (ch === d || ch === 10 || ch === 13) break;
      k++;
    }
    return k;
  };

  while (i < n) {
    if (text.charCodeAt(i) === 34 /* " */) {
      let val = '';
      let seg = i + 1;
      for (;;) {
        const q = text.indexOf('"', seg);
        if (q === -1) {
          // Unterminated quote: everything from recordStart on is incomplete.
          row.push(val + text.slice(seg));
          return { records, consumed: recordStart, tail: row };
        }
        if (text.charCodeAt(q + 1) === 34) {
          val += text.slice(seg, q + 1);
          seg = q + 2;
          continue;
        }
        if (q + 1 >= n) {
          // Closing quote is the last char; can't yet know whether it's an escaped quote.
          row.push(val + text.slice(seg, q));
          return { records, consumed: recordStart, tail: row };
        }
        val += text.slice(seg, q);
        i = q + 1;
        break;
      }
      const k = scanUnquoted(i); // tolerate junk after closing quote
      if (k > i) val += text.slice(i, k);
      i = k;
      row.push(val);
    } else {
      const k = scanUnquoted(i);
      row.push(text.slice(i, k));
      i = k;
    }
    if (i >= n) break;
    const c = text.charCodeAt(i);
    if (c === d) {
      i++;
      if (i >= n) row.push('');
      continue;
    }
    if (c === 13) {
      if (i + 1 >= n) break; // lone \r at end: maybe half of \r\n
      if (text.charCodeAt(i + 1) === 10) i++;
    }
    i++;
    records.push(row);
    row = [];
    recordStart = i;
  }
  return { records, consumed: recordStart, tail: recordStart < n ? row : null };
}

/** Split JSON Lines text into complete lines + incomplete tail. */
export function splitLines(text: string): ParseResult<string> {
  const records: string[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) break;
    records.push(text.slice(start, nl));
    start = nl + 1;
  }
  const tail = start < text.length ? text.slice(start) : null;
  return { records, consumed: start, tail };
}

/** Pick the most likely delimiter from the first line of a file. */
export function sniffDelimiter(sample: string): string {
  const nl = sample.search(/\r?\n/);
  const line = nl === -1 ? sample : sample.slice(0, nl);
  const counts: Record<string, number> = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  let best = ',';
  for (const k of Object.keys(counts)) if (counts[k] > counts[best]) best = k;
  return best;
}

export function cellString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
