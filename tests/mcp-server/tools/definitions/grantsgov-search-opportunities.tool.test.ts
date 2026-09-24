/**
 * @fileoverview Tests for grantsgov_search_opportunities across its three modes
 * (plain upstream page, exact opportunity-number match paged locally, closing-
 * window scan): the exact `search2` body per input, schema normalization and
 * blank form fields, agency subtree encoding, enrichment on every path, zero-hit
 * and window notices, each declared error reason with its recovery hint, the
 * production success envelope (output.extend(enrichment) parse) via
 * runToolContract, and format().
 * @module tests/mcp-server/tools/definitions/grantsgov-search-opportunities.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grantsgovSearchOpportunities } from '@/mcp-server/tools/definitions/grantsgov-search-opportunities.tool.js';
import {
  getGrantsGovService,
  initGrantsGovService,
} from '@/services/grants-gov/grants-gov-service.js';
import { addDays, daysBetween, todayET } from '@/services/grants-gov/normalize.js';
import type { RawFacets, RawHit, Search2Body } from '@/services/grants-gov/types.js';
import {
  bodyOf,
  closingIn,
  FACETS_ALL,
  FACETS_OPEN,
  HRSA_HIT,
  json,
  OPP_NUM_1_HITS,
  ok,
  POSTED_HITS,
  postedHit,
  referenceResponse,
  SEARCH2_URL,
  searchData,
} from '../../../fixtures/grants-gov.js';
import {
  CDC_FACETS,
  CDC_FORECAST_HITS,
  NSF_ZERO_HIT_FACETS,
} from '../../../fixtures/grants-gov-records.js';
import { drained, rejectionOf } from '../../../fixtures/harness.js';

const tool = grantsgovSearchOpportunities;
type Input = Parameters<typeof tool.input.parse>[0];
type Output = Parameters<NonNullable<typeof tool.format>>[0];

if (!tool.enrichment)
  throw new Error('grantsgov_search_opportunities declares no enrichment block');
/** The production success shape: output fields plus the declared enrichment. */
const Effective = tool.output.extend(tool.enrichment);

const FACET_FRAGMENT =
  'Facet counts describe every posted opportunity matching the other filters, not only those closing in the window.';
const RERUN = 'Rerun with fewer filters to see facet counts for refining.';
const ALN_FRAGMENT = (aln: string) =>
  `assistance_listing is one exact ALN (${aln}); confirm the number (each grantsgov_get_opportunity record lists its assistance_listings), or drop assistance_listing and search the program name as keyword.`;

let http: FetchMockHarness;

beforeEach(() => {
  http = createFetchMock();
  http.install();
  initGrantsGovService();
});

afterEach(() => {
  getGrantsGovService().dispose();
  http.restore();
});

/**
 * Routes every `search2` call: facets-only calls (`rows: 0`) build the reference
 * snapshot from the recorded facets; every other call is a search page, answered
 * by `respond`.
 */
function serve(respond: (body: Search2Body) => Response | Promise<Response>) {
  http.route({
    method: 'POST',
    match: SEARCH2_URL,
    respond: async (request) => {
      const body = await bodyOf(request);
      return body.rows === 0 ? referenceResponse(body) : await respond(body);
    },
  });
}

/** Serves one fixed page for every search call. */
const page = (hits: RawHit[], hitCount = hits.length, facets: RawFacets = {}) =>
  serve(() => ok(searchData(hits, hitCount, facets)));

/** Serves pages sliced from `rows` by the request's startRecordNum and rows (closing-window scans). */
const paged = (rows: RawHit[], hitCount = rows.length, facets: RawFacets = FACETS_OPEN) =>
  serve(({ startRecordNum = 0, rows: size = 0 }) =>
    ok(searchData(rows.slice(startRecordNum, startRecordNum + size), hitCount, facets)),
  );

/** Request bodies of the search-page calls, in order (reference snapshot calls excluded). */
async function pageBodies(): Promise<Search2Body[]> {
  const bodies = await Promise.all(http.calls.map((call) => bodyOf(call.request)));
  return bodies.filter((body) => body.rows !== 0);
}

const snapshotCalls = async () =>
  (await Promise.all(http.calls.map((call) => bodyOf(call.request)))).filter(
    (body) => body.rows === 0,
  ).length;

async function run(raw: Input) {
  const ctx = createMockContext({ errors: tool.errors });
  const result = await tool.handler(tool.input.parse(raw), ctx);
  const enrichment = getEnrichment(ctx);
  expect({ ...result, ...enrichment }).toEqual(expect.schemaMatching(Effective));
  return { result, enrichment };
}

const failure = (raw: Input) =>
  rejectionOf(() =>
    tool.handler(tool.input.parse(raw), createMockContext({ errors: tool.errors })),
  );

/** {@link failure} with retry backoff drained. */
const drainedFailure = (raw: Input) => drained(() => failure(raw));

const ids = (result: Output) => result.opportunities.map((row) => row.opportunity_id);
const today = todayET();

const DEFAULT_BODY = {
  oppStatuses: 'forecasted|posted',
  sortBy: 'openDate|desc',
  rows: 25,
  startRecordNum: 0,
};

