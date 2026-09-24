/**
 * @fileoverview grantsgov_list_reference — decodes the codes the search filters
 * take (agencies, applicant eligibility, funding categories and instruments)
 * from a live snapshot with opportunity counts, plus the static statuses, sort
 * options, and keyword syntax.
 * @module mcp-server/tools/definitions/grantsgov-list-reference.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGrantsGovService } from '@/services/grants-gov/grants-gov-service.js';
import { resolveAgencyScope } from '@/services/grants-gov/reference.js';
import type { ReferenceCode, ReferenceSnapshot } from '@/services/grants-gov/types.js';
import { AGENCY_CODE, normalizeAgencyCode, optionalText } from '../input-schemas.js';
import { tableCell } from '../render.js';

const TOPICS = [
  'agencies',
  'eligibilities',
  'funding_categories',
  'funding_instruments',
  'statuses',
  'sort_options',
  'keyword_syntax',
] as const;

type Topic = (typeof TOPICS)[number];

interface Entry {
  code: string;
  description?: string;
  has_children?: boolean;
  label: string;
  open_count?: number;
  parent_code?: string;
  total_count?: number;
}

const STATUS_ENTRIES: readonly Omit<Entry, 'total_count'>[] = [
  {
    code: 'forecasted',
    label: 'Forecasted',
    description: 'Announced ahead of posting; its dates are estimates. Searched by default.',
  },
  { code: 'posted', label: 'Posted', description: 'Open for applications. Searched by default.' },
  {
    code: 'closed',
    label: 'Closed',
    description: 'Past the close date, awaiting archive. Add to statuses to include.',
  },
  {
    code: 'archived',
    label: 'Archived',
    description: 'Past the archive date. Add to statuses to include.',
  },
];

const SORT_ENTRIES: readonly Entry[] = [
  {
    code: 'relevance',
    label: 'Best keyword match',
    description:
      'Needs a keyword; without one the order is arbitrary. The default when keyword is set.',
  },
  {
    code: 'open_date_desc',
    label: 'Newest posted first',
    description: 'No keyword needed. The default when keyword is not set.',
  },
  { code: 'open_date_asc', label: 'Oldest posted first', description: 'No keyword needed.' },
  {
    code: 'close_date_asc',
    label: 'Closing soonest first',
    description:
      'No keyword needed. Opportunities with no close date sort last. The only sort closing_within_days allows.',
  },
  {
    code: 'close_date_desc',
    label: 'Closing latest first',
    description: 'No keyword needed. Opportunities with no close date sort first.',
  },
  {
    code: 'opportunity_number_asc',
    label: 'Opportunity number, A to Z',
    description: 'No keyword needed.',
  },
  {
    code: 'opportunity_number_desc',
    label: 'Opportunity number, Z to A',
    description: 'No keyword needed.',
  },
  { code: 'agency_asc', label: 'Agency code, A to Z', description: 'No keyword needed.' },
  { code: 'agency_desc', label: 'Agency code, Z to A', description: 'No keyword needed.' },
];

const KEYWORD_SYNTAX_ENTRIES: readonly Entry[] = [
  {
    code: 'term',
    label: 'Word',
    description:
      'rural matches the word in the title, description, opportunity number, or agency. Separate words are all required: rural broadband is searched as rural AND broadband.',
  },
  {
    code: '"phrase"',
    label: 'Exact phrase',
    description:
      '"mental health" matches the words together, in order. A word with an internal hyphen or period (COVID-19, K-12, 93.866) is matched as a phrase automatically.',
  },
  {
    code: 'AND',
    label: 'All of',
    description:
      'rural AND broadband requires both words. AND is already implied between bare words, and and/or/not are read as operators in any case.',
  },
  {
    code: 'OR',
    label: 'Any of',
    description:
      'rural OR tribal matches either word. Use OR to widen a search instead of listing bare words.',
  },
  {
    code: 'NOT / -term',
    label: 'Exclude',
    description:
      'broadband NOT satellite and broadband -satellite both drop records mentioning satellite. A lone NOT satellite is also valid.',
  },
  {
    code: '( … )',
    label: 'Group',
    description:
      '(rural OR tribal) AND broadband groups alternatives. Unbalanced quotes or parentheses and a leading, trailing, or doubled operator are rejected.',
  },
  {
    code: 'term*',
    label: 'Prefix wildcard',
    description:
      'broad* matches broadband, broadcast, and other words starting with broad. Trailing position only.',
  },
  {
    code: ': ~ ? [ ] { } ^ \\ / ! +',
    label: 'Removed characters',
    description:
      'Field, fuzzy, range, and boost syntax is not supported; these characters are replaced by a space. && and || are read as AND and OR.',
  },
];

/** Lowercase, strip diacritics and punctuation, so matching ignores case, accents, and hyphens. */
const normalizeForMatch = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ');

/** The words of a `name_contains` value; empty when it has no letters or digits. */
const nameTokens = (query: string) => normalizeForMatch(query).split(/\s+/).filter(Boolean);

