import type { ColType, Format, HostMessage, Layout, WebviewMessage } from '../shared/protocol';
import { debounce, h, highlight, ICON } from './dom';
import { Grid, type GridCol } from './grid';
import {
  columnRange,
  computeView,
  facet,
  highlightRegex,
  isFilterActive,
  Table,
  type ColumnFilter,
  type TextQuery,
  type ViewQuery,
} from './model';

declare function acquireVsCodeApi(): { postMessage(m: WebviewMessage): void };
const vscode = acquireVsCodeApi();
const post = (m: WebviewMessage) => vscode.postMessage(m);

// ------------------------------------------------------------------ state

const table = new Table();
let fileName = '';
let format: Format = 'csv';
let live = false;
let layout: Layout = {};
/** Display order of all columns (indices into table.columns). */
let order: number[] = [];
const hidden = new Set<number>();
const pinned = new Set<number>();
const widths: number[] = [];
const autoWidth: boolean[] = [];
let sort: { col: number; dir: 1 | -1 } | undefined;
const filters = new Map<number, ColumnFilter>();
const global: TextQuery = { text: '', regex: false, caseSensitive: false };
let view: number[] = [];
let follow = true;
let loading = true;
let statusMsg = '';
let statusErr = false;
let freshFrom = Infinity;
let freshUntil = 0;
let sidePanel: 'none' | 'columns' | 'details' = 'none';

const query = (): ViewQuery => ({ filters, global, sort });
const visibleCols = () => {
  const vis = order.filter((c) => !hidden.has(c));
  return [...vis.filter((c) => pinned.has(c)), ...vis.filter((c) => !pinned.has(c))];
};

// ------------------------------------------------------------------ layout persistence

const saveLayout = debounce(() => {
  const name = (c: number) => table.columns[c].name;
  const l: Layout = {
    order: order.map(name),
    hidden: [...hidden].map(name),
    pinned: [...pinned].map(name),
    widths: Object.fromEntries(order.filter((c) => !autoWidth[c]).map((c) => [name(c), widths[c]])),
    types: Object.fromEntries(table.columns.filter((c) => c.override).map((c) => [c.name, c.override!])),
    sort: sort ? { column: name(sort.col), dir: sort.dir } : undefined,
  };
  layout = l;
  post({ type: 'saveLayout', layout: l });
}, 400);

function addColumns(names: string[]) {
  const start = table.columns.length;
  table.setColumns(names);
  const pos = new Map((layout.order ?? []).map((n, i) => [n, i]));
  for (let c = start; c < table.columns.length; c++) {
    const col = table.columns[c];
    const w = layout.widths?.[col.name];
    widths[c] = w ?? Math.max(60, Math.min(200, col.name.length * 7.5 + 40));
    autoWidth[c] = w === undefined;
    if (layout.hidden?.includes(col.name)) hidden.add(c);
    if (layout.pinned?.includes(col.name)) pinned.add(c);
    const t = layout.types?.[col.name];
    if (t) col.override = t;
    if (layout.sort?.column === col.name && !sort) sort = { col: c, dir: layout.sort.dir };
    const p = pos.get(col.name);
    if (p === undefined) order.push(c);
    else {
      const at = order.findIndex((o) => (pos.get(table.columns[o].name) ?? Infinity) > p);
      if (at < 0) order.push(c);
      else order.splice(at, 0, c);
    }
  }
}

let charW: { cell: number; head: number } | undefined;
/** Average char widths of the cell (editor) font and header (UI) font. */
function measureChars() {
  if (charW) return charW;
  const ctx = document.createElement('canvas').getContext('2d')!;
  const probe = (cls: string) => {
    const el = h('div', { class: cls, style: { position: 'absolute', visibility: 'hidden' } });
    document.body.append(el);
    const cs = getComputedStyle(el);
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    el.remove();
    const sample = 'abcdefghijklmnopqrstuvwxyz0123456789-:._ ABCDEFGHIJ';
    return ctx.measureText(sample).width / sample.length;
  };
  charW = { cell: probe('cell') || 7.5, head: probe('hcell') || 7.5 };
  return charW;
}

/** Fit auto-width columns to their content (sampled). */
function estimateWidths(force?: number) {
  const rows = table.rows;
  if (!rows.length) return;
  const sample = Math.min(rows.length, 300);
  for (let c = 0; c < table.columns.length; c++) {
    if (force !== undefined ? c !== force : !autoWidth[c] || widths[c] < 0) continue;
    const lens: number[] = [];
    for (let i = 0; i < sample; i++) {
      const v = rows[i][c];
      if (v) lens.push(Math.min(v.length, 80));
    }
    lens.sort((a, b) => a - b);
    const p90 = lens.length ? lens[Math.min(lens.length - 1, Math.floor(lens.length * 0.95))] : 0;
    const name = table.columns[c].name.length;
    const cw = measureChars();
    const content = (p90 + 2) * cw.cell + 14;
    const header = name * cw.head + 48;
    widths[c] = Math.round(Math.max(56, Math.min(force !== undefined ? 800 : 400, Math.max(content, Math.min(header, 240)))));
    if (force === undefined) autoWidth[c] = true;
  }
}

