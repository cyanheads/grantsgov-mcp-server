/**
 * @fileoverview Builds the reference snapshot (the live filter vocabulary with
 * counts and the agency tree) from two facets-only `search2` responses, and
 * encodes agency filters against it. Pure; no I/O.
 * @module services/grants-gov/reference
 */

import type {
  AgencyNode,
  RawFacetOption,
  RawFacets,
  ReferenceCode,
  ReferenceSnapshot,
} from './types.js';

/** `code` sits directly under `candidate`: `candidate`, optional spaces, `-`, then more. */
function extendsCode(code: string, candidate: string): boolean {
  return (
    code.length > candidate.length &&
    code.startsWith(candidate) &&
    /^ *-./.test(code.slice(candidate.length))
  );
}

const trimmed = (value: string | null | undefined) => value?.trim() ?? '';

/** Code → count over a flat facet list, skipping entries without a code. */
function countsByCode(options: readonly RawFacetOption[] | null | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const option of options ?? []) {
    const code = trimmed(option.value);
    if (code && !counts.has(code)) counts.set(code, option.count ?? 0);
  }
  return counts;
}

/** Code → count over every agency code (top-level and sub-agency), folding self sub-entries into the parent. */
function agencyCounts(facets: RawFacets): Map<string, number> {
  const counts = new Map<string, number>();
  for (const top of facets.agencies ?? []) {
    const topCode = trimmed(top.value);
    if (!topCode) continue;
    counts.set(topCode, top.count ?? 0);
    for (const sub of top.subAgencyOptions ?? []) {
      const code = trimmed(sub.value);
      if (code && code !== topCode && !counts.has(code)) counts.set(code, sub.count ?? 0);
    }
  }
  return counts;
}

