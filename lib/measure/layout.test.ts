import { describe, expect, it } from 'vitest';
import { solveShape } from './geometry';
import { layoutShape } from './layout';

const shape = (kind: 'rect' | 'L' | 'U', dims: Record<string, string>) => {
  const r = solveShape({ kind, dims });
  if (!r.ok) throw new Error(r.errors.join(' '));
  return r.shape;
};

describe('layoutShape', () => {
  it('labels lettered sides and runs steep-side labels vertically', () => {
    const { path, labels } = layoutShape(shape('rect', { A: '40', B: '30' }));
    expect(path.startsWith('M')).toBe(true);
    const texts = labels.map((l) => l.text);
    expect(texts).toContain(`A 40'`);
    expect(texts).toContain(`B 30'`);
    expect(labels.find((l) => l.text === `B 30'`)!.vertical).toBe(true);
    // The other two sides mirror A and B, so they're left unlabelled.
    expect(labels).toHaveLength(2);
  });

  it('keeps labels in tight notches from overlapping', () => {
    const { labels } = layoutShape(shape('U', { A: '40', B: '30', C: '14', D: '12' }));
    const boxes = labels.map((l) => {
      const w = l.text.length * 7.6, h = 15;
      return l.vertical ? [l.x - h / 2, l.y - w / 2, l.x + h / 2, l.y + w / 2] : [l.x - w / 2, l.y - h / 2, l.x + w / 2, l.y + h / 2];
    });
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i]!, boxes[j]!];
        expect(a[0]! < b[2]! && a[2]! > b[0]! && a[1]! < b[3]! && a[3]! > b[1]!).toBe(false);
      }
  });
});
