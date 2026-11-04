// Job screen: customer, address, and the list of spaces with their net square footage.

import { countPhotos } from '../db';
import { field, h, mount } from '../dom';
import { computeSpace, newSpace, SPACE_NAME, SPACE_TYPES, type Job, type SpaceType } from '../model';
import { changed, flush } from '../store';
import { formatSqft } from '../units';
import { go, topBar } from './layout';

export async function renderJob(root: HTMLElement, job: Job): Promise<void> {
  const photoCounts = await Promise.all(job.spaces.map((sp) => countPhotos(sp.id)));

  const addSpace = async (type: SpaceType) => {
    const space = newSpace(type, job.spaces);
    job.spaces.push(space);
    await flush();
    go(`#/job/${job.id}/space/${space.id}`);
  };

  const total = job.spaces.reduce((sum, sp) => sum + computeSpace(sp).net, 0);

  mount(
    root,
    topBar('Job', { href: '#/', label: 'Jobs' }, h('a', { class: 'btn small', href: `#/job/${job.id}/summary` }, 'Summary')),
    h(
      'main',
      { class: 'screen' },
      h(
        'section',
        { class: 'card' },
        field({ label: 'Customer name', value: job.customer, placeholder: 'e.g. Pat Smith', oninput: (v) => { job.customer = v; changed(); } }),
        field({ label: 'Address', value: job.address, placeholder: 'e.g. 12 Main St, Newark DE', oninput: (v) => { job.address = v; changed(); } }),
      ),
      h('h2', {}, 'Spaces'),
      job.spaces.length
        ? h(
            'ul',
            { class: 'cards' },
            job.spaces.map((sp, i) => {
              const r = computeSpace(sp);
              return h(
                'li',
                { class: 'card' },
                h(
                  'a',
                  { class: 'card-main space-card', href: `#/job/${job.id}/space/${sp.id}` },
                  h('span', { class: `type-dot t-${sp.type}` }),
                  h('span', { class: 'space-name' }, h('strong', {}, sp.name), h('span', { class: 'muted small' }, `${SPACE_NAME[sp.type]} · ${photoCounts[i]} photo${photoCounts[i] === 1 ? '' : 's'}`)),
                  h('span', { class: r.errors.length ? 'space-net warn' : 'space-net' }, r.errors.length ? 'Needs sizes' : `${formatSqft(r.net)} sq ft`),
                ),
              );
            }),
          )
        : h('p', { class: 'empty' }, 'No spaces yet. Add the first one below.'),
      job.spaces.length ? h('p', { class: 'total-line' }, 'Net total ', h('strong', {}, `${formatSqft(total)} sq ft`)) : null,
      h('h2', {}, 'Add a space'),
      h(
        'div',
        { class: 'type-grid' },
        SPACE_TYPES.map((t) =>
          h('button', { type: 'button', class: `btn type-btn t-${t.type}`, onclick: () => addSpace(t.type) }, h('strong', {}, `+ ${t.name}`), h('span', { class: 'small' }, t.hint)),
        ),
      ),
      job.spaces.length ? h('a', { class: 'btn primary block xl', href: `#/job/${job.id}/summary` }, 'View summary') : null,
    ),
  );
}
