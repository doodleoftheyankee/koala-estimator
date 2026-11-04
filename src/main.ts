// Entry point: hash router, offline service worker, and the "new version" banner.

import './style.css';
import { h } from './dom';
import { requestPersistence } from './db';
import { flush, openJob } from './store';
import { renderHome } from './screens/home';
import { renderJob } from './screens/job';
import { renderPhotos } from './screens/photos';
import { renderSpace } from './screens/space';
import { renderSummary } from './screens/summary';

const app = document.getElementById('app')!;

/** Routes: #/  #/job/:id  #/job/:id/summary  #/job/:id/space/:sid  #/job/:id/space/:sid/photos */
async function route(): Promise<void> {
  await flush();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  try {
    if (parts[0] !== 'job' || !parts[1]) return await renderHome(app);
    const job = await openJob(parts[1]);
    if (!job) return notFound('That job no longer exists on this phone.');
    if (!parts[2]) return await renderJob(app, job);
    if (parts[2] === 'summary') return await renderSummary(app, job);
    if (parts[2] === 'space' && parts[3]) {
      const space = job.spaces.find((s) => s.id === parts[3]);
      if (!space) return notFound('That space was deleted.', `#/job/${job.id}`);
      return parts[4] === 'photos' ? await renderPhotos(app, job, space) : await renderSpace(app, job, space);
    }
    notFound('Page not found.');
  } catch (e) {
    console.error(e);
    notFound(`Something went wrong: ${e instanceof Error ? e.message : e}`);
  }
}

function notFound(message: string, back = '#/'): void {
  app.replaceChildren(h('main', { class: 'screen' }, h('p', { class: 'empty' }, message), h('a', { class: 'btn primary block', href: back }, 'Go back')));
}

window.addEventListener('hashchange', () => void route());
void route();
void requestPersistence();

// Offline support: the service worker (built by vite.config.ts) caches the whole app on first
// load. When a new version is deployed, offer a reload instead of swapping code mid-measurement.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const offerUpdate = (worker: ServiceWorker) => {
        const bar = h(
          'div',
          { class: 'update-bar', role: 'alert' },
          h('span', {}, 'A new version of AtticScan is ready.'),
          h('button', { type: 'button', class: 'btn small primary', onclick: async () => { await flush(); worker.postMessage('skipWaiting'); } }, 'Update'),
        );
        document.body.append(bar);
      };
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
        });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        location.reload();
      });
    } catch (e) {
      console.warn('Offline mode unavailable:', e);
    }
  });
}