describe('plain search mode', () => {
  it('sends the default scope and maps rows deadline first', async () => {
    page(POSTED_HITS);
    const { result, enrichment } = await run({});
    expect(await pageBodies()).toEqual([DEFAULT_BODY]);
    expect(await snapshotCalls()).toBe(0);
    expect(result.opportunities[0]).toEqual({
      opportunity_id: '362180',
      opportunity_number: 'HT942526AZRPTRRA',
      title: 'DoW Alzheimer’s Transforming Research Award',
      status: 'posted',
      doc_type: 'synopsis',
      agency_code: 'DOD-AMRAA',
      agency_name: 'Defense Health Agency Contracting Activity - DHACA',
      open_date: '2026-05-01',
      close_date: '2026-09-24',
      close_date_kind: 'fixed',
      days_until_close: daysBetween(today, '2026-09-24'),
      assistance_listings: ['12.420'],
    });
    expect(enrichment).toEqual({
      totalCount: 2,
      truncated: false,
      shown: 2,
      cap: 25,
      applied_filters: {
        statuses: ['forecasted', 'posted'],
        statuses_defaulted: true,
        include_unrestricted: true,
        sort: 'open_date_desc',
      },
    });
  });

  it('returns at most limit rows when the upstream sends more than it was asked for', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => postedHit(900 + i, 10));
    page(rows, 12);
    const { result, enrichment } = await run({ limit: 5 });
    expect(result.opportunities).toHaveLength(5);
    expect(enrichment).toMatchObject({ totalCount: 12, shown: 5, next_offset: 5 });
  });

  it('maps forecast, placeholder, long-running, and sparse rows', async () => {
    const [forecast] = CDC_FORECAST_HITS as [RawHit];
    const placeholderDos: RawHit = {
      id: '355211',
      number: 'OFOP0001473',
      title: 'U.S. EMBASSY TO LIBYA PAS ANNUAL PROGRAM STATEMENT',
      agencyCode: 'DOS-TUN',
      agency: 'U.S. Mission to Tunisia',
      openDate: '06/28/2024',
      closeDate: '01/01/2099',
      oppStatus: 'posted',
      docType: 'synopsis',
      cfdaList: ['19.040'],
    };
    const placeholderNsf: RawHit = { ...placeholderDos, id: '363621', closeDate: '08/17/2076' };
    const longRunning: RawHit = { ...placeholderDos, id: '356612', closeDate: '09/30/2034' };
    const sparse: RawHit = {
      id: '1',
      number: ' SPARSE-1 ',
      title: 'Sparse row',
      agencyCode: ' ',
      agency: '',
      openDate: '',
      closeDate: null,
      oppStatus: 'POSTED',
      docType: 'synopsis',
      cfdaList: ['', '93.940'],
    };
    page([forecast, placeholderDos, placeholderNsf, longRunning, sparse]);
    const { result } = await run({});
    const [f, dos, nsf, dod, bare] = result.opportunities;
    expect(f).toMatchObject({ status: 'forecasted', doc_type: 'forecast' });
    expect(f?.close_date_kind).toBe('none_listed');
    expect(f).not.toHaveProperty('close_date');
    expect(f).not.toHaveProperty('days_until_close');
    expect(dos).toMatchObject({ close_date: '2099-01-01', close_date_kind: 'placeholder' });
    expect(dos).not.toHaveProperty('days_until_close');
    expect(nsf).toMatchObject({ close_date: '2076-08-17', close_date_kind: 'placeholder' });
    expect(dod).toMatchObject({
      close_date: '2034-09-30',
      close_date_kind: 'fixed',
      days_until_close: daysBetween(today, '2034-09-30'),
    });
    expect(bare).toEqual({
      opportunity_id: '1',
      opportunity_number: 'SPARSE-1',
      title: 'Sparse row',
      status: 'posted',
      doc_type: 'synopsis',
      close_date_kind: 'none_listed',
      assistance_listings: ['93.940'],
    });
  });

  it('compiles the keyword into the body and sends relevance by omitting sortBy', async () => {
    page(POSTED_HITS);
    const { enrichment } = await run({ keyword: 'rural broadband' });
    const [body] = await pageBodies();
    expect(body).toEqual({
      keyword: 'rural AND broadband',
      oppStatuses: 'forecasted|posted',
      rows: 25,
      startRecordNum: 0,
    });
    expect(enrichment).toMatchObject({
      effective_keyword: 'rural AND broadband',
      applied_filters: { sort: 'relevance' },
    });
  });

  it('normalizes operators, quotes punctuated tokens, and strips unsupported syntax', async () => {
    page([]);
    const { enrichment } = await run({
      keyword: '(COVID-19 or k-12) and tribal? Healthy Start: x',
    });
    const [body] = await pageBodies();
    expect(body?.keyword).toBe('("COVID-19" OR "k-12") AND tribal AND Healthy AND Start AND x');
    expect(enrichment.effective_keyword).toBe(body?.keyword);
  });

  it('sends a grouped AND/OR keyword exactly as grouped', async () => {
    page([]);
    await run({ keyword: '(broadband or internet) rural' });
    await run({ keyword: 'broadband OR (internet rural)' });
    expect((await pageBodies()).map((body) => body.keyword)).toEqual([
      '(broadband OR internet) AND rural',
      'broadband OR (internet AND rural)',
    ]);
  });

  it('honors an explicit sort alongside a keyword', async () => {
    page([]);
    await run({ keyword: 'broadband', sort: 'close_date_desc' });
    expect((await pageBodies())[0]).toMatchObject({ sortBy: 'closeDate|desc' });
  });

  it('normalizes every filter in the schema and sends its pipe-joined upstream form', async () => {
    page(POSTED_HITS);
    const { enrichment } = await run({
      statuses: ['Posted', ' FORECASTED ', 'posted'],
      agencies: ['hhs'],
      eligibilities: ['7', ' 12 '],
      funding_categories: ['hl', 'ed'],
      funding_instruments: ['g', 'CA'],
      assistance_listing: 'CFDA 93866',
      posted_within_days: '30',
      sort: 'agency_asc',
      limit: 10,
      offset: 20,
    });
    expect(await pageBodies()).toEqual([
      {
        agencies: 'HHS|HHS-*',
        eligibilities: '07|12|99',
        fundingCategories: 'HL|ED',
        fundingInstruments: 'G|CA',
        cfda: '93.866',
        dateRange: '30',
        oppStatuses: 'posted|forecasted',
        sortBy: 'agency|asc',
        rows: 10,
        startRecordNum: 20,
      },
    ]);
    expect(await snapshotCalls()).toBe(2);
    expect(enrichment.applied_filters).toEqual({
      statuses: ['posted', 'forecasted'],
      statuses_defaulted: false,
      agencies_sent: 'HHS|HHS-*',
      eligibilities_sent: '07|12|99',
      include_unrestricted: true,
      funding_categories: ['HL', 'ED'],
      funding_instruments: ['G', 'CA'],
      assistance_listing: '93.866',
      posted_within_days: 30,
      sort: 'agency_asc',
    });
  });

  it('reads blank form-client fields as unset and sends the default scope', async () => {
    page([]);
    const { enrichment } = await run({
      keyword: '  ',
      statuses: ['', ' '],
      agencies: [' '],
      eligibilities: [''],
      funding_categories: [''],
      funding_instruments: [' '],
      assistance_listing: '',
      opportunity_number: '   ',
      posted_within_days: '',
      closing_within_days: '',
      sort: '',
    });
    expect(await pageBodies()).toEqual([DEFAULT_BODY]);
    expect(await snapshotCalls()).toBe(0);
    expect(enrichment.applied_filters).toEqual({
      statuses: ['forecasted', 'posted'],
      statuses_defaulted: true,
      include_unrestricted: true,
      sort: 'open_date_desc',
    });
    expect(enrichment).not.toHaveProperty('effective_keyword');
  });
});

