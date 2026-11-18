// Daymark buttons. One `primary` (hi-vis) per screen: the one thing to do next.
//
//   <Button variant="primary" size="lg" icon={Plus}>New estimate</Button>   hi-vis, the one action
//   <Button>Roof lookup</Button>                    default: variant "secondary" (surface, ink edge)
//   <Button variant="ink">Send quote</Button>       filled ink: final actions on office screens
//   <Button variant="ghost">More</Button>           no edge: overflow, low-weight actions
//   <Button variant="danger">Delete area</Button>   quiet red; confirm it and offer Undo
//   <Button variant="main">Save</Button>            the register's main action: hi-vis in the
//                                                   field, ink in the quiet register (ui.tsx primary)
//   <ButtonLink href="/field" variant="primary">…</ButtonLink>   a link that looks like a button
//   <IconButton icon={RefreshCw} label="Sync now" />             48px, icon only, named
//
// Sizes: sm 48px · md = --ctl-h (56 field / 48 quiet) · lg = --ctl-h-go (64 field / 56 quiet).
// The hi-vis fill always carries ink text and its 2px ink edge (3px in Sun+). The edge is set in
// the inline style, so a className cannot remove it. Disabled buttons drop the keel and the
// hi-vis, take the draft fill and keep the label readable; put the reason next to the button.
import Link from 'next/link';
import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type LucideIcon } from './icons';

export type ButtonVariant = 'primary' | 'main' | 'secondary' | 'ink' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BASE =
  'inline-flex items-center justify-center gap-2.5 rounded-control text-center font-extrabold leading-tight tracking-[-0.005em] select-none press disabled:cursor-not-allowed aria-disabled:cursor-not-allowed';

const SIZE: Record<ButtonSize, string> = {
  sm: 'min-h-12 px-4 py-1.5 text-base',
  md: 'min-h-[var(--ctl-h)] px-5 py-2 text-[18px]',
  lg: 'min-h-[var(--ctl-h-go)] px-6 py-2 text-[19px]',
};

const EDGE = 'border-solid border-[length:var(--bw)]';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'border-solid border-[length:var(--bw-go)] border-hivis-edge bg-hivis text-on-hivis shadow-keel-go hover:bg-hivis-press',
  main: 'border-solid border-[length:var(--bw-go)] border-[var(--main-edge)] bg-[var(--main-fill)] text-[var(--on-main)] shadow-[var(--main-keel)]',
  secondary: `${EDGE} border-edge bg-surface text-ink shadow-keel-s hover:bg-sunken`,
  ink: `${EDGE} border-ink bg-ink text-on-ink shadow-keel-s`,
  ghost: 'border-solid border-[length:var(--bw)] border-transparent bg-transparent text-ink underline-offset-4 hover:bg-sunken hover:underline',
  danger: `${EDGE} border-bad bg-surface text-bad shadow-keel-s hover:bg-bad-fill`,
};

const DISABLED = `${EDGE} border-line-strong bg-draft-fill text-ink-2 shadow-none`;

/** The hi-vis edge, enforced: inline styles win over any className. */
export const HIVIS_EDGE_STYLE: CSSProperties = {
  borderStyle: 'solid',
  borderWidth: 'var(--bw-go)',
  borderColor: 'var(--hivis-edge)',
};

/** The main-action edge: the hi-vis edge in the field register, ink in the quiet one. */
const MAIN_EDGE_STYLE: CSSProperties = { borderStyle: 'solid', borderWidth: 'var(--bw-go)', borderColor: 'var(--main-edge)' };

export interface ButtonLook {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full width. */
  block?: boolean;
  disabled?: boolean;
}

/** Class names for a button look, for elements that are not <Button> (a <summary>, a <label>). */
export function buttonClass({ variant = 'secondary', size = 'md', block = false, disabled = false }: ButtonLook = {}, className?: string) {
  return cx(BASE, SIZE[size], disabled ? DISABLED : VARIANT[variant], block && 'w-full', className);
}

/** Inline style for a button look: the enforced hi-vis edge, merged over any style given. */
export function buttonStyle(variant: ButtonVariant, disabled: boolean | undefined, style?: CSSProperties): CSSProperties | undefined {
  if (disabled || (variant !== 'primary' && variant !== 'main')) return style;
  return { ...style, ...(variant === 'primary' ? HIVIS_EDGE_STYLE : MAIN_EDGE_STYLE) };
}

function Content({ icon, iconEnd, children }: { icon?: LucideIcon; iconEnd?: LucideIcon; children?: ReactNode }) {
  return (
    <>
      {icon ? <Icon icon={icon} /> : null}
      {children}
      {iconEnd ? <Icon icon={iconEnd} /> : null}
    </>
  );
}

export type ButtonProps = ComponentProps<'button'> &
  ButtonLook & {
    /** Leading icon (Lucide). */
    icon?: LucideIcon;
    /** Trailing icon (Lucide). */
    iconEnd?: LucideIcon;
  };

export function Button({ variant = 'secondary', size = 'md', block, icon, iconEnd, className, style, children, type = 'button', disabled, ...props }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={buttonClass({ variant, size, block, disabled }, className)}
      style={buttonStyle(variant, disabled, style)}
      {...props}
    >
      <Content icon={icon} iconEnd={iconEnd}>
        {children}
      </Content>
    </button>
  );
}

export type ButtonLinkProps = ComponentProps<typeof Link> &
  Omit<ButtonLook, 'disabled'> & {
    icon?: LucideIcon;
    iconEnd?: LucideIcon;
  };

/** A Next.js link with a button look (navigation that should read as an action). */
export function ButtonLink({ variant = 'secondary', size = 'md', block, icon, iconEnd, className, style, children, ...props }: ButtonLinkProps) {
  return (
    <Link className={buttonClass({ variant, size, block }, cx('no-underline', className))} style={buttonStyle(variant, false, style)} {...props}>
      <Content icon={icon} iconEnd={iconEnd}>
        {children}
      </Content>
    </Link>
  );
}

export type IconButtonProps = Omit<ComponentProps<'button'>, 'children'> & {
  icon: LucideIcon;
  /** Required: what the button does, for screen readers and as a tooltip. */
  label: string;
  variant?: Exclude<ButtonVariant, 'primary' | 'main'>;
};

/** A 48px icon-only button. Always named. */
export function IconButton({ icon, label, variant = 'secondary', className, type = 'button', disabled, title, ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      className={buttonClass({ variant, size: 'sm', disabled }, cx('w-12 shrink-0 px-0', className))}
      {...props}
    >
      <Icon icon={icon} />
    </button>
  );
}
