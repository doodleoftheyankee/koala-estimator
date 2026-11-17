import { describe, expect, it } from 'vitest';
import {
  clampPt,
  fmt1,
  loupeFor,
  nearestPoint,
  photoFileProblem,
  photoOpenFailed,
  pitchCheck,
  pitchChoices,
  pitchDegrees,
  pitchFacts,
  pitchFrom,
  pitchHint,
  PITCH_TIPS,
  shrunkSize,
  SIDES_AGREE,
  type PitchReading,
  type Pt,
} from './pitchPhoto';

/** A reading that has to be good, for the tests that check its numbers. */
function good(r: PitchReading) {
  if (r.bad) throw new Error('expected a reading');
  return r;
}

/** Turns points about a centre, like a phone held at an angle. */
const rotate = (pts: Pt[], deg: number, c: Pt = { x: 600, y: 400 }): Pt[] => {
  const a = (deg * Math.PI) / 180;
  return pts.map((p) => ({ x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a), y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a) }));
};

// A 6/12 gable on a level photo: 600 px between the eave corners, the peak 150 px up in the middle.
const L: Pt = { x: 300, y: 500 };
const P: Pt = { x: 600, y: 350 };
const R: Pt = { x: 900, y: 500 };

describe('pitchFrom', () => {
  it('reads a level gable: rise over half the span, both sides the same', () => {
    const r = good(pitchFrom(L, P, R));
    expect(r.pitch).toBeCloseTo(6, 9);
    expect(r.left).toBeCloseTo(6, 9);
    expect(r.right).toBeCloseTo(6, 9);
    expect(r.foot.x).toBeCloseTo(600, 9);
    expect(r.foot.y).toBeCloseTo(500, 9);
  });

  it.each([-25, -8, 3, 12, 40])('ignores a phone tilted %i°: the eave-to-eave line sets level', (deg) => {
    const [l, p, q] = rotate([L, P, R], deg);
    const r = good(pitchFrom(l!, p!, q!));
    expect(r.pitch).toBeCloseTo(6, 9);
    expect(r.left).toBeCloseTo(6, 9);
    expect(r.right).toBeCloseTo(6, 9);
    // The plumb foot turns with the photo: still halfway between the corners.
    expect(r.foot.x).toBeCloseTo((l!.x + q!.x) / 2, 9);
    expect(r.foot.y).toBeCloseTo((l!.y + q!.y) / 2, 9);
  });

  it('a tilted photo of a 9/12 gable still reads 9/12', () => {
    const pts = rotate([{ x: 200, y: 600 }, { x: 500, y: 375 }, { x: 800, y: 600 }], 7.5);
    expect(good(pitchFrom(pts[0]!, pts[1]!, pts[2]!)).pitch).toBeCloseTo(9, 9);
  });

  it('reads unequal sides on their own, and the whole gable from the full span', () => {
    // Peak 200 px from the left corner and 400 px from the right one, 100 px up.
    const r = good(pitchFrom({ x: 0, y: 300 }, { x: 200, y: 200 }, { x: 600, y: 300 }));
    expect(r.left).toBeCloseTo(6, 9);
    expect(r.right).toBeCloseTo(3, 9);
    expect(r.pitch).toBeCloseTo(4, 9);
    expect(pitchCheck(r).tone).toBe('warn');
  });

  it("doesn't depend on the photo's size", () => {
    const big = good(pitchFrom({ x: L.x * 3, y: L.y * 3 }, { x: P.x * 3, y: P.y * 3 }, { x: R.x * 3, y: R.y * 3 }));
    expect(big.pitch).toBeCloseTo(6, 9);
  });

  it('reads the peak on either side of the eave line (an upside-down photo)', () => {
    expect(good(pitchFrom(L, { x: 600, y: 650 }, R)).pitch).toBeCloseTo(6, 9);
  });

  it.each<[string, Pt, Pt, Pt]>([
    ['the same point three times', L, L, L],
    ['eave corners under 4 px apart', { x: 100, y: 100 }, { x: 101, y: 50 }, { x: 103, y: 100 }],
    ['the peak on the eave line', L, { x: 600, y: 500 }, R],
    ['the peak under 1 px off the eave line', L, { x: 600, y: 500.9 }, R],
    ['the peak straight above the left corner', L, { x: 300, y: 350 }, R],
    ['the peak past the left corner', L, { x: 250, y: 350 }, R],
    ['the peak straight above the right corner', L, { x: 900, y: 350 }, R],
    ['the peak past the right corner', L, { x: 950, y: 350 }, R],
  ])("isn't a roof triangle: %s", (_, l, p, r) => {
    const reading = pitchFrom(l, p, r);
    expect(reading.bad).toBe(true);
    expect(pitchCheck(reading)).toEqual({
      tone: 'bad',
      text: "Those points don't make a roof triangle. The peak has to sit above and between the two corners.",
      short: 'Move the points to make a roof triangle.',
    });
  });

  it('reads corners tapped right to left too, with the sides swapped', () => {
    const r = good(pitchFrom({ x: 600, y: 300 }, { x: 200, y: 200 }, { x: 0, y: 300 }));
    expect(r.pitch).toBeCloseTo(4, 9);
    expect(r.left).toBeCloseTo(3, 9);
    expect(r.right).toBeCloseTo(6, 9);
  });

  it('a nearly flat roof still reads', () => {
    expect(good(pitchFrom(L, { x: 600, y: 498 }, R)).pitch).toBeCloseTo(0.08, 9);
  });
});