describe('agency subtree encoding', () => {
  it.each([
    ['a top-level code with its -* subtree', ['hhs'], 'HHS|HHS-*'],
    [
      'a space-bearing code, quoted, with each descendant listed quoted',
      ['dot-faa-faa   coe'],
      '"DOT-FAA-FAA COE"|"DOT-FAA-FAA COE-AJFE"|"DOT-FAA-FAA COE-FAA JAMS"|"DOT-FAA-FAA COE-GACOE"',
    ],
    ['a space-bearing leaf code, quoted', ['DOT-FTA - TPM'], '"DOT-FTA - TPM"'],
    [
      'a " - "-joined child the wildcard misses, appended',
      ['DOT-FTA'],
      'DOT-FTA|DOT-FTA-*|"DOT-FTA - TPM"',
    ],
    ['a prefix that is not a code, as its subtree only', ['HHS-OS'], 'HHS-OS-*'],
    [
      'leaf codes bare, never CODE* (USDA-FS is a non-hyphen prefix of USDA-FSA)',
      ['NSF', 'USDA-FS'],
      'NSF|USDA-FS',
    ],
    ['a repeated code once', ['NSF', 'nsf'], 'NSF'],
  ])('encodes %s', async (_label, agencies, sent) => {
    page([]);
    const { enrichment } = await run({ agencies });
    expect((await pageBodies())[0]?.agencies).toBe(sent);
    expect(enrichment.applied_filters).toMatchObject({ agencies_sent: sent });
  });
});

describe('include_unrestricted', () => {
  it('adds 99 to the eligibilities sent by default', async () => {
    page([]);
    const { enrichment } = await run({ eligibilities: ['12'] });
    expect((await pageBodies())[0]?.eligibilities).toBe('12|99');
    expect(enrichment.applied_filters).toMatchObject({
      eligibilities_sent: '12|99',
      include_unrestricted: true,
    });
  });

  it('sends only the listed codes when false', async () => {
    page(POSTED_HITS);
    await run({ eligibilities: ['12'], include_unrestricted: false });
    expect((await pageBodies())[0]?.eligibilities).toBe('12');
  });

  it('does not duplicate 99 when the caller lists it', async () => {
    page(POSTED_HITS);
    await run({ eligibilities: ['99', '12'] });
    expect((await pageBodies())[0]?.eligibilities).toBe('99|12');
  });

  it('does nothing without eligibilities', async () => {
    page(POSTED_HITS);
    await run({ include_unrestricted: true });
    expect((await pageBodies())[0]).not.toHaveProperty('eligibilities');
    expect(await snapshotCalls()).toBe(0);
  });
});

describe('paging', () => {
  it('flags a truncated page with next_offset and a More results notice', async () => {
    page(POSTED_HITS, 5);
    const { enrichment } = await run({ limit: 2 });
    expect(enrichment).toMatchObject({
      totalCount: 5,
      truncated: true,
      shown: 2,
      cap: 2,
      next_offset: 2,
      notice: 'More results: call again with offset 2.',
    });
  });

  it('reports the last page without next_offset or a notice', async () => {
    page([HRSA_HIT], 5);
    const { enrichment } = await run({ limit: 2, offset: 4 });
    expect(await pageBodies()).toEqual([{ ...DEFAULT_BODY, rows: 2, startRecordNum: 4 }]);
    expect(enrichment).toMatchObject({ totalCount: 5, truncated: false, shown: 1, cap: 2 });
    expect(enrichment).not.toHaveProperty('next_offset');
    expect(enrichment).not.toHaveProperty('notice');
  });

  it('explains an offset past the end (upstream keeps the true hitCount)', async () => {
    page([], 5);
    const { result, enrichment } = await run({ offset: 50 });
    expect(result.opportunities).toEqual([]);
    expect(enrichment).toMatchObject({
      totalCount: 5,
      truncated: false,
      shown: 0,
      notice:
        'Offset 50 is past the end of 5 results. Call again with offset 0, or a multiple of limit below 5.',
    });
    expect(enrichment).not.toHaveProperty('next_offset');
  });
});

describe('facets', () => {
  it('maps every facet group, trimming labels, with no sub_agencies unless agencies is set', async () => {
    page(CDC_FORECAST_HITS, 58, CDC_FACETS);
    const { result } = await run({});
    expect(result.facets).toEqual({
      statuses: [
        { code: 'posted', label: 'posted', count: 35 },
        { code: 'closed', label: 'closed', count: 69 },
        { code: 'archived', label: 'archived', count: 3758 },
        { code: 'forecasted', label: 'forecasted', count: 58 },
      ],
      eligibilities: [
        { code: '00', label: 'State governments', count: 41 },
        { code: '12', label: 'Nonprofits', count: 37 },
      ],
      funding_categories: [{ code: 'HL', label: 'Health', count: 58 }],
      funding_instruments: [
        { code: 'CA', label: 'Cooperative Agreement', count: 44 },
        { code: 'G', label: 'Grant', count: 14 },
      ],
      agencies: [{ code: 'HHS', label: 'Department of Health and Human Services', count: 58 }],
    });
  });

  it('lists sub_agencies when agencies is set', async () => {
    page(CDC_FORECAST_HITS, 58, CDC_FACETS);
    const { result } = await run({ agencies: ['HHS-CDC'] });
    expect(result.facets?.sub_agencies?.map((facet) => facet.code)).toEqual([
      'HHS-CDC-CSTLTS',
      'HHS-CDC-NCBDDD',
      'HHS-CDC-NCCDPHP',
    ]);
  });

  it('drops a top-level agency listed under itself from sub_agencies', async () => {
    const doc = FACETS_ALL.agencies?.filter((agency) => agency.value === 'DOC') ?? [];
    page([], 0, { agencies: doc });
    const { result } = await run({ agencies: ['DOC'] });
    expect(result.facets?.sub_agencies?.map((facet) => facet.code)).toEqual([
      'DOC-EDA',
      'DOC-NOAA',
    ]);
  });

  it('omits facets when include_facets is false', async () => {
    page(CDC_FORECAST_HITS, 58, CDC_FACETS);
    const { result } = await run({ include_facets: false });
    expect(result).not.toHaveProperty('facets');
  });
});

