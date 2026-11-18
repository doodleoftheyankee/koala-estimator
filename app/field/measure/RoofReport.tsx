'use client';
// The printed roof takeoff: one letter page, on paper colours, put straight onto <body> so that in
// print it is the only thing shown (app/globals.css hides the rest of the app while it is there).
// On screen it is never seen. The aerial photo is painted with the outline, the edges and the face
// numbers onto a canvas and kept as an image, because a page's own drawing doesn't always print.
// Daymark on paper: ink on white (print is always the Day theme), gauge numerals for the numbers,
// sign labels for the heads, and the photo's lines on their ink casing, as on screen.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { pitchText, roundFt, roundSqft, type RoofResult } from '@/lib/roof/lookup';
import { COMPANY, EDGE_INFO, EDGES_NOT_MEASURED, oneDecimal, REPORT_FOOTER, reportFaceColumns, squaresLabel, type TakeoffData, type TakeoffFace } from '@/lib/roof/roofing';
import { edgeColor, MAP_COLORS, mapShapes, paintRoofMap, satelliteUrl } from '@/lib/roof/draw';
import { num } from '@/lib/format';

const comma = (n: number) => num(n);
const sqft = (n: number | null) => (n === null ? '–' : `${comma(roundSqft(n))} sq ft`);
/** The printed photo is 960 pixels square: sharp at about 3 inches wide. */
const PHOTO_PX = 960;


const noSubscribe = () => () => undefined;
/** True once on the phone (portals need the page's body). */
const useMounted = () =>
  useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );

