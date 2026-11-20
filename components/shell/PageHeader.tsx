// A page's title row inside the app shell: an optional back link ("‹ Jobs"), the title (the page's
// one <h1>), an optional line under it, and an actions slot (right of the title on desktops,
// under it on phones).
//
//   <PageHeader title="Jobs" description="Assign a crew and a date…" actions={<ButtonLink …/>} />
//   <PageHeader back={{ href: '/jobs', label: 'Jobs' }} title={job.customer.name} meta={<StatusBadge …/>} />
//
// Works in server and client components (no hooks).
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cx } from '../daymark/cx';
import { ChevronLeft, Icon } from '../daymark/icons';

export function PageHeader({
  title,
  description,
  back,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Where Back goes, named by its destination: { href: '/jobs', label: 'Jobs' } → "‹ Jobs". */
  back?: { href: string; label: string };
  /** Small things beside the title: a status badge, "Read-only". */
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx('space-y-2', className)}>
      {back ? (
        <Link href={back.href} className="-ml-2 inline-flex min-h-12 items-center gap-1 rounded-control px-2 text-[16px] font-bold text-ink-2 hover:bg-sunken hover:text-ink">
          <Icon icon={ChevronLeft} size="s" />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="min-w-0 text-[30px] leading-[1.07] font-extrabold tracking-[-0.02em] text-ink [overflow-wrap:anywhere]">{title}</h1>
            {meta}
          </div>
          {description ? <p className="max-w-prose text-[16px] font-medium text-ink-2">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