describe('pitchCheck', () => {
  const reading = (left: number, right: number): PitchReading => ({ bad: false, pitch: (left + right) / 2, left, right, foot: { x: 0, y: 0 } });

  it('waits for three points', () => {
    expect(pitchCheck(null)).toEqual({ tone: 'idle', text: 'Tap three points to read the pitch.', short: 'Tap the three points first.' });
  });

  it('agrees under 0.75/12 apart', () => {
    expect(SIDES_AGREE).toBe(0.75);
    expect(pitchCheck(reading(6, 6))).toEqual({ tone: 'ok', text: 'Both sides agree. A phone tipped back reads low on both sides, so shoot with it upright.', short: '✓ Both sides agree.' });
    expect(pitchCheck(reading(6, 6.74)).tone).toBe('ok');
    expect(pitchCheck(reading(6.74, 6)).tone).toBe('ok');
  });

  it('asks for a retake at 0.75/12 apart or more, naming both sides', () => {
    expect(pitchCheck(reading(6, 6.75))).toEqual({
      tone: 'warn',
      text: 'Sides read 6.0/12 and 6.8/12. Retake from straight in front, unless this gable really has unequal sides.',
      short: "The sides don't agree. Retake from straight in front?",
    });
    expect(pitchCheck(reading(8.2, 5.1)).text).toBe('Sides read 8.2/12 and 5.1/12. Retake from straight in front, unless this gable really has unequal sides.');
  });
});

describe('pitchFacts and pitchChoices', () => {
  it('shows the pitch and sides to one decimal, the angle and the pitch factor', () => {
    expect(pitchFacts(good(pitchFrom(L, P, R)))).toEqual({ pitch: '6.0', degrees: '26.6', factor: '1.118', left: '6.0', right: '6.0' });
    expect(pitchDegrees(12)).toBeCloseTo(45, 9);
    expect(fmt1(6.25)).toBe('6.3');
    expect(fmt1(0)).toBe('0.0');
  });

  it.each<[number, string, string | null]>([
    [6.3, '6/12', '6.3/12'],
    [6, '6/12', null],
    [6.04, '6/12', null],
    [5.96, '6/12', null],
    [6.5, '7/12', '6.5/12'],
    [6.45, '6/12', '6.5/12'],
    [11.7, '12/12', '11.7/12'],
    [0.3, '0/12', '0.3/12'],
  ])('%f → Use %s, and %s as measured', (pitch, rounded, measured) => {
    expect(pitchChoices(pitch)).toEqual({ rounded, measured });
  });
});

describe('pitchHint', () => {
  it('walks through the three taps, then says how to fine-tune', () => {
    // Each tap names the edge, so the peak and the corners are taken on the same one.
    expect(pitchHint(0)).toEqual({ step: 'Tap 1 of 3', text: 'the left eave corner, on the top edge of the rake trim.' });
    expect(pitchHint(1)).toEqual({ step: 'Tap 2 of 3', text: 'the peak, on that same edge.' });
    expect(pitchHint(2)).toEqual({ step: 'Tap 3 of 3', text: 'the right eave corner, on the same edge.' });
    expect(pitchHint(3)).toEqual({ step: null, text: 'Drag any point to fine-tune it. A magnifier shows while you drag.' });
  });
});