// ------------------------------------------------------------------ view computation

function recompute() {
  view = computeView(table, query());
  grid.invalidate();
  refreshChrome();
}
const recomputeSoon = debounce(recompute, 120);

function onRows(m: Extract<HostMessage, { type: 'rows' }>) {
  const before = table.rows.length;
  const hadProv = m.dropProvisional && table.hasProvisional;
  if (m.dropProvisional) table.dropProvisional();
  if (m.columns) {
    const n = table.columns.length;
    addColumns(m.columns);
    if (table.columns.length !== n) refreshColumns();
  }
  const firstData = before === 0 && m.rows.length > 0;
  const start = table.rows.length;
  table.append(m.rows, m.provisional);
  if (firstData) {
    estimateWidths();
    refreshColumns();
  }
  if (!loading && m.rows.length) {
    freshFrom = Math.min(freshFrom === Infinity ? start : freshFrom, start);
    freshUntil = Date.now() + 1500;
    setTimeout(() => {
      if (Date.now() >= freshUntil) {
        freshFrom = Infinity;
        grid.invalidate();
      }
    }, 1600);
  }

  if (sort) {
    recomputeThrottled();
  } else {
    // Incremental: drop a removed provisional row from the view, filter only the new rows.
    if (hadProv) while (view.length && view[view.length - 1] >= start) view.pop();
    computeView(table, query(), start, view);
    grid.invalidate();
    refreshChrome();
  }
  if (m.done) loading = false;
  if (follow && live) grid.scrollToBottom();
  if (popup?.refresh) popupRefreshSoon();
  if (sidePanel === 'details') renderDetails();
}

let lastFull = 0;
let throttleTimer: ReturnType<typeof setTimeout> | undefined;
function recomputeThrottled() {
  const wait = Math.max(0, 300 - (Date.now() - lastFull));
  if (throttleTimer) return;
  throttleTimer = setTimeout(() => {
    throttleTimer = undefined;
    lastFull = Date.now();
    recompute();
    if (follow && live) grid.scrollToBottom();
  }, wait);
}

// ------------------------------------------------------------------ grid

const grid = new Grid(
  {
    rowCount: () => view.length,
    rowLabel: (r) => String(view[r] + 1),
    rowClass: (r) => {
      const i = view[r];
      if (table.hasProvisional && i === table.rows.length - 1) return 'prov';
      return i >= freshFrom && Date.now() < freshUntil ? 'fresh' : '';
    },
    cellHtml: (r, c) => {
      let s = table.rows[view[r]][c] ?? '';
      if (!s) return '';
      if (s.length > 400) s = s.slice(0, 400) + '…';
      if (s.includes('\n')) s = s.replace(/\r?\n/g, ' ⏎ ');
      return highlight(s, cellHighlight(c));
    },
  },
  {
    onSort: (col, e) => {
      if (e.shiftKey || e.ctrlKey) return;
      setSort(!sort || sort.col !== col ? { col, dir: 1 } : sort.dir === 1 ? { col, dir: -1 } : undefined);
    },
    onFilter: (col, anchor) => openFilterPopup(col, anchor),
    onResize: (col, w, done) => {
      widths[col] = w;
      autoWidth[col] = false;
      refreshColumns();
      if (done) saveLayout();
    },
    onAutoSize: (col) => {
      estimateWidths(col);
      autoWidth[col] = false;
      refreshColumns();
      saveLayout();
    },
    onMove: (col, before) => moveColumn(col, before),
    onSelect: (r, c) => selectCell(r, c),
    onActivate: (r, c) => {
      selectCell(r, c);
      setSidePanel('details');
    },
    onCellMenu: (e, r, c) => cellMenu(e, r, c),
    onHeaderMenu: (e, c) => headerMenu(e, c),
    onScroll: (atBottom, user) => {
      if (!user || !live) return;
      if (follow !== atBottom) {
        follow = atBottom;
        refreshChrome();
      }
    },
  },
);