describe('zero-hit notice composition', () => {
  it('composes every applicable fragment in order', async () => {
    page([], 0, NSF_ZERO_HIT_FACETS);
    const { result, enrichment } = await run({
      keyword: 'tuberculosis tribal',
      eligibilities: ['07'],
      include_unrestricted: false,
      posted_within_days: 7,
      funding_instruments: ['G'],
    });
    expect(result.opportunities).toEqual([]);
    expect(enrichment).toMatchObject({ totalCount: 0, truncated: false, shown: 0, cap: 25 });
    expect(enrichment.notice).toBe(
      [
        'No opportunities matched these filters.',
        '236 closed and 972 archived opportunities match; add "closed" and/or "archived" to statuses to include them.',
        'All keyword terms were required (tuberculosis AND tribal); join alternatives with OR, in parentheses when other terms stay required, or drop a term.',
        'Set include_unrestricted to true to add opportunities open to any applicant type.',
        'Raise posted_within_days or remove it; it limits results to opportunities posted in the last 7 days.',
        'Remove one filter at a time, or confirm the eligibilities and funding_instruments codes with grantsgov_list_reference.',
        RERUN,
      ].join(' '),
    );
  });

  it('leaves out the status fragment when statuses was given explicitly', async () => {
    page([], 0, NSF_ZERO_HIT_FACETS);
    const { enrichment } = await run({ statuses: ['forecasted'], keyword: 'tuberculosis' });
    expect(enrichment.notice).toBe(`No opportunities matched these filters. ${RERUN}`);
  });

  it('leaves out the status fragment when no closed or archived opportunity matches', async () => {
    page([], 0, {});
    const { enrichment } = await run({ assistance_listing: '93.ECH' });
    expect(enrichment.notice).toBe(
      `No opportunities matched these filters. ${ALN_FRAGMENT('93.ECH')} ${RERUN}`,
    );
    expect((await pageBodies())[0]?.cfda).toBe('93.ECH');
  });

  it('never sends an assistance_listing-only search to grantsgov_list_reference, which has no ALN topic', async () => {
    page([], 0, {});
    const { enrichment } = await run({ assistance_listing: '99.999' });
    expect(enrichment.notice).not.toContain('grantsgov_list_reference');
    expect(enrichment.notice).toContain('search the program name as keyword');
  });

  it('names only the code filters grantsgov_list_reference can confirm', async () => {
    page([], 0, {});
    const { enrichment } = await run({
      agencies: ['NSF'],
      funding_categories: ['HL'],
      assistance_listing: '93866',
    });
    expect(enrichment.notice).toBe(
      [
        'No opportunities matched these filters.',
        ALN_FRAGMENT('93.866'),
        'Remove one filter at a time, or confirm the agencies and funding_categories codes with grantsgov_list_reference.',
        RERUN,
      ].join(' '),
    );
  });

  it('adds the exact-match fragment in opportunity-number mode, without the status counts', async () => {
    page([], 0, NSF_ZERO_HIT_FACETS);
    const { enrichment } = await run({ opportunity_number: 'HRSA-99-999' });
    expect(enrichment.notice).toBe(
      `No opportunities matched these filters. opportunity_number is exact-match; call grantsgov_get_opportunity with opportunity_numbers to search every status, or put the number in quotes in keyword for a full-text match. ${RERUN}`,
    );
    expect(await pageBodies()).toHaveLength(1);
  });
});

describe('opportunity-number mode', () => {
  it('sends the number quoted, filters to exact matches, and pages them locally', async () => {
    page(OPP_NUM_1_HITS, 6);
    const { result, enrichment } = await run({
      opportunity_number: '1',
      statuses: ['archived'],
      limit: 2,
      offset: 2,
    });
    expect(await pageBodies()).toEqual([
      {
        oppNum: '"1"',
        oppStatuses: 'archived',
        sortBy: 'openDate|desc',
        rows: 100,
        startRecordNum: 0,
      },
    ]);
    expect(ids(result)).toEqual(['53475', '252180']);
    expect(enrichment).toMatchObject({
      totalCount: 5,
      truncated: true,
      shown: 2,
      next_offset: 4,
      notice: 'More results: call again with offset 4.',
      applied_filters: { opportunity_number: '1' },
    });
  });

  it('never counts the non-equal upstream hit', async () => {
    page(OPP_NUM_1_HITS, 6);
    const { result, enrichment } = await run({ opportunity_number: '1', statuses: ['archived'] });
    expect(ids(result)).not.toContain('47142');
    expect(enrichment).toMatchObject({ totalCount: 5, truncated: false, shown: 5 });
  });

  it('explains an offset past the end of the local matches', async () => {
    page(OPP_NUM_1_HITS, 6);
    const { enrichment } = await run({
      opportunity_number: '1',
      statuses: ['archived'],
      offset: 10,
    });
    expect(enrichment).toMatchObject({
      totalCount: 5,
      shown: 0,
      notice:
        'Offset 10 is past the end of 5 results. Call again with offset 0, or a multiple of limit below 5.',
    });
  });

  it('retries once uppercased when a lowercase number has no exact match', async () => {
    serve(({ oppNum }) => ok(searchData(oppNum === '"HRSA-27-005"' ? [HRSA_HIT] : [])));
    const { result, enrichment } = await run({ opportunity_number: 'hrsa-27-005' });
    expect((await pageBodies()).map((body) => body.oppNum)).toEqual([
      '"hrsa-27-005"',
      '"HRSA-27-005"',
    ]);
    expect(ids(result)).toEqual(['363423']);
    expect(enrichment).toMatchObject({
      totalCount: 1,
      applied_filters: { opportunity_number: 'hrsa-27-005' },
    });
  });

  it('keeps a number containing a space literal', async () => {
    const hit: RawHit = { ...HRSA_HIT, id: '360001', number: 'PAS-TUNIS- APS FY2026' };
    page([hit]);
    const { result } = await run({ opportunity_number: ' PAS-TUNIS- APS FY2026 ' });
    expect((await pageBodies())[0]?.oppNum).toBe('"PAS-TUNIS- APS FY2026"');
    expect(ids(result)).toEqual(['360001']);
  });

  it('rejects a double quote inside the number at the schema', () => {
    expect(() => tool.input.parse({ opportunity_number: 'A"B' })).toThrow();
  });

  it('removes one pair of surrounding double quotes and quotes the number once upstream', async () => {
    page([HRSA_HIT]);
    const { result, enrichment } = await run({ opportunity_number: ' "HRSA-27-005" ' });
    expect((await pageBodies())[0]?.oppNum).toBe('"HRSA-27-005"');
    expect(ids(result)).toEqual(['363423']);
    expect(enrichment.applied_filters).toMatchObject({ opportunity_number: 'HRSA-27-005' });
  });
});

