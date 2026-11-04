// Virtualized (rows and columns) grid with sticky header, pinned columns, resize and reorder.
import { esc, ICON } from './dom';

export const ROW_H = 22;
export const HEADER_H = 28;

export interface GridCol {
  col: number;
  name: string;
  width: number;
  pinned: boolean;
  typeLabel: string;
  sort: 0 | 1 | -1;
  filtered: boolean;
  align: 'left' | 'right';
}

export interface GridSource {
  rowCount(): number;
  /** Label shown in the row-number gutter. */
  rowLabel(viewRow: number): string;
  cellHtml(viewRow: number, col: number): string;
  rowClass(viewRow: number): string;
}

export interface GridEvents {
  onSort(col: number, e: MouseEvent): void;
  onFilter(col: number, anchor: HTMLElement): void;
  onResize(col: number, width: number, done: boolean): void;
  onAutoSize(col: number): void;
  onMove(col: number, before: number | null): void;
  onSelect(viewRow: number, col: number): void;
  onActivate(viewRow: number, col: number): void;
  onCellMenu(e: MouseEvent, viewRow: number, col: number): void;
  onHeaderMenu(e: MouseEvent, col: number): void;
  onScroll(atBottom: boolean, userScroll: boolean): void;
}

export class Grid {
  readonly el: HTMLDivElement;
  private content: HTMLDivElement;
  private header: HTMLDivElement;
  private hpin: HTMLDivElement;
  private hcells: HTMLDivElement;
  private body: HTMLDivElement;
  private dropMarker: HTMLDivElement;

  private cols: GridCol[] = [];
  private pinned: GridCol[] = [];
  private scrolled: GridCol[] = [];
  /** x offset (within scrolled area) of each scrolled column; length = scrolled.length + 1 */
  private xs: number[] = [0];
  private pinXs: number[] = [0];
  private gutterW = 40;
  private pinW = 40;

  private headerKey = '';
  private bodyKey = '';
  private dataVersion = 0;
  private raf = 0;
  selRow = -1;
  selCol = -1;
  private programmaticScroll = false;

  constructor(private src: GridSource, private ev: GridEvents) {
    this.el = document.createElement('div');
    this.el.className = 'grid';
    this.el.tabIndex = 0;
    this.content = div('grid-content');
    this.header = div('grid-header');
    this.hpin = div('grid-pin');
    this.hcells = div('grid-hcells');
    this.body = div('grid-body');
    this.dropMarker = div('drop-marker');
    this.header.append(this.hpin, this.hcells);
    this.content.append(this.header, this.body, this.dropMarker);
    this.el.append(this.content);

    this.el.addEventListener('scroll', () => {
      const user = !this.programmaticScroll;
      this.programmaticScroll = false;
      this.schedule();
      this.ev.onScroll(this.atBottom(), user);
    });
    new ResizeObserver(() => this.schedule()).observe(this.el);
    this.wireHeader();
    this.wireBody();
  }

  setColumns(cols: GridCol[]) {
    this.cols = cols;
    this.pinned = cols.filter((c) => c.pinned);
    this.scrolled = cols.filter((c) => !c.pinned);
    this.xs = [0];
    for (const c of this.scrolled) this.xs.push(this.xs[this.xs.length - 1] + c.width);
    this.headerKey = '';
    this.layout();
  }

  /** Call when row data/order changed. */
  invalidate() {
    this.dataVersion++;
    this.layout();
  }

  private layout() {
    const n = this.src.rowCount();
    this.gutterW = Math.max(36, String(Math.max(n, 1)).length * 7.5 + 16);
    this.pinXs = [this.gutterW];
    for (const c of this.pinned) this.pinXs.push(this.pinXs[this.pinXs.length - 1] + c.width);
    this.pinW = this.pinXs[this.pinXs.length - 1];
    const w = this.pinW + this.xs[this.xs.length - 1];
    this.content.style.width = `${w}px`;
    this.content.style.height = `${HEADER_H + n * ROW_H}px`;
    this.header.style.width = `${w}px`;
    this.hpin.style.width = `${this.pinW}px`;
    this.headerKey = '';
    this.bodyKey = '';
    this.schedule();
  }

  schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private visibleCols(): [number, number] {
    const left = this.el.scrollLeft;
    const right = left + this.el.clientWidth - this.pinW;
    const xs = this.xs;
    let a = bsearch(xs, left) - 1;
    let b = bsearch(xs, right);
    a = Math.max(0, a);
    b = Math.min(this.scrolled.length, b + 1);
    return [a, b];
  }

