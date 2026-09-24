/**
 * @fileoverview Pure normalizers for Grants.gov values: US Eastern "today", the
 * four upstream date shapes, money and count strings, close-date kind, and HTML
 * entity decoding.
 * @module services/grants-gov/normalize
 */

/** How a listed close date should be read. */
export type CloseDateKind = 'fixed' | 'none_listed' | 'placeholder';

/** A close date this many years past the current ET year is an "accepted anytime" stand-in. */
const PLACEHOLDER_YEARS_OUT = 25;

const DAY_MS = 86_400_000;

const etDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's date in US Eastern Time (the zone Grants.gov publishes in), as `YYYY-MM-DD`. */
export function todayET(now: Date = new Date()): string {
  return etDateFormat.format(now);
}

/** Calendar arithmetic on `YYYY-MM-DD` dates, independent of the host time zone. */
export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS,
  );
}

/** Builds `YYYY-MM-DD` from parts, or `undefined` when they do not form a real calendar date. */
function isoFromParts(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return;
  }
  return date.toISOString().slice(0, 10);
}

/** Parses a search-row date, `MM/DD/YYYY`. Blank or malformed → `undefined`. */
export function parseSlashDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return;
  const match = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(raw);
  if (!match) return;
  return isoFromParts(Number(match[3]), Number(match[1]), Number(match[2]));
}

/**
 * Parses a detail-record `…Str` date (`2026-10-19-00-00-00`) or an already-ISO
 * date (`2026-10-19`). The midnight time component is an artifact and is dropped.
 */
export function parseStrDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return;
  const match = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[-T\s].*)?$/.exec(raw);
  if (!match) return;
  return isoFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Parses a long-form date: `Oct 19, 2026 12:00:00 AM EDT` (detail record) or
 * `Mar 20, 2015` (related opportunities). The time and zone are dropped — the
 * calendar date is what the upstream reports.
 */
export function parseLongDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return;
  const match = /^\s*([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})\b/.exec(raw);
  if (!match) return;
  const month = MONTHS[match[1]?.toLowerCase() ?? ''];
  if (!month) return;
  return isoFromParts(Number(match[3]), month, Number(match[2]));
}

/**
 * Parses an upstream money string (`"10116100"`, `"1,500,000"`, `"$250000.00"`).
 * `"none"`, `""`, `null`, missing, and any non-numeric value → `undefined`;
 * `"0"` is kept as `0` (some agencies list 0 alongside a real funding total).
 */
export function parseMoney(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
  if (typeof raw !== 'string') return;
  const cleaned = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return;
  return Number(cleaned);
}

/** Parses an upstream whole-number string (`"63"`). Anything else → `undefined`. */
export function parseCount(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 ? raw : undefined;
  if (typeof raw !== 'string') return;
  const cleaned = raw.trim().replace(/,/g, '');
  if (!/^\d+$/.test(cleaned)) return;
  return Number(cleaned);
}

/**
 * Classifies a close date: absent → `none_listed`; a year at least
 * {@link PLACEHOLDER_YEARS_OUT} past today's ET year (the `01/01/2099` sentinel,
 * NSF "accepted anytime" dates) → `placeholder`; anything else → `fixed`.
 */
export function closeDateKind(closeIso: string | undefined, today: string): CloseDateKind {
  if (!closeIso) return 'none_listed';
  return Number(closeIso.slice(0, 4)) >= Number(today.slice(0, 4)) + PLACEHOLDER_YEARS_OUT
    ? 'placeholder'
    : 'fixed';
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: '\xa0',
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

/** A numeric reference to a valid, non-surrogate code point; `undefined` otherwise. */
function fromCodePoint(codePoint: number): string | undefined {
  if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return;
  return String.fromCodePoint(codePoint);
}

/**
 * Decodes HTML entities in one pass: the named set Grants.gov emits plus numeric
 * `&#…;` / `&#x…;` references. Unknown named entities are left as written, and a
 * double-encoded `&amp;rsquo;` decodes once, to `&rsquo;`.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      return fromCodePoint(Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10)) ?? entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}
