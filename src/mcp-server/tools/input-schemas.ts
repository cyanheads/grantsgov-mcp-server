/**
 * @fileoverview Shared input conventions for every grantsgov tool. Form clients
 * submit every optional field, blank, so blank strings and emptied lists read as
 * unset; value normalization runs in the schema, ahead of the pattern check.
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
 * Preprocess for number inputs: blank reads as unset, and a digit string (`"30"`,
 * or an id as search rows emit it) becomes its number, since the mapping is exact.
 */
export const numberFromDigits = (value: unknown): unknown => {
  const normalized = blankToUndefined(value);
  return typeof normalized === 'string' && /^\d+$/.test(normalized)
    ? Number(normalized)
    : normalized;
};

/**
 * An agency-assigned opportunity number. It is sent to Grants.gov wrapped in
 * double quotes (the field is query-parsed), so `"` is rejected; no real number
 * contains one. Internal spaces are kept: numbers with spaces exist.
 */
export const OPPORTUNITY_NUMBER = z
  .string()
  .max(100)
  .regex(/^[^"]+$/, 'An opportunity number cannot contain a double quote.');

/**
 * A Grants.gov agency code. Ten real codes contain spaces (`DOT-FAA-FAA COE`,
 * `DOT-FTA - TPM`), so single interior spaces are allowed.
 */
export const AGENCY_CODE = /^[A-Z0-9](?:[A-Z0-9 -]*[A-Z0-9])?$/;

/** Trims, uppercases (lowercase matches nothing upstream), and collapses interior whitespace runs. */
export const normalizeAgencyCode = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, ' ') : value;