  private render() {
    const [ca, cb] = this.visibleCols();
    const n = this.src.rowCount();
    const top = this.el.scrollTop;
    const ra = Math.max(0, Math.floor(top / ROW_H) - 4);
    const rb = Math.min(n, Math.ceil((top + this.el.clientHeight - HEADER_H) / ROW_H) + 4);

    const hk = `${ca}:${cb}`;
    if (hk !== this.headerKey) {
      this.headerKey = hk;
      let pin = `<div class="corner" style="width:${this.gutterW}px"></div>`;
      this.pinned.forEach((c, i) => (pin += this.headerCell(c, this.pinXs[i])));
      this.hpin.innerHTML = pin;
      let hs = '';
      for (let j = ca; j < cb; j++) hs += this.headerCell(this.scrolled[j], this.pinW + this.xs[j]);
      this.hcells.innerHTML = hs;
    }

    const bk = `${ra}:${rb}:${ca}:${cb}:${this.dataVersion}:${this.selRow}:${this.selCol}`;
    if (bk === this.bodyKey) return;
    this.bodyKey = bk;
    const src = this.src;
    const parts: string[] = [];
    const sel = this.selRow;
    const totalW = this.pinW + this.xs[this.xs.length - 1];
    for (let r = ra; r < rb; r++) {
      const isSel = r === sel;
      parts.push(`<div class="row ${src.rowClass(r)}${isSel ? ' sel' : ''}" data-r="${r}" style="top:${HEADER_H + r * ROW_H}px;width:${totalW}px">`);
      parts.push(`<div class="rpin" style="width:${this.pinW}px"><div class="gutter" style="width:${this.gutterW}px">${src.rowLabel(r)}</div>`);
      for (let i = 0; i < this.pinned.length; i++) parts.push(this.cell(r, this.pinned[i], this.pinXs[i], isSel));
      parts.push('</div>');
      for (let j = ca; j < cb; j++) parts.push(this.cell(r, this.scrolled[j], this.pinW + this.xs[j], isSel));
      parts.push('</div>');
    }
    this.body.innerHTML = parts.join('');
  }

  private headerCell(c: GridCol, x: number): string {
    const sort = c.sort ? `<span class="sort">${c.sort > 0 ? ICON.up : ICON.down}</span>` : '';
    return (
      `<div class="hcell${c.filtered ? ' filtered' : ''}${c.pinned ? ' pinned' : ''}" data-c="${c.col}" style="left:${x}px;width:${c.width}px" title="${esc(c.name)} (${c.typeLabel})&#10;Click: sort · Drag: move · Right-click: more">` +
      `<span class="htype t-${c.typeLabel}"></span><span class="hname">${esc(c.name)}</span>${sort}` +
      `<span class="fbtn" title="Filter">${ICON.filter}</span><div class="resizer"></div></div>`
    );
  }

  private cell(r: number, c: GridCol, x: number, isSel: boolean): string {
    const cls = isSel && c.col === this.selCol ? 'cell cur' : 'cell';
    return `<div class="${cls}${c.align === 'right' ? ' num' : ''}" data-c="${c.col}" style="left:${x}px;width:${c.width}px">${this.src.cellHtml(r, c.col)}</div>`;
  }

  // ------------------------------------------------------------ interaction

  private colAtX(clientX: number): { index: number; after: boolean } | null {
    const rect = this.el.getBoundingClientRect();
    const xView = clientX - rect.left;
    if (xView < this.pinW) {
      for (let i = 0; i < this.pinned.length; i++) {
        if (xView < this.pinXs[i + 1]) return { index: this.cols.indexOf(this.pinned[i]), after: xView > (this.pinXs[i] + this.pinXs[i + 1]) / 2 };
      }
      return this.pinned.length ? { index: this.cols.indexOf(this.pinned[0]), after: false } : this.scrolled.length ? { index: this.cols.indexOf(this.scrolled[0]), after: false } : null;
    }
    const x = xView - this.pinW + this.el.scrollLeft;
    const j = Math.min(this.scrolled.length - 1, Math.max(0, bsearch(this.xs, x) - 1));
    if (j < 0 || !this.scrolled[j]) return null;
    return { index: this.cols.indexOf(this.scrolled[j]), after: x > (this.xs[j] + this.xs[j + 1]) / 2 };
  }

