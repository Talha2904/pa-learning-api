import { isIsoDate } from '../../shared/utils/dates.js';

/** Small parsers shared by the Excel/CSV importers. Each returns undefined when the value is invalid. */

export function parseYesNo(raw: string | undefined, fallback: boolean): boolean | undefined {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return fallback;
  if (['yes', 'y', 'true', '1', 'mandatory'].includes(v)) return true;
  if (['no', 'n', 'false', '0', 'optional'].includes(v)) return false;
  return undefined;
}

/** Accepts YYYY-MM-DD and UK DD/MM/YYYY. Blank → null. */
export function parseDate(raw: string | undefined): string | null | undefined {
  const v = (raw ?? '').trim();
  if (!v) return null;
  if (isIsoDate(v)) return v;
  const uk = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (uk) {
    const iso = `${uk[3]}-${uk[2]!.padStart(2, '0')}-${uk[1]!.padStart(2, '0')}`;
    if (isIsoDate(iso)) return iso;
  }
  return undefined;
}

export function parseHours(raw: string | undefined, max: number): number | undefined {
  const n = Number((raw ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > max) return undefined;
  return Math.round(n * 100) / 100;
}

/** Case-insensitive lookup by name in a reference list. */
export function byName<T extends { name: string }>(list: T[], raw: string | undefined): T | undefined {
  const v = (raw ?? '').trim().toLowerCase();
  return v ? list.find((x) => x.name.toLowerCase() === v) : undefined;
}

/** Path parts that still mean "front page": index files and language / country codes (e.g. /gb/en.html). */
const LANDING_SEGMENT = /^(index|home|default|welcome|[a-z]{2}(-[a-z]{2})?)$/;

/**
 * True when a learning link goes to a provider's front page (https://www.icaew.com/,
 * https://www.accaglobal.com/gb/en.html) rather than a specific course. Mirrors
 * isHomePageLink in the frontend's lib/forms.ts - keep them in sync.
 */
export function isHomePageLink(link: string | null | undefined): boolean {
  if (!link) return false;
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol) || u.search || u.hash) return false;
  return u.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => s.toLowerCase().replace(/\.(html?|php|aspx?)$/, ''))
    .every((s) => LANDING_SEGMENT.test(s));
}

export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