describe('closing-window mode', () => {
  const cutoff = (days: number) => addDays(today, days);

  it('scans posted records by close date and returns only the window', async () => {
    paged([
      postedHit(1, -1),
      postedHit(2, 0),
      postedHit(3, 3),
      postedHit(4, 7),
      postedHit(5, 8),
      postedHit(6, 'blank'),
    ]);
    const { result, enrichment } = await run({ closing_within_days: 7 });
    expect(await pageBodies()).toEqual([
      { oppStatuses: 'posted', sortBy: 'closeDate|asc', rows: 500, startRecordNum: 0 },
    ]);
    expect(ids(result)).toEqual(['2', '3', '4']);
    expect(result.opportunities.map((row) => row.days_until_close)).toEqual([0, 3, 7]);
    expect(enrichment).toEqual({
      totalCount: 3,
      truncated: false,
      shown: 3,
      cap: 25,
      notice: FACET_FRAGMENT,
      applied_filters: {
        statuses: ['posted'],
        statuses_defaulted: false,
        include_unrestricted: true,
        closing_within_days: 7,
        closing_cutoff_date: cutoff(7),
        sort: 'close_date_asc',
      },
    });
  });

  it('accepts statuses [posted], sort close_date_asc, and a digit string', async () => {
    paged([postedHit(1, 2)]);
    const { result, enrichment } = await run({
      closing_within_days: '7',
      statuses: ['Posted'],
      sort: 'close_date_asc',
      include_facets: false,
    });
    expect(ids(result)).toEqual(['1']);
    expect(enrichment).not.toHaveProperty('notice');
  });

  it('pages the window locally and composes the facet and More results fragments', async () => {
    paged([postedHit(1, 1), postedHit(2, 2), postedHit(3, 3), postedHit(4, 40)]);
    const { result, enrichment } = await run({ closing_within_days: 30, limit: 2 });
    expect(ids(result)).toEqual(['1', '2']);
    expect(enrichment).toMatchObject({
      totalCount: 3,
      truncated: true,
      shown: 2,
      next_offset: 2,
      notice: `${FACET_FRAGMENT} More results: call again with offset 2.`,
    });
  });

  it('names the next close date when it is fixed and within 365 days', async () => {
    paged([postedHit(1, 40)], 12);
    const { result, enrichment } = await run({ closing_within_days: 30, include_facets: false });
    expect(result.opportunities).toEqual([]);
    expect(enrichment).toMatchObject({
      totalCount: 0,
      truncated: false,
      shown: 0,
      notice: `No posted opportunity matching these filters closes within 30 days; the next one closes ${cutoff(40)} (40 days). Raise closing_within_days to at least 40.`,
    });
  });

  it('phrases a closing_within_days of 0 as today, with a singular day', async () => {
    paged([postedHit(1, 1)], 12);
    const { enrichment } = await run({ closing_within_days: 0, include_facets: false });
    expect(enrichment.notice).toBe(
      `No posted opportunity matching these filters closes today; the next one closes ${cutoff(1)} (1 day). Raise closing_within_days to at least 1.`,
    );
  });

  it('appends the facet fragment to the empty-window notice when facets are included', async () => {
    paged([postedHit(1, 40)], 12);
    const { enrichment } = await run({ closing_within_days: 30 });
    expect(enrichment.notice).toMatch(/Raise closing_within_days to at least 40\. Facet counts/);
  });

  it.each([
    ['a blank close date', postedHit(1, 'blank')],
    ['a placeholder close date', { ...postedHit(1, 0), closeDate: '01/01/2099' }],
    ['a fixed date more than 365 days out', postedHit(1, 400)],
  ])('points to a close-date sort when the next row has %s', async (_label, next) => {
    paged([next], 77);
    const { enrichment } = await run({ closing_within_days: 30, include_facets: false });
    expect(enrichment.notice).toBe(
      'No posted opportunity matching these filters has a fixed deadline within 30 days; all 77 posted matches close later or list no fixed date. Call grantsgov_search_opportunities without closing_within_days and with sort close_date_asc to see them.',
    );
  });

  it('falls back to the zero-hit composition when nothing posted matches', async () => {
    paged([], 0);
    const { enrichment } = await run({ closing_within_days: 30, include_facets: false });
    expect(enrichment.notice).toBe(`No opportunities matched these filters. ${RERUN}`);
  });

  it('stops at the 2,000-row ceiling and says so', async () => {
    paged(Array.from({ length: 2500 }, (_, i) => postedHit(i + 1, 2)));
    const { result, enrichment } = await run({ closing_within_days: 5, include_facets: false });
    expect(await pageBodies()).toHaveLength(4);
    expect(result.opportunities).toHaveLength(25);
    expect(enrichment).toMatchObject({
      totalCount: 2000,
      truncated: true,
      next_offset: 25,
      notice:
        'The closing window holds more than 2,000 opportunities; results cover the first 2,000 by close date. Add filters to narrow. More results: call again with offset 25.',
    });
  });

  it('applies the exact-number filter to the window, retrying uppercased', async () => {
    const match: RawHit = { ...HRSA_HIT, closeDate: closingIn(5) };
    const nonEqual: RawHit = {
      ...HRSA_HIT,
      id: '363424',
      number: 'HRSA-27-0051',
      closeDate: closingIn(6),
    };
    serve(({ oppNum }) => ok(searchData(oppNum === '"HRSA-27-005"' ? [match, nonEqual] : [])));
    const { result, enrichment } = await run({
      closing_within_days: 30,
      opportunity_number: 'hrsa-27-005',
    });
    expect((await pageBodies()).map((body) => [body.oppNum, body.oppStatuses])).toEqual([
      ['"hrsa-27-005"', 'posted'],
      ['"HRSA-27-005"', 'posted'],
    ]);
    expect(ids(result)).toEqual(['363423']);
    expect(enrichment.totalCount).toBe(1);
  });

  it('does not count non-equal oppNum hits as posted matches in the empty-window notice', async () => {
    const [nonEqual] = OPP_NUM_1_HITS as [RawHit];
    paged([{ ...nonEqual, oppStatus: 'posted', closeDate: closingIn(3) }], 1);
    const { result, enrichment } = await run({
      closing_within_days: 30,
      opportunity_number: '1',
      include_facets: false,
    });
    expect(result.opportunities).toEqual([]);
    expect(enrichment.notice).toBe(
      `No opportunities matched these filters. opportunity_number is exact-match; call grantsgov_get_opportunity with opportunity_numbers to search every status, or put the number in quotes in keyword for a full-text match. ${RERUN}`,
    );
  });

  it('cuts the window from one close-date page of exact matches in number mode', async () => {
    const [nonEqual] = OPP_NUM_1_HITS as [RawHit];
    const match: RawHit = { ...HRSA_HIT, closeDate: closingIn(45) };
    paged([{ ...nonEqual, oppStatus: 'posted', closeDate: closingIn(3) }, match], 2);
    const { result, enrichment } = await run({
      closing_within_days: 30,
      opportunity_number: 'HRSA-27-005',
      include_facets: false,
    });
    expect(await pageBodies()).toEqual([
      {
        oppNum: '"HRSA-27-005"',
        oppStatuses: 'posted',
        sortBy: 'closeDate|asc',
        rows: 100,
        startRecordNum: 0,
      },
    ]);
    expect(result.opportunities).toEqual([]);
    expect(enrichment.notice).toBe(
      `No posted opportunity matching these filters closes within 30 days; the next one closes ${cutoff(45)} (45 days). Raise closing_within_days to at least 45.`,
    );
  });

  it('keeps a lowercase number’s own scan when it has an exact posted match past the window', async () => {
    const match: RawHit = { ...HRSA_HIT, number: 'abc-1', closeDate: closingIn(45) };
    serve(({ oppNum }) => ok(searchData(oppNum === '"abc-1"' ? [match] : [])));
    const { enrichment } = await run({
      closing_within_days: 30,
      opportunity_number: 'abc-1',
      include_facets: false,
    });
    expect((await pageBodies()).map((body) => body.oppNum)).toEqual(['"abc-1"']);
    expect(enrichment.notice).toContain('the next one closes');
  });

  it('names a single posted match in the singular', async () => {
    paged([{ ...HRSA_HIT, closeDate: '01/01/2099' }], 1);
    const { enrichment } = await run({
      closing_within_days: 30,
      opportunity_number: 'HRSA-27-005',
      include_facets: false,
    });
    expect(enrichment.notice).toBe(
      'No posted opportunity matching these filters has a fixed deadline within 30 days; the 1 posted match closes later or lists no fixed date. Call grantsgov_search_opportunities without closing_within_days and with sort close_date_asc to see them.',
    );
  });

  it('explains posted matches dated before today instead of claiming they close later', async () => {
    paged([postedHit(1, -1), postedHit(2, -1)], 2);
    const { result, enrichment } = await run({ closing_within_days: 30, include_facets: false });
    expect(result.opportunities).toEqual([]);
    expect(enrichment.notice).toBe(
      'No posted opportunity matching these filters closes within 30 days; all 2 posted matches have close dates before today that Grants.gov has not yet marked closed. Call grantsgov_search_opportunities without closing_within_days and with sort close_date_asc to see them.',
    );
  });
});

