'use client';
// The living Daymark sheet. Tokens are read from the live CSS (so this page shows what ships),
// contrast is computed in the browser for every promised pair, and every component is shown in
// Day, Night and Sun+, in the field and quiet registers.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Banner,
  Button,
  ButtonLink,
  Card,
  Check,
  Chip,
  ChipGroup,
  CircleCheck,
  CloudUpload,
  Copy,
  DisplayTitle,
  Dock,
  EmptyState,
  Field,
  GaugeNumber,
  HazardNote,
  HousePlus,
  Icon,
  IconButton,
  Input,
  JOB_BADGE_STATUSES,
  Kpi,
  LoadingSteps,
  Monogram,
  PlateList,
  Printer,
  ProgressBar,
  QUOTE_STATUSES,
  ReadoutTiles,
  RefreshCw,
  Ruler,
  Satellite,
  Camera,
  SectionHead,
  Segmented,
  Select,
  Sheet,
  SignLabel,
  Signature,
  Skeleton,
  Smartphone,
  StatusBadge,
  StatusBoard,
  StepTrack,
  Switch,
  SwitchRow,
  SyncIndicator,
  Tabs,
  Tag,
  Textarea,
  ThemeSwitcher,
  ToastView,
  TriangleAlert,
  Plus,
  Search,
  Send,
  Eye,
  PencilLine,
  X,
  Clock,
  CloudOff,
  Phone,
  Mail,
  CalendarCheck,
  FilePenLine,
  ShieldCheck,
  Download,
  Star,
  Trash2,
  cx,
  useToast,
  type LucideIcon,
} from '@/components/daymark';
import { ACCESS_LABELS, num } from '@/lib/format';
import { CONTRAST_PAIRS, contrastRatio, pairApplies, parseColor, type RegisterName, type ThemeName } from '@/lib/design/contrast';

export interface DesignSamples {
  floor: string;
  deck: string;
  pitch: string;
  wallRun: string;
  facesAll: string;
  facesKept: string;
  facesOut: string;
  facesAllValue: number;
  facesKeptValue: number;
  overhangs: { value: string; label: string }[];
  defaultOverhang: string;
  tiers: { tier: string; label: string; title: string; price: string; monthly: string | null; priceValue: number }[];
  termMonths: string;
}

const THEMES: { id: ThemeName; name: string; about: string }[] = [
  { id: 'day', name: 'Day', about: 'Ink on chalk. The default.' },
  { id: 'night', name: 'Night', about: 'Same names, dark values. Ink fills invert; hi-vis stays.' },
  { id: 'sun', name: 'Sun+', about: 'All greys to black on white, 3px edges. For direct sun.' },
];

const TOKEN_GROUPS: { title: string; tokens: [string, string][] }[] = [
  { title: 'Surfaces', tokens: [['canvas', 'Page (chalk)'], ['surface', 'Plates, inputs, dock'], ['sunken', 'Wells, sum rows'], ['draft-fill', 'Draft tag, disabled']] },
  {
    title: 'Ink and lines',
    tokens: [
      ['ink', 'Text, edges, keel'],
      ['ink-2', 'Secondary text'],
      ['ink-3', 'Meta, placeholders'],
      ['on-ink', 'Text on ink fills'],
      ['ink-accent', 'Tick and Undo on ink'],
      ['line', 'Hairlines (decorative)'],
      ['line-strong', 'Input and switch edges'],
      ['edge', 'Plate and button edges'],
      ['rule', 'Section rules, dock top'],
      ['focus', 'Focus ring'],
    ],
  },
  {
    title: 'Hi-vis',
    tokens: [
      ['hivis', 'Chosen value, the one action'],
      ['hivis-press', 'Hi-vis pressed'],
      ['on-hivis', 'Text on hi-vis'],
      ['hivis-edge', 'Edge on hi-vis (always)'],
      ['hivis-wash', 'Chosen column, quiet chosen'],
    ],
  },
  {
    title: 'Status',
    tokens: [
      ['ok', 'Signed, done'],
      ['ok-fill', 'OK fill'],
      ['warn', 'Needs your action'],
      ['warn-fill', 'Warn fill'],
      ['hazard', 'Hatch stripe (with ink)'],
      ['bad', 'Errors, lost'],
      ['bad-fill', 'Bad fill'],
      ['info', 'Sent, waiting'],
      ['info-fill', 'Info fill'],
      ['viewed', 'Viewed'],
      ['viewed-fill', 'Viewed fill'],
      ['track', 'Upcoming step bars'],
    ],
  },
];

