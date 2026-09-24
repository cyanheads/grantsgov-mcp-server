/**
 * @fileoverview grantsgov_search_opportunities — searches Grants.gov funding
 * opportunities by keyword and filters, deadline first, with facet counts. Three
 * modes share one enrichment contract: a plain upstream page, an exact
 * opportunity-number match paged locally, and a server-side closing-window scan.
 * @module mcp-server/tools/definitions/grantsgov-search-opportunities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  cutClosingWindow,
  getGrantsGovService,
  isSameOpportunityNumber,
  quoteOppNum,
  SCAN_CEILING,
} from '@/services/grants-gov/grants-gov-service.js';
import { compileKeyword } from '@/services/grants-gov/keyword.js';
import {
  addDays,
  closeDateKind,
  daysBetween,
  decodeEntities,
  parseSlashDate,
  todayET,
} from '@/services/grants-gov/normalize.js';
import { encodeAgencyFilter, resolveAgencyScope } from '@/services/grants-gov/reference.js';
import type {
  ClosingWindowScan,
  RawFacetOption,
  RawFacets,
  RawHit,
  Search2Body,
} from '@/services/grants-gov/types.js';
import {
  AGENCY_CODE,
  normalizeAgencyCode,
  numberFromDigits,
  OPPORTUNITY_NUMBER,
  optionalList,
  optionalText,
} from '../input-schemas.js';
import { inline, tableCell } from '../render.js';

const STATUSES = ['forecasted', 'posted', 'closed', 'archived'] as const;
type Status = (typeof STATUSES)[number];
const DEFAULT_STATUSES: readonly Status[] = ['forecasted', 'posted'];

const SORTS = [
  'relevance',
  'open_date_desc',
  'open_date_asc',
  'close_date_asc',
  'close_date_desc',
  'opportunity_number_asc',
  'opportunity_number_desc',
  'agency_asc',
  'agency_desc',
] as const;
type Sort = (typeof SORTS)[number];

/** `sortBy` per sort. Relevance is sent by omitting `sortBy`: every literal relevance value returns 0 upstream. */
const SORT_BY: Readonly<Record<Sort, string | undefined>> = {
  relevance: undefined,
  open_date_desc: 'openDate|desc',
  open_date_asc: 'openDate|asc',
  close_date_asc: 'closeDate|asc',
  close_date_desc: 'closeDate|desc',
  opportunity_number_asc: 'oppNum|asc',
  opportunity_number_desc: 'oppNum|desc',
  agency_asc: 'agency|asc',
  agency_desc: 'agency|desc',
};

const FUNDING_INSTRUMENTS = ['G', 'CA', 'PC', 'O'] as const;

/** Rows fetched for a local exact-match page in opportunity-number mode. */
const NUMBER_MODE_ROWS = 100;
/** The unrestricted applicant-type code ("open to any type of entity"). */
const UNRESTRICTED = '99';

const trimLower = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const trimUpper = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** `7` or `"7"` → `"07"`: the upstream matches zero-padded codes only. */
const padEligibility = (value: unknown): unknown => {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  return /^\d$/.test(trimmed) ? `0${trimmed}` : trimmed;
};