describe('error contract', () => {
  it.each([
    [
      'statuses other than posted',
      { closing_within_days: 7, statuses: ['posted', 'closed'] },
      'closing_within_days searches posted opportunities only, so it cannot combine with statuses posted, closed.',
      'Remove statuses (closing_within_days always searches posted opportunities), or remove closing_within_days, and call grantsgov_search_opportunities again.',
    ],
    [
      'a sort other than close_date_asc',
      { closing_within_days: 7, sort: 'open_date_desc' },
      'closing_within_days orders results by close date, so it cannot combine with sort open_date_desc.',
      'Remove sort (closing_within_days always sorts close_date_asc), or remove closing_within_days, and call grantsgov_search_opportunities again.',
    ],
    [
      'posted_within_days with closed or archived',
      { posted_within_days: 30, statuses: ['posted', 'archived', 'closed'] },
      'posted_within_days works only with the forecasted and posted statuses; Grants.gov ignores archived and closed when a posting window is set.',
      'Remove archived and closed from statuses, or remove posted_within_days, and call grantsgov_search_opportunities again.',
    ],
  ])(
    'throws filter_conflict for closing/posting windows with %s, before any upstream call',
    async (_label, input, message, hint) => {
      const error = await failure(input);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(message);
      expect(error.data).toMatchObject({ reason: 'filter_conflict', recovery: { hint } });
      expect(http.calls).toHaveLength(0);
    },
  );

  it.each([
    ['rural AND', 'it ends with a dangling AND'],
    ['"mental health', 'it has an unbalanced double quote'],
    ['(rural OR tribal', 'it has an opening parenthesis with no matching closing one'],
    ['OR broadband', 'it starts a group or the keyword with OR'],
    ['?! ~ ^', 'nothing searchable is left after removing unsupported characters and operators'],
  ])('throws invalid_keyword for %j', async (keyword, problem) => {
    const error = await failure({ keyword });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(`The keyword was rejected because ${problem}.`);
    expect(error.data).toMatchObject({
      reason: 'invalid_keyword',
      keyword,
      recovery: {
        hint: 'Fix the keyword syntax, or call grantsgov_list_reference with topic keyword_syntax for the supported operators.',
      },
    });
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    [
      'broadband OR internet rural',
      'it mixes AND and OR without parentheses (broadband OR internet AND rural; bare terms are joined by AND), so which terms are alternatives is ambiguous',
      'Add parentheses to say which terms are alternatives, e.g. (broadband OR internet) AND rural or broadband OR (internet AND rural).',
    ],
    [
      'agency:NSF',
      'it uses field syntax (agency:NSF), which keyword does not support',
      'Drop "agency:" and pass NSF in the agencies filter (codes from grantsgov_list_reference topic agencies), or keep NSF as a plain keyword term to match it anywhere in the text.',
    ],
    [
      'cfda:93.866',
      'it uses field syntax (cfda:93.866), which keyword does not support',
      'Drop "cfda:" and pass 93.866 in the assistance_listing filter, or keep 93.866 as a plain keyword term to match it anywhere in the text.',
    ],
  ])(
    'throws invalid_keyword for %j with a keyword-specific recovery hint',
    async (keyword, problem, hint) => {
      const error = await failure({ keyword });
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(`The keyword was rejected because ${problem}.`);
      expect(error.data).toMatchObject({ reason: 'invalid_keyword', keyword, recovery: { hint } });
      expect(http.calls).toHaveLength(0);
    },
  );

  it.each([
    ['xyz', 'XYZ'],
    ['HHS-O', 'HHS-O'],
  ])('throws unknown_agency for %j, naming the normalized code', async (raw, code) => {
    serve(() => ok(searchData([])));
    const error = await failure({ agencies: ['NSF', raw] });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(`No agency code "${code}" in the Grants.gov vocabulary.`);
    expect(error.data).toMatchObject({
      reason: 'unknown_agency',
      agency: code,
      recovery: {
        hint: `Call grantsgov_list_reference with topic agencies and name_contains set to the agency name to find the code for "${code}".`,
      },
    });
    expect(await pageBodies()).toEqual([]);
  });

  it('throws unknown_eligibility for a code outside the vocabulary', async () => {
    serve(() => ok(searchData([])));
    const error = await failure({ eligibilities: ['12', '42'] });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe('"42" is not a Grants.gov applicant-type code.');
    expect(error.data).toMatchObject({
      reason: 'unknown_eligibility',
      eligibility: '42',
      recovery: {
        hint: 'Call grantsgov_list_reference with topic eligibilities for the valid two-digit applicant-type codes.',
      },
    });
    expect(await pageBodies()).toEqual([]);
  });

  it('throws unknown_funding_category for a code outside the vocabulary', async () => {
    serve(() => ok(searchData([])));
    const error = await failure({ funding_categories: ['zz'] });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe('"ZZ" is not a Grants.gov funding category code.');
    expect(error.data).toMatchObject({
      reason: 'unknown_funding_category',
      fundingCategory: 'ZZ',
      recovery: {
        hint: 'Call grantsgov_list_reference with topic funding_categories for the valid category codes.',
      },
    });
  });

  it('surfaces upstream_route_unavailable with this tool’s recovery hint on a 403', async () => {
    serve(() => json({ message: 'Missing Authentication Token' }, 403));
    const error = await failure({});
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'upstream_route_unavailable',
      retryable: false,
      recovery: {
        hint: 'The Grants.gov search API route is not answering; the legacy API may have been retired, so report this to the server maintainer.',
      },
    });
    expect(await pageBodies()).toHaveLength(1);
  });

  it.each([502, 504])(
    'surfaces upstream_unavailable with this tool’s recovery hint after retrying a %i',
    async (status) => {
      serve(() => json({ message: 'Internal server error' }, status));
      const error = await drainedFailure({});
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'upstream_unavailable',
        retryAttempts: 3,
        recovery: {
          hint: 'Grants.gov is not responding; wait a minute and call grantsgov_search_opportunities again.',
        },
      });
      expect(await pageBodies()).toHaveLength(3);
    },
  );

  it('surfaces rate_limited with this tool’s recovery hint on a 429 past the retry budget', async () => {
    serve(() => json({ message: 'Too Many Requests' }, 429, { 'Retry-After': '120' }));
    const error = await drainedFailure({});
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({
      reason: 'rate_limited',
      status: 429,
      retryAfter: '120',
      recovery: {
        hint: 'Grants.gov is rate limiting requests; wait the retryAfter interval (or a minute) and call grantsgov_search_opportunities again.',
      },
    });
    expect(await pageBodies()).toHaveLength(1);
  });

  it('declares exactly the reasons exercised above', () => {
    expect(tool.errors?.map((entry) => entry.reason)).toEqual([
      'invalid_keyword',
      'unknown_agency',
      'unknown_eligibility',
      'unknown_funding_category',
      'filter_conflict',
      'upstream_unavailable',
      'rate_limited',
      'upstream_route_unavailable',
    ]);
  });
});