describe('photo handling', () => {
  it('shrinks big photos to 2400 px on the long side and never enlarges', () => {
    expect(shrunkSize(4032, 3024)).toEqual({ width: 2400, height: 1800 });
    expect(shrunkSize(3024, 4032)).toEqual({ width: 1800, height: 2400 });
    expect(shrunkSize(1200, 800)).toEqual({ width: 1200, height: 800 });
    expect(shrunkSize(2400, 10)).toEqual({ width: 2400, height: 10 });
    expect(shrunkSize(48000, 10)).toEqual({ width: 2400, height: 1 });
  });

  it('turns away files that are not photos, and lets unknown types try', () => {
    expect(photoFileProblem({ type: 'application/pdf', name: 'plan.pdf' })).toMatch(/isn't a photo/);
    expect(photoFileProblem({ type: 'image/jpeg', name: 'a.jpg' })).toBeNull();
    expect(photoFileProblem({ type: '', name: 'IMG_0001.HEIC' })).toBeNull();
  });

  it('explains HEIC photos the browser cannot open, by type or by name', () => {
    for (const f of [{ type: 'image/heic', name: 'x' }, { type: 'image/heif', name: 'x' }, { type: '', name: 'IMG_0001.HEIC' }, { type: '', name: 'a.heif' }]) {
      expect(photoOpenFailed(f)).toMatch(/^This browser can't open HEIC photos/);
    }
    expect(photoOpenFailed({ type: 'image/jpeg', name: 'a.jpg' })).toBe("Couldn't open that photo. Try another one, or take a new photo.");
  });
});

describe('dragging points', () => {
  const pts: Pt[] = [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 90, y: 10 }];

  it('finds the nearest point within reach', () => {
    expect(nearestPoint(pts, { x: 48, y: 14 }, 26)).toBe(1);
    expect(nearestPoint(pts, { x: 31, y: 10 }, 26)).toBe(1);
    expect(nearestPoint(pts, { x: 30, y: 60 }, 26)).toBe(-1);
    expect(nearestPoint([], { x: 0, y: 0 }, 26)).toBe(-1);
  });

  it('keeps points on the photo', () => {
    expect(clampPt({ x: -5, y: 900 }, 800, 600)).toEqual({ x: 0, y: 600 });
    expect(clampPt({ x: 20, y: 30 }, 800, 600)).toEqual({ x: 20, y: 30 });
  });

  it('puts the magnifier in the top corner away from the point, at 4× zoom', () => {
    const photo = { width: 1200, height: 800 };
    // A 360 px board showing the 1200 px photo: 0.3 screen px per photo px.
    const right = loupeFor({ x: 900, y: 400 }, photo, 360, 0.3);
    expect(right.r).toBe(66);
    expect(right.cx).toBe(78);
    expect(right.cy).toBe(78);
    expect(right.scale).toBeCloseTo(1.2, 9);
    expect(right.src).toEqual({ x: 900 - 55, y: 400 - 55, w: 110, h: 110 });
    expect(right.dst).toEqual({ x: 12, y: 12, w: 132, h: 132 });
    const left = loupeFor({ x: 100, y: 400 }, photo, 360, 0.3);
    expect(left.cx).toBe(360 - 66 - 12);
    // A small board keeps a 40 px magnifier.
    expect(loupeFor({ x: 100, y: 400 }, photo, 150, 0.125).r).toBe(40);
  });

  it('shows only the part of the photo there is near its edges', () => {
    const photo = { width: 1200, height: 800 };
    const corner = loupeFor({ x: 0, y: 0 }, photo, 360, 0.3);
    expect(corner.src).toEqual({ x: 0, y: 0, w: 55, h: 55 });
    // The photo's corner sits at the magnifier's centre; the empty part is left dark.
    expect(corner.dst.x).toBeCloseTo(corner.cx, 9);
    expect(corner.dst.y).toBeCloseTo(corner.cy, 9);
    expect(corner.dst.w).toBeCloseTo(66, 9);
    expect(corner.dst.h).toBeCloseTo(66, 9);
    const far = loupeFor({ x: 1200, y: 800 }, photo, 360, 0.3);
    expect(far.src).toEqual({ x: 1145, y: 745, w: 55, h: 55 });
    expect(far.dst.w).toBeCloseTo(66, 9);
  });
});

describe('tips', () => {
  // A camera tipped back to fit a gable in: the rise is foreshortened more than the run, so the
  // pitch reads low, the same on both sides (so "Both sides agree" can't catch it). Pinhole camera
  // 5 ft up, aimed at the middle of a 24 ft wide 6/12 gable with its eaves 20 ft up, 25 ft away.
  const project = (tipDeg: number) => (x: number, y: number) => {
    const t = (tipDeg * Math.PI) / 180;
    const [dy, dz] = [y - 5, 25];
    const zc = dz * Math.cos(t) + dy * Math.sin(t);
    const yc = dy * Math.cos(t) - dz * Math.sin(t);
    return { x: (1000 * x) / zc, y: (-1000 * yc) / zc };
  };
  it('a phone tipped back reads low on both sides, which is why the tips say to hold it upright', () => {
    const level = project(0);
    const upright = good(pitchFrom(level(-12, 20), level(0, 26), level(12, 20)));
    expect(upright.pitch).toBeCloseTo(6, 6);
    const tipped = project(Math.atan2(23 - 5, 25) * (180 / Math.PI));
    const read = good(pitchFrom(tipped(-12, 20), tipped(0, 26), tipped(12, 20)));
    expect(read.pitch).toBeLessThan(5);
    expect(pitchCheck(read).tone).toBe('ok');
    expect(PITCH_TIPS.join(' ')).toMatch(/upright, not tipped back/);
    expect(PITCH_TIPS.join(' ')).not.toMatch(/Tilting the phone is fine/);
  });
});
