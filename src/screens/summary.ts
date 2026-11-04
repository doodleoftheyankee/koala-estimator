// Summary: every space's numbers, net totals per type, and the ways to get them out of the app.

import { countPhotos } from '../db';
import { h, mount, toast } from '../dom';
import { SPACE_NAME, totalsByType, type Job } from '../model';
import { exportJson, foamDeskLink, summaryRows, summaryText } from '../summary';
import { formatSqft } from '../units';
import { topBar } from './layout';

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older iOS / non-secure contexts: fall back to a hidden textarea.
    const ta = h('textarea', { readonly: true, style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function fileName(job: Job): string {
  const who = (job.customer || 'job').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `atticscan-${who || 'job'}-${new Date().toISOString().slice(0, 10)}.json`;
}

/** Shares the file where the phone supports it (iOS share sheet), otherwise downloads it. */
async function saveJson(job: Job, json: string): Promise<void> {
  const file = new File([json], fileName(job), { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function renderSummary(root: HTMLElement, job: Job): Promise<void> {
  const rows = summaryRows(job);
  const totals = totalsByType(job);
  const grand = totals.reduce((s, t) => s + t.net, 0);
  const counts: Record<string, number> = {};
  await Promise.all(job.spaces.map(async (sp) => { counts[sp.id] = await countPhotos(sp.id); }));

  mount(
    root,
    topBar('Summary', { href: `#/job/${job.id}`, label: 'Job' }),
    h(
      'main',
      { class: 'screen' },
      h('section', { class: 'card' }, h('strong', {}, job.customer || 'Unnamed customer'), h('div', { class: 'muted' }, job.address || 'No address')),
      rows.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'summary' },
              h('thead', {}, h('tr', {}, h('th', {}, 'Space'), h('th', {}, 'Gross'), h('th', {}, 'Cut'), h('th', {}, 'Net'))),
              h(
                'tbody',
                {},
                rows.map((r) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, h('a', { href: `#/job/${job.id}/space/${r.space.id}` }, r.space.name), h('div', { class: 'muted small' }, SPACE_NAME[r.space.type])),
                    r.ok ? [h('td', {}, formatSqft(r.gross)), h('td', {}, formatSqft(r.cutouts)), h('td', { class: 'strong' }, formatSqft(r.net))] : h('td', { colspan: 3, class: 'warn' }, 'Needs sizes'),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, 'No spaces yet.'),
      h('h2', {}, 'Net total by type'),
      h(
        'ul',
        { class: 'cards' },
        totals.map((t) =>
          h(
            'li',
            { class: 'card type-total' },
            h('div', { class: 'type-total-head' }, h('span', { class: `type-dot t-${t.type}` }), h('strong', {}, SPACE_NAME[t.type]), h('span', { class: 'num' }, `${formatSqft(t.net)} sq ft`)),
            t.net > 0
              ? h('a', { class: 'btn primary block', href: foamDeskLink(t.type, t.net), target: '_blank', rel: 'noopener' }, `Price ${SPACE_NAME[t.type]} in Foam Desk ↗`)
              : null,
          ),
        ),
      ),
      totals.length ? h('p', { class: 'total-line' }, 'All spaces ', h('strong', {}, `${formatSqft(grand)} sq ft`)) : null,
      h('h2', {}, 'Share'),
      h('button', {
        type: 'button', class: 'btn block',
        onclick: async () => {
          await copyText(summaryText(job));
          toast('Summary copied');
        },
      }, '📋 Copy summary text'),
      h('button', { type: 'button', class: 'btn block', onclick: () => saveJson(job, exportJson(job, counts)) }, '⬇ Export JSON'),
      h('details', { class: 'card' }, h('summary', {}, 'Preview summary text'), h('pre', { class: 'preview-text' }, summaryText(job))),
    ),
  );
}