describe('input schema', () => {
  it.each([
    ['an unknown status', { statuses: ['open'] }],
    ['an unknown sort', { sort: 'relevance_desc' }],
    ['an unknown funding instrument', { funding_instruments: ['X'] }],
    ['a three-digit eligibility', { eligibilities: ['123'] }],
    ['a three-digit numeric eligibility', { eligibilities: [123] }],
    ['an empty quoted opportunity number', { opportunity_number: '""' }],
    ['a wildcard agency code', { agencies: ['HHS*'] }],
    ['a malformed ALN', { assistance_listing: '93.8666' }],
    ['a multi-value ALN', { assistance_listing: '93.866|47.076' }],
    ['posted_within_days 0', { posted_within_days: 0 }],
    ['closing_within_days over 365', { closing_within_days: 366 }],
    ['a non-digit day string', { closing_within_days: 'soon' }],
    ['limit over 100', { limit: 101 }],
    ['a keyword over 500 characters', { keyword: 'x'.repeat(501) }],
    ['more than 10 agencies', { agencies: Array.from({ length: 11 }, () => 'NSF') }],
  ])('rejects %s', (_label, input) => {
    expect(() => tool.input.parse(input)).toThrow();
  });
});

describe('production envelope (runToolContract)', () => {
  const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

  it('parses a zero-result page against output + enrichment', async () => {
    page([], 0, NSF_ZERO_HIT_FACETS);
    const result = await runToolContract(tool, { agencies: ['NSF'], statuses: ['forecasted'] });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      opportunities: [],
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 25,
      applied_filters: { agencies_sent: 'NSF', statuses: ['forecasted'] },
      notice: expect.stringContaining('No opportunities matched these filters.'),
    });
    expect(text(result)).toContain('No opportunities on this page.');
    expect(text(result)).toContain('**Applied filters:**');
  });

  it('parses an under-cap page against output + enrichment', async () => {
    page(POSTED_HITS, 2, CDC_FACETS);
    const result = await runToolContract(tool, { keyword: 'research' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      totalCount: 2,
      truncated: false,
      shown: 2,
      effective_keyword: 'research',
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(result.structuredContent).not.toHaveProperty('next_offset');
    expect(text(result)).toContain('`HT942526AZRPTRRA`');
  });

  it('parses a truncated page against output + enrichment', async () => {
    page(POSTED_HITS, 940);
    const result = await runToolContract(tool, { limit: 2, include_facets: false });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      totalCount: 940,
      truncated: true,
      shown: 2,
      cap: 2,
      next_offset: 2,
      notice: 'More results: call again with offset 2.',
    });
    expect(result.structuredContent).not.toHaveProperty('facets');
  });

  it('parses a truncated opportunity-number page', async () => {
    page(OPP_NUM_1_HITS, 6);
    const result = await runToolContract(tool, {
      opportunity_number: '1',
      statuses: ['archived'],
      limit: 3,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ totalCount: 5, truncated: true, shown: 3 });
  });

  it('parses an empty closing window', async () => {
    paged([postedHit(1, 40)], 12);
    const result = await runToolContract(tool, { closing_within_days: 30 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      opportunities: [],
      totalCount: 0,
      applied_filters: { closing_within_days: 30, sort: 'close_date_asc' },
      notice: expect.stringContaining('Raise closing_within_days to at least 40.'),
    });
  });

  it('returns the dual-surface error envelope for a declared failure', async () => {
    const result = await runToolContract(tool, { closing_within_days: 7, sort: 'agency_asc' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'filter_conflict' },
      },
    });
    expect(text(result)).toContain('Remove sort (closing_within_days always sorts close_date_asc)');
  });
});

