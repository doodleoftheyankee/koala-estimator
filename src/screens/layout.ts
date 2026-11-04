// Shared screen chrome: a sticky top bar with a big back button and a title.

import { h } from '../dom';

export function topBar(title: string, back?: { href: string; label?: string }, action?: HTMLElement): HTMLElement {
  return h(
    'header',
    { class: 'topbar' },
    back ? h('a', { class: 'back', href: back.href, 'aria-label': back.label ?? 'Back' }, '‹ ', back.label ?? 'Back') : h('span', { class: 'brand' }, '▲ AtticScan'),
    h('h1', {}, title),
    action ?? h('span'),
  );
}

export function go(hash: string): void {
  location.hash = hash;
}