/** A flat vocabulary list sorted by code, with open counts looked up in the default-scope facets. */
function vocabulary(
  all: readonly RawFacetOption[] | null | undefined,
  open: readonly RawFacetOption[] | null | undefined,
): ReferenceCode[] {
  const openCounts = countsByCode(open);
  const seen = new Set<string>();
  const entries: ReferenceCode[] = [];
  for (const option of all ?? []) {
    const code = trimmed(option.value);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    entries.push({
      code,
      label: trimmed(option.label) || code,
      openCount: openCounts.get(code) ?? 0,
      totalCount: option.count ?? 0,
    });
  }
  return entries.sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Builds the snapshot from the all-statuses facets (full vocabulary and total
 * counts) and the default-scope facets (open counts). Codes appear only when at
 * least one opportunity carries them, which is what makes the snapshot a valid
 * allowlist. Agency parents come from hyphen prefixes: a code's parent is the
 * longest other code it extends (`DOT-FTA - TPM` → `DOT-FTA`), else its top-level
 * agency. A top-level agency listed under itself is folded into its own row.
 */
export function buildReferenceSnapshot(
  all: RawFacets,
  open: RawFacets,
  fetchedAt: string,
): ReferenceSnapshot {
  const openCounts = agencyCounts(open);
  const labels = new Map<string, string>();
  const topOf = new Map<string, string>();
  const topLevelAgencies: string[] = [];

  for (const top of all.agencies ?? []) {
    const topCode = trimmed(top.value);
    if (!topCode || labels.has(topCode)) continue;
    labels.set(topCode, trimmed(top.label) || topCode);
    topLevelAgencies.push(topCode);
  }
  for (const top of all.agencies ?? []) {
    const topCode = trimmed(top.value);
    if (!topCode) continue;
    for (const sub of top.subAgencyOptions ?? []) {
      const code = trimmed(sub.value);
      if (!code || code === topCode || labels.has(code)) continue;
      labels.set(code, trimmed(sub.label) || code);
      topOf.set(code, topCode);
    }
  }

  const totals = agencyCounts(all);
  const codes = [...labels.keys()];
  const parents = new Map<string, string>();
  for (const [code, topCode] of topOf) {
    let parent = topCode;
    for (const candidate of codes) {
      if (candidate.length > parent.length && extendsCode(code, candidate)) parent = candidate;
    }
    parents.set(code, parent);
  }

  const children = new Map<string, string[]>();
  for (const [code, parent] of parents) {
    const list = children.get(parent) ?? [];
    list.push(code);
    children.set(parent, list);
  }

  const descendantsOf = (code: string): string[] =>
    (children.get(code) ?? []).flatMap((child) => [child, ...descendantsOf(child)]);

  const agencies = new Map<string, AgencyNode>();
  for (const code of codes.sort((a, b) => a.localeCompare(b))) {
    const parentCode = parents.get(code);
    agencies.set(code, {
      code,
      label: labels.get(code) ?? code,
      openCount: openCounts.get(code) ?? 0,
      totalCount: totals.get(code) ?? 0,
      children: (children.get(code) ?? []).sort((a, b) => a.localeCompare(b)),
      descendants: descendantsOf(code).sort((a, b) => a.localeCompare(b)),
      ...(parentCode !== undefined && { parentCode }),
    });
  }

  const statusCounts: Record<string, number> = {};
  for (const [status, count] of countsByCode(all.oppStatusOptions))
    statusCounts[status.toLowerCase()] = count;

  return {
    agencies,
    eligibilities: vocabulary(all.eligibilities, open.eligibilities),
    fetchedAt,
    fundingCategories: vocabulary(all.fundingCategories, open.fundingCategories),
    fundingInstruments: vocabulary(all.fundingInstruments, open.fundingInstruments),
    statusCounts,
    topLevelAgencies: topLevelAgencies.sort((a, b) => a.localeCompare(b)),
  };
}

/** What an agency filter value names in the snapshot. */
export type AgencyScope =
  | { kind: 'code'; node: AgencyNode }
  /** A hyphen-delimited prefix of real codes that is not a code itself (`HHS-OS`). */
  | { kind: 'prefix'; prefix: string; codes: string[] };

/**
 * Resolves an agency value to a snapshot code, or to the codes it is a
 * hyphen-delimited prefix of. `undefined` when it is neither.
 */
export function resolveAgencyScope(
  snapshot: ReferenceSnapshot,
  value: string,
): AgencyScope | undefined {
  const node = snapshot.agencies.get(value);
  if (node) return { kind: 'code', node };
  const codes = [...snapshot.agencies.keys()].filter((code) => extendsCode(code, value));
  return codes.length > 0 ? { kind: 'prefix', prefix: value, codes } : undefined;
}

const quote = (code: string) => `"${code}"`;

/**
 * Encodes validated agency values for `search2`'s query-parsed `agencies` field.
 *
 * 1. Self: a space-free code is sent bare, a code with a space quoted. A prefix
 *    that is not a code sends no self term.
 * 2. Descendants (only when some exist): a space-free value adds `VALUE-*`, an
 *    exact subtree at every level (`VALUE*` would also catch unrelated codes
 *    that extend it without a hyphen). A value with a space cannot carry a
 *    wildcard inside quotes, so its descendants are listed explicitly, quoted.
 * 3. Descendants `VALUE-*` cannot match (`DOT-FTA - TPM` under `DOT-FTA`) are
 *    appended explicitly, quoted.
 *
 * @throws Error when a value is neither a code nor a prefix — callers validate first.
 */
export function encodeAgencyFilter(values: readonly string[], snapshot: ReferenceSnapshot): string {
  const parts: string[] = [];
  for (const value of values) {
    const scope = resolveAgencyScope(snapshot, value);
    if (!scope) throw new Error(`encodeAgencyFilter: "${value}" is not a validated agency value`);
    const descendants = scope.kind === 'code' ? scope.node.descendants : scope.codes;
    const hasSpace = value.includes(' ');

    if (scope.kind === 'code') parts.push(hasSpace ? quote(value) : value);
    if (descendants.length === 0) continue;
    if (hasSpace) {
      parts.push(...descendants.map(quote));
      continue;
    }
    parts.push(`${value}-*`);
    parts.push(...descendants.filter((code) => !code.startsWith(`${value}-`)).map(quote));
  }
  return [...new Set(parts)].join('|');
}
