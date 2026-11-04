import * as fs from 'node:fs';
import { TableBuilder, type BuilderOptions } from './tableBuilder';

export interface ReadBatch {
  rows: string[][];
  provisional: boolean;
  /** View must be cleared before applying (file truncated/rewritten, or header changed). */
  reset: boolean;
  columns: string[];
}

const ANCHOR = 64;

/**
 * Incrementally reads a local file. Remembers the byte offset of the end of the last complete
 * record and re-reads from there on each change, so appends are cheap and an incomplete trailing
 * record (a line still being written) is re-parsed once it is finished.
 */
export class LiveReader {
  readonly builder: TableBuilder;
  private committed = 0;
  private anchor: Buffer | null = null;
  private lastSize = -1;
  private lastMtime = 0;
  private decoder = new TextDecoder('utf-8');

  constructor(readonly path: string, opts: BuilderOptions) {
    this.builder = new TableBuilder(opts);
  }

  /** Returns null when nothing changed. */
  async read(): Promise<ReadBatch | null> {
    const fh = await fs.promises.open(this.path, 'r');
    try {
      const st = await fh.stat();
      if (st.size === this.lastSize && st.mtimeMs === this.lastMtime) return null;
      const first = this.lastSize < 0;
      const reset = !first && (st.size < this.committed || !(await this.anchorMatches(fh)));
      if (reset) {
        this.committed = 0;
        this.anchor = null;
        this.builder.reset();
      }
      this.lastSize = st.size;
      this.lastMtime = st.mtimeMs;

      let start = this.committed;
      const len = st.size - start;
      const buf = Buffer.allocUnsafe(Math.max(0, len));
      let off = 0;
      while (off < len) {
        const { bytesRead } = await fh.read(buf, off, len - off, start + off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      let bytes = buf.subarray(0, off);
      if (start === 0 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        bytes = bytes.subarray(3);
        start = 3;
      }
      const text = this.decoder.decode(bytes);
      const res = this.builder.ingest(text);
      if (res.consumed > 0) {
        const consumedBytes = res.consumed === text.length ? bytes.length : Buffer.byteLength(text.slice(0, res.consumed));
        this.committed = start + consumedBytes;
        const aStart = Math.max(0, consumedBytes - ANCHOR);
        this.anchor = Buffer.from(bytes.subarray(aStart, consumedBytes));
      }
      return { rows: res.rows, provisional: res.provisional, reset: reset || res.columnsReset, columns: this.builder.columns };
    } finally {
      await fh.close();
    }
  }

  /** Detect in-place rewrites: the bytes just before our committed offset must be unchanged. */
  private async anchorMatches(fh: fs.promises.FileHandle): Promise<boolean> {
    if (!this.anchor || !this.anchor.length) return true;
    const b = Buffer.alloc(this.anchor.length);
    const { bytesRead } = await fh.read(b, 0, b.length, this.committed - this.anchor.length);
    return bytesRead === b.length && b.equals(this.anchor);
  }
}

/** Parse an in-memory file (non-`file:` URIs, where we can't tail). */
export function parseWhole(data: Uint8Array, opts: BuilderOptions): ReadBatch {
  let bytes = data;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  const b = new TableBuilder(opts);
  const res = b.ingest(new TextDecoder('utf-8').decode(bytes));
  return { rows: res.rows, provisional: false, reset: true, columns: b.columns };
}