const hlCache = new Map<number, RegExp | null>();
let hlKey = '';
function cellHighlight(c: number): RegExp | null {
  const key = `${global.text}|${global.regex}|${global.caseSensitive}|${[...filters].map(([k, f]) => k + ':' + (f.text ?? '')).join(',')}`;
  if (key !== hlKey) {
    hlKey = key;
    hlCache.clear();
  }
  let re = hlCache.get(c);
  if (re === undefined) {
    const parts: string[] = [];
    const g = highlightRegex(global);
    if (g) parts.push(g.source);
    const f = highlightRegex(filters.get(c)?.text);
    if (f) parts.push(f.source);
    try {
      re = parts.length ? new RegExp(parts.join('|'), global.caseSensitive && !f ? 'g' : 'gi') : null;
    } catch {
      re = null;
    }
    hlCache.set(c, re);
  }
  return re;
}

function refreshColumns() {
  const cols: GridCol[] = visibleCols().map((c) => {
    const col = table.columns[c];
    const t = col.type;
    return {
      col: c,
      name: col.name,
      width: widths[c],
      pinned: pinned.has(c),
      typeLabel: t,
      sort: sort?.col === c ? sort.dir : 0,
      filtered: isFilterActive(filters.get(c)),
      align: t === 'number' ? 'right' : 'left',
    };
  });
  grid.setColumns(cols);
  refreshChrome();
  if (sidePanel === 'columns') renderColumnPanel();
}

function setSort(s: typeof sort) {
  sort = s;
  saveLayout();
  refreshColumns();
  recompute();
}

function moveColumn(col: number, before: number | null) {
  const from = order.indexOf(col);
  order.splice(from, 1);
  if (before === null) order.push(col);
  else order.splice(order.indexOf(before), 0, col);
  // Moving across the pinned boundary pins/unpins.
  if (before !== null && pinned.has(before) !== pinned.has(col)) {
    if (pinned.has(before)) pinned.add(col);
    else pinned.delete(col);
  } else if (before === null) pinned.delete(col);
  saveLayout();
  refreshColumns();
}

function setFilter(col: number, f: ColumnFilter | undefined) {
  if (f && isFilterActive(f)) filters.set(col, f);
  else filters.delete(col);
  refreshColumns();
  recomputeSoon();
}

function selectCell(r: number, c: number) {
  if (r < 0 || r >= view.length) return;
  grid.select(r, c);
  grid.ensureVisible(r, c);
  if (sidePanel === 'details') renderDetails();
}

// ------------------------------------------------------------------ toolbar & status

const searchInput = h('input', { class: 'search', type: 'text', placeholder: 'Search all columns…', spellcheck: false });
const caseBtn = h('button', { class: 'toggle', title: 'Match case' }, 'Aa');
const regexBtn = h('button', { class: 'toggle', title: 'Use regular expression' }, '.*');
const clearBtn = h('button', { class: 'btn', title: 'Clear all filters and search' }, 'Clear filters');
const colsBtn = h('button', { class: 'btn', title: 'Show, hide and reorder columns' }, 'Columns');
const detailsBtn = h('button', { class: 'btn', title: 'Show all fields of the selected row' }, 'Row details');
const followBtn = h('button', { class: 'btn toggle', title: 'Keep scrolled to newest rows as the file grows' }, 'Follow');
const textBtn = h('button', { class: 'btn', title: 'Reopen as text' }, 'Text');
const status = h('div', { class: 'status' });

const applySearch = debounce(() => {
  global.text = searchInput.value;
  recompute();
}, 150);
searchInput.addEventListener('input', applySearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    applySearch();
    grid.el.focus();
  } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
    e.preventDefault();
    grid.el.focus();
    if (view.length) selectCell(Math.max(0, grid.selRow), grid.selCol >= 0 ? grid.selCol : visibleCols()[0]);
  }
});
caseBtn.onclick = () => {
  global.caseSensitive = !global.caseSensitive;
  recompute();
};
regexBtn.onclick = () => {
  global.regex = !global.regex;
  recompute();
};
clearBtn.onclick = () => {
  filters.clear();
  searchInput.value = '';
  global.text = '';
  refreshColumns();
  recompute();
};
colsBtn.onclick = () => setSidePanel(sidePanel === 'columns' ? 'none' : 'columns');
detailsBtn.onclick = () => setSidePanel(sidePanel === 'details' ? 'none' : 'details');
followBtn.onclick = () => {
  follow = !follow;
  if (follow) grid.scrollToBottom();
  refreshChrome();
};
textBtn.onclick = () => post({ type: 'openAsText' });

