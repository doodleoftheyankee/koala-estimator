'use client';
// The gross margin a target net margin works out to (L10, OD9), as the owner types: it reads the
// overhead and target net margin inputs of the form it sits in. The stored value does not change.
import { useEffect, useRef, useState } from 'react';
import { marginPreview } from '@/lib/admin/settings';

export function MarginPreview({ overheadPct, netMarginPct }: { overheadPct: number; netMarginPct: number }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [values, setValues] = useState({ overheadPct, netMarginPct });

  useEffect(() => {
    const form = ref.current?.closest('form');
    if (!form) return;
    const read = (name: string, fallback: number) => {
      const el = form.elements.namedItem(name);
      if (!(el instanceof HTMLInputElement) || el.value.trim() === '') return fallback;
      return Number(el.value.replace(/,/g, '')) / 100;
    };
    const onInput = () => setValues({ overheadPct: read('overhead_pct', Number.NaN), netMarginPct: read('target_margin_pct', Number.NaN) });
    form.addEventListener('input', onInput);
    return () => form.removeEventListener('input', onInput);
  }, []);

  const p = marginPreview(values.overheadPct, values.netMarginPct);
  return (
    <p ref={ref} className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700 ring-1 ring-slate-200" aria-live="polite" data-margin-preview>
      {p ? p.text : 'Enter the overhead and the target net margin to see the gross margin they make.'}{' '}
      <span className="text-slate-500">Prices are direct cost × (1 + overhead) ÷ (1 − net margin).</span>
    </p>
  );
}
