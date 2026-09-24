/**
 * @fileoverview Shared input conventions for every grantsgov tool. Form clients
 * submit every optional field, blank, so blank strings and emptied lists read as
 * unset. Inputs that accept several spellings advertise the raw forms in
 * `tools/list` and normalize in the schema, so a client validating arguments
 * against the advertised schema never rejects a spelling the server accepts.
 * @module mcp-server/tools/input-schemas
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Treat blank/whitespace-only strings as unset; trim everything else. */
export const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' ? (value.trim() === '' ? undefined : value.trim()) : value;

/** An optional string input where `''` or whitespace-only reads as unset. Never `.min(1)`. */
export const optionalText = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankToUndefined, schema.optional());

/** An optional list input: blank elements are dropped, and a list left empty reads as unset. */
export const optionalList = <T extends z.ZodType>(item: T, max: number) =>
  z.preprocess((value) => {
    if (!Array.isArray(value)) return value;
    const kept = value.map(blankToUndefined).filter((x) => x !== undefined);
    return kept.length === 0 ? undefined : kept;
  }, z.array(item).max(max).optional());

/**
 * Preprocess for number inputs: blank reads as unset, and a digit string (`"30"`)
 * becomes its number, since the mapping is exact.
 */
export const numberFromDigits = (value: unknown): unknown => {
  const normalized = blankToUndefined(value);
  return typeof normalized === 'string' && /^\d+$/.test(normalized)
    ? Number(normalized)
    : normalized;
};

/** Preprocess for enum inputs: trims and lowercases a string, passes anything else through. */
export const trimLower = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * A JSON Schema pattern admitting `core` with surrounding whitespace, or a blank
 * value. No regex flags: `tools/list` carries only the source, so a flag would
 * advertise a narrower pattern than the server enforces.
 */
export const rawPattern = (core: string) => new RegExp(`^\\s*(?:${core})?\\s*$`);

/**
 * A string input checked in two stages. `tools/list` advertises only the first:
 * `raw`, which admits every spelling the description promises (any case,
 * surrounding whitespace). The value is then normalized, and `normalized`
 * validates the form the handler receives.
 */
export const normalizedString = <T extends z.ZodType<unknown, string>>(
  raw: RegExp,
  rawMessage: string,
  normalize: (value: string) => string,
  normalized: T,
) => z.string().regex(raw, rawMessage).transform(normalize).pipe(normalized);

/**
 * A Grants.gov agency code as the handler receives it. Ten real codes contain
 * spaces (`DOT-FAA-FAA COE`, `DOT-FTA - TPM`), so single interior spaces are
 * allowed.
 */
export const AGENCY_CODE = /^[A-Z0-9](?:[A-Z0-9 -]*[A-Z0-9])?$/;

/** Trims, uppercases (lowercase matches nothing upstream), and collapses interior whitespace runs. */
export const normalizeAgencyCode = (value: string): string =>
  value.trim().toUpperCase().replace(/\s+/g, ' ');

/** An agency code in any case (`hhs-nih11`), normalized to {@link AGENCY_CODE}. */
export const AGENCY_CODE_INPUT = normalizedString(
  rawPattern('[A-Za-z0-9](?:[A-Za-z0-9\\s-]*[A-Za-z0-9])?'),
  'An agency code is letters, digits, hyphens, and single spaces, e.g. HHS-NIH11.',
  normalizeAgencyCode,
  z.string().regex(AGENCY_CODE),
);

/** Trims, then removes one pair of double quotes around the whole value and trims again. */
export const unquoteOpportunityNumber = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).trim()
    : trimmed;
};

/**
 * An agency-assigned opportunity number. It is sent to Grants.gov wrapped in
 * double quotes (the field is query-parsed), so a quote inside the number is
 * rejected; no real number contains one. One pair around the whole value is
 * removed. Internal spaces are kept: numbers with spaces exist.
 */
export const OPPORTUNITY_NUMBER_INPUT = normalizedString(
  rawPattern('"[^"]*"|[^"]*'),
  'An opportunity number cannot contain a double quote; only one pair around the whole number is accepted.',
  unquoteOpportunityNumber,
  z
    .string()
    .min(1, 'An opportunity number cannot be empty.')
    .max(100, 'An opportunity number is at most 100 characters.'),
);