const fmt = (n: number) => n.toLocaleString();
function refreshChrome() {
  caseBtn.classList.toggle('on', !!global.caseSensitive);
  regexBtn.classList.toggle('on', !!global.regex);
  followBtn.classList.toggle('on', follow);
  followBtn.style.display = live ? '' : 'none';
  colsBtn.classList.toggle('on', sidePanel === 'columns');
  detailsBtn.classList.toggle('on', sidePanel === 'details');
  const nf = [...filters.values()].filter(isFilterActive).length + (global.text ? 1 : 0);
  clearBtn.disabled = nf === 0;
  clearBtn.textContent = nf ? `Clear filters (${nf})` : 'Clear filters';
  const total = table.rows.length;
  const shown = view.length;
  const nh = order.filter((c) => hidden.has(c)).length;
  let s = shown === total ? `${fmt(total)} rows` : `${fmt(shown)} of ${fmt(total)} rows`;
  s += ` · ${fmt(table.columns.length)} columns${nh ? ` (${fmt(nh)} hidden)` : ''}`;
  if (loading) s += ' · loading…';
  else if (live) s += ' · live';
  if (statusMsg) s += ` · ${statusMsg}`;
  status.textContent = s;
  status.classList.toggle('error', statusErr);
  status.title = `${fileName} (${format === 'jsonl' ? 'JSON Lines' : 'delimited'})`;
}

// ------------------------------------------------------------------ side panel (columns / details)

const side = h('div', { class: 'side' });
const sideBody = h('div', { class: 'side-body' });
const sideFilter = h('input', { class: 'search', type: 'text', placeholder: 'Filter…', spellcheck: false });
const sideTools = h('div', { class: 'side-tools' });
const sideTitle = h('div', { class: 'side-title' });
side.append(h('div', { class: 'side-head' }, sideTitle, h('button', { class: 'icon', title: 'Close', onclick: () => setSidePanel('none') }, '✕')), sideFilter, sideTools, sideBody);
sideFilter.addEventListener('input', () => (sidePanel === 'columns' ? renderColumnPanel() : renderDetails()));
let detailsHideEmpty = false;

function setSidePanel(p: typeof sidePanel) {
  if (p !== sidePanel) sideFilter.value = '';
  sidePanel = p;
  side.style.display = p === 'none' ? 'none' : '';
  if (p === 'columns') renderColumnPanel();
  if (p === 'details') renderDetails();
  refreshChrome();
}

function renderColumnPanel() {
  sideTitle.textContent = 'Columns';
  sideFilter.placeholder = 'Filter columns…';
  const q = sideFilter.value.toLowerCase();
  const matches = order.filter((c) => !q || table.columns[c].name.toLowerCase().includes(q));
  setChildren(
    sideTools,
    h('button', { class: 'btn', onclick: () => setHidden(matches, false) }, q ? 'Show matching' : 'Show all'),
    h('button', { class: 'btn', onclick: () => setHidden(matches, true) }, q ? 'Hide matching' : 'Hide all'),
    q ? h('button', { class: 'btn', title: 'Show only columns matching the filter', onclick: () => { setHidden(order, true); setHidden(matches, false); } }, 'Only matching') : null,
    h('button', { class: 'btn', title: 'Hide columns with no values in the current rows', onclick: hideEmpty }, 'Hide empty'),
    h('button', { class: 'btn', title: 'Restore original order, widths, visibility', onclick: resetLayout }, 'Reset'),
  );
  let dragCol = -1;
  const items = matches.map((c) => {
    const col = table.columns[c];
    const cb = h('input', { type: 'checkbox', checked: !hidden.has(c), onchange: () => setHidden([c], !cb.checked) });
    const pin = h('span', { class: `pin${pinned.has(c) ? ' on' : ''}`, title: pinned.has(c) ? 'Unpin' : 'Pin to left', onclick: () => togglePin(c) });
    pin.innerHTML = ICON.pin;
    const li = h(
      'div',
      { class: `col-item${hidden.has(c) ? ' off' : ''}`, draggable: true },
      cb,
      pin,
      h('span', { class: 'col-name', title: col.name, onclick: () => revealColumn(c) }, col.name),
      h('span', { class: `col-type t-${col.type}` }, col.type),
      isFilterActive(filters.get(c)) ? h('span', { class: 'col-f', title: 'Filtered' }, '●') : null,
    );
    li.addEventListener('dragstart', (e) => {
      dragCol = c;
      e.dataTransfer!.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      const after = e.offsetY > li.offsetHeight / 2;
      li.classList.toggle('drop-before', !after);
      li.classList.toggle('drop-after', after);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const after = li.classList.contains('drop-after');
      li.classList.remove('drop-before', 'drop-after');
      if (dragCol < 0 || dragCol === c) return;
      const idx = order.indexOf(c) + (after ? 1 : 0);
      moveColumn(dragCol, order[idx] === dragCol ? order[idx + 1] ?? null : order[idx] ?? null);
    });
    return li;
  });
  sideBody.replaceChildren(...items);
}

