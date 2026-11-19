// /design: the living Daymark system sheet, for staff (owner and office). Every token and
// component in Day, Night and Sun+, in the field and quiet registers. Not linked from customer
// pages. The sample figures come from the engines (the roof fixture through lib/roof, the
// placeholder pricing fixture through lib/pricing), never typed in.
import type { Metadata } from 'next';
import fixture from '@/lib/roof/__fixtures__/takeoff.json';
import { feet, formatMoney, inches, num, TIER_LABELS } from '@/lib/format';
import { monthlyPayment, priceEstimate } from '@/lib/pricing';
import { area, coefficients, estimate, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { compactTakeoff, DEFAULT_OVERHANG_IN, defaultFaces, OVERHANG_CHOICES, pitchText, roofFigures, roundFt, roundSqft, takeoffSchema } from '@/lib/roof/lookup';
import { requireRole } from '@/lib/server/auth';
import { DesignSheet, type DesignSamples } from './DesignSheet';

export const metadata: Metadata = { title: 'Design system', robots: { index: false, follow: false } };

function samples(): DesignSamples {
  const roof = compactTakeoff(takeoffSchema.parse(structuredClone(fixture)));
  const fig = roofFigures(roof, { overhangIn: DEFAULT_OVERHANG_IN, ...defaultFaces(roof, 'house') });
  // An attic with old insulation in place, so all three sample options step up (OD6).
  const priced = priceEstimate(estimate({ areas: [area({ currentR: 19 })] }), snapshot, coefficients);
  const fin = snapshot.settings.financing;
  return {
    floor: num(roundSqft(fig.floorSqft)),
    deck: fig.deckSqft === null ? '—' : num(roundSqft(fig.deckSqft)),
    pitch: fig.mainPitch === null ? '—' : pitchText(fig.mainPitch),
    wallRun: fig.wallRunFt === null ? '—' : feet(roundFt(fig.wallRunFt)),
    facesAll: num(roof.segments.length),
    facesKept: num(fig.facesKept),
    facesOut: num(roof.segments.length - fig.facesKept),
    facesAllValue: roof.segments.length,
    facesKeptValue: fig.facesKept,
    overhangs: OVERHANG_CHOICES.map((n) => ({ value: String(n), label: n === 0 ? 'None' : inches(n, 0) })),
    defaultOverhang: String(DEFAULT_OVERHANG_IN),
    tiers: priced.options.map((o) => ({
      tier: o.tier,
      label: TIER_LABELS[o.tier],
      title: o.label,
      price: formatMoney(o.price),
      monthly: fin.show ? formatMoney(monthlyPayment(o.price, fin.apr, fin.termMonths)) : null,
      priceValue: o.price,
    })),
    termMonths: num(fin.termMonths),
  };
}

export default async function DesignPage() {
  await requireRole('owner', 'office');
  return <DesignSheet samples={samples()} />;
}