describe('format', () => {
  const render = (result: Output) => {
    const [block] = tool.format?.(result) ?? [];
    if (block?.type !== 'text') throw new Error('Expected one text block');
    return block.text;
  };

  const row = (overrides: Partial<Output['opportunities'][number]>) => ({
    opportunity_id: '363423',
    opportunity_number: 'HRSA-27-005',
    title: 'Fiscal Year (FY) 2027 Service Area Competition (SAC)',
    status: 'posted' as const,
    doc_type: 'synopsis' as const,
    agency_code: 'HHS-HRSA',
    agency_name: 'Health Resources and Services Administration',
    open_date: '2026-09-18',
    close_date: '2026-10-19',
    close_date_kind: 'fixed' as const,
    days_until_close: 26,
    assistance_listings: ['93.224'],
    ...overrides,
  });

  it('renders one table row per opportunity, deadline first', () => {
    const text = render({ opportunities: [row({})] });
    expect(text).toContain(
      '| Close date | Days left | Title | Opportunity number | ID | Agency | Status | Posted | ALN |',
    );
    expect(text).toContain(
      '| 2026-10-19 | 26 | Fiscal Year (FY) 2027 Service Area Competition (SAC) | `HRSA-27-005` | 363423 | Health Resources and Services Administration `HHS-HRSA` | posted (synopsis) | 2026-09-18 | 93.224 |',
    );
    expect(text).not.toContain('### Facet counts');
  });

  it('renders none-listed and placeholder close dates and sparse rows honestly', () => {
    const {
      close_date: _c,
      days_until_close: _d,
      agency_code: _ac,
      agency_name: _an,
      open_date: _o,
      ...bare
    } = row({});
    const text = render({
      opportunities: [
        { ...bare, close_date_kind: 'none_listed', doc_type: 'forecast', assistance_listings: [] },
        row({
          close_date: '2099-01-01',
          close_date_kind: 'placeholder',
          days_until_close: undefined,
        }),
      ],
    });
    expect(text).toContain(
      '| none listed | — | Fiscal Year (FY) 2027 Service Area Competition (SAC) | `HRSA-27-005` | 363423 | Not listed | posted (forecast) | not listed | none |',
    );
    expect(text).toContain('| 2099-01-01 (placeholder date: open-ended) | — |');
  });

  it('keeps agency-authored text inside its cell (| escaped, line breaks flattened)', () => {
    const text = render({
      opportunities: [
        row({
          title: 'Evil | title\r\n## Injected heading',
          agency_name: 'Agency\nName',
          opportunity_number: 'A|B',
        }),
      ],
      facets: {
        statuses: [{ code: 'posted', label: 'posted\n# Forged', count: 1 }],
        eligibilities: [],
        funding_categories: [],
        funding_instruments: [],
        agencies: [],
      },
    });
    expect(text).toContain('| Evil \\| title ## Injected heading | `A\\|B` |');
    expect(text).toContain('| Agency Name `HHS-HRSA` |');
    expect(text).toContain('- **Statuses:** `posted` posted # Forged (1)');
    const lines = text.split('\n');
    expect(lines.some((line) => line.startsWith('## Injected'))).toBe(false);
    expect(lines.some((line) => line.startsWith('# Forged'))).toBe(false);
  });

  it('flattens Unicode line breaks and escapes every upstream cell, the id included', () => {
    const text = render({
      opportunities: [
        row({
          opportunity_id: '1 | 2\u2028# Forged id',
          title: 'Title\u2029## Forged title',
          agency_name: 'Agency\u0085Name \\| split',
        }),
      ],
    });
    expect(text).toContain(
      '| Title ## Forged title | `HRSA-27-005` | 1 \\| 2 # Forged id | Agency Name \\\\\\| split `HHS-HRSA` |',
    );
    const lines = text.split(/\r\n|[\n\v\f\r\u0085\u2028\u2029]/);
    expect(lines.some((line) => line.startsWith('## Forged'))).toBe(false);
    expect(lines.some((line) => line.startsWith('# Forged'))).toBe(false);
  });

  it('renders facet groups, "none" for an empty group, and sub-agencies only when present', () => {
    const facets = {
      statuses: [{ code: 'posted', label: 'posted', count: 35 }],
      eligibilities: [],
      funding_categories: [{ code: 'HL', label: 'Health', count: 58 }],
      funding_instruments: [{ code: 'G', label: 'Grant', count: 14 }],
      agencies: [{ code: 'HHS', label: 'Department of Health and Human Services', count: 58 }],
    };
    const text = render({ opportunities: [], facets });
    expect(text).toContain('No opportunities on this page.');
    expect(text).toContain('### Facet counts');
    expect(text).toContain('- **Applicant eligibility:** none');
    expect(text).toContain('- **Funding categories:** `HL` Health (58)');
    expect(text).not.toContain('Sub-agencies');
    const withSubs = render({
      opportunities: [],
      facets: { ...facets, sub_agencies: [{ code: 'HHS-CDC', label: 'CDC', count: 3 }] },
    });
    expect(withSubs).toContain('- **Sub-agencies:** `HHS-CDC` CDC (3)');
  });
});