function setChildren(el: HTMLElement, ...kids: (Node | null)[]) {
  el.replaceChildren(...kids.filter((k): k is Node => !!k));
}

function setHidden(cols: number[], hide: boolean) {
  for (const c of cols) hide ? hidden.add(c) : hidden.delete(c);
  saveLayout();
  refreshColumns();
}

function togglePin(c: number) {
  pinned.has(c) ? pinned.delete(c) : pinned.add(c);
  saveLayout();
  refreshColumns();
}

function hideEmpty() {
  const nonEmpty = new Set<number>();
  for (const r of view) {
    const row = table.rows[r];
    for (let c = 0; c < row.length; c++) if (row[c]) nonEmpty.add(c);
  }
  setHidden(order.filter((c) => !nonEmpty.has(c)), true);
}

function resetLayout() {
  layout = {};
  order = table.columns.map((_, i) => i);
  hidden.clear();
  pinned.clear();
  for (let c = 0; c < table.columns.length; c++) {
    autoWidth[c] = true;
    table.columns[c].override = undefined;
  }
  estimateWidths();
  sort = undefined;
  saveLayout();
  refreshColumns();
  recompute();
}

function revealColumn(c: number) {
  if (hidden.has(c)) setHidden([c], false);
  const r = Math.max(0, grid.selRow);
  grid.select(r, c);
  grid.ensureVisible(r, c);
  if (sidePanel === 'details') renderDetails();
}

function renderDetails() {
  sideTitle.textContent = 'Row details';
  sideFilter.placeholder = 'Filter fields…';
  const r = grid.selRow;
  const ri = view[r];
  setChildren(
    sideTools,
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: detailsHideEmpty, onchange: (e: Event) => { detailsHideEmpty = (e.target as HTMLInputElement).checked; renderDetails(); } }), 'Hide empty'),
    ri !== undefined ? h('button', { class: 'btn', onclick: () => post({ type: 'copy', text: JSON.stringify(rowObject(ri), null, 2) }) }, 'Copy as JSON') : null,
    ri !== undefined ? h('span', { class: 'muted' }, `Row ${fmt(ri + 1)}`) : null,
  );
  if (ri === undefined) {
    sideBody.replaceChildren(h('div', { class: 'muted pad' }, 'Select a row to see all of its fields.'));
    return;
  }
  const q = sideFilter.value.toLowerCase();
  const row = table.rows[ri];
  const cols = [...visibleCols(), ...order.filter((c) => hidden.has(c))];
  const items: HTMLElement[] = [];
  for (const c of cols) {
    const name = table.columns[c].name;
    const v = row[c] ?? '';
    if (detailsHideEmpty && !v) continue;
    if (q && !name.toLowerCase().includes(q) && !v.toLowerCase().includes(q)) continue;
    const val = h('div', { class: 'd-val' });
    val.innerHTML = highlight(pretty(v), cellHighlight(c));
    items.push(
      h(
        'div',
        { class: `d-item${hidden.has(c) ? ' off' : ''}${c === grid.selCol ? ' cur' : ''}` },
        h('div', { class: 'd-name', title: `${name} — click to show column`, onclick: () => revealColumn(c) }, name),
        val,
        h(
          'div',
          { class: 'd-acts' },
          h('button', { class: 'icon', title: 'Filter to this value', onclick: () => setValueFilter(c, v, 'include') }, '='),
          h('button', { class: 'icon', title: 'Exclude this value', onclick: () => setValueFilter(c, v, 'exclude') }, '≠'),
          h('button', { class: 'icon', title: 'Copy value', onclick: () => post({ type: 'copy', text: v }) }, '⧉'),
        ),
      ),
    );
  }
  sideBody.replaceChildren(...items);
}

function pretty(v: string): string {
  const t = v.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON */
    }
  }
  return v;
}

function rowObject(ri: number): Record<string, string> {
  const row = table.rows[ri];
  return Object.fromEntries(visibleCols().map((c) => [table.columns[c].name, row[c] ?? '']));
}

function setValueFilter(c: number, v: string, mode: 'include' | 'exclude') {
  const f = { ...(filters.get(c) ?? {}) };
  const cur = f.values;
  if (mode === 'include') f.values = { mode, set: new Set([v]) };
  else if (cur?.mode === 'exclude') f.values = { mode, set: new Set([...cur.set, v]) };
  else if (cur?.mode === 'include') {
    const s = new Set(cur.set);
    s.delete(v);
    f.values = { mode: 'include', set: s };
  } else f.values = { mode, set: new Set([v]) };
  setFilter(c, f);
}

// ------------------------------------------------------------------ popups (filter, context menu)

interface Popup {
  el: HTMLElement;
  refresh?: () => void;
}
let popup: Popup | undefined;
const popupRefreshSoon = debounce(() => popup?.refresh?.(), 1000);

