// Space editor: shape, cutouts, pitch or wall height, with gross / cutouts / net always visible.

import { countPhotos, deleteSpacePhotos } from '../db';
import { field, h, mount } from '../dom';
import { computeSpace, CUTOUT_PRESETS, newCutout, pitchFactor, SPACE_TYPES, type Job, type Space } from '../model';
import { shapeEditor } from '../shapeView';
import { changed, flush } from '../store';
import { formatSqft, parsePitch } from '../units';
import { go, topBar } from './layout';

export async function renderSpace(root: HTMLElement, job: Job, space: Space): Promise<void> {
  const photos = await countPhotos(space.id);

  // Live totals, updated on every keystroke without rebuilding the inputs (keeps focus).
  const gross = h('span', { class: 'num' });
  const cut = h('span', { class: 'num' });
  const net = h('span', { class: 'num big' });
  const basis = h('p', { class: 'basis' });
  const problems = h('ul', { class: 'problems' });
  const cutoutAreas = new Map<string, HTMLElement>();

  const refresh = () => {
    const r = computeSpace(space);
    gross.textContent = formatSqft(r.gross);
    cut.textContent = r.cutouts ? `−${formatSqft(r.cutouts)}` : '0';
    net.textContent = formatSqft(r.net);
    basis.textContent = r.errors.length ? '' : r.basis;
    problems.replaceChildren(...[...r.errors.map((e) => h('li', { class: 'error' }, e)), ...r.notes.map((n) => h('li', { class: 'note' }, n))]);
    for (const c of r.cutoutResults) {
      const el = cutoutAreas.get(c.id);
      if (el) el.textContent = c.errors.length ? c.errors[0]! : `${formatSqft(c.area)} sq ft`;
    }
    pitchInfo();
  };
  const edited = () => {
    refresh();
    changed();
  };

  // Roofline pitch factor readouts.
  const factor1 = h('span', { class: 'factor' });
  const factor2 = h('span', { class: 'factor' });
  const pitchInfo = () => {
    const show = (el: HTMLElement, text: string) => {
      const p = parsePitch(text);
      el.textContent = p === null ? '' : `factor ×${pitchFactor(p).toFixed(3)}`;
    };
    show(factor1, space.pitch);
    show(factor2, space.pitch2);
  };

  const render = () => {
    cutoutAreas.clear();
    const typeInfo = SPACE_TYPES.find((t) => t.type === space.type)!;

    const totals = h(
      'div',
      { class: 'totals', 'aria-live': 'polite' },
      h('div', {}, h('span', { class: 'lbl' }, 'Gross'), gross),
      h('div', {}, h('span', { class: 'lbl' }, 'Cutouts'), cut),
      h('div', { class: 'net' }, h('span', { class: 'lbl' }, 'Net sq ft'), net),
    );

    const typePicker = h(
      'div',
      { class: 'seg', role: 'radiogroup', 'aria-label': 'Space type' },
      SPACE_TYPES.map((t) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(t.type === space.type),
            class: t.type === space.type ? `seg-btn selected t-${t.type}` : 'seg-btn',
            onclick: () => {
              if (t.type === space.type) return;
              space.type = t.type;
              render();
              edited();
            },
          },
          t.name,
        ),
      ),
    );

    const isWalls = space.type === 'crawl_walls';
    const extra =
      space.type === 'roofline'
        ? h(
            'section',
            { class: 'card' },
            h('h2', {}, 'Pitch'),
            h('div', { class: 'with-aside' }, field({ label: 'Roof pitch (rise / 12)', value: space.pitch, placeholder: 'e.g. 6/12', inputmode: 'decimal', oninput: (v) => { space.pitch = v; edited(); } }), factor1),
            h(
              'label',
              { class: 'toggle' },
              h('input', {
                type: 'checkbox',
                checked: space.twoSlope,
                onchange: (e: Event) => {
                  space.twoSlope = (e.target as HTMLInputElement).checked;
                  render();
                  edited();
                },
              }),
              h('span', {}, 'Two different slopes'),
            ),
            space.twoSlope
              ? [
                  h('div', { class: 'with-aside' }, field({ label: 'Second pitch (rise / 12)', value: space.pitch2, placeholder: 'e.g. 12/12', inputmode: 'decimal', oninput: (v) => { space.pitch2 = v; edited(); } }), factor2),
                  field({ label: '% of footprint at the first pitch', value: space.splitPct, inputmode: 'decimal', placeholder: '50', oninput: (v) => { space.splitPct = v; edited(); } }),
                ]
              : null,
            h('p', { class: 'hint' }, 'Roof area = footprint × pitch factor (√(1 + (rise/12)²)). Measure skylights and other cutouts on the roof surface.'),
          )
        : isWalls
          ? h(
              'section',
              { class: 'card' },
              h('h2', {}, 'Walls'),
              field({ label: 'Average wall height', value: space.wallHeight, placeholder: `e.g. 3'6"`, oninput: (v) => { space.wallHeight = v; edited(); } }),
              field({
                label: 'Perimeter (optional)',
                value: space.perimeter,
                placeholder: 'Leave blank to use the outline below',
                hint: 'Type the total wall run here, or draw the crawlspace outline below and its perimeter is used.',
                oninput: (v) => { space.perimeter = v; edited(); },
              }),
            )
          : null;

    const cutouts = h(
      'section',
      { class: 'card' },
      h('h2', {}, isWalls ? 'Vents and doors' : 'Cutouts'),
      h('p', { class: 'hint' }, isWalls ? 'Openings subtracted from the wall area.' : 'Areas that are not insulated: subtracted from the gross.'),
      space.cutouts.map((c, i) => {
        const area = h('span', { class: 'cutout-area' });
        cutoutAreas.set(c.id, area);
        const label = field({ label: 'Name', value: c.label, oninput: (v) => { c.label = v; changed(); } });
        return h(
          'div',
          { class: 'cutout' },
          h(
            'div',
            { class: 'cutout-head' },
            h('strong', {}, `#${i + 1}`),
            area,
            h('button', {
              type: 'button', class: 'btn icon danger', 'aria-label': `Remove ${c.label}`,
              onclick: () => {
                space.cutouts.splice(i, 1);
                render();
                edited();
              },
            }, '✕'),
          ),
          label,
          h(
            'div',
            { class: 'quick' },
            CUTOUT_PRESETS[space.type].map((name) =>
              h('button', {
                type: 'button', class: 'chip small',
                onclick: () => {
                  c.label = name;
                  (label.querySelector('input') as HTMLInputElement).value = name;
                  changed();
                },
              }, name),
            ),
          ),
          field({ label: 'How many', value: c.qty, inputmode: 'numeric', oninput: (v) => { c.qty = v; edited(); } }),
          shapeEditor(c.shape, edited, { compact: true }),
        );
      }),
      h('button', {
        type: 'button', class: 'btn block',
        onclick: () => {
          space.cutouts.push(newCutout(space.type));
          render();
          edited();
        },
      }, isWalls ? '+ Add vent or door' : '+ Add cutout'),
    );

    mount(
      root,
      topBar(space.name || 'Space', { href: `#/job/${job.id}`, label: 'Job' }),
      h(
        'main',
        { class: 'screen' },
        totals,
        basis,
        problems,
        h('section', { class: 'card' }, field({ label: 'Space name', value: space.name, oninput: (v) => { space.name = v; changed(); } }), typePicker, h('p', { class: 'hint' }, typeInfo.hint)),
        extra,
        h('section', { class: 'card' }, h('h2', {}, isWalls ? 'Crawlspace outline' : space.type === 'roofline' ? 'Footprint (plan view)' : 'Shape'), shapeEditor(space.shape, edited)),
        cutouts,
        h(
          'section',
          { class: 'card' },
          h('h2', {}, 'Photos and notes'),
          h('a', { class: 'btn block', href: `#/job/${job.id}/space/${space.id}/photos` }, `📷 Photos (${photos}/6)`),
          (() => {
            const ta = h('textarea', { rows: 3, placeholder: 'Access, existing insulation, hazards…' });
            ta.value = space.notes;
            ta.addEventListener('input', () => { space.notes = ta.value; changed(); });
            return h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Notes'), ta);
          })(),
        ),
        h('button', {
          type: 'button', class: 'btn danger block',
          onclick: async () => {
            if (!confirm(`Delete "${space.name}" and its photos?`)) return;
            job.spaces = job.spaces.filter((x) => x.id !== space.id);
            await deleteSpacePhotos(space.id);
            await flush();
            go(`#/job/${job.id}`);
          },
        }, 'Delete space'),
      ),
    );
    refresh();
  };

  render();
}