/** The aerial photo with the outline, edges and face numbers, as an image; null until it is painted. */
function useReportPhoto(result: RoofResult, excluded: readonly number[]): string | null {
  const [photo, setPhoto] = useState<{ key: string; url: string } | null>(null);
  const key = `${satelliteUrl(result)}|${result.edges.length}|${excluded.join(',')}`;
  useEffect(() => {
    let live = true;
    const paint = async (img: HTMLImageElement | null) => {
      // The face numbers in the app's number face (Archivo), once it has loaded.
      await document.fonts?.ready;
      if (!live) return;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = PHOTO_PX;
      const g = canvas.getContext('2d');
      if (!g) return;
      const font = getComputedStyle(document.body).getPropertyValue('--f-num').trim() || undefined;
      paintRoofMap(g, PHOTO_PX, mapShapes(result, excluded), img, { font });
      try {
        setPhoto({ key, url: canvas.toDataURL('image/jpeg', 0.86) });
      } catch {
        // A photo the browser won't let us copy: the report goes without it.
      }
    };
    const img = new Image();
    img.onload = () => void paint(img);
    img.onerror = () => void paint(null);
    img.src = satelliteUrl(result);
    return () => {
      live = false;
    };
    // The key holds everything the picture depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return photo?.key === key ? photo.url : null;
}

export function RoofReport({ data, result, excluded }: { data: TakeoffData; result: RoofResult; excluded: readonly number[] }) {
  const mounted = useMounted();
  const photo = useReportPhoto(result, excluded);
  if (!mounted) return null;
  const shaded = result.faces.some((f) => excluded.includes(f.n));
  const nums: Array<[string, string, boolean?]> = [
    ['Attic floor', sqft(data.atticFloorSqft), true],
    ['Roof surface', sqft(data.roofSqft), true],
    ['Roof deck over the attic (spray foam)', sqft(data.deckSqft)],
    ['Footprint (to the drip edge)', sqft(data.footprintSqft)],
    ['Wall run', data.wallRunFt === null ? '–' : `${comma(roundFt(data.wallRunFt))} ft${data.wallRunRough ? ' (rough)' : ''}`],
    ...(data.lowSlopeSqft > 0 ? [['Low slope (under 2/12, not shingles)', sqft(data.lowSlopeSqft)] as [string, string]] : []),
    [squaresLabel(data), data.squares === null ? '–' : oneDecimal(data.squares)],
    [`Order with ${data.wastePct}% waste`, data.order ? `${data.order.text} sq · ${comma(data.order.bundles)} bundles` : data.roofSqft !== null ? 'No shingle area' : '–'],
    ['Main pitch', data.mainPitch === null ? '–' : pitchText(data.mainPitch)],
  ];
  const columns = reportFaceColumns(data.faces.length);
  const perColumn = Math.ceil(data.faces.length / columns);
  const faceTables = Array.from({ length: columns }, (_, i) => data.faces.slice(i * perColumn, (i + 1) * perColumn)).filter((f) => f.length);
  return createPortal(
    <div id="roof-report" className="roof-report" data-testid="roof-report">
      <header className="mb-2.5 border-b-[3px] border-solid border-ink pb-1.5">
        <p className="sign-label text-ink [--sign-size:8pt]">{COMPANY} · Roof takeoff</p>
        <h1 className="mt-0.5 text-[17pt] leading-tight font-extrabold tracking-[-0.01em] [overflow-wrap:anywhere]">{data.title}</h1>
        <p className="text-[8.5pt] text-ink-2">
          Looked up {data.lookedUp}. {data.photo}.
        </p>
      </header>

      <div className="roof-report-top mb-2.5 grid grid-cols-[3.1in_minmax(0,1fr)] items-start gap-4 [break-inside:avoid]">
        <figure className="m-0 space-y-1">
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element -- a painted data URL
            <img src={photo} alt="Aerial photo with the roof outline, the roof edges and the face numbers" className="block aspect-square w-full max-w-[3.1in] rounded-[4px] bg-frame" />
          ) : (
            <div className="flex aspect-square w-full max-w-[3.1in] items-center justify-center rounded-[4px] bg-draft-fill text-[8pt] text-ink-2">Aerial photo not loaded</div>
          )}
          <figcaption className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[7.5pt] text-ink-2">
            {result.outline.length ? <LegendItem color={MAP_COLORS.light} label="Outline" /> : null}
            {data.edges.map((e) => (
              <LegendItem key={e.type} color={edgeColor(e.type)} dash={Boolean(EDGE_INFO[e.type].dash)} label={e.label} />
            ))}
            {shaded ? (
              <span className="inline-flex items-center gap-1">
                <i
                  className="inline-block h-2 w-3 rounded-[1px]"
                  style={{ background: `repeating-linear-gradient(135deg, ${MAP_COLORS.light} 0 1.5px, ${MAP_COLORS.casing} 1.5px 4px)`, boxShadow: `0 0 0 1px ${MAP_COLORS.casing}` }}
                />
                Not over the attic
              </span>
            ) : null}
          </figcaption>
        </figure>
        <dl className="m-0 grid grid-cols-2 gap-x-3.5 gap-y-1.5">
          {nums.map(([label, value, big]) => (
            <div key={label} className="border-t border-solid border-line pt-0.5">
              <dt className="text-[8pt] text-ink-2">{label}</dt>
              <dd className={big ? 'gauge text-[24pt] leading-tight text-ink' : 'gauge-m text-[13pt] text-ink'}>{value}</dd>
            </div>
          ))}
          <div className="col-span-2 text-[7.5pt] text-ink-2">
            Attic floor: {data.atticNote} Roof surface: every face along the slope, overhangs included.
          </div>
        </dl>
      </div>

      {data.warnings.length ? (
        <div className="relative mb-2 overflow-hidden rounded-[4px] border border-solid border-ink py-1 pr-2 pl-3 text-[8pt] [break-inside:avoid]">
          <span aria-hidden className="hatch absolute inset-y-0 left-0 w-1.5" />
          <p className="font-extrabold">Check on site:</p>
          {data.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      ) : null}

      {data.faces.length ? (
        // Not kept in one piece: a long list carries on onto a second page instead of leaving a gap.
        <section className="mb-2">
          <h2 className="sign-label mb-1 text-ink [--sign-size:9.5pt]">Roof faces</h2>
          <div className="roof-report-faces grid items-start gap-x-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }} data-columns={columns}>
            {faceTables.map((faces) => (
              <FacesTable key={faces[0]!.n} faces={faces} compact={columns > 1} />
            ))}
          </div>
        </section>
      ) : null}

      {data.edgesMeasured ? (
        <div className="roof-report-two mb-2 grid grid-cols-2 gap-4 [break-inside:avoid]">
          <section>
            <h2 className="sign-label mb-1 text-ink [--sign-size:9.5pt]">Roof edges</h2>
            <table className="w-full border-collapse text-[8.5pt] tabular-nums">
              <thead>
                <tr className="border-b-2 border-solid border-ink text-left text-[7.5pt] tracking-wide text-ink-2 uppercase">
                  <th className="px-1 py-0.5 font-semibold">Edge</th>
                  <th className="px-1 py-0.5 text-right font-semibold">Feet</th>
                </tr>
              </thead>
              <tbody>
                {data.edges.map((e) => (
                  <tr key={e.type} className="border-b border-solid border-line">
                    <td className="px-1 py-0.5">{e.label}</td>
                    <td className="px-1 py-0.5 text-right">{comma(roundFt(e.ft))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-0.5 text-[7.5pt] text-ink-2">Along the slope.</p>
          </section>
          <section>
            <h2 className="sign-label mb-1 text-ink [--sign-size:9.5pt]">Materials</h2>
            <table className="w-full border-collapse text-[8.5pt] tabular-nums">
              <thead>
                <tr className="border-b-2 border-solid border-ink text-left text-[7.5pt] tracking-wide text-ink-2 uppercase">
                  <th className="px-1 py-0.5 font-semibold">Item</th>
                  <th className="px-1 py-0.5 font-semibold">From</th>
                  <th className="px-1 py-0.5 text-right font-semibold">Feet</th>
                </tr>
              </thead>
              <tbody>
                {data.materials.map((m) => (
                  <tr key={m.item} className="border-b border-solid border-line">
                    <td className="px-1 py-0.5">{m.item}</td>
                    <td className="px-1 py-0.5">{m.from}</td>
                    <td className="px-1 py-0.5 text-right">{comma(m.ft)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-0.5 text-[7.5pt] text-ink-2">Rounded up to the next foot. Estimates from aerial data: check on site before ordering.</p>
          </section>
        </div>
      ) : (
        <section className="mb-2">
          <h2 className="sign-label mb-1 text-ink [--sign-size:9.5pt]">Roof edges</h2>
          <p className="text-[8.5pt] text-ink-2">{EDGES_NOT_MEASURED}</p>
        </section>
      )}

      <footer className="mt-2.5 flex flex-wrap justify-between gap-3 border-t-2 border-solid border-ink pt-1 text-[9pt] font-bold">
        <span>{REPORT_FOOTER}</span>
        <span className="font-medium text-ink-2">
          {COMPANY} · Overhang used: {data.overhangIn ? `${data.overhangIn}"` : 'none'}
        </span>
      </footer>
    </div>,
    document.body,
  );
}

/** One table of roof faces; `compact` (side by side) uses shorter words. */
function FacesTable({ faces, compact }: { faces: readonly TakeoffFace[]; compact: boolean }) {
  return (
    <table className={`w-full border-collapse tabular-nums ${compact ? 'text-[7.5pt]' : 'text-[8.5pt]'}`}>
      <thead>
        <tr className="border-b-2 border-solid border-ink text-left text-[7.5pt] tracking-wide text-ink-2 uppercase">
          <th className="px-1 py-0.5 font-semibold">Face</th>
          <th className="px-1 py-0.5 font-semibold">Pitch</th>
          <th className="px-1 py-0.5 font-semibold">{compact ? 'Faces' : 'Direction'}</th>
          <th className="px-1 py-0.5 text-right font-semibold">{compact ? 'Sq ft' : 'Sq ft (along the slope)'}</th>
          <th className="px-1 py-0.5 font-semibold">{compact ? 'Attic' : 'Over the attic'}</th>
        </tr>
      </thead>
      <tbody>
        {faces.map((f) => (
          <tr key={f.n} className="border-b border-solid border-line">
            <td className="px-1 py-0.5">{f.n}</td>
            <td className="px-1 py-0.5">
              {f.pitch}
              {f.lowSlope ? (compact ? ' low' : ' (low slope)') : ''}
            </td>
            <td className="px-1 py-0.5">{compact ? f.direction.replace(/^faces /, '') : f.direction}</td>
            <td className="px-1 py-0.5 text-right">{comma(roundSqft(f.sqft))}</td>
            <td className="px-1 py-0.5">{f.overAttic ? 'Yes' : 'No'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LegendItem({ color, label, dash }: { color: string; label: string; dash?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <i
        className="inline-block h-1.5 w-3.5 rounded-sm"
        style={{ background: dash ? `repeating-linear-gradient(90deg, ${color} 0 3px, ${MAP_COLORS.casing} 3px 5px)` : color, boxShadow: `0 0 0 1px ${MAP_COLORS.casing}` }}
      />
      {label}
    </span>
  );
}