function closePopup() {
  popup?.el.remove();
  popup = undefined;
}

function place(el: HTMLElement, x: number, y: number) {
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
}

document.addEventListener('mousedown', (e) => {
  if (popup && !popup.el.contains(e.target as Node)) closePopup();
}, true);

const MAX_VALUES = 1000;

function openFilterPopup(c: number, anchor: HTMLElement) {
  closePopup();
  const col = table.columns[c];
  const cur = (): ColumnFilter => filters.get(c) ?? {};
  const update = (patch: Partial<ColumnFilter>) => setFilter(c, { ...cur(), ...patch });

  const el = h('div', { class: 'popup filter-popup' });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePopup();
      grid.el.focus();
    }
  });

  const typeSel = h('select', { title: 'Column type (affects sorting and range filters)' });
  for (const t of ['auto', 'string', 'number', 'date', 'boolean']) {
    typeSel.append(h('option', { value: t, selected: (col.override ?? 'auto') === t }, t === 'auto' ? `auto (${col.inferred})` : t));
  }
  typeSel.onchange = () => {
    col.override = typeSel.value === 'auto' ? undefined : (typeSel.value as ColType);
    saveLayout();
    refreshColumns();
    recompute();
    openFilterPopup(c, anchor);
  };

  const sortBtns = h(
    'div',
    { class: 'row-btns' },
    h('button', { class: `btn${sort?.col === c && sort.dir === 1 ? ' on' : ''}`, onclick: () => setSort({ col: c, dir: 1 }) }, 'Sort ▲'),
    h('button', { class: `btn${sort?.col === c && sort.dir === -1 ? ' on' : ''}`, onclick: () => setSort({ col: c, dir: -1 }) }, 'Sort ▼'),
    h('button', { class: 'btn', onclick: () => { setHidden([c], true); closePopup(); } }, 'Hide'),
    h('button', { class: 'btn', onclick: () => { togglePin(c); closePopup(); } }, pinned.has(c) ? 'Unpin' : 'Pin'),
  );

  const text = h('input', { type: 'text', class: 'search', placeholder: 'Contains…  (=exact  !not  /regex/  "" empty)', value: cur().text ?? '', spellcheck: false });
  text.addEventListener('input', () => update({ text: text.value || undefined }));

  // Range
  let range: HTMLElement | null = null;
  if (col.type === 'number' || col.type === 'date') {
    const isDate = col.type === 'date';
    const rr = columnRange(table, c);
    const show = (n: number) => (isDate ? fmtDate(n) : String(n));
    const min = h('input', { type: 'text', placeholder: rr ? show(rr.min) : 'min', value: cur().min ?? '', spellcheck: false });
    const max = h('input', { type: 'text', placeholder: rr ? show(rr.max) : 'max', value: cur().max ?? '', spellcheck: false });
    const apply = () => update({ min: min.value || undefined, max: max.value || undefined });
    min.addEventListener('input', apply);
    max.addEventListener('input', apply);
    const quick = isDate
      ? h(
          'div',
          { class: 'row-btns' },
          ...['-5m', '-1h', '-24h', '-7d'].map((d) => h('button', { class: 'btn', title: `Last ${d.slice(1)}`, onclick: () => { min.value = d; max.value = ''; apply(); } }, `last ${d.slice(1)}`)),
        )
      : null;
    range = h(
      'div',
      { class: 'section' },
      h('div', { class: 'label' }, isDate ? 'Date range (ISO, epoch, now, -15m, -2h, -1d)' : 'Range'),
      h('div', { class: 'range' }, min, h('span', {}, '–'), max),
      quick,
    );
  }

  // Values
  const valSearch = h('input', { type: 'text', class: 'search', placeholder: 'Search values…', spellcheck: false });
  const allBox = h('input', { type: 'checkbox' });
  const allLabel = h('span');
  const onlyBtn = h('button', { class: 'btn', title: 'Show only the listed values' }, 'Only these');
  const sortByValue = h('input', { type: 'checkbox', title: 'Sort values alphabetically instead of by count' });
  const list = h('div', { class: 'values' });
  const more = h('div', { class: 'muted' });
  let facets = facet(table, query(), c);

  const checked = (v: string) => {
    const vs = cur().values;
    return !vs || (vs.mode === 'include' ? vs.set.has(v) : !vs.set.has(v));
  };
  const setChecked = (vals: string[], on: boolean) => {
    let vs = cur().values;
    if (!vs) vs = { mode: 'exclude', set: new Set() };
    const set = new Set(vs.set);
    for (const v of vals) (vs.mode === 'include') === on ? set.add(v) : set.delete(v);
    update({ values: vs.mode === 'exclude' && !set.size ? undefined : { mode: vs.mode, set } });
  };

  let listed: string[] = [];
  const renderValues = () => {
    const q = valSearch.value.toLowerCase();
    let fs = q ? facets.filter((f) => f.value.toLowerCase().includes(q)) : facets.slice();
    if (sortByValue.checked) {
      const coll = new Intl.Collator(undefined, { numeric: true });
      fs.sort((a, b) => coll.compare(a.value, b.value));
    } else fs.sort((a, b) => b.count - a.count);
    const total = fs.length;
    fs = fs.slice(0, MAX_VALUES);
    listed = fs.map((f) => f.value);
    const nChecked = listed.filter(checked).length;
    allBox.checked = nChecked === listed.length && listed.length > 0;
    allBox.indeterminate = nChecked > 0 && nChecked < listed.length;
    allLabel.textContent = q ? `(All matching: ${fmt(total)})` : `(Select all: ${fmt(total)} values)`;
    onlyBtn.style.display = q ? '' : 'none';
    list.replaceChildren(
      ...fs.map((f) =>
        h(
          'label',
          { class: 'val', title: f.value },
          h('input', { type: 'checkbox', checked: checked(f.value), onchange: (e: Event) => { setChecked([f.value], (e.target as HTMLInputElement).checked); renderValues(); } }),
          h('span', { class: f.value ? 'v' : 'v muted' }, f.value ? oneLine(f.value) : '(empty)'),
          h('span', { class: 'cnt' }, fmt(f.count)),
        ),
      ),
    );
    more.textContent = total > MAX_VALUES ? `Showing ${fmt(MAX_VALUES)} of ${fmt(total)} — search to narrow` : '';
  };
  allBox.onchange = () => {
    if (!valSearch.value) update({ values: allBox.checked ? undefined : { mode: 'include', set: new Set() } });
    else setChecked(listed, allBox.checked);
    renderValues();
  };
  onlyBtn.onclick = () => {
    update({ values: { mode: 'include', set: new Set(listed) } });
    renderValues();
  };
  valSearch.addEventListener('input', renderValues);
  sortByValue.onchange = renderValues;

  setChildren(
    el,
    h('div', { class: 'popup-head' }, h('b', { title: col.name }, col.name), typeSel),
    sortBtns,
    h('div', { class: 'section' }, h('div', { class: 'label' }, 'Text filter'), text),
    range,
    h(
      'div',
      { class: 'section' },
      h('div', { class: 'label' }, 'Values ', h('label', { class: 'chk small' }, sortByValue, 'A→Z')),
      valSearch,
      h('div', { class: 'all-row' }, h('label', { class: 'val' }, allBox, allLabel), onlyBtn),
      list,
      more,
    ),
    h(
      'div',
      { class: 'row-btns end' },
      h('button', { class: 'btn', onclick: () => { setFilter(c, undefined); openFilterPopup(c, anchor); } }, 'Clear filter'),
      h('button', { class: 'btn primary', onclick: () => { closePopup(); grid.el.focus(); } }, 'Done'),
    ),
  );
  renderValues();
  const r = anchor.getBoundingClientRect();
  place(el, r.left, r.bottom + 2);
  popup = {
    el,
    refresh: () => {
      facets = facet(table, query(), c);
      renderValues();
    },
  };
  text.focus();
}

