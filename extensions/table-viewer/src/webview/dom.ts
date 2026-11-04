export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Escape + wrap regex matches in <mark>. `re` must be global. */
export function highlight(s: string, re: RegExp | null): string {
  if (!re || !s) return esc(s);
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(s)) && guard++ < 50) {
    if (!m[0].length) {
      re.lastIndex++;
      continue;
    }
    out += esc(s.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const ICON = {
  filter: '<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M1 2h14l-5.5 6.5V14l-3-1.5V8.5z"/></svg>',
  up: '▲',
  down: '▼',
  pin: '<svg viewBox="0 0 16 16" width="11" height="11"><path fill="currentColor" d="M10 1l5 5-2 1-3 3 .5 3.5L9 15l-3-3-4 4-1-1 4-4-3-3 1.5-1.5L7 7l3-3z"/></svg>',
};
