// Messages. One semantic scale: info = blue, ok = green, warn (needs your action) = amber,
// bad (error, conflict) = red, hazard = "look again" (unsynced, offline, check on site).
// Every banner has an icon and words; hazard always has the hatch, an icon AND a title word,
// because hi-vis and hazard yellow are close for some colour-vision types.
//
//   <Banner tone="bad" title="No roof found at 99 Crawl Ln." action={<Button>Tap the roof</Button>} />
//   <Banner tone="hazard" title="Offline." layout="bar">Saving on this phone. 2 will sync.</Banner>
//   <HazardNote title="Check on site.">Finished attic rooms are not in these numbers.</HazardNote>
import type { ReactNode } from 'react';
import { cx } from './cx';
import { CircleCheck, CloudOff, Icon, Info, OctagonAlert, TriangleAlert, type LucideIcon } from './icons';

export type BannerTone = 'info' | 'ok' | 'warn' | 'bad' | 'hazard';

const TONE: Record<BannerTone, { box: string; title: string; icon: LucideIcon }> = {
  info: { box: 'bg-info-fill border-info', title: 'text-info', icon: Info },
  ok: { box: 'bg-ok-fill border-ok', title: 'text-ok', icon: CircleCheck },
  warn: { box: 'bg-warn-fill border-warn', title: 'text-warn', icon: TriangleAlert },
  bad: { box: 'bg-bad-fill border-bad', title: 'text-bad', icon: OctagonAlert },
  hazard: { box: 'bg-warn-fill border-edge', title: 'text-warn', icon: TriangleAlert },
};

type Common = {
  children?: ReactNode;
  /** A button or link for the next step. */
  action?: ReactNode;
  /** box: a rounded box in the page. bar: full width under a header (offline). */
  layout?: 'box' | 'bar';
  /** Replace the tone's icon (hazard: CloudOff for offline, CloudUpload for unsynced). */
  icon?: LucideIcon;
  className?: string;
  id?: string;
  /** Announce it (role alert for bad, status otherwise). Default true; false for static text. */
  live?: boolean;
};

export type BannerProps =
  | (Common & { tone: 'hazard'; /** Required for hazard: the word that goes with the hatch. */ title: ReactNode })
  | (Common & { tone?: Exclude<BannerTone, 'hazard'>; title?: ReactNode });

export function Banner({ tone = 'info', title, children, action, layout = 'box', icon, className, id, live = true }: BannerProps) {
  const t = TONE[tone];
  const hazard = tone === 'hazard';
  return (
    <div
      id={id}
      role={live ? (tone === 'bad' ? 'alert' : 'status') : undefined}
      className={cx(
        'relative flex flex-wrap items-start gap-x-3 gap-y-2 border-solid text-[15.5px] leading-snug text-ink',
        t.box,
        layout === 'box' ? 'rounded-control border-[length:var(--bw)] px-3.5 py-3' : 'border-b-[length:var(--bw)] px-4 py-3',
        hazard && (layout === 'box' ? 'overflow-hidden pl-7' : 'pl-8'),
        className,
      )}
    >
      {hazard ? <span aria-hidden className="hatch absolute inset-y-0 left-0 w-2.5" /> : null}
      <span className={cx('mt-px', t.title)}>
        <Icon icon={icon ?? (hazard && layout === 'bar' ? CloudOff : t.icon)} />
      </span>
      <div className="min-w-0 flex-1 basis-48">
        {title ? <p className={cx('font-extrabold', t.title)}>{title}</p> : null}
        {children ? <div className={cx(title ? 'mt-0.5' : '', 'font-medium')}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** A "look again" note beside a 6px hatch bar: always with an icon and a bold first word. */
export function HazardNote({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <p className={cx('relative flex gap-2.5 pl-4 text-[15.5px] leading-snug font-semibold text-ink', className)}>
      <span aria-hidden className="hatch absolute inset-y-0 left-0 w-1.5 rounded-sm" />
      <span className="mt-px text-warn">
        <Icon icon={TriangleAlert} size="s" />
      </span>
      <span>
        <strong className="font-extrabold">{title}</strong> {children}
      </span>
    </p>
  );
}