/** Strict token match: every token appears in the entry's label or code. */
function matchesName(entry: Entry, tokens: readonly string[]): boolean {
  const haystack = normalizeForMatch(`${entry.label} ${entry.code}`);
  return tokens.every((token) => haystack.includes(token));
}

const vocabularyEntry = ({ code, label, openCount, totalCount }: ReferenceCode): Entry => ({
  code,
  label,
  open_count: openCount,
  total_count: totalCount,
});

function agencyEntry(snapshot: ReferenceSnapshot, code: string): Entry {
  const node = snapshot.agencies.get(code);
  if (!node) return { code, label: code };
  return {
    code,
    label: node.label,
    ...(node.parentCode !== undefined && { parent_code: node.parentCode }),
    has_children: node.children.length > 0,
    open_count: node.openCount,
    total_count: node.totalCount,
  };
}

/** Entries for the snapshot-backed topics other than agencies. */
function vocabularyEntries(
  topic: Exclude<Topic, 'agencies' | 'sort_options' | 'keyword_syntax'>,
  snapshot: ReferenceSnapshot,
): Entry[] {
  switch (topic) {
    case 'eligibilities':
      return snapshot.eligibilities.map(vocabularyEntry);
    case 'funding_categories':
      return snapshot.fundingCategories.map(vocabularyEntry);
    case 'funding_instruments':
      return snapshot.fundingInstruments.map(vocabularyEntry);
    case 'statuses':
      return STATUS_ENTRIES.map((entry) => ({
        ...entry,
        total_count: snapshot.statusCounts[entry.code] ?? 0,
      }));
  }
}

