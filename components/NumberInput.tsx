'use client';
import { useState, type InputHTMLAttributes } from 'react';
import { Input } from './ui';

/**
 * Numeric input that lets people type freely ("12.", "") and reports a number or null.
 * Uses a decimal keypad on phones.
 */
export function NumberInput({
  value,
  onValue,
  allowDecimal = true,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: number | null;
  onValue: (v: number | null) => void;
  allowDecimal?: boolean;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [prevValue, setPrevValue] = useState(value);
  // Adopt outside changes, unless the user is mid-typing an equivalent value ("12." vs 12).
  if (value !== prevValue) {
    setPrevValue(value);
    if (parse(text) !== value) setText(value === null ? '' : String(value));
  }
  return (
    <Input
      {...props}
      type="text"
      inputMode={allowDecimal ? 'decimal' : 'numeric'}
      value={text}
      onChange={(e) => {
        const t = e.target.value.replace(/[^0-9.]/g, '');
        setText(t);
        onValue(parse(t));
      }}
    />
  );
}

function parse(t: string): number | null {
  if (t.trim() === '' || t === '.') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
