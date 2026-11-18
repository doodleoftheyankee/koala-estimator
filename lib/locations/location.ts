// A franchise store ("location"): its name, time zone, state, contact details and branding, read
// from the locations table. Nothing in the app names a store; it always comes from here.
// Pure (no I/O) so it can be tested; lib/server/location.ts does the queries.
import { z } from 'zod';
import type { Role } from '@/lib/pricing';

export interface LocationInfo {
  id: string;
  name: string;
  shortName: string;
  timeZone: string;
  state: string;
  county: string | null;
  climateZone: string;
  shopAddress: string | null;
  phone: string | null;
  licenseNumber: string | null;
  quoteFromEmail: string | null;
  officeNotifyEmail: string | null;
  ownerReportEmail: string | null;
  logoPath: string | null;
  brandColor: string | null;
  utilities: string[];
  rowVersion: number;
}

/** Columns read for a LocationInfo. */
export const LOCATION_COLUMNS =
  'id, name, short_name, time_zone, state, default_county, climate_zone, shop_address, phone, license_number, ' +
  'quote_from_email, office_notify_email, owner_report_email, logo_path, brand_color, utilities, row_version';

const text = z.string().nullish().transform((v) => (v && v.trim() ? v.trim() : null));

const locationRowSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  short_name: z.string().min(1),
  time_zone: z.string().min(1),
  state: z.string().length(2),
  default_county: text,
  climate_zone: z.string().min(1),
  shop_address: text,
  phone: text,
  license_number: text,
  quote_from_email: text,
  office_notify_email: text,
  owner_report_email: text,
  logo_path: text,
  brand_color: text,
  utilities: z.array(z.string()).nullish(),
  row_version: z.coerce.number().int().catch(1),
});

export function parseLocation(row: unknown): LocationInfo {
  const r = locationRowSchema.parse(row);
  return {
    id: r.id,
    name: r.name,
    shortName: r.short_name,
    timeZone: r.time_zone,
    state: r.state,
    county: r.default_county,
    climateZone: r.climate_zone,
    shopAddress: r.shop_address,
    phone: r.phone,
    licenseNumber: r.license_number,
    quoteFromEmail: r.quote_from_email,
    officeNotifyEmail: r.office_notify_email,
    ownerReportEmail: r.owner_report_email,
    logoPath: r.logo_path,
    brandColor: r.brand_color,
    utilities: (r.utilities ?? []).map((u) => u.trim()).filter(Boolean),
    rowVersion: r.row_version,
  };
}

/** One store the signed-in person works in, with their role there (my_locations()). */
export interface Membership {
  locationId: string;
  name: string;
  shortName: string;
  role: Role;
}

const membershipRowSchema = z.object({
  location_id: z.string(),
  name: z.string(),
  short_name: z.string(),
  role: z.enum(['owner', 'office', 'estimator', 'crew']),
});

export function parseMemberships(rows: unknown): Membership[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const r = membershipRowSchema.safeParse(row);
    return r.success ? [{ locationId: r.data.location_id, name: r.data.name, shortName: r.data.short_name, role: r.data.role }] : [];
  });
}

/** Cookie that remembers which store a person in several stores is working in. */
export const LOCATION_COOKIE = 'koala_location';

/**
 * The store this request works in: the one the person picked (cookie) if they still work there,
 * otherwise the first of their stores by name. Null when they work in none.
 */
export function pickMembership(memberships: Membership[], chosen: string | null | undefined): Membership | null {
  if (!memberships.length) return null;
  return memberships.find((m) => m.locationId === chosen) ?? [...memberships].sort((a, b) => a.name.localeCompare(b.name))[0]!;
}

const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/** "Delaware" for "DE"; the code itself when unknown. */
export function stateName(code: string): string {
  return STATE_NAMES[code.toUpperCase()] ?? code.toUpperCase();
}

/** True for a time zone this runtime can format dates in. */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Who a store's emails come from: the store's own sender, else the deployment's QUOTE_FROM_EMAIL,
 * else the store's name on the email provider's test address.
 */
export function senderAddress(location: Pick<LocationInfo, 'name' | 'quoteFromEmail'>, envFrom: string | null): string {
  if (location.quoteFromEmail) return location.quoteFromEmail.includes('<') ? location.quoteFromEmail : `${location.name} <${location.quoteFromEmail}>`;
  if (envFrom) return envFrom;
  return `${location.name.replace(/[<>"]/g, '')} <onboarding@resend.dev>`;
}