export const grantsgovListReference = tool('grantsgov_list_reference', {
  title: 'List Grants.gov Reference Codes',
  description:
    "List the codes Grants.gov search filters accept, with labels and live opportunity counts: agencies (top level, or one agency's sub-agencies via parent_code, or matched by name via name_contains), applicant eligibility types, funding categories, funding instruments, statuses, sort options, and keyword syntax. Use the codes as grantsgov_search_opportunities inputs.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    topic: z
      .enum(TOPICS)
      .describe(
        'Which list to return: agencies (agency codes), eligibilities (two-digit applicant-type codes), funding_categories, funding_instruments, statuses, sort_options, or keyword_syntax.',
      ),
    name_contains: optionalText(z.string().max(100)).describe(
      'Keep only entries whose label or code contains every word given, ignoring case, accents, and punctuation (e.g. "national science", "nih"). For agencies this searches every code, top-level and sub-agency. Works with every topic. A value with no letters or digits matches nothing.',
    ),
    parent_code: optionalText(
      z.preprocess(normalizeAgencyCode, z.string().regex(AGENCY_CODE)),
    ).describe(
      'Agencies only: list every code under this agency at any depth (e.g. HHS, DOD-DARPA). Case-insensitive. Omit for the top-level list.',
    ),
  }),

  output: z.object({
    topic: z.enum(TOPICS).describe('The topic listed.'),
    entries: z
      .array(
        z
          .object({
            code: z
              .string()
              .describe(
                'Value to pass to the matching grantsgov_search_opportunities input (agencies, eligibilities, funding_categories, funding_instruments, statuses, or sort); for keyword_syntax, the form to write inside keyword.',
              ),
            label: z.string().describe('Human-readable name.'),
            parent_code: z.string().optional().describe('agencies only: the parent agency code.'),
            has_children: z
              .boolean()
              .optional()
              .describe(
                'agencies only: true when the code has sub-agencies (searching it includes them).',
              ),
            open_count: z
              .number()
              .optional()
              .describe(
                'Forecasted + posted opportunities with this code. For a top-level agency this covers its sub-agencies; for a sub-agency, only records filed at exactly this code.',
              ),
            total_count: z
              .number()
              .optional()
              .describe(
                'Opportunities with this code across all statuses, counted the same way as open_count.',
              ),
            description: z
              .string()
              .optional()
              .describe('Usage notes for statuses, sort_options, and keyword_syntax entries.'),
          })
          .describe('One reference entry.'),
      )
      .describe('Reference entries.'),
    snapshot_date: z
      .string()
      .optional()
      .describe(
        'When the live vocabulary was fetched (ISO timestamp); absent for fully static topics.',
      ),
  }),

  enrichment: {
    totalCount: z.number().describe('Entries returned.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when name_contains matched nothing, or when parent_code has no sub-agencies.',
      ),
  },

  errors: [
    {
      reason: 'unknown_parent_code',
      code: JsonRpcErrorCode.NotFound,
      when: 'parent_code is not a known agency code.',
      recovery:
        'Call grantsgov_list_reference with topic agencies and name_contains set to the agency name to find its code.',
    },
    {
      reason: 'filter_not_applicable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'parent_code given with a topic other than agencies.',
      recovery:
        'Remove parent_code, or call grantsgov_list_reference with topic agencies to list sub-agencies.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The snapshot fetch failed after retries and no cached snapshot exists.',
      recovery:
        'Grants.gov is not responding; wait a minute and call grantsgov_list_reference again.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The snapshot fetch got HTTP 429 (rate limited) through every retry, and no cached snapshot exists.',
      recovery:
        'Grants.gov is rate limiting requests; wait the retryAfter interval (or a minute) and call grantsgov_list_reference again.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_route_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The snapshot fetch got HTTP 403 Missing Authentication Token (the search route no longer exists at the gateway), and no cached snapshot exists.',
      recovery:
        'The Grants.gov search API route is not answering; the legacy API may have been retired, so report this to the server maintainer.',
      retryable: false,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich.total(0);
    const { topic, name_contains: nameContains, parent_code: parentCode } = input;

    if (parentCode !== undefined && topic !== 'agencies') {
      throw ctx.fail(
        'filter_not_applicable',
        `parent_code applies only to topic agencies, not ${topic}.`,
        {
          ...ctx.recoveryFor('filter_not_applicable'),
        },
      );
    }

    let entries: Entry[];
    let snapshotDate: string | undefined;
    let leafParent = false;

    if (topic === 'sort_options') {
      entries = [...SORT_ENTRIES];
    } else if (topic === 'keyword_syntax') {
      entries = [...KEYWORD_SYNTAX_ENTRIES];
    } else {
      const snapshot = await getGrantsGovService().getReference(ctx);
      snapshotDate = snapshot.fetchedAt;
      if (topic !== 'agencies') {
        entries = vocabularyEntries(topic, snapshot);
      } else if (parentCode !== undefined) {
        const scope = resolveAgencyScope(snapshot, parentCode);
        if (!scope) {
          throw ctx.fail(
            'unknown_parent_code',
            `No agency code "${parentCode}" in the Grants.gov vocabulary.`,
            {
              parentCode,
              ...ctx.recoveryFor('unknown_parent_code'),
            },
          );
        }
        const codes = scope.kind === 'code' ? scope.node.descendants : scope.codes;
        leafParent = codes.length === 0;
        entries = codes.map((code) => agencyEntry(snapshot, code));
      } else {
        const codes =
          nameContains !== undefined ? [...snapshot.agencies.keys()] : snapshot.topLevelAgencies;
        entries = codes.map((code) => agencyEntry(snapshot, code));
      }
    }

    const tokens = nameContains === undefined ? undefined : nameTokens(nameContains);
    if (tokens !== undefined)
      entries = tokens.length === 0 ? [] : entries.filter((entry) => matchesName(entry, tokens));
    ctx.enrich.total(entries.length);

    if (tokens !== undefined && tokens.length === 0) {
      ctx.enrich.notice(
        `name_contains "${nameContains}" has no letters or digits, so it matches nothing. Pass a word from the name, or call grantsgov_list_reference with topic ${topic} and no name_contains to browse the full list.`,
      );
    } else if (leafParent) {
      ctx.enrich.notice(
        `${parentCode} has no sub-agencies. Pass it directly as an agencies filter to grantsgov_search_opportunities.`,
      );
    } else if (entries.length === 0 && nameContains !== undefined) {
      ctx.enrich.notice(
        `No ${topic} entry matched "${nameContains}". Try a shorter name or a single distinctive word, or call grantsgov_list_reference with topic ${topic} and no name_contains to browse the full list.`,
      );
    }

    ctx.log.info('Listed reference entries', { topic, count: entries.length });
    return { topic, entries, ...(snapshotDate !== undefined && { snapshot_date: snapshotDate }) };
  },

  format: (result) => {
    const { entries } = result;
    const lines = [`## Grants.gov reference: ${result.topic}`, ''];
    if (result.snapshot_date) lines.push(`Live vocabulary fetched ${result.snapshot_date}.`, '');
    if (entries.length === 0) {
      lines.push('No entries.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    type Row = (typeof entries)[number];
    const optionalColumns: { key: keyof Row; header: string; cell: (entry: Row) => string }[] = [
      {
        key: 'parent_code',
        header: 'Parent',
        cell: (e) => (e.parent_code ? `\`${tableCell(e.parent_code)}\`` : ''),
      },
      {
        key: 'has_children',
        header: 'Has sub-agencies',
        cell: (e) => (e.has_children === undefined ? '' : e.has_children ? 'yes' : 'no'),
      },
      { key: 'open_count', header: 'Open', cell: (e) => String(e.open_count ?? '') },
      { key: 'total_count', header: 'All statuses', cell: (e) => String(e.total_count ?? '') },
      {
        key: 'description',
        header: 'Notes',
        cell: (e) => (e.description ? tableCell(e.description) : ''),
      },
    ];
    const columns = [
      { header: 'Code', cell: (e: Row) => `\`${tableCell(e.code)}\`` },
      { header: 'Label', cell: (e: Row) => tableCell(e.label) },
      ...optionalColumns.filter(({ key }) => entries.some((entry) => entry[key] !== undefined)),
    ];

    lines.push(
      `| ${columns.map((c) => c.header).join(' | ')} |`,
      `|${columns.map(() => ':---').join('|')}|`,
    );
    for (const entry of entries) lines.push(`| ${columns.map((c) => c.cell(entry)).join(' | ')} |`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