const ROOF_LINES: [string, string, boolean?][] = [
  ['e-ridge', 'Ridge'],
  ['e-hip', 'Hip'],
  ['e-valley', 'Valley'],
  ['e-eave', 'Eave'],
  ['e-rake', 'Rake'],
  ['e-break', 'Pitch break', true],
];

const ICONS: [LucideIcon, string][] = [
  [Satellite, 'Roof lookup, aerial'],
  [Ruler, 'Measure'],
  [Camera, 'Photos'],
  [Search, 'Search'],
  [RefreshCw, 'Sync'],
  [CloudUpload, 'Not synced'],
  [CloudOff, 'Offline'],
  [PencilLine, 'Draft'],
  [Send, 'Sent'],
  [Eye, 'Viewed'],
  [Check, 'Signed'],
  [CircleCheck, 'Confirmed'],
  [X, 'Lost, close'],
  [Clock, 'Expired'],
  [TriangleAlert, 'Check'],
  [Printer, 'Print'],
  [Copy, 'Copy'],
  [Phone, 'Call'],
  [Mail, 'Email'],
  [Signature, 'Sign'],
  [CalendarCheck, 'Scheduled'],
  [FilePenLine, 'Quote'],
  [ShieldCheck, 'Verified'],
  [Download, 'Download'],
  [Star, 'Recommended'],
  [Trash2, 'Delete'],
];

/** Reads custom properties from an element's computed style once it is on screen. */
function useComputedTokens(names: readonly string[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const key = names.join(',');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const read = () => Object.fromEntries(key.split(',').map((n) => [n, cs.getPropertyValue(`--${n}`).trim()]));
    // Computed styles exist only once the element is in the document, so this runs after mount.
    setValues(read());
  }, [key]);
  return { ref, values };
}

function Panel({ theme, register, children, className }: { theme: ThemeName; register: RegisterName; children: ReactNode; className?: string }) {
  return (
    <div
      data-theme={theme}
      data-register={register === 'quiet' ? 'quiet' : undefined}
      className={cx('min-w-0 rounded-plate border-solid border-[length:var(--bw)] border-edge bg-canvas p-4 text-ink sm:p-5', className)}
    >
      {children}
    </div>
  );
}

