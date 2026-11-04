// Home: start a new job or reopen a saved one.

import { deleteJob, listJobs } from '../db';
import { h, mount } from '../dom';
import { newJob, totalsByType } from '../model';
import { setCurrent, flush } from '../store';
import { formatSqft } from '../units';
import { go, topBar } from './layout';

export async function renderHome(root: HTMLElement): Promise<void> {
  const jobs = await listJobs();

  const start = async () => {
    const job = newJob();
    setCurrent(job);
    await flush();
    go(`#/job/${job.id}`);
  };

  mount(
    root,
    topBar('Jobs'),
    h(
      'main',
      { class: 'screen' },
      h('button', { type: 'button', class: 'btn primary block xl', onclick: start }, '+ New job'),
      jobs.length
        ? h(
            'ul',
            { class: 'cards' },
            jobs.map((job) => {
              const total = totalsByType(job).reduce((s, t) => s + t.net, 0);
              return h(
                'li',
                { class: 'card row-card' },
                h(
                  'a',
                  { class: 'card-main', href: `#/job/${job.id}` },
                  h('strong', {}, job.customer || 'Unnamed customer'),
                  h('span', { class: 'muted' }, job.address || 'No address'),
                  h('span', { class: 'muted small' }, `${job.spaces.length} space${job.spaces.length === 1 ? '' : 's'} · ${formatSqft(total)} sq ft · ${new Date(job.updatedAt).toLocaleDateString()}`),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn icon danger',
                    'aria-label': `Delete job ${job.customer}`,
                    onclick: async () => {
                      if (!confirm(`Delete the job for ${job.customer || 'this customer'}, including its photos?`)) return;
                      await deleteJob(job.id);
                      void renderHome(root);
                    },
                  },
                  '🗑',
                ),
              );
            }),
          )
        : h('p', { class: 'empty' }, 'No jobs yet. Tap "New job" to measure your first attic or crawlspace.'),
    ),
  );
}
