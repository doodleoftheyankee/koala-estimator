// Tiny DOM helpers so screens can be written as plain functions without a framework.

type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;
type Child = Node | string | number | null | undefined | false | Child[];

/** Creates an element: h('button', { class: 'big', onclick: fn }, 'Save'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'value' && 'value' in el) (el as HTMLInputElement).value = String(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Creates an SVG element with attributes. */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  append(el, children);
  return el;
}

function append(el: Element, children: Child[]): void {
  for (const c of children.flat(Infinity as 1) as Child[]) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

/** Replaces all children of an element. */
export function mount(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

let toastTimer: number | undefined;

/** Shows a short message at the bottom of the screen. */
export function toast(message: string): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), 2600);
}

/** A labelled text input that reports every keystroke. */
export function field(opts: {
  label: string;
  value: string;
  oninput: (v: string) => void;
  placeholder?: string;
  hint?: string;
  inputmode?: string;
  type?: string;
  id?: string;
}): HTMLLabelElement {
  const input = h('input', {
    type: opts.type ?? 'text',
    value: opts.value,
    placeholder: opts.placeholder,
    inputmode: opts.inputmode,
    id: opts.id,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'next',
  });
  input.addEventListener('input', () => opts.oninput(input.value));
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, opts.label), input, opts.hint ? h('span', { class: 'field-hint' }, opts.hint) : null);
}