function oneLine(s: string) {
  const t = s.length > 200 ? s.slice(0, 200) + '…' : s;
  return t.replace(/\r?\n/g, ' ⏎ ');
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return isNaN(d.getTime()) ? '' : d.toISOString().replace('.000Z', 'Z');
}

interface MenuItem {
  label: string;
  run: () => void;
  disabled?: boolean;
}
function menu(e: MouseEvent, items: (MenuItem | null)[]) {
  closePopup();
  const el = h('div', { class: 'popup menu' });
  for (const it of items) {
    if (!it) {
      el.append(h('div', { class: 'sep' }));
      continue;
    }
    el.append(h('div', { class: `mi${it.disabled ? ' disabled' : ''}`, onclick: () => { closePopup(); if (!it.disabled) it.run(); } }, it.label));
  }
  place(el, e.clientX, e.clientY);
  popup = { el };
}

function cellMenu(e: MouseEvent, r: number, c: number) {
  selectCell(r, c);
  const ri = view[r];
  const v = table.rows[ri][c] ?? '';
  const name = table.columns[c]?.name ?? '';
  const short = v.length > 30 ? v.slice(0, 30) + '…' : v || '(empty)';
  const vis = visibleCols();
  menu(e, [
    { label: 'Copy value', run: () => post({ type: 'copy', text: v }) },
    { label: 'Copy row (TSV)', run: () => post({ type: 'copy', text: vis.map((x) => table.rows[ri][x] ?? '').join('\t') }) },
    { label: 'Copy row (JSON)', run: () => post({ type: 'copy', text: JSON.stringify(rowObject(ri)) }) },
    null,
    { label: `Only "${oneLine(short)}" in ${name}`, run: () => setValueFilter(c, v, 'include') },
    { label: `Exclude "${oneLine(short)}" from ${name}`, run: () => setValueFilter(c, v, 'exclude') },
    null,
    { label: 'Row details', run: () => setSidePanel('details') },
    { label: `Hide column ${name}`, run: () => setHidden([c], true) },
  ]);
}

