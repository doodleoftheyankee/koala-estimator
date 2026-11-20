import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactTakeoff, FT_PER_M, MAP_SIZE, mapFrame, mapZoom, metersBetween, takeoffSchema } from './lookup';
import { mapShapes } from './draw';
import { HOUSE_CHIP, houseState, photoQuality, scaleBar, sourceLine } from './photo';

const house = (name: string) => compactTakeoff(takeoffSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', 'roof-takeoff', `${name}.json`), 'utf8'))));

describe('scaleBar', () => {
  it('is a round length in feet that matches the photo as shown', () => {
    for (const name of ['1-gable', '2-hip', '3-cross-gable', '5-twin', '8-main-row']) {
      const r = house(name);
      const k = mapShapes(r, []).magnify;
      const bar = scaleBar(r, k)!;
      expect([5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]).toContain(bar.feet);
      // The bar is the share of the shown photo that its feet take, from the map frame itself.
      const view = mapFrame(r.center, mapZoom(r.box));
      const feetAcross = (metersBetween(view.toLatLng(0, MAP_SIZE / 2), view.toLatLng(MAP_SIZE, MAP_SIZE / 2)) * FT_PER_M) / k;
      expect(bar.share).toBeCloseTo(bar.feet / feetAcross, 9);
      expect(bar.share).toBeGreaterThan(0.08);
      expect(bar.share).toBeLessThanOrEqual(0.25);
    }
  });

  it('gets shorter in feet when the photo is enlarged', () => {
    const r = house('3-cross-gable');
    const whole = scaleBar(r, 1)!;
    const enlarged = scaleBar(r, 2)!;
    expect(enlarged.feet).toBeLessThanOrEqual(whole.feet);
    expect(enlarged.feet / enlarged.share).toBeCloseTo(whole.feet / whole.share / 2, 6);
  });
});

describe('photo words', () => {
  it('says where the numbers come from and how sharp the photo is', () => {
    const r = house('3-cross-gable');
    expect(sourceLine({ imagery: { year: 2023, month: 6 } })).toBe('Aerial photo · Jun 2023');
    expect(sourceLine({ imagery: null })).toBe('Aerial photo · date unknown');
    expect(photoQuality({ quality: 'HIGH' })).toEqual({
      label: 'Sharp photo',
      tone: 'ok',
    });
    expect(photoQuality({ quality: 'MEDIUM' })).toEqual({
      label: 'Good photo',
      tone: 'draft',
    });
    expect(photoQuality({ quality: 'LOW' })).toEqual({
      label: 'Blurry photo: check on site',
      tone: 'warn',
    });
    expect(photoQuality({ quality: null })).toBeNull();
    expect(photoQuality(r)).not.toBeNull();
  });
});

describe('houseState', () => {
  it('asks only when Google placed the address roughly or a roof was tapped', () => {
    expect(houseState({ precision: 'ROOFTOP' }, false, false)).toBe('found');
    expect(houseState({ precision: 'RANGE_INTERPOLATED' }, false, false)).toBe('check');
    expect(houseState({ precision: 'PIN' }, false, false)).toBe('check');
    expect(houseState({ precision: 'PIN' }, true, false)).toBe('checked');
    expect(houseState({ precision: 'ROOFTOP' }, true, true)).toBe('tap');
    expect(Object.values(HOUSE_CHIP)).toEqual(['Tap the right roof', 'Check the house', 'Right house', 'House found']);
  });
});