  private wireHeader() {
    this.header.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      const hc = t.closest<HTMLElement>('.hcell');
      if (!hc) return;
      const col = Number(hc.dataset.c);
      e.preventDefault();
      if (t.closest('.resizer')) return this.startResize(e, col, hc);
      if (t.closest('.fbtn')) return this.ev.onFilter(col, hc);
      const sx = e.clientX;
      let dragging = false;
      const move = (m: MouseEvent) => {
        if (!dragging && Math.abs(m.clientX - sx) > 5) {
          dragging = true;
          hc.classList.add('dragging');
        }
        if (dragging) {
          const tgt = this.colAtX(m.clientX);
          if (tgt) {
            const target = this.cols[tgt.index];
            const rect = this.el.getBoundingClientRect();
            const x = target.pinned
              ? this.pinXs[this.pinned.indexOf(target) + (tgt.after ? 1 : 0)] + this.el.scrollLeft
              : this.pinW + this.xs[this.scrolled.indexOf(target) + (tgt.after ? 1 : 0)];
            this.dropMarker.style.display = 'block';
            this.dropMarker.style.left = `${x - 1}px`;
            this.dropMarker.style.top = `${this.el.scrollTop}px`;
            this.dropMarker.style.height = `${this.el.clientHeight}px`;
            // auto-scroll while dragging near edges
            if (m.clientX > rect.right - 30) this.el.scrollLeft += 20;
            else if (m.clientX < rect.left + this.pinW + 30 && m.clientX > rect.left + this.pinW) this.el.scrollLeft -= 20;
          }
        }
      };
      const up = (u: MouseEvent) => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.dropMarker.style.display = 'none';
        hc.classList.remove('dragging');
        if (!dragging) return this.ev.onSort(col, u);
        const tgt = this.colAtX(u.clientX);
        if (!tgt) return;
        const beforeIdx = tgt.after ? tgt.index + 1 : tgt.index;
        const before = this.cols[beforeIdx]?.col ?? null;
        if (before !== col) this.ev.onMove(col, before);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    this.header.addEventListener('dblclick', (e) => {
      const t = e.target as HTMLElement;
      const hc = t.closest<HTMLElement>('.hcell');
      if (hc && t.closest('.resizer')) this.ev.onAutoSize(Number(hc.dataset.c));
    });
    this.header.addEventListener('contextmenu', (e) => {
      const hc = (e.target as HTMLElement).closest<HTMLElement>('.hcell');
      if (!hc) return;
      e.preventDefault();
      this.ev.onHeaderMenu(e, Number(hc.dataset.c));
    });
  }

  private startResize(e: MouseEvent, col: number, hc: HTMLElement) {
    const sx = e.clientX;
    const sw = hc.offsetWidth;
    document.body.classList.add('resizing');
    const move = (m: MouseEvent) => this.ev.onResize(col, Math.max(36, sw + m.clientX - sx), false);
    const up = (m: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      this.ev.onResize(col, Math.max(36, sw + m.clientX - sx), true);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  private hit(e: MouseEvent): [number, number] | null {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>('.row');
    if (!row) return null;
    const cell = t.closest<HTMLElement>('.cell');
    return [Number(row.dataset.r), cell ? Number(cell.dataset.c) : this.selCol];
  }

  private wireBody() {
    this.body.addEventListener('mousedown', (e) => {
      const h = this.hit(e);
      if (h) this.ev.onSelect(h[0], h[1]);
    });
    this.body.addEventListener('dblclick', (e) => {
      const h = this.hit(e);
      if (h) this.ev.onActivate(h[0], h[1]);
    });
    this.body.addEventListener('contextmenu', (e) => {
      const h = this.hit(e);
      if (!h) return;
      e.preventDefault();
      this.ev.onCellMenu(e, h[0], h[1]);
    });
  }

  select(viewRow: number, col: number) {
    this.selRow = viewRow;
    this.selCol = col;
    this.schedule();
  }

  ensureVisible(viewRow: number, col: number) {
    const el = this.el;
    const y = HEADER_H + viewRow * ROW_H;
    if (y - HEADER_H < el.scrollTop) this.scrollTo(undefined, y - HEADER_H);
    else if (y + ROW_H > el.scrollTop + el.clientHeight) this.scrollTo(undefined, y + ROW_H - el.clientHeight);
    const j = this.scrolled.findIndex((c) => c.col === col);
    if (j >= 0) {
      const x0 = this.xs[j];
      const x1 = this.xs[j + 1];
      const vw = el.clientWidth - this.pinW;
      if (x0 < el.scrollLeft) this.scrollTo(x0, undefined);
      else if (x1 > el.scrollLeft + vw) this.scrollTo(Math.min(x0, x1 - vw), undefined);
    }
  }

  scrollTo(left?: number, top?: number) {
    const { scrollLeft, scrollTop } = this.el;
    if (left !== undefined) this.el.scrollLeft = left;
    if (top !== undefined) this.el.scrollTop = top;
    if (this.el.scrollLeft !== scrollLeft || this.el.scrollTop !== scrollTop) this.programmaticScroll = true;
  }

  scrollToBottom() {
    this.scrollTo(undefined, this.el.scrollHeight);
  }

  atBottom(): boolean {
    return this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - ROW_H;
  }

  pageRows(): number {
    return Math.max(1, Math.floor((this.el.clientHeight - HEADER_H) / ROW_H) - 1);
  }
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

/** First index i with xs[i] > x. */
function bsearch(xs: number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= x) lo = m + 1;
    else hi = m;
  }
  return lo;
}
