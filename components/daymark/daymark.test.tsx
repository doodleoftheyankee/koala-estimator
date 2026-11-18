// Hi-vis is 1.06:1 on chalk and 1.24:1 on white, so it vanishes without its ink edge. These tests
// check the components draw that edge themselves, inline, so no className or style passed in by a
// screen can take it away. They also check the status vocabulary stays one vocabulary.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, ButtonLink, buttonClass } from './Button';
import { Chip } from './Chip';
import { ChipGroup, ReadoutTiles, Segmented, StatusBoard } from './choice';
import { Banner } from './Banner';
import { JOB_BADGE_STATUSES, QUOTE_STATUSES, STATUS_META, StatusBadge, jobBadgeStatus } from './StatusBadge';
import { Button as LegacyButton, Chips as LegacyChips } from '../ui';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => undefined;

describe('hi-vis always carries its ink edge', () => {
  it('primary buttons set the edge inline, even when a screen tries to remove it', () => {
    const out = html(
      <Button variant="primary" className="border-0 border-transparent" style={{ border: 'none', borderWidth: 0 }}>
        Use it
      </Button>,
    );
    expect(out).toContain('border-width:var(--bw-go)');
    expect(out).toContain('border-color:var(--hivis-edge)');
    expect(out).toContain('border-style:solid');
    expect(out).toContain('bg-hivis');
    expect(out).toContain('text-on-hivis');
  });

  it('the legacy ui.tsx primary is the register main action, its edge set inline', () => {
    const out = html(<LegacyButton className="border-0">Save</LegacyButton>);
    expect(out).toContain('border-width:var(--bw-go)');
    expect(out).toContain('border-color:var(--main-edge)');
    expect(out).toContain('bg-[var(--main-fill)]');
  });

  it('button links get the edge too', () => {
    const out = html(
      <ButtonLink href="/field" variant="primary" style={{ borderWidth: 0 }}>
        New estimate
      </ButtonLink>,
    );
    expect(out).toContain('border-width:var(--bw-go)');
    expect(out).toContain('border-color:var(--hivis-edge)');
  });

  it('a disabled primary drops the hi-vis (and so its edge) and stays readable', () => {
    const out = html(
      <Button variant="primary" disabled>
        Use it
      </Button>,
    );
    expect(out).not.toContain('bg-hivis');
    expect(out).toContain('bg-draft-fill');
    expect(out).toContain('text-ink-2');
  });

  it('buttonClass carries the edge classes for elements that are not buttons', () => {
    expect(buttonClass({ variant: 'primary' })).toMatch(/border-\[length:var\(--bw-go\)\].*border-hivis-edge/);
  });

  it('chosen chips, segments, tiles and board cells set the chosen fill and edge inline', () => {
    const outs = [
      html(
        <Chip selected className="border-0" style={{ border: 'none' }}>
          Air seal
        </Chip>,
      ),
      html(<ChipGroup label="Access" value="a" onChange={noop} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />),
      html(<LegacyChips label="Access" value="a" onChange={noop} options={[{ value: 'a', label: 'A' }]} />),
      html(<Segmented label="Overhang" value="a" onChange={noop} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />),
      html(<StatusBoard label="Show" value="a" onChange={noop} cells={[{ value: 'a', count: 'x', label: 'All' }]} />),
      html(<ReadoutTiles label="Area" value="a" onChange={noop} options={[{ value: 'a', label: 'Attic floor', gauge: 'x' }]} />),
    ];
    for (const out of outs) {
      expect(out).toContain('background-color:var(--chosen-fill)');
      expect(out).toMatch(/var\(--chosen-edge\)/);
      expect(out).toMatch(/var\(--bw-go\)/);
    }
  });

  it('unchosen options carry no hi-vis', () => {
    const out = html(<Segmented label="Overhang" value={null} onChange={noop} options={[{ value: 'a', label: 'A' }]} />);
    expect(out).not.toContain('chosen-fill');
    expect(out).toContain('aria-checked="false"');
  });
});

describe('hazard always comes with an icon and a word', () => {
  it('draws the hatch, an icon and the title', () => {
    const out = html(<Banner tone="hazard" title="Offline." layout="bar" />);
    expect(out).toContain('hatch');
    expect(out).toContain('<svg');
    expect(out).toContain('Offline.');
  });
});

describe('one status vocabulary', () => {
  it('has the seven quote statuses and the job statuses, each with an icon, a word and a tone', () => {
    expect(QUOTE_STATUSES).toEqual(['draft', 'sent', 'viewed', 'signed', 'declined', 'expired', 'lost']);
    expect(JOB_BADGE_STATUSES).toHaveLength(7);
    const words = new Set<string>();
    for (const s of [...QUOTE_STATUSES, ...JOB_BADGE_STATUSES]) {
      const m = STATUS_META[s];
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.icon).toBeTruthy();
      words.add(m.label);
      const out = html(<StatusBadge status={s} />);
      expect(out).toContain('<svg');
      expect(out).toContain(m.label);
    }
    expect(words.size).toBe(14); // no word means two things
    expect(STATUS_META.signed.tone).toBe('signed'); // the only solid tag
  });

  it('maps the job statuses in lib/jobs/status.ts', () => {
    expect(jobBadgeStatus({ status: 'scheduled', scheduledStart: '2026-11-20' })).toBe('job.scheduled');
    expect(jobBadgeStatus({ status: 'scheduled', scheduledStart: null })).toBe('job.to_schedule');
    expect(jobBadgeStatus({ status: 'in_progress' })).toBe('job.in_progress');
    expect(jobBadgeStatus({ status: 'completed' })).toBe('job.completed');
    expect(jobBadgeStatus({ status: 'completed', actualsCount: 3, verifiedCount: 1 })).toBe('job.needs_check');
    expect(jobBadgeStatus({ status: 'completed', actualsCount: 3, verifiedCount: 3 })).toBe('job.verified');
    expect(jobBadgeStatus({ status: 'cancelled' })).toBe('job.cancelled');
  });
});