function TokenPanel({ theme }: { theme: (typeof THEMES)[number] }) {
  const names = TOKEN_GROUPS.flatMap((g) => g.tokens.map(([n]) => n));
  const { ref, values } = useComputedTokens(names);
  return (
    <Panel theme={theme.id} register="field">
      <div ref={ref}>
        <p className="text-[22px] font-extrabold">{theme.name}</p>
        <p className="mb-4 text-[15px] font-medium text-ink-2">{theme.about}</p>
        <div className="space-y-5">
          {TOKEN_GROUPS.map((g) => (
            <div key={g.title}>
              <SignLabel className="mb-2">{g.title}</SignLabel>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1">
                {g.tokens.map(([name, use]) => (
                  <li key={name} className="flex min-w-0 items-center gap-2.5 rounded-control border-solid border-[length:var(--bw)] border-line bg-surface p-1.5 pr-2.5">
                    <span aria-hidden className="h-10 w-10 shrink-0 rounded-[8px] border border-solid border-line-strong" style={{ background: `var(--${name})` }} />
                    <span className="min-w-0">
                      <code className="block truncate text-[14px] font-bold">--{name}</code>
                      <span className="block truncate text-[13px] text-ink-2">
                        <span className="font-mono">{values[name] ?? ''}</span> · {use}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

const PAIR_TOKENS = [...new Set(CONTRAST_PAIRS.flatMap((p) => [p.fg, p.bg]).filter((t) => !t.startsWith('#')))];

function ContrastPanel({ theme, register }: { theme: ThemeName; register: RegisterName }) {
  const { ref, values } = useComputedTokens(PAIR_TOKENS);
  const pairs = CONTRAST_PAIRS.filter((p) => pairApplies(p, theme, register));
  const rows = pairs.map((p) => {
    const fg = parseColor(p.fg.startsWith('#') ? p.fg : (values[p.fg] ?? ''));
    const bg = parseColor(p.bg.startsWith('#') ? p.bg : (values[p.bg] ?? ''));
    const ratio = fg && bg ? contrastRatio(fg, bg) : null;
    return { p, ratio, ok: ratio !== null && ratio >= p.min };
  });
  const ready = Object.keys(values).length > 0;
  const passed = rows.filter((r) => r.ok).length;
  const name = THEMES.find((t) => t.id === theme)!.name;
  return (
    <Panel theme={theme} register={register} className="p-0 sm:p-0">
      <div ref={ref}>
        <details>
          <summary className="flex min-h-14 cursor-pointer items-center gap-3 px-4 text-[17px] font-bold">
            <span className="min-w-0 flex-1">
              {name} · {register}
            </span>
            {ready ? (
              <Tag tone={passed === rows.length ? 'ok' : 'bad'} icon={passed === rows.length ? CircleCheck : TriangleAlert}>
                {passed} of {rows.length} pass
              </Tag>
            ) : null}
          </summary>
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="border-y-[length:var(--bw)] border-solid border-edge">
                <th className="sign-label px-3 py-2 text-left [--sign-size:11px]">Pair</th>
                <th className="sign-label px-3 py-2 text-right [--sign-size:11px]">Ratio</th>
                <th className="sign-label px-3 py-2 text-right [--sign-size:11px]">Needs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, ratio, ok }) => (
                <tr key={p.name} className="border-b border-solid border-line">
                  <td className="px-3 py-1.5">
                    <span className="font-semibold">{p.name}</span>
                    <span className="block text-[13px] text-ink-2">
                      {p.fg} on {p.bg}
                    </span>
                  </td>
                  <td className="gauge-m px-3 text-right text-[17px]">{ratio === null ? '—' : ratio.toFixed(2)}</td>
                  <td className="px-3 text-right whitespace-nowrap">
                    <span className={cx('inline-flex items-center gap-1 font-bold', ok ? 'text-ok' : 'text-bad')}>
                      <Icon icon={ok ? Check : X} size="xs" />
                      {p.min}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    </Panel>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <SectionHead as="h4">{title}</SectionHead>
      {children}
    </div>
  );
}

/** Every component, interactive, in one theme and register. */
function Gallery({ s, quiet }: { s: DesignSamples; quiet: boolean }) {
  const toast = useToast();
  const [overhang, setOverhang] = useState(s.defaultOverhang);
  const [tab, setTab] = useState<'aerial' | 'measure' | 'photos'>('aerial');
  const [access, setAccess] = useState<keyof typeof ACCESS_LABELS>('easy');
  const [airSeal, setAirSeal] = useState(true);
  const [board, setBoard] = useState<'all' | 'kept' | 'out'>('all');
  const [area, setArea] = useState<'floor' | 'deck'>('floor');
  const [tier, setTier] = useState(s.tiers[1]?.tier ?? s.tiers[0]?.tier ?? 'better');
  const [edges, setEdges] = useState(true);
  const [face, setFace] = useState(false);
  const [sheet, setSheet] = useState(false);
  const chosen = s.tiers.find((t) => t.tier === tier);
  const maxPrice = Math.max(...s.tiers.map((t) => t.priceValue));

  return (
    <div className="space-y-8">
      <Block title="Buttons">
        <div className="flex flex-col gap-3">
          <Button variant="primary" size="lg" icon={Check}>
            Use {s.floor} sq ft
          </Button>
          <Button icon={Satellite}>Roof lookup</Button>
          <Button variant="ink" icon={Send}>
            Send quote
          </Button>
          <Button variant="main">Save changes (main: hi-vis here, ink when quiet)</Button>
          <div className="flex flex-wrap gap-3">
            <Button variant="ghost">More options</Button>
            <Button variant="danger" icon={Trash2}>
              Delete area
            </Button>
            <IconButton icon={RefreshCw} label="Sync now" />
          </div>
          <div>
            <Button variant="primary" size="lg" block disabled>
              Use {s.floor} sq ft
            </Button>
            <p className="mt-1.5 text-[15px] font-semibold text-ink-2">Confirm the house first.</p>
          </div>
          <ButtonLink href="#components" size="sm" iconEnd={Download}>
            A link that looks like a button
          </ButtonLink>
        </div>
      </Block>

      <Block title="Single choice">
        <Segmented label="Overhang" value={overhang} onChange={setOverhang} options={s.overhangs} />
        <Tabs
          label="Measure with"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'aerial', label: 'Aerial', icon: Satellite },
            { value: 'measure', label: 'Measure', icon: Ruler },
            { value: 'photos', label: 'Photos', icon: Camera },
          ]}
        />
        <ChipGroup label="Access" value={access} onChange={setAccess} options={Object.entries(ACCESS_LABELS).map(([value, label]) => ({ value: value as keyof typeof ACCESS_LABELS, label }))} />
        <div className="flex flex-wrap gap-2">
          <Chip selected={airSeal} onClick={() => setAirSeal(!airSeal)}>
            Air seal
          </Chip>
          <Chip icon={Smartphone}>On this phone</Chip>
        </div>
        <StatusBoard
          label="Show faces"
          value={board}
          onChange={setBoard}
          cells={[
            { value: 'all', count: s.facesAll, label: 'All' },
            { value: 'kept', count: s.facesKept, label: 'Kept' },
            { value: 'out', count: s.facesOut, label: 'Left out' },
          ]}
        />
        <ReadoutTiles
          label="Use which area"
          value={area}
          onChange={setArea}
          options={[
            { value: 'floor', label: 'Attic floor', meaning: 'Blown-in, on the ceiling', gauge: s.floor, unit: 'square feet' },
            { value: 'deck', label: 'Roof deck', meaning: 'Spray foam, under the roof', gauge: s.deck, unit: 'square feet' },
          ]}
        />
      </Block>

      <Block title="Switches and fields">
        <SwitchRow checked={edges} onChange={setEdges} label="Show roof edges" hint="Lines on the photo" />
        <div className="flex items-center justify-between gap-3 rounded-control border-solid border-[length:var(--bw)] border-line-strong bg-surface px-3.5 py-2">
          <span className="font-bold">Face 2: over the attic</span>
          <Switch checked={face} onChange={setFace} label="Face 2: over the attic" />
        </div>
        <Field label="Customer name" hint="As it should read on the quote">
          <Input placeholder="First and last name" />
        </Field>
        <Field label="Email" error="Check the email address: it has no @.">
          <Input aria-invalid defaultValue="name.example.com" />
        </Field>
        <Field label="Existing insulation">
          <Select defaultValue="none">
            <option value="none">None</option>
            <option value="fiberglass">Blown fiberglass</option>
            <option value="cellulose">Blown cellulose</option>
          </Select>
        </Field>
        <Field label="Notes for the crew">
          <Textarea rows={2} placeholder="Gate code, dog, where to park" />
        </Field>
        <Field label="Read only">
          <Input value="Set by the office" readOnly />
        </Field>
      </Block>

      <Block title="Status (one vocabulary)">
        <div className="flex flex-wrap gap-2">
          {QUOTE_STATUSES.map((st) => (
            <StatusBadge key={st} status={st} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {JOB_BADGE_STATUSES.map((st) => (
            <StatusBadge key={st} status={st} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Tag tone="line" icon={CircleCheck}>
            Ready
          </Tag>
          <Tag tone="warn" icon={CloudUpload}>
            Not synced
          </Tag>
          <Tag tone="bad" icon={TriangleAlert}>
            Conflict
          </Tag>
        </div>
      </Block>

      <Block title="Numbers">
        <div className="grid grid-cols-2 gap-4">
          <GaugeNumber size="xl" label="Attic floor" meaning="Blown-in, on the ceiling" value={s.floor} unit="square feet" />
          <GaugeNumber size="xl" label="Roof deck" meaning="Spray foam, under the roof" value={s.deck} unit="square feet" />
        </div>
        <div className="flex flex-wrap gap-6">
          {s.tiers.map((t) => (
            <GaugeNumber key={t.tier} size="l" label={t.label} value={t.price} />
          ))}
        </div>
        <Card className="grid grid-cols-3 gap-0 p-0">
          <Kpi className="p-3" label="Pitch" value={s.pitch} delta="Main roof" />
          <Kpi className="border-l-[length:var(--bw)] border-solid border-edge p-3" label="Wall run" value={s.wallRun} delta="Inside the overhang" />
          <Kpi className="border-l-[length:var(--bw)] border-solid border-edge p-3" label="Faces" value={s.facesKept} delta={`${s.facesOut} left out`} deltaTone="bad" />
        </Card>
        <SectionHead count={num(s.tiers.length)}>Options</SectionHead>
        <PlateList aria-label="Options">
          {s.tiers.map((t) => (
            <li key={t.tier} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="font-bold">{t.label}</span>
              <span className="gauge-m text-[22px]">{t.price}</span>
            </li>
          ))}
        </PlateList>
      </Block>

      <Block title="Table and chart">
        <Card padded={false} className="overflow-x-auto">
          <table className="w-full border-collapse text-[15px]">
            <thead>
              <tr className="border-b-[length:var(--bw)] border-solid border-edge">
                <th className="sign-label px-3 py-2.5 text-left [--sign-size:11px]">Option</th>
                <th className="sign-label px-3 py-2.5 text-right [--sign-size:11px]">Price</th>
                <th className="sign-label px-3 py-2.5 text-right [--sign-size:11px]">Per month</th>
              </tr>
            </thead>
            <tbody>
              {s.tiers.map((t) => (
                <tr key={t.tier} className={cx('border-b border-solid border-line last:border-b-0', t.tier === tier && 'bg-hivis-wash')}>
                  <td className="px-3 py-2.5 font-semibold">{t.label}</td>
                  <td className="gauge-m px-3 text-right text-[18px]">{t.price}</td>
                  <td className="gauge-m px-3 text-right text-[18px]">{t.monthly ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card>
          <SignLabel className="mb-3">Price by option</SignLabel>
          <ul className="space-y-2.5">
            {s.tiers.map((t) => (
              <li key={t.tier} className="grid grid-cols-[64px_1fr_auto] items-center gap-3 font-bold">
                <span>{t.label}</span>
                <span
                  className={cx('h-7 rounded-[4px]', t.tier === tier ? 'bg-hivis shadow-[inset_0_0_0_2px_var(--hivis-edge)]' : 'bg-ink')}
                  style={{ width: `${(t.priceValue / maxPrice) * 100}%` }}
                />
                <span className="gauge-m text-[18px]">{t.price}</span>
              </li>
            ))}
          </ul>
        </Card>
      </Block>

      <Block title="Quote options (the chosen tier)">
        <ReadoutTiles
          label="Choose your option"
          value={tier}
          onChange={setTier}
          size="l"
          className="grid-cols-1 sm:grid-cols-3"
          options={s.tiers.map((t) => ({
            value: t.tier,
            label: t.label,
            gauge: t.price,
            meaning: t.monthly ? `or about ${t.monthly}/mo for ${s.termMonths} months` : undefined,
          }))}
        />
        <Button variant="primary" size="lg" block icon={Signature}>
          Review and sign{chosen ? ` · ${chosen.price}` : ''}
        </Button>
      </Block>

      <Block title="Messages">
        <Banner tone="info" title="Quote sent.">
          We will tell you when the customer opens it.
        </Banner>
        <Banner tone="ok" title="Signed.">
          The office will call to schedule.
        </Banner>
        <Banner tone="warn" title="Add a size first.">
          The Garage area has no size, so it is not in the price.
        </Banner>
        <Banner tone="bad" title="No roof found at this address." action={<Button size="sm">Tap the roof on the map</Button>}>
          Google has no roof outline for it.
        </Banner>
        <Banner tone="hazard" title="Check on site.">
          Finished attic rooms and knee walls are not in these numbers.
        </Banner>
        <Banner tone="hazard" layout="bar" title="Offline.">
          Saving on this phone. Changes sync when you have signal.
        </Banner>
        <HazardNote title="Measure this yourself.">Cathedral ceilings are not in the aerial numbers.</HazardNote>
      </Block>

      <Block title="States">
        <Card>
          <EmptyState
            icon={HousePlus}
            title="No estimates on this phone yet"
            hint="Start one at the door, or look up a roof first."
            action={
              <Button variant="primary" icon={Plus}>
                New estimate
              </Button>
            }
          />
        </Card>
        <Card className="space-y-3">
          <LoadingSteps
            steps={[
              { label: 'Finding the address', state: 'done' },
              { label: 'Reading the roof', state: 'doing' },
              { label: 'Drawing the faces', state: 'todo' },
            ]}
          />
          <ProgressBar label="Faces kept" value={s.facesKeptValue} max={s.facesAllValue} />
          <Skeleton className="w-2/3" />
          <Skeleton className="w-1/2" />
        </Card>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <SyncIndicator state="synced" />
          <SyncIndicator state="syncing" />
          <SyncIndicator state="pending" />
          <SyncIndicator state="offline" />
          <SyncIndicator state="conflict" />
          <SyncIndicator state="error" />
          <SyncIndicator state="pending" compact onClick={() => undefined} />
        </div>
        <ToastView toast={{ message: 'Quote sent', undo: () => undefined }} />
        <div className="flex flex-wrap gap-3">
          <Button size="sm" onClick={() => toast.show({ message: 'Area deleted', undo: () => toast.show({ message: 'Area restored' }) })}>
            Show a toast
          </Button>
          <Button size="sm" onClick={() => setSheet(true)}>
            Open a sheet
          </Button>
        </div>
        <Sheet
          open={sheet}
          onClose={() => setSheet(false)}
          title="Attic size"
          footer={
            <Button variant="primary" size="lg" block onClick={() => setSheet(false)}>
              Use {s.floor} sq ft
            </Button>
          }
        >
          <GaugeNumber size="xl" label="Attic floor" value={s.floor} unit="square feet" />
          <p className="mt-3 text-ink-2">A sheet rises from the dock: X to close, one named action.</p>
        </Sheet>
      </Block>

      <Block title="Dock, steps, mark">
        <div className="overflow-hidden rounded-plate border-solid border-[length:var(--bw)] border-edge">
          <Dock inline note="Fills the attic floor and notes the source">
            <Button variant="primary" size="lg" icon={Check}>
              Use {s.floor} sq ft
            </Button>
          </Dock>
        </div>
        <StepTrack steps={['Customer', 'Areas', 'Options', 'Send']} current={1} />
        <div className="flex items-end gap-4">
          <Monogram size={56} />
          <Monogram size={40} />
          <Monogram size={28} />
        </div>
      </Block>

      <Block title="Icons (Lucide, with words)">
        <ul className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
          {ICONS.map(([glyph, word]) => (
            <li key={word} className="flex items-center gap-2 text-[15px] font-semibold">
              <Icon icon={glyph} />
              {word}
            </li>
          ))}
        </ul>
      </Block>
      {quiet ? (
        <p className="text-[15px] text-ink-2">
          Quiet register: 1px rules, no keel, chosen values in the wash with an ink edge, digits in running text have plain zeros (0123456789).
        </p>
      ) : (
        <p className="text-[15px] text-ink-2">Field register: 2px edges, keels, chosen values in hi-vis. Digits in running text: 0123456789.</p>
      )}
    </div>
  );
}

function RoofLines() {
  return (
    <div className="rounded-plate bg-frame p-4 text-on-frame">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {ROOF_LINES.map(([token, name, dashed]) => (
          <li key={token} className="flex items-center gap-3">
            <svg width="72" height="16" viewBox="0 0 72 16" aria-hidden>
              <line x1="4" y1="8" x2="68" y2="8" stroke="var(--e-casing)" strokeWidth="8" strokeLinecap="round" />
              <line x1="4" y1="8" x2="68" y2="8" stroke={`var(--${token})`} strokeWidth="4" strokeLinecap="round" strokeDasharray={dashed ? '8 6' : undefined} />
            </svg>
            <span className="min-w-0">
              <span className="block font-bold">{name}</span>
              <code className="block text-[13px] opacity-80">--{token}</code>
            </span>
          </li>
        ))}
        <li className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-face-badge text-[15px] font-extrabold text-on-face-badge ring-2 ring-on-face-badge">1</span>
          <span className="font-bold">Face number</span>
        </li>
      </ul>
      <p className="mt-3 text-[14px] opacity-80">Every line sits on a 2px ink casing, so it reads on lawn and shingles; each has its length in the legend.</p>
    </div>
  );
}

export function DesignSheet({ samples }: { samples: DesignSamples }) {
  return (
    <div className="min-h-dvh">
      <header className="border-b-[length:var(--bw-x)] border-solid border-rule bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-5">
          <Monogram size={52} />
          <div className="min-w-0 flex-1">
            <SignLabel>Koala Estimator · staff only</SignLabel>
            <DisplayTitle>Daymark system sheet</DisplayTitle>
          </div>
          <div className="w-full sm:w-[420px]">
            <SignLabel className="mb-1.5">This device</SignLabel>
            <ThemeSwitcher />
          </div>
        </div>
        <nav aria-label="Sections" className="mx-auto flex max-w-6xl flex-wrap gap-x-5 gap-y-1 px-4 pb-3 text-[15px] font-bold">
          {[
            ['#tokens', 'Tokens'],
            ['#contrast', 'Contrast'],
            ['#type', 'Type'],
            ['#roof-map', 'Roof map'],
            ['#components-day', 'Day'],
            ['#components-night', 'Night'],
            ['#components-sun', 'Sun+'],
            ['#rules', 'Rules'],
          ].map(([href, label]) => (
            <a key={href} href={href} className="inline-flex min-h-12 items-center underline underline-offset-4">
              {label}
            </a>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl space-y-14 px-4 py-8">
        <p className="max-w-3xl text-[17px] font-medium text-ink-2">
          Ink on chalk, one hi-vis action colour, condensed gauge numbers and wide sign labels. Hi-vis means one thing: what you are choosing, or the one thing to do
          next. It always carries ink text and a 2px ink edge. Field screens (estimators and crews on phones) use the full system; the customer quote and the
          office screens use the quiet register. Sample figures on this page come from the roof and pricing engines run on their test fixtures (placeholder prices, not real ones).
        </p>

        <section id="tokens" className="space-y-4">
          <SectionHead>Colour tokens</SectionHead>
          <p className="text-ink-2">Read from the live CSS. Use them as Tailwind classes: bg-surface, text-ink, border-edge, bg-hivis, text-on-hivis, bg-ok-fill …</p>
          <div className="grid gap-4 lg:grid-cols-3">
            {THEMES.map((t) => (
              <TokenPanel key={t.id} theme={t} />
            ))}
          </div>
        </section>

        <section id="contrast" className="space-y-4">
          <SectionHead>Contrast, computed here</SectionHead>
          <p className="text-ink-2">Every promised pair, measured in this browser (WCAG 2.x: text 4.5, boundaries and icons 3). lib/design/contrast.test.ts checks the same pairs in CI.</p>
          <div className="grid gap-3 lg:grid-cols-2">
            {THEMES.flatMap((t) => (['field', 'quiet'] as const).map((r) => <ContrastPanel key={`${t.id}-${r}`} theme={t.id} register={r} />))}
          </div>
        </section>

        <section id="type" className="space-y-4">
          <SectionHead>Type</SectionHead>
          <Card className="divide-y divide-line p-0">
            {[
              ['Gauge XL · Archivo 800, width 72%, tabular', <span key="x" className="gauge text-[60px]">{samples.floor} {samples.tiers[1]?.price}</span>],
              ['Gauge L · prices, counts', <span key="l" className="gauge text-[38px]">{[samples.tiers[2]?.price, samples.pitch, samples.wallRun].join(' · ')}</span>],
              ['Gauge M · tables, legends, dock totals', <span key="m" className="gauge-m text-[24px]">{samples.tiers.map((t) => t.price).join(' · ')}</span>],
              ['Display · Atkinson Hyperlegible Next 800, 30px', <DisplayTitle key="d" as="p">Your insulation quote</DisplayTitle>],
              ['Title · 800, 22–26px', <p key="t" className="text-[24px] font-extrabold">Air seal and blown cellulose</p>],
              ['Body · 450–600, 17px (15px minimum)', <p key="b" className="text-[17px]">How far the eaves stick out past the walls. The attic floor is measured inside it.</p>],
              ['Sign label · Archivo 700, width 118%, caps', <SignLabel key="s" tone="ink">Roof takeoff · Attic floor · Price holds until</SignLabel>],
            ].map(([k, v], i) => (
              <div key={i} className="grid gap-2 px-4 py-3 md:grid-cols-[260px_1fr] md:items-baseline">
                <p className="text-[14px] font-semibold text-ink-2">{k}</p>
                <div className="min-w-0 overflow-hidden">{v}</div>
              </div>
            ))}
          </Card>
        </section>

        <section id="roof-map" className="space-y-4">
          <SectionHead>Roof map colours</SectionHead>
          <RoofLines />
        </section>

        <section id="components" className="space-y-10">
          {THEMES.map((t) => (
            <div key={t.id} id={`components-${t.id}`} className="space-y-4">
              <SectionHead>{`Components · ${t.name}`}</SectionHead>
              <div className="grid gap-4 lg:grid-cols-2">
                <Panel theme={t.id} register="field">
                  <SignLabel className="mb-4">Field register</SignLabel>
                  <Gallery s={samples} quiet={false} />
                </Panel>
                <Panel theme={t.id} register="quiet">
                  <SignLabel className="mb-4">Quiet register</SignLabel>
                  <Gallery s={samples} quiet />
                </Panel>
              </div>
            </div>
          ))}
        </section>

        <section id="rules" className="space-y-4">
          <SectionHead>Five rules</SectionHead>
          <PlateList>
            {[
              ['Hi-vis = choose or go.', 'Only the chosen value in a single-choice group and the one primary action on a screen. Always ink text and a 2px ink edge.'],
              ['Ink = where you are.', 'The current tab, a finished step, a switch that is on: solid ink (light in Night).'],
              ['Numbers are gauges.', 'Every quantity a decision depends on uses gauge numerals with a sign label. Values come from lib/format.ts, never typed in.'],
              ['Never colour alone.', 'Status shows an icon, a word and a colour. Switches say ON or OFF. The hatch always has an icon and a word.'],
              ['One thumb, one dock.', 'The main action sits in the bottom dock, 64px, with a one-line note of what it does.'],
            ].map(([a, b]) => (
              <li key={a} className="px-4 py-3">
                <p className="font-extrabold">{a}</p>
                <p className="text-ink-2">{b}</p>
              </li>
            ))}
          </PlateList>
          <SectionHead as="h3">Motion</SectionHead>
          <PlateList>
            {[
              ['Press · 80 ms', 'Buttons drop onto their keel.'],
              ['Choose · 140 ms', 'Hi-vis fills the chosen tile or segment; the switch knob slides. Numbers never animate.'],
              ['Move · 220 ms', 'Sheets rise from the dock; no bounce or parallax.'],
              ['Reduced motion', 'Every transition is off. State still changes, and is always written in words.'],
            ].map(([a, b]) => (
              <li key={a} className="grid gap-1 px-4 py-3 md:grid-cols-[200px_1fr]">
                <p className="font-extrabold">{a}</p>
                <p className="text-ink-2">{b}</p>
              </li>
            ))}
          </PlateList>
        </section>
      </main>
    </div>
  );
}