/** Uppercases, strips a leading `ALN`/`CFDA` label, and dots a 5-character form (`93866` → `93.866`). */
const normalizeAln = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const bare = value
    .trim()
    .toUpperCase()
    .replace(/^(?:ALN|CFDA)(?:\s*(?:NO\.?|NUMBER))?\s*[:#]?\s*/, '');
  return /^\d{2}[0-9A-Z]{3}$/.test(bare) ? `${bare.slice(0, 2)}.${bare.slice(2)}` : bare;
};

const facetList = (description: string) =>
  z
    .array(
      z
        .object({
          code: z
            .string()
            .describe('Value to pass to the matching grantsgov_search_opportunities input.'),
          label: z.string().describe('Human-readable name.'),
          count: z.number().describe('Opportunities with this value under the current filters.'),
        })
        .describe('One facet value with its count.'),
    )
    .describe(description);

const OpportunityRow = z
  .object({
    opportunity_id: z
      .string()
      .describe(
        'Numeric Grants.gov id as a digit string. Pass to grantsgov_get_opportunity.opportunity_ids.',
      ),
    opportunity_number: z
      .string()
      .describe('Agency-assigned opportunity number, e.g. HRSA-27-005.'),
    title: z.string().describe('Opportunity title (HTML entities decoded).'),
    status: z.enum(STATUSES).describe('Lifecycle status.'),
    doc_type: z
      .enum(['synopsis', 'forecast'])
      .describe('Whether the record is a posted synopsis or a forecast.'),
    agency_code: z
      .string()
      .optional()
      .describe('Owning agency code, e.g. HHS-HRSA. Omitted when the record lists none.'),
    agency_name: z
      .string()
      .optional()
      .describe('Owning agency name. Omitted when the record lists none.'),
    open_date: z.string().optional().describe('Posting date, YYYY-MM-DD. Omitted when not listed.'),
    close_date: z
      .string()
      .optional()
      .describe('Close date as listed, YYYY-MM-DD. Omitted when none is listed.'),
    close_date_kind: z
      .enum(['fixed', 'none_listed', 'placeholder'])
      .describe(
        'fixed = a real deadline; none_listed = no close date in search (rolling or open-ended, and every forecast: its estimated close date is on the grantsgov_get_opportunity record); placeholder = a far-future stand-in date the agency uses for "accepted anytime".',
      ),
    days_until_close: z
      .number()
      .int()
      .optional()
      .describe(
        'Days from today (US Eastern) to close_date. Present only when close_date_kind is fixed; 0 = closes today; negative for a posted record whose close date passed before Grants.gov updated its status.',
      ),
    assistance_listings: z
      .array(z.string().describe('One assistance listing number, e.g. 93.224.'))
      .describe('Assistance listing numbers (ALN, formerly CFDA). Empty when none listed.'),
  })
  .describe('One matching opportunity.');

type Row = z.infer<typeof OpportunityRow>;
type Facet = { code: string; label: string; count: number };

const AppliedFilters = z
  .object({
    statuses: z.array(z.enum(STATUSES).describe('One status.')).describe('Statuses searched.'),
    statuses_defaulted: z
      .boolean()
      .describe('True when statuses was not given and the default (forecasted, posted) applied.'),
    agencies_sent: z
      .string()
      .optional()
      .describe(
        'Agency filter as sent upstream: pipe-joined, with sub-agency subtrees expanded and codes containing spaces quoted.',
      ),
    eligibilities_sent: z
      .string()
      .optional()
      .describe(
        'Applicant-type codes as sent upstream, pipe-joined, including 99 when include_unrestricted added it.',
      ),
    include_unrestricted: z
      .boolean()
      .describe('The include_unrestricted setting; it acts only when eligibilities is set.'),
    funding_categories: z
      .array(z.string().describe('One category code.'))
      .optional()
      .describe('Funding category codes applied.'),
    funding_instruments: z
      .array(z.string().describe('One instrument code.'))
      .optional()
      .describe('Funding instrument codes applied.'),
    assistance_listing: z.string().optional().describe('Assistance listing number applied.'),
    opportunity_number: z
      .string()
      .optional()
      .describe('Opportunity number matched exactly (case-insensitive).'),
    posted_within_days: z.number().optional().describe('Posting-date window applied, in days.'),
    closing_within_days: z.number().optional().describe('Closing window applied, in days.'),
    closing_cutoff_date: z
      .string()
      .optional()
      .describe('Last close date inside the closing window, YYYY-MM-DD (US Eastern).'),
    sort: z.enum(SORTS).describe('Sort order applied.'),
  })
  .describe('Filters as the server applied them, including defaults and expansions.');

type Applied = z.infer<typeof AppliedFilters>;

function renderAppliedFilters(applied: Applied): string {
  const parts = [
    `statuses ${applied.statuses.join(', ')}${applied.statuses_defaulted ? ' (default)' : ''}`,
    applied.agencies_sent !== undefined && `agencies sent \`${applied.agencies_sent}\``,
    applied.eligibilities_sent !== undefined &&
      `eligibilities sent \`${applied.eligibilities_sent}\``,
    `include_unrestricted ${applied.include_unrestricted}`,
    applied.funding_categories && `funding categories ${applied.funding_categories.join(', ')}`,
    applied.funding_instruments && `funding instruments ${applied.funding_instruments.join(', ')}`,
    applied.assistance_listing !== undefined && `assistance listing ${applied.assistance_listing}`,
    applied.opportunity_number !== undefined &&
      `opportunity number \`${applied.opportunity_number}\``,
    applied.posted_within_days !== undefined && `posted within ${applied.posted_within_days} days`,
    applied.closing_within_days !== undefined &&
      `closing within ${applied.closing_within_days} days (through ${applied.closing_cutoff_date})`,
    `sort ${applied.sort}`,
  ].filter((part): part is string => typeof part === 'string');
  return `**Applied filters:** ${parts.join('; ')}`;
}

/** A search row as output. Upstream statuses and doc types are fixed vocabularies; anything else fails loudly at the output parse. */
function toRow(hit: RawHit, today: string): Row {
  const closeDate = parseSlashDate(hit.closeDate);
  const kind = closeDateKind(closeDate, today);
  const openDate = parseSlashDate(hit.openDate);
  const agencyCode = hit.agencyCode?.trim();
  const agencyName = hit.agency?.trim();
  return {
    opportunity_id: hit.id ?? '',
    opportunity_number: hit.number?.trim() ?? '',
    title: decodeEntities(hit.title?.trim() ?? ''),
    status: hit.oppStatus?.toLowerCase() as Status,
    doc_type: hit.docType?.toLowerCase() as Row['doc_type'],
    ...(agencyCode && { agency_code: agencyCode }),
    ...(agencyName && { agency_name: agencyName }),
    ...(openDate && { open_date: openDate }),
    ...(closeDate && { close_date: closeDate }),
    close_date_kind: kind,
    ...(closeDate && kind === 'fixed' && { days_until_close: daysBetween(today, closeDate) }),
    assistance_listings: (hit.cfdaList ?? []).filter((aln) => aln.trim() !== ''),
  };
}

function toFacets(options: readonly RawFacetOption[] | null | undefined): Facet[] {
  return (options ?? []).flatMap((option) => {
    const code = option.value?.trim();
    if (!code) return [];
    return [{ code, label: option.label?.trim() || code, count: option.count ?? 0 }];
  });
}

/** Count per status from `oppStatusOptions`, which covers all four statuses whatever the status filter. */
function statusCount(facets: RawFacets, status: Status): number {
  return (
    facets.oppStatusOptions?.find((option) => option.value?.trim().toLowerCase() === status)
      ?.count ?? 0
  );
}

/**
 * Runs a number-scoped lookup as given; on no exact match with lowercase letters
 * present, retries once uppercased (the upstream match is case-sensitive).
 */
async function withUppercaseRetry<T>(
  opportunityNumber: string | undefined,
  run: (sent: string | undefined) => Promise<T>,
  exactMatches: (result: T) => number,
): Promise<T> {
  const first = await run(opportunityNumber);
  if (
    opportunityNumber === undefined ||
    exactMatches(first) > 0 ||
    !/[a-z]/.test(opportunityNumber)
  ) {
    return first;
  }
  return await run(opportunityNumber.toUpperCase());
}

const pluralDays = (days: number) => `${days} day${days === 1 ? '' : 's'}`;

/** `closing_within_days` as prose: 0 is today (US Eastern). */
const windowPhrase = (days: number) => (days === 0 ? 'today' : `within ${pluralDays(days)}`);

/**
 * The notice for an empty closing window over a non-empty posted set: the next
 * fixed close date when it is within reach, else why every posted match falls
 * outside the window.
 */
function emptyWindowNotice(scan: ClosingWindowScan, closingDays: number, today: string): string {
  const lead = 'No posted opportunity matching these filters';
  const window = windowPhrase(closingDays);
  const next = scan.nextCloseAfterWindow;
  const nextDate = parseSlashDate(next?.closeDate);
  if (nextDate !== undefined && closeDateKind(nextDate, today) === 'fixed') {
    const nextDays = daysBetween(today, nextDate);
    if (nextDays <= 365) {
      return `${lead} closes ${window}; the next one closes ${nextDate} (${pluralDays(nextDays)}). Raise closing_within_days to at least ${nextDays}.`;
    }
  }
  const one = scan.postedTotal === 1;
  const matches = one ? 'the 1 posted match' : `all ${scan.postedTotal} posted matches`;
  const tail =
    'Call grantsgov_search_opportunities without closing_within_days and with sort close_date_asc to see them.';
  const everyMatchBeforeToday = next === undefined;
  if (everyMatchBeforeToday) {
    return `${lead} closes ${window}; ${matches} ${one ? 'has a close date' : 'have close dates'} before today that Grants.gov has not yet marked closed. ${tail}`;
  }
  return `${lead} has a fixed deadline ${window}; ${matches} ${one ? 'closes' : 'close'} later or ${one ? 'lists' : 'list'} no fixed date. ${tail}`;
}

export const grantsgovSearchOpportunities = tool('grantsgov_search_opportunities', {
  title: 'Search Grants.gov Opportunities',
  description:
    'Search federal funding opportunities on Grants.gov by keyword, agency, applicant eligibility, funding category, funding instrument, assistance listing, opportunity number, posting window (posted_within_days), or closing window (closing_within_days). Returns forecasted and posted opportunities unless statuses says otherwise, each row led by its close date and days remaining, plus facet counts for narrowing. Keyword terms are all required; join alternatives with OR. Rows carry no award amounts or eligibility detail; read those with grantsgov_get_opportunity. Filter codes come from grantsgov_list_reference.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    keyword: optionalText(z.string().max(500)).describe(
      'Full-text search over title, description, opportunity number, and agency. Every term is required (rural broadband = rural AND broadband); join alternatives with OR, group with parentheses, quote phrases ("mental health"), exclude with NOT or -term, and use a trailing * for prefixes (broad*). A word with an internal hyphen or period (COVID-19, K-12) is matched as a phrase. See grantsgov_list_reference topic keyword_syntax.',
    ),
    statuses: optionalList(z.preprocess(trimLower, z.enum(STATUSES)), 4).describe(
      'Lifecycle statuses to include: forecasted, posted, closed, archived. Case-insensitive. Default: forecasted and posted.',
    ),
    agencies: optionalList(
      z.preprocess(normalizeAgencyCode, z.string().regex(AGENCY_CODE)),
      10,
    ).describe(
      'Agency codes from grantsgov_list_reference topic agencies (e.g. HHS, HHS-NIH11, NSF). A code includes its sub-agencies. Case-insensitive. Any listed agency matches.',
    ),
    eligibilities: optionalList(
      z.preprocess(padEligibility, z.string().regex(/^\d{2}$/)),
      17,
    ).describe(
      'Two-digit applicant-type codes from grantsgov_list_reference topic eligibilities (e.g. 12 = nonprofits with 501(c)(3) status, 07 = federally recognized tribal governments). A single digit is zero-padded. Any listed type matches.',
    ),
    include_unrestricted: z
      .boolean()
      .default(true)
      .describe(
        'When eligibilities is set, also match opportunities open to any applicant type (code 99), which the specific codes do not cover. Set false to see only opportunities targeted at the listed types.',
      ),
    funding_categories: optionalList(
      z.preprocess(trimUpper, z.string().regex(/^[A-Z]{1,4}$/)),
      28,
    ).describe(
      'Funding category codes from grantsgov_list_reference topic funding_categories (e.g. HL = Health, ED = Education). Case-insensitive. Any listed category matches.',
    ),
    funding_instruments: optionalList(
      z.preprocess(trimUpper, z.enum(FUNDING_INSTRUMENTS)),
      4,
    ).describe(
      'Funding instruments: G (grant), CA (cooperative agreement), PC (procurement contract), O (other). Case-insensitive. Any listed instrument matches.',
    ),
    assistance_listing: optionalText(
      z.preprocess(normalizeAln, z.string().regex(/^\d{2}\.[0-9A-Z]{3}$/)),
    ).describe(
      'One assistance listing number (ALN, formerly CFDA), e.g. 93.866 or 93866. Only one value is supported.',
    ),
    opportunity_number: optionalText(OPPORTUNITY_NUMBER).describe(
      'Exact agency-assigned opportunity number (e.g. HRSA-27-005), matched case-insensitively. Numbers are not unique across agencies, so several rows can match. To look up a number across every status, prefer grantsgov_get_opportunity with opportunity_numbers.',
    ),
    posted_within_days: z
      .preprocess(numberFromDigits, z.number().int().min(1).max(3650).optional())
      .describe(
        'Only opportunities posted in the last N days (1-3650). Works only with the forecasted and posted statuses.',
      ),
    closing_within_days: z
      .preprocess(numberFromDigits, z.number().int().min(0).max(365).optional())
      .describe(
        'Only posted opportunities closing between today and N days from today, US Eastern (0-365; 0 = closing today). Searches posted opportunities in close-date order, so statuses may only be posted and sort only close_date_asc.',
      ),
    sort: optionalText(z.enum(SORTS)).describe(
      'Result order: relevance (best keyword match; needs keyword, otherwise the order is arbitrary), open_date_desc/open_date_asc (posting date), close_date_asc/close_date_desc (close date; no close date sorts last on asc), opportunity_number_asc/_desc, agency_asc/_desc. Default: relevance with a keyword, else open_date_desc.',
    ),
    limit: z.number().int().min(1).max(100).default(25).describe('Rows per page (1-100).'),
    offset: z
      .number()
      .int()
      .min(0)
      .max(100_000)
      .default(0)
      .describe('Zero-based row offset for paging; use next_offset from the previous page.'),
    include_facets: z
      .boolean()
      .default(true)
      .describe('Include facet counts per filter value. Set false when paging to save space.'),
  }),

  output: z.object({
    opportunities: z.array(OpportunityRow).describe('Matching opportunities, deadline first.'),
    facets: z
      .object({
        statuses: facetList(
          'Counts per status for the other filters, covering all four statuses whatever the statuses filter.',
        ),
        eligibilities: facetList('Counts per applicant-type code.'),
        funding_categories: facetList('Counts per funding category code.'),
        funding_instruments: facetList('Counts per funding instrument code.'),
        agencies: facetList('Counts per top-level agency code.'),
        sub_agencies: facetList(
          'Counts per sub-agency code under the top-level agencies in the result. Present only when agencies is set.',
        ).optional(),
      })
      .optional()
      .describe(
        'Counts per filter value for the current filters. Omitted when include_facets is false.',
      ),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Total matching opportunities (the closing-window count in closing_within_days mode).',
      ),
    truncated: z.boolean().describe('True when more rows exist past this page.'),
    shown: z.number().describe('Rows returned on this page.'),
    cap: z.number().describe('The limit applied.'),
    next_offset: z
      .number()
      .optional()
      .describe('Offset for the next page; absent on the last page.'),
    effective_keyword: z.string().optional().describe('The keyword as compiled and sent upstream.'),
    applied_filters: AppliedFilters,
    notice: z.string().optional().describe('Zero-hit or window guidance naming the next call.'),
  },
  enrichmentTrailer: { applied_filters: { render: renderAppliedFilters } },

  errors: [
    {
      reason: 'invalid_keyword',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The keyword has unbalanced quotes or parentheses, a leading AND/OR, a trailing or doubled operator, or nothing left after removing unsupported characters.',
      recovery:
        'Fix the keyword syntax, or call grantsgov_list_reference with topic keyword_syntax for the supported operators.',
    },
    {
      reason: 'unknown_agency',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An agencies code is neither a known agency code nor a hyphen-delimited prefix of one.',
      recovery:
        'Call grantsgov_list_reference with topic agencies and name_contains set to the agency name to find its code.',
    },
    {
      reason: 'unknown_eligibility',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An eligibilities code is not in the applicant-type list.',
      recovery:
        'Call grantsgov_list_reference with topic eligibilities for the valid two-digit applicant-type codes.',
    },
    {
      reason: 'unknown_funding_category',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A funding_categories code is not in the category list.',
      recovery:
        'Call grantsgov_list_reference with topic funding_categories for the valid category codes.',
    },
    {
      reason: 'filter_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'posted_within_days with closed or archived in statuses; closing_within_days with statuses other than posted or a sort other than close_date_asc.',
      recovery:
        'Remove the conflicting statuses or sort value and call grantsgov_search_opportunities again.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Grants.gov did not respond, or returned a 5xx, a non-JSON body, a non-zero errorcode, or a backend-unavailable message, after retries.',
      recovery:
        'Grants.gov is not responding; wait a minute and call grantsgov_search_opportunities again.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Grants.gov answered HTTP 429 (rate limited) through every retry, or asked for a wait longer than the retry budget.',
      recovery:
        'Grants.gov is rate limiting requests; wait the retryAfter interval (or a minute) and call grantsgov_search_opportunities again.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_route_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Grants.gov answered HTTP 403 Missing Authentication Token: the search route no longer exists at the gateway.',
      recovery:
        'The Grants.gov search API route is not answering; the legacy API may have been retired, so report this to the server maintainer.',
      retryable: false,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ totalCount: 0, truncated: false, shown: 0, cap: input.limit });

    const today = todayET();
    const closingDays = input.closing_within_days;
    const oppNum = input.opportunity_number;
    const explicitStatuses = input.statuses && [...new Set(input.statuses)];

    if (closingDays !== undefined) {
      if (explicitStatuses?.some((status) => status !== 'posted')) {
        throw ctx.fail(
          'filter_conflict',
          `closing_within_days searches posted opportunities only, so it cannot combine with statuses ${explicitStatuses.join(', ')}.`,
          {
            recovery: {
              hint: 'Remove statuses (closing_within_days always searches posted opportunities), or remove closing_within_days, and call grantsgov_search_opportunities again.',
            },
          },
        );
      }
      if (input.sort !== undefined && input.sort !== 'close_date_asc') {
        throw ctx.fail(
          'filter_conflict',
          `closing_within_days orders results by close date, so it cannot combine with sort ${input.sort}.`,
          {
            recovery: {
              hint: 'Remove sort (closing_within_days always sorts close_date_asc), or remove closing_within_days, and call grantsgov_search_opportunities again.',
            },
          },
        );
      }
    }
    const statuses: readonly Status[] =
      closingDays !== undefined ? ['posted'] : (explicitStatuses ?? DEFAULT_STATUSES);
    if (input.posted_within_days !== undefined) {
      const late = statuses.filter((status) => status === 'closed' || status === 'archived');
      if (late.length > 0) {
        throw ctx.fail(
          'filter_conflict',
          `posted_within_days works only with the forecasted and posted statuses; Grants.gov ignores ${late.join(' and ')} when a posting window is set.`,
          {
            recovery: {
              hint: `Remove ${late.join(' and ')} from statuses, or remove posted_within_days, and call grantsgov_search_opportunities again.`,
            },
          },
        );
      }
    }

    let keyword: { compiled: string; andJoined: boolean } | undefined;
    if (input.keyword !== undefined) {
      const compiled = compileKeyword(input.keyword);
      if (!compiled.ok) {
        throw ctx.fail('invalid_keyword', `The keyword was rejected because ${compiled.problem}.`, {
          keyword: input.keyword,
          ...ctx.recoveryFor('invalid_keyword'),
        });
      }
      keyword = compiled;
    }

    const service = getGrantsGovService();
    const needsSnapshot =
      input.agencies !== undefined ||
      input.eligibilities !== undefined ||
      input.funding_categories !== undefined;
    const snapshot = needsSnapshot ? await service.getReference(ctx) : undefined;

    let agenciesSent: string | undefined;
    if (input.agencies && snapshot) {
      const agencies = [...new Set(input.agencies)];
      const unknown = agencies.find((code) => !resolveAgencyScope(snapshot, code));
      if (unknown !== undefined) {
        throw ctx.fail(
          'unknown_agency',
          `No agency code "${unknown}" in the Grants.gov vocabulary.`,
          {
            agency: unknown,
            recovery: {
              hint: `Call grantsgov_list_reference with topic agencies and name_contains set to the agency name to find the code for "${unknown}".`,
            },
          },
        );
      }
      agenciesSent = encodeAgencyFilter(agencies, snapshot);
    }

    let eligibilitiesSent: string | undefined;
    if (input.eligibilities && snapshot) {
      const known = new Set(snapshot.eligibilities.map((entry) => entry.code));
      const codes = [...new Set(input.eligibilities)];
      const unknown = codes.find((code) => !known.has(code));
      if (unknown !== undefined) {
        throw ctx.fail(
          'unknown_eligibility',
          `"${unknown}" is not a Grants.gov applicant-type code.`,
          { eligibility: unknown, ...ctx.recoveryFor('unknown_eligibility') },
        );
      }
      if (input.include_unrestricted && !codes.includes(UNRESTRICTED)) codes.push(UNRESTRICTED);
      eligibilitiesSent = codes.join('|');
    }

    const fundingCategories = input.funding_categories && [...new Set(input.funding_categories)];
    if (fundingCategories && snapshot) {
      const known = new Set(snapshot.fundingCategories.map((entry) => entry.code));
      const unknown = fundingCategories.find((code) => !known.has(code));
      if (unknown !== undefined) {
        throw ctx.fail(
          'unknown_funding_category',
          `"${unknown}" is not a Grants.gov funding category code.`,
          { fundingCategory: unknown, ...ctx.recoveryFor('unknown_funding_category') },
        );
      }
    }
    const fundingInstruments = input.funding_instruments && [...new Set(input.funding_instruments)];

    const sort: Sort =
      closingDays !== undefined
        ? 'close_date_asc'
        : (input.sort ?? (keyword ? 'relevance' : 'open_date_desc'));
    const cutoff = closingDays !== undefined ? addDays(today, closingDays) : undefined;

    const applied: Applied = {
      statuses: [...statuses],
      statuses_defaulted: closingDays === undefined && explicitStatuses === undefined,
      ...(agenciesSent !== undefined && { agencies_sent: agenciesSent }),
      ...(eligibilitiesSent !== undefined && { eligibilities_sent: eligibilitiesSent }),
      include_unrestricted: input.include_unrestricted,
      ...(fundingCategories && { funding_categories: fundingCategories }),
      ...(fundingInstruments && { funding_instruments: fundingInstruments }),
      ...(input.assistance_listing !== undefined && {
        assistance_listing: input.assistance_listing,
      }),
      ...(oppNum !== undefined && { opportunity_number: oppNum }),
      ...(input.posted_within_days !== undefined && {
        posted_within_days: input.posted_within_days,
      }),
      ...(closingDays !== undefined && { closing_within_days: closingDays }),
      ...(cutoff !== undefined && { closing_cutoff_date: cutoff }),
      sort,
    };
    ctx.enrich({
      applied_filters: applied,
      ...(keyword && { effective_keyword: keyword.compiled }),
    });

    /** Every filter except status, sort, paging, and the opportunity number. */
    const filters: Search2Body = {
      ...(keyword && { keyword: keyword.compiled }),
      ...(agenciesSent !== undefined && { agencies: agenciesSent }),
      ...(eligibilitiesSent !== undefined && { eligibilities: eligibilitiesSent }),
      ...(fundingCategories && { fundingCategories: fundingCategories.join('|') }),
      ...(fundingInstruments && { fundingInstruments: fundingInstruments.join('|') }),
      ...(input.assistance_listing !== undefined && { cfda: input.assistance_listing }),
      ...(input.posted_within_days !== undefined && {
        dateRange: String(input.posted_within_days),
      }),
    };
    const withNumber = (sent: string | undefined): Search2Body =>
      sent === undefined ? filters : { ...filters, oppNum: quoteOppNum(sent) };
    const exact = (hits: readonly RawHit[]) =>
      oppNum === undefined
        ? [...hits]
        : hits.filter((hit) => isSameOpportunityNumber(hit.number, oppNum));
    const sortBy = SORT_BY[sort];
    const page = (hits: readonly RawHit[]) => hits.slice(input.offset, input.offset + input.limit);

    let hits: RawHit[];
    let total: number;
    let facets: RawFacets;
    /** Notice text that replaces the zero-hit composition when set. */
    let primaryNotice: string | undefined;
    let ceilingHit = false;

    if (cutoff !== undefined && closingDays !== undefined) {
      let scan: ClosingWindowScan;
      if (oppNum === undefined) {
        scan = await service.scanClosingWindow(filters, cutoff, ctx);
      } else {
        /**
         * A number narrows the posted set to a handful of rows, so one close-date
         * page is cut locally over exact matches only: the window, the next close
         * after it, and the posted count all exclude non-equal upstream hits.
         */
        const result = await withUppercaseRetry(
          oppNum,
          (sent) =>
            service.search(
              {
                ...withNumber(sent),
                oppStatuses: 'posted',
                sortBy: 'closeDate|asc',
                rows: NUMBER_MODE_ROWS,
                startRecordNum: 0,
              },
              ctx,
            ),
          (response) => exact(response.hits).length,
        );
        const posted = exact(result.hits);
        scan = {
          ...cutClosingWindow(posted, today, cutoff),
          postedTotal: posted.length,
          facets: result.facets,
          ceilingHit: false,
        };
      }
      total = scan.windowHits.length;
      hits = page(scan.windowHits);
      facets = scan.facets;
      ceilingHit = scan.ceilingHit;
      if (total === 0 && scan.postedTotal > 0) {
        primaryNotice = emptyWindowNotice(scan, closingDays, today);
      }
    } else if (oppNum !== undefined) {
      const result = await withUppercaseRetry(
        oppNum,
        (sent) =>
          service.search(
            {
              ...withNumber(sent),
              oppStatuses: statuses.join('|'),
              ...(sortBy !== undefined && { sortBy }),
              rows: NUMBER_MODE_ROWS,
              startRecordNum: 0,
            },
            ctx,
          ),
        (response) => exact(response.hits).length,
      );
      const matches = exact(result.hits);
      total = matches.length;
      hits = page(matches);
      facets = result.facets;
    } else {
      const result = await service.search(
        {
          ...filters,
          oppStatuses: statuses.join('|'),
          ...(sortBy !== undefined && { sortBy }),
          rows: input.limit,
          startRecordNum: input.offset,
        },
        ctx,
      );
      total = result.hitCount;
      hits = result.hits;
      facets = result.facets;
    }

    const opportunities = hits.map((hit) => toRow(hit, today));

    const fragments: string[] = [];
    if (primaryNotice !== undefined) {
      fragments.push(primaryNotice);
    } else if (total === 0) {
      fragments.push('No opportunities matched these filters.');
      const closed = statusCount(facets, 'closed');
      const archived = statusCount(facets, 'archived');
      // In number mode these counts include the non-equal hits; the exact-match fragment names the right call instead.
      if (applied.statuses_defaulted && oppNum === undefined && closed + archived > 0) {
        fragments.push(
          `${closed} closed and ${archived} archived opportunities match; add "closed" and/or "archived" to statuses to include them.`,
        );
      }
      if (keyword?.andJoined) {
        fragments.push(
          `All keyword terms were required (${keyword.compiled}); join alternatives with OR, or drop a term.`,
        );
      }
      if (input.eligibilities !== undefined && !input.include_unrestricted) {
        fragments.push(
          'Set include_unrestricted to true to add opportunities open to any applicant type.',
        );
      }
      if (input.posted_within_days !== undefined) {
        fragments.push(
          `Raise posted_within_days or remove it; it limits results to opportunities posted in the last ${pluralDays(input.posted_within_days)}.`,
        );
      }
      if (oppNum !== undefined) {
        fragments.push(
          'opportunity_number is exact-match; call grantsgov_get_opportunity with opportunity_numbers to search every status, or put the number in quotes in keyword for a full-text match.',
        );
      }
      if (
        input.agencies !== undefined ||
        input.eligibilities !== undefined ||
        fundingCategories !== undefined ||
        fundingInstruments !== undefined ||
        input.assistance_listing !== undefined
      ) {
        fragments.push(
          'Remove one filter at a time, or call grantsgov_list_reference to confirm the codes.',
        );
      }
      fragments.push('Rerun with fewer filters to see facet counts for refining.');
    } else if (opportunities.length === 0 && input.offset >= total) {
      fragments.push(
        `Offset ${input.offset} is past the end of ${total} results. Call again with offset 0, or a multiple of limit below ${total}.`,
      );
    }
    if (ceilingHit) {
      fragments.push(
        `The closing window holds more than ${SCAN_CEILING.toLocaleString('en-US')} opportunities; results cover the first ${SCAN_CEILING.toLocaleString('en-US')} by close date. Add filters to narrow.`,
      );
    }
    if (closingDays !== undefined && input.include_facets) {
      fragments.push(
        'Facet counts describe every posted opportunity matching the other filters, not only those closing in the window.',
      );
    }

    const nextOffset = input.offset + opportunities.length;
    const more = opportunities.length > 0 && nextOffset < total;
    if (more) fragments.push(`More results: call again with offset ${nextOffset}.`);
    const notice = fragments.length > 0 ? fragments.join(' ') : undefined;

    ctx.enrich({ totalCount: total, shown: opportunities.length });
    if (more) {
      ctx.enrich({ next_offset: nextOffset });
      ctx.enrich.truncated({
        shown: opportunities.length,
        cap: input.limit,
        ...(notice !== undefined && { guidance: notice }),
      });
    } else if (notice !== undefined) {
      ctx.enrich.notice(notice);
    }

    ctx.log.info('Searched Grants.gov opportunities', {
      mode:
        closingDays !== undefined ? 'closing_window' : oppNum !== undefined ? 'number' : 'search',
      total,
      shown: opportunities.length,
    });

    if (!input.include_facets) return { opportunities };
    return {
      opportunities,
      facets: {
        statuses: toFacets(facets.oppStatusOptions),
        eligibilities: toFacets(facets.eligibilities),
        funding_categories: toFacets(facets.fundingCategories),
        funding_instruments: toFacets(facets.fundingInstruments),
        agencies: toFacets(facets.agencies),
        ...(input.agencies !== undefined && {
          sub_agencies: (facets.agencies ?? []).flatMap((top) =>
            toFacets(top.subAgencyOptions).filter((sub) => sub.code !== top.value?.trim()),
          ),
        }),
      },
    };
  },

  format: (result) => {
    const lines: string[] = ['## Grants.gov opportunities', ''];
    if (result.opportunities.length === 0) {
      lines.push('No opportunities on this page.');
    } else {
      lines.push(
        '| Close date | Days left | Title | Opportunity number | ID | Agency | Status | Posted | ALN |',
        '|:---|:---|:---|:---|:---|:---|:---|:---|:---|',
      );
      for (const row of result.opportunities) {
        const closes =
          row.close_date_kind === 'none_listed'
            ? 'none listed'
            : row.close_date_kind === 'placeholder'
              ? `${row.close_date} (placeholder date: open-ended)`
              : (row.close_date ?? '');
        const agency =
          row.agency_name !== undefined || row.agency_code !== undefined
            ? [
                row.agency_name !== undefined ? tableCell(row.agency_name) : undefined,
                row.agency_code !== undefined ? `\`${tableCell(row.agency_code)}\`` : undefined,
              ]
                .filter(Boolean)
                .join(' ')
            : 'Not listed';
        lines.push(
          `| ${closes} | ${row.days_until_close ?? '—'} | ${tableCell(row.title)} | \`${tableCell(row.opportunity_number)}\` | ${row.opportunity_id} | ${agency} | ${row.status} (${row.doc_type}) | ${row.open_date ?? 'not listed'} | ${row.assistance_listings.map(tableCell).join(', ') || 'none'} |`,
        );
      }
    }

    const { facets } = result;
    if (facets) {
      const groups: [string, Facet[] | undefined][] = [
        ['Statuses', facets.statuses],
        ['Applicant eligibility', facets.eligibilities],
        ['Funding categories', facets.funding_categories],
        ['Funding instruments', facets.funding_instruments],
        ['Agencies', facets.agencies],
        ['Sub-agencies', facets.sub_agencies],
      ];
      lines.push('', '### Facet counts');
      for (const [heading, list] of groups) {
        if (!list) continue;
        const values = list.map(
          (facet) => `\`${inline(facet.code)}\` ${inline(facet.label)} (${facet.count})`,
        );
        lines.push(`- **${heading}:** ${values.length > 0 ? values.join('; ') : 'none'}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
