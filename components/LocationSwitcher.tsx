'use client';
// Store picker for people who work in more than one store. Hidden for everyone else.
import { switchLocation } from '@/app/location/actions';
import type { Membership } from '@/lib/locations/location';

export function LocationSwitcher({ memberships, current }: { memberships: Membership[]; current: string }) {
  if (memberships.length < 2) return null;
  return (
    <form action={switchLocation}>
      <label className="sr-only" htmlFor="location-switcher">
        Store
      </label>
      <select
        id="location-switcher"
        name="locationId"
        defaultValue={current}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="min-h-11 rounded-lg border border-slate-300 bg-white px-2 text-sm font-medium text-slate-800"
      >
        {memberships.map((m) => (
          <option key={m.locationId} value={m.locationId}>
            {m.shortName}
          </option>
        ))}
      </select>
    </form>
  );
}
