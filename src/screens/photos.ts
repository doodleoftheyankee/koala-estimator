// Photos for one space: take or pick up to 6, see thumbnails, open full size, delete.

import { deletePhoto, listPhotos, type PhotoRecord } from '../db';
import { h, mount, toast } from '../dom';
import type { Job, Space } from '../model';
import { KOALA_FIELD_URL, MAX_PHOTOS_PER_SPACE, savePhoto } from '../photos';
import { topBar } from './layout';

export async function renderPhotos(root: HTMLElement, job: Job, space: Space): Promise<void> {
  const photos = await listPhotos(space.id);
  const urls: string[] = [];
  const url = (b: Blob) => {
    const u = URL.createObjectURL(b);
    urls.push(u);
    return u;
  };
  // Free the object URLs when we leave this screen.
  window.addEventListener('hashchange', () => urls.forEach((u) => URL.revokeObjectURL(u)), { once: true });

  const left = MAX_PHOTOS_PER_SPACE - photos.length;
  const status = h('p', { class: 'hint', 'aria-live': 'polite' });

  /** Downscales and stores the picked photos, up to the per-space limit. */
  const addFiles = async (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (!files.length) return;
    const take = files.slice(0, left);
    if (files.length > left) toast(`Only ${left} more photo${left === 1 ? '' : 's'} fit (max ${MAX_PHOTOS_PER_SPACE}).`);
    status.textContent = `Saving ${take.length} photo${take.length === 1 ? '' : 's'}…`;
    for (const f of take) {
      try {
        await savePhoto(f, job.id, space.id);
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Could not save a photo.');
      }
    }
    void renderPhotos(root, job, space);
  };
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'visually-hidden', id: 'photo-input' });
  input.addEventListener('change', () => void addFiles(input.files));
  // A second input with capture opens the camera directly on phones.
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden', id: 'camera-input' });
  camera.addEventListener('change', () => void addFiles(camera.files));

  const viewer = (p: PhotoRecord) => {
    const dialog = h(
      'dialog',
      { class: 'viewer' },
      h('img', { src: url(p.blob), alt: p.name }),
      h(
        'div',
        { class: 'row' },
        h('button', {
          type: 'button', class: 'btn danger',
          onclick: async () => {
            if (!confirm('Delete this photo?')) return;
            await deletePhoto(p.id);
            dialog.close();
            void renderPhotos(root, job, space);
          },
        }, 'Delete'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => dialog.close() }, 'Close'),
      ),
    );
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  };

  mount(
    root,
    topBar(`${space.name} photos`, { href: `#/job/${job.id}/space/${space.id}`, label: 'Space' }),
    h(
      'main',
      { class: 'screen' },
      h('p', { class: 'muted' }, `${photos.length} of ${MAX_PHOTOS_PER_SPACE} photos. Stored on this phone only.`),
      h(
        'div',
        { class: 'thumbs' },
        photos.map((p) =>
          h('button', { type: 'button', class: 'thumb', 'aria-label': `Open photo ${p.name}`, onclick: () => viewer(p) }, h('img', { src: url(p.thumb), alt: '' })),
        ),
      ),
      left > 0
        ? h(
            'div',
            { class: 'row' },
            camera,
            input,
            h('label', { for: 'camera-input', class: 'btn primary grow' }, '📷 Take photo'),
            h('label', { for: 'photo-input', class: 'btn grow' }, '🖼 Choose'),
          )
        : h('p', { class: 'hint' }, 'This space has the maximum 6 photos. Delete one to add another.'),
      status,
      h(
        'section',
        { class: 'card ai-card' },
        h('strong', {}, '✨ AI photo reading'),
        h(
          'p',
          { class: 'hint' },
          'In the Koala app, AI reads your photos and fills in existing insulation and depth, R-value, framing, access and obstacles, and flags hazards like vermiculite or knob-and-tube. Add the area there to use it.',
        ),
        h('a', { class: 'btn primary block', href: KOALA_FIELD_URL, target: '_blank', rel: 'noopener' }, 'Open the Koala app ↗'),
      ),
    ),
  );
}