function headerMenu(e: MouseEvent, c: number) {
  const name = table.columns[c].name;
  menu(e, [
    { label: 'Sort ascending', run: () => setSort({ col: c, dir: 1 }) },
    { label: 'Sort descending', run: () => setSort({ col: c, dir: -1 }) },
    { label: 'Clear sort', run: () => setSort(undefined), disabled: !sort },
    null,
    { label: 'Filter…', run: () => { const hc = grid.el.querySelector<HTMLElement>(`.hcell[data-c="${c}"]`); if (hc) openFilterPopup(c, hc); } },
    { label: 'Clear filter', run: () => setFilter(c, undefined), disabled: !isFilterActive(filters.get(c)) },
    null,
    { label: pinned.has(c) ? 'Unpin column' : 'Pin column to left', run: () => togglePin(c) },
    { label: 'Hide column', run: () => setHidden([c], true) },
    { label: 'Hide all other columns', run: () => { setHidden(order, true); setHidden([c], false); } },
    { label: 'Show all columns', run: () => setHidden(order, false) },
    { label: 'Auto-size column', run: () => { estimateWidths(c); autoWidth[c] = false; refreshColumns(); saveLayout(); } },
    null,
    { label: `Copy column name "${name}"`, run: () => post({ type: 'copy', text: name }) },
  ]);
}

// ------------------------------------------------------------------ keyboard

grid.el.addEventListener('keydown', (e) => {
  const vis = visibleCols();
  let r = grid.selRow;
  let ci = vis.indexOf(grid.selCol);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'c') {
    if (r >= 0 && grid.selCol >= 0) post({ type: 'copy', text: table.rows[view[r]][grid.selCol] ?? '' });
    e.preventDefault();
    return;
  }
  const page = grid.pageRows();
  switch (e.key) {
    case 'ArrowDown': r++; break;
    case 'ArrowUp': r--; break;
    case 'ArrowRight': ci++; break;
    case 'ArrowLeft': ci--; break;
    case 'PageDown': r += page; break;
    case 'PageUp': r -= page; break;
    case 'Home': if (mod) r = 0; else ci = 0; break;
    case 'End': if (mod) r = view.length - 1; else ci = vis.length - 1; break;
    case 'Enter': setSidePanel('details'); e.preventDefault(); return;
    default: return;
  }
  e.preventDefault();
  r = Math.max(0, Math.min(view.length - 1, r));
  ci = Math.max(0, Math.min(vis.length - 1, ci));
  selectCell(r, vis[ci]);
});

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (e.key === 'Escape' && popup) closePopup();
});

// ------------------------------------------------------------------ host messages

window.addEventListener('message', (ev: MessageEvent<HostMessage>) => {
  const m = ev.data;
  switch (m.type) {
    case 'reset': {
      fileName = m.fileName;
      format = m.format;
      live = m.live;
      layout = m.layout ?? {};
      follow = false;
      loading = true;
      statusMsg = '';
      statusErr = false;
      table.clear();
      order = [];
      hidden.clear();
      pinned.clear();
      widths.length = 0;
      autoWidth.length = 0;
      filters.clear();
      sort = undefined;
      view = [];
      grid.select(-1, -1);
      document.title = fileName;
      refreshColumns();
      grid.invalidate();
      break;
    }
    case 'rows':
      statusMsg = '';
      statusErr = false;
      onRows(m);
      break;
    case 'status':
      statusMsg = m.message;
      statusErr = !!m.error;
      if (m.error) loading = false;
      refreshChrome();
      break;
  }
});

// ------------------------------------------------------------------ mount

document.body.append(
  h(
    'div',
    { class: 'app' },
    h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'searchbox' }, searchInput, caseBtn, regexBtn),
      clearBtn,
      colsBtn,
      detailsBtn,
      followBtn,
      h('div', { class: 'spacer' }),
      status,
      textBtn,
    ),
    h('div', { class: 'main' }, grid.el, side),
  ),
);
side.style.display = 'none';
refreshChrome();
post({ type: 'ready' });
