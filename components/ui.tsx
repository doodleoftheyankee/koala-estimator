// The original small UI kit, now drawn in Daymark (components/daymark). The exported API is
// unchanged so every screen picks up the look at once; new code should import from
// '@/components/daymark', which has more variants (ink, go-sized buttons, gauges, tags, banners).
import type { ComponentProps, ReactNode } from 'react';
import { Banner, type BannerTone } from './daymark/Banner';
import { Button as DmButton, type ButtonVariant } from './daymark/Button';
import { Card as DmCard } from './daymark/Card';
import { ChipGroup } from './daymark/choice';
import { cx } from './daymark/cx';
import { SwitchRow } from './daymark/Form';
import { Tag, type TagTone } from './daymark/StatusBadge';

export { Field, Input, Select, Textarea } from './daymark/Form';
export { cx };

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANT: Record<Variant, ButtonVariant> = { primary: 'main', secondary: 'secondary', ghost: 'ghost', danger: 'danger' };

/**
 * primary = the register's main action: hi-vis with its ink edge on field screens, ink on quiet
 * (office, quote) screens, where today's pages may still show several. Converted screens choose
 * the one hi-vis action with <Button variant="primary"> from components/daymark.
 * secondary = surface with an ink edge, ghost = no edge, danger = quiet red.
 * Sizes: sm 48px, md 56px (48 in the quiet register), lg 64px (56).
 */
export function Button({ variant = 'primary', size = 'md', ...props }: ComponentProps<'button'> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  return <DmButton variant={VARIANT[variant]} size={size} {...props} />;
}

/** Single-choice chips; easier than a dropdown on a phone. */
export function Chips<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return <ChipGroup label={label} value={value} options={options} onChange={onChange} />;
}

/** A row that is one big switch, with ON or OFF written in the switch. */
export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return <SwitchRow checked={checked} onChange={onChange} label={label} hint={hint} />;
}

/** A plate: surface, edge, 16px radius, padded. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <DmCard className={className}>{children}</DmCard>;
}

type Tone = 'slate' | 'green' | 'amber' | 'red' | 'blue';
const TAG_TONE: Record<Tone, TagTone> = { slate: 'draft', green: 'ok', amber: 'warn', red: 'bad', blue: 'info' };

/** A small tag in a fixed tone. Prefer StatusBadge (components/daymark) for quote and job status. */
export function Badge({ tone = 'slate', children }: { tone?: Tone; children: ReactNode }) {
  return <Tag tone={TAG_TONE[tone]}>{children}</Tag>;
}

const BANNER_TONE: Record<'amber' | 'red' | 'blue' | 'green', Exclude<BannerTone, 'hazard'>> = { amber: 'warn', red: 'bad', blue: 'info', green: 'ok' };

/** A message box with an icon. amber = needs your action, red = error, blue = info, green = done. */
export function Alert({ tone = 'amber', children }: { tone?: 'amber' | 'red' | 'blue' | 'green'; children: ReactNode }) {
  return (
    <Banner tone={BANNER_TONE[tone]} live={false}>
      {children}
    </Banner>
  );
}
