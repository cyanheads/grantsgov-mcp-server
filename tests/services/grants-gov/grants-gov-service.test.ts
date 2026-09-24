/**
 * @fileoverview Tests for GrantsGovService at the HTTP boundary: the exact
 * request sent, the per-endpoint accept-list and body classification, retry,
 * the reference snapshot cache, number resolution, and the closing-window scan.
 * Retry backoff runs under fake timers (see `drained`).
 * @module tests/services/grants-gov/grants-gov-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { grantsgovListReference } from '@/mcp-server/tools/definitions/grantsgov-list-reference.tool.js';
import { ALL_STATUSES, GrantsGovService } from '@/services/grants-gov/grants-gov-service.js';
import { addDays, todayET } from '@/services/grants-gov/normalize.js';
import {
  bodyOf,
  DETAIL_BACKEND_UNAVAILABLE,
  DETAIL_HRSA,
  DETAIL_ID_REQUIRED,
  DETAIL_NOT_FOUND,
  envelope,
  FACETS_ALL,
  FACETS_OPEN,
  FETCH_URL,
  HRSA_HIT,
  html,
  json,
  OPP_NUM_1_HITS,
  ok,
  POSTED_HITS,
  postedHit,
  referenceRoute,
  SEARCH2_URL,
  searchData,
} from '../../fixtures/grants-gov.js';
import { drained, rejectionOf } from '../../fixtures/harness.js';

const ctxFor = (options: { signal?: AbortSignal } = {}) =>
  createMockContext({ errors: grantsgovListReference.errors, ...options });

let http: FetchMockHarness;
let service: GrantsGovService;

beforeEach(() => {
  http = createFetchMock();
  http.install();
  service = new GrantsGovService();
});

afterEach(() => {
  service.dispose();
  http.restore();
  vi.restoreAllMocks();
});

const route = (
  match: string,
  respond: Response | ((request: Request) => Response | Promise<Response>),
  once = false,
) => http.route({ method: 'POST', match, respond, ...(once && { once }) });

/** Runs `call` to its rejection, retry backoff drained, and returns it as an McpError. */
async function rejection(call: () => Promise<unknown>): Promise<McpError> {
  const error: unknown = await drained(() => rejectionOf(call));
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

describe('search', () => {
  it('POSTs the body verbatim as JSON and returns hits and facets', async () => {
    route(SEARCH2_URL, ok(searchData(POSTED_HITS, 940, FACETS_OPEN)));
    const body = { keyword: 'rural AND broadband', oppStatuses: 'posted', rows: 25 };

    const result = await service.search(body, ctxFor());

    expect(result.hitCount).toBe(940);
    expect(result.hits).toEqual(POSTED_HITS);
    expect(result.facets.agencies).toEqual(FACETS_OPEN.agencies);
    expect(result.facets.oppStatusOptions).toEqual(FACETS_OPEN.oppStatusOptions);
    expect(http.calls).toHaveLength(1);
    const [call] = http.calls;
    expect(call?.request.method).toBe('POST');
    expect(call?.request.url).toBe(SEARCH2_URL);
    expect(call?.request.headers.get('content-type')).toBe('application/json');
    expect(await call?.request.clone().text()).toBe(JSON.stringify(body));
  });

  it('reads a missing oppHits as no rows', async () => {
    route(SEARCH2_URL, ok({ hitCount: 0 }));
    const result = await service.search({ rows: 0 }, ctxFor());
    expect(result).toEqual({ hitCount: 0, hits: [], facets: expect.any(Object) });
  });

  it('classifies a body with no hit count as upstream_unavailable', async () => {
    route(SEARCH2_URL, ok({ oppHits: [] }));
    const error = await rejection(() => service.search({}, ctxFor()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('no hit count');
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
  });

  it('does not accept 404 on search2 (accept-list is {200})', async () => {
    route(SEARCH2_URL, json({ message: 'Not Found' }, 404));
    const error = await rejection(() => service.search({}, ctxFor()));
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(http.calls).toHaveLength(1);
  });
});

describe('accept-list and body classification', () => {
  it('maps 403 Missing Authentication Token to upstream_route_unavailable, without retrying', async () => {
    route(SEARCH2_URL, json({ message: 'Missing Authentication Token' }, 403));
    const error = await rejection(() => service.search({}, ctxFor()));

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'upstream_route_unavailable',
      retryable: false,
      status: 403,
      recovery: { hint: expect.stringContaining('report this to the server maintainer') },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('retries a 502 and classifies the exhausted ladder as upstream_unavailable', async () => {
    route(SEARCH2_URL, json({ message: 'Internal server error' }, 502));
    const error = await rejection(() => service.search({}, ctxFor()));

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('failed after 3 attempts');
    expect(error.data).toMatchObject({
      reason: 'upstream_unavailable',
      status: 502,
      retryAttempts: 3,
      recovery: { hint: expect.stringContaining('call grantsgov_list_reference again') },
    });
    expect(http.calls).toHaveLength(3);
  });

  it('classifies a 504 as upstream_unavailable with the contract’s ServiceUnavailable code', async () => {
    route(SEARCH2_URL, json({ message: 'Endpoint request timed out' }, 504));
    const error = await rejection(() => service.search({}, ctxFor()));
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', status: 504 });
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('aborts an attempt that outlives its 15 s timeout and retries it', async () => {
    route(
      SEARCH2_URL,
      (request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
      true,
    );
    route(SEARCH2_URL, ok(searchData(POSTED_HITS, 2)));
    const result = await drained(() => service.search({}, ctxFor()));
    expect(result.hitCount).toBe(2);
    expect(http.calls).toHaveLength(2);
  });

  it('recovers when a 502 is followed by a 200', async () => {
    route(SEARCH2_URL, json({ message: 'Internal server error' }, 502), true);
    route(SEARCH2_URL, ok(searchData(POSTED_HITS, 2)));
    const result = await drained(() => service.search({}, ctxFor()));
    expect(result.hitCount).toBe(2);
    expect(http.calls).toHaveLength(2);
  });

  it('classifies an HTML body on a 200 as upstream_unavailable', async () => {
    route(SEARCH2_URL, html(200));
    const error = await rejection(() => service.search({}, ctxFor()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('returned HTML instead of JSON');
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
    expect(http.calls).toHaveLength(3);
  });

  it('classifies a non-JSON body as upstream_unavailable', async () => {
    route(SEARCH2_URL, new Response('Webservice Fails', { status: 200 }));
    const error = await rejection(() => service.search({}, ctxFor()));
    expect(error.message).toContain('not valid JSON');
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
  });

  it('classifies a non-zero errorcode as upstream_unavailable', async () => {
    route(SEARCH2_URL, Response.json(envelope(null, 1)));
    const error = await rejection(() => service.search({}, ctxFor()));
    expect(error.message).toContain('reported error code 1');
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
  });

  it('classifies a 200 with no data object as upstream_unavailable', async () => {
    route(SEARCH2_URL, Response.json({ errorcode: 0, msg: 'Webservice Succeeds' }));
    const error = await rejection(() => service.search({}, ctxFor()));
    expect(error.message).toContain('no data object');
  });

  it('fails fast on 429 when Retry-After exceeds the retry budget, keeping the hint', async () => {
    route(SEARCH2_URL, json({ message: 'Too Many Requests' }, 429, { 'Retry-After': '120' }));
    const error = await rejection(() => service.search({}, ctxFor()));
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ status: 429, retryAfter: '120' });
    expect(http.calls).toHaveLength(1);
  });

  it('honors a short Retry-After on 429 and succeeds on the retry', async () => {
    route(SEARCH2_URL, json({ message: 'Too Many Requests' }, 429, { 'Retry-After': '0' }), true);
    route(SEARCH2_URL, ok(searchData(POSTED_HITS, 2)));
    const result = await service.search({}, ctxFor());
    expect(result.hitCount).toBe(2);
    expect(http.calls).toHaveLength(2);
  });

  it('wraps a network failure as upstream_unavailable and retries it', async () => {
    route(
      SEARCH2_URL,
      async () => {
        throw new TypeError('fetch failed');
      },
      true,
    );
    route(SEARCH2_URL, ok(searchData(POSTED_HITS, 2)));
    const result = await drained(() => service.search({}, ctxFor()));
    expect(result.hitCount).toBe(2);
    expect(http.calls).toHaveLength(2);
  });

  it('reports an exhausted network failure with the upstream message', async () => {
    route(SEARCH2_URL, async () => {
      throw new TypeError('fetch failed');
    });
    const error = await rejection(() => service.search({}, ctxFor()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('Could not reach Grants.gov search2: fetch failed');
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
  });

  it('stops at once when the caller cancels', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller went away'));
    route(SEARCH2_URL, ok(searchData([], 0)));
    await expect(service.search({}, ctxFor({ signal: controller.signal }))).rejects.toThrow(
      'caller went away',
    );
    expect(http.calls).toHaveLength(0);
  });
});

describe('fetchOpportunity', () => {
  it('sends { opportunityId } and returns the record with its revision history stripped', async () => {
    route(FETCH_URL, ok(DETAIL_HRSA));
    const result = await service.fetchOpportunity(363423, ctxFor());

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.record).not.toHaveProperty('opportunityHistoryDetails');
    expect(result.record).toMatchObject({
      id: 363423,
      opportunityNumber: 'HRSA-27-005',
      docType: 'synopsis',
      forecastHistCount: 11,
      synopsis: { awardCeiling: '10116100' },
      forecast: { awardCeiling: '19182000' },
    });
    expect(await bodyOf(http.calls[0]?.request as Request)).toEqual({ opportunityId: 363423 });
  });

  it('reads the 200 not-found skeleton as not_found, never thrown', async () => {
    route(FETCH_URL, ok(DETAIL_NOT_FOUND));
    await expect(service.fetchOpportunity(999999999, ctxFor())).resolves.toEqual({
      kind: 'not_found',
    });
    expect(http.calls).toHaveLength(1);
  });

  it('reads a 404 as not_found without parsing the body', async () => {
    route(FETCH_URL, html(404));
    await expect(service.fetchOpportunity(999999999, ctxFor())).resolves.toEqual({
      kind: 'not_found',
    });
    expect(http.calls).toHaveLength(1);
  });

  it('classifies the in-band "backend … is not available" message as upstream_unavailable', async () => {
    route(FETCH_URL, ok(DETAIL_BACKEND_UNAVAILABLE));
    const error = await rejection(() => service.fetchOpportunity(363423, ctxFor()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('backend is unavailable');
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
    expect(http.calls).toHaveLength(3);
  });

  it('classifies a body that is neither a record nor a not-found as upstream_unavailable', async () => {
    route(FETCH_URL, ok(DETAIL_ID_REQUIRED));
    const error = await rejection(() => service.fetchOpportunity(363423, ctxFor()));
    expect(error.message).toContain('neither a record nor a not-found message');
  });

  it('maps 403 to upstream_route_unavailable', async () => {
    route(FETCH_URL, json({ message: 'Missing Authentication Token' }, 403));
    const error = await rejection(() => service.fetchOpportunity(363423, ctxFor()));
    expect(error.data).toMatchObject({ reason: 'upstream_route_unavailable', retryable: false });
    expect(http.calls).toHaveLength(1);
  });

  it('maps an exhausted 502 to upstream_unavailable', async () => {
    route(FETCH_URL, json({ message: 'Internal server error' }, 502));
    const error = await rejection(() => service.fetchOpportunity(363423, ctxFor()));
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', status: 502 });
  });

  it('classifies an HTML body on a 200 as upstream_unavailable', async () => {
    route(FETCH_URL, html(200));
    const error = await rejection(() => service.fetchOpportunity(363423, ctxFor()));
    expect(error.message).toContain('fetchOpportunity returned HTML');
  });
});

describe('resolveNumber', () => {
  it('resolves a unique number, sent quoted across all four statuses', async () => {
    route(SEARCH2_URL, ok(searchData([HRSA_HIT])));
    await expect(service.resolveNumber('HRSA-27-005', ctxFor())).resolves.toEqual({
      kind: 'unique',
      id: 363423,
    });
    expect(await bodyOf(http.calls[0]?.request as Request)).toEqual({
      oppNum: '"HRSA-27-005"',
      oppStatuses: ALL_STATUSES,
      rows: 10,
    });
  });

  it('returns every exact match as ambiguous and filters the non-equal upstream hit', async () => {
    route(SEARCH2_URL, ok(searchData(OPP_NUM_1_HITS)));
    const result = await service.resolveNumber('1', ctxFor());
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates.map((hit) => hit.id)).toEqual([
      '169194',
      '169193',
      '53475',
      '252180',
      '263109',
    ]);
    expect(result.candidates.some((hit) => hit.number === '21561-9-F017A')).toBe(false);
  });

  it('is not_found when the only upstream hit is a non-equal number', async () => {
    route(SEARCH2_URL, ok(searchData(OPP_NUM_1_HITS.slice(0, 1))));
    await expect(service.resolveNumber('1', ctxFor())).resolves.toEqual({ kind: 'not_found' });
    expect(http.calls).toHaveLength(1);
  });

  it('is not_found on zero hits, with no retry when the number has no lowercase', async () => {
    route(SEARCH2_URL, ok(searchData([])));
    await expect(service.resolveNumber('HRSA-99-999', ctxFor())).resolves.toEqual({
      kind: 'not_found',
    });
    expect(http.calls).toHaveLength(1);
  });

  it('retries once uppercased when a lowercase number has no exact match', async () => {
    route(SEARCH2_URL, ok(searchData([])), true);
    route(SEARCH2_URL, ok(searchData([HRSA_HIT])));
    await expect(service.resolveNumber('hrsa-27-005', ctxFor())).resolves.toEqual({
      kind: 'unique',
      id: 363423,
    });
    expect(http.calls).toHaveLength(2);
    expect((await bodyOf(http.calls[0]?.request as Request)).oppNum).toBe('"hrsa-27-005"');
    expect((await bodyOf(http.calls[1]?.request as Request)).oppNum).toBe('"HRSA-27-005"');
  });

  it('is not_found after the uppercase retry also misses', async () => {
    route(SEARCH2_URL, ok(searchData([])));
    await expect(service.resolveNumber('hrsa-99-999', ctxFor())).resolves.toEqual({
      kind: 'not_found',
    });
    expect(http.calls).toHaveLength(2);
  });

  it('quotes a number containing a space and matches it exactly', async () => {
    const hit = { ...HRSA_HIT, id: '360001', number: 'PAS-TUNIS- APS FY2026' };
    route(SEARCH2_URL, ok(searchData([hit])));
    await expect(service.resolveNumber('PAS-TUNIS- APS FY2026', ctxFor())).resolves.toEqual({
      kind: 'unique',
      id: 360001,
    });
    expect((await bodyOf(http.calls[0]?.request as Request)).oppNum).toBe(
      '"PAS-TUNIS- APS FY2026"',
    );
  });

  it('ignores hits without a numeric id', async () => {
    route(
      SEARCH2_URL,
      ok(
        searchData([
          { ...HRSA_HIT, id: null },
          { ...HRSA_HIT, id: 'abc' },
        ]),
      ),
    );
    await expect(service.resolveNumber('HRSA-27-005', ctxFor())).resolves.toEqual({
      kind: 'not_found',
    });
  });
});

describe('scanClosingWindow', () => {
  const today = todayET();
  const cutoff = addDays(today, 7);

  /** Serves 500-row pages from `rows`, keyed by the request's startRecordNum. */
  const pagedRoute = (rows: ReturnType<typeof postedHit>[], hitCount = rows.length) =>
    route(SEARCH2_URL, async (request) => {
      const { startRecordNum = 0, rows: size = 0 } = await bodyOf(request);
      return ok(
        searchData(rows.slice(startRecordNum, startRecordNum + size), hitCount, FACETS_OPEN),
      );
    });

  it('pages posted records by close date with the caller’s other filters', async () => {
    pagedRoute([postedHit(1, 0)]);
    await service.scanClosingWindow(
      {
        agencies: 'HHS|HHS-*',
        keyword: 'rural',
        oppStatuses: 'forecasted',
        sortBy: 'openDate|desc',
      },
      cutoff,
      ctxFor(),
    );
    expect(await bodyOf(http.calls[0]?.request as Request)).toEqual({
      agencies: 'HHS|HHS-*',
      keyword: 'rural',
      oppStatuses: 'posted',
      sortBy: 'closeDate|asc',
      rows: 500,
      startRecordNum: 0,
    });
  });

  it('stops at the first row past the cutoff and keeps it as nextCloseAfterWindow', async () => {
    const rows = [
      postedHit(1, 0),
      postedHit(2, 3),
      postedHit(3, 7),
      postedHit(4, 10),
      postedHit(5, 12),
    ];
    pagedRoute(rows, 940);
    const scan = await service.scanClosingWindow({}, cutoff, ctxFor());

    expect(scan.windowHits.map((hit) => hit.id)).toEqual(['1', '2', '3']);
    expect(scan.nextCloseAfterWindow?.id).toBe('4');
    expect(scan.postedTotal).toBe(940);
    expect(scan.ceilingHit).toBe(false);
    expect(scan.facets.agencies).toEqual(FACETS_OPEN.agencies);
    expect(http.calls).toHaveLength(1);
  });

  it('stops at the first blank close date (blanks sort last)', async () => {
    pagedRoute([postedHit(1, 1), postedHit(2, 'blank'), postedHit(3, 2)]);
    const scan = await service.scanClosingWindow({}, cutoff, ctxFor());
    expect(scan.windowHits.map((hit) => hit.id)).toEqual(['1']);
    expect(scan.nextCloseAfterWindow?.id).toBe('2');
  });

  it('skips a posted row dated before today (status flip not yet run)', async () => {
    pagedRoute([postedHit(1, -1), postedHit(2, 0), postedHit(3, 2)]);
    const scan = await service.scanClosingWindow({}, cutoff, ctxFor());
    expect(scan.windowHits.map((hit) => hit.id)).toEqual(['2', '3']);
  });

  it('returns no nextCloseAfterWindow when a short page ends inside the window', async () => {
    pagedRoute([postedHit(1, 0), postedHit(2, 5)]);
    const scan = await service.scanClosingWindow({}, cutoff, ctxFor());
    expect(scan.windowHits).toHaveLength(2);
    expect(scan.nextCloseAfterWindow).toBeUndefined();
    expect(scan.ceilingHit).toBe(false);
    expect(http.calls).toHaveLength(1);
  });

  it('handles an empty posted set', async () => {
    pagedRoute([], 0);
    const scan = await service.scanClosingWindow({}, cutoff, ctxFor());
    expect(scan).toMatchObject({ windowHits: [], postedTotal: 0, ceilingHit: false });
    expect(scan.nextCloseAfterWindow).toBeUndefined();
  });

  it('reads further pages while every row stays inside the window, keeping first-page totals', async () => {
    const rows = Array.from({ length: 503 }, (_, i) => postedHit(i + 1, i < 502 ? 3 : 30));
    let page = 0;
    route(SEARCH2_URL, async (request) => {
      const { startRecordNum = 0 } = await bodyOf(request);
      page++;
      return ok(
        searchData(
          rows.slice(startRecordNum, startRecordNum + 500),
          page === 1 ? 940 : 1,
          page === 1 ? FACETS_OPEN : {},
        ),
      );
    });
    const scan = await service.scanClosingWindow({}, cutoff, ctxFor());

    expect(http.calls).toHaveLength(2);
    expect((await bodyOf(http.calls[1]?.request as Request)).startRecordNum).toBe(500);
    expect(scan.windowHits).toHaveLength(502);
    expect(scan.nextCloseAfterWindow?.id).toBe('503');
    expect(scan.postedTotal).toBe(940);
    expect(scan.facets.agencies).toEqual(FACETS_OPEN.agencies);
  });

  it('includes a row closing exactly on the cutoff date', async () => {
    pagedRoute([postedHit(1, 7), postedHit(2, 8)]);
    const scan = await service.scanClosingWindow({}, cutoff, ctxFor());
    expect(scan.windowHits.map((hit) => hit.id)).toEqual(['1']);
    expect(scan.nextCloseAfterWindow?.id).toBe('2');
  });

  it('stops at the 2,000-row ceiling and flags it', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => postedHit(i + 1, 2));
    pagedRoute(rows);
    const scan = await service.scanClosingWindow({}, cutoff, ctxFor());

    expect(http.calls).toHaveLength(4);
    expect(scan.windowHits).toHaveLength(2000);
    expect(scan.ceilingHit).toBe(true);
    expect(scan.nextCloseAfterWindow).toBeUndefined();
  });

  it('checks cancellation before paging', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller went away'));
    pagedRoute([postedHit(1, 0)]);
    await expect(
      service.scanClosingWindow({}, cutoff, ctxFor({ signal: controller.signal })),
    ).rejects.toThrow('caller went away');
    expect(http.calls).toHaveLength(0);
  });
});

describe('getReference', () => {
  it('builds the snapshot from two facets-only calls', async () => {
    http.route(referenceRoute());
    const snapshot = await service.getReference(ctxFor());

    expect(http.calls).toHaveLength(2);
    const bodies = await Promise.all(http.calls.map((call) => bodyOf(call.request)));
    expect(bodies).toEqual(
      expect.arrayContaining([{ rows: 0, oppStatuses: ALL_STATUSES }, { rows: 0 }]),
    );
    expect(snapshot.topLevelAgencies).toEqual(['DOC', 'DOT', 'HHS', 'NSF', 'USDA']);
    expect(snapshot.agencies.get('HHS')).toMatchObject({ openCount: 940, totalCount: 23899 });
    expect(snapshot.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('serves the cached snapshot within 24 h', async () => {
    http.route(referenceRoute());
    const first = await service.getReference(ctxFor());
    const second = await service.getReference(ctxFor());
    expect(second).toBe(first);
    expect(http.calls).toHaveLength(2);
  });

  it('shares one in-flight build between concurrent callers', async () => {
    http.route(referenceRoute());
    const [a, b] = await Promise.all([
      service.getReference(ctxFor()),
      service.getReference(ctxFor()),
    ]);
    expect(a).toBe(b);
    expect(http.calls).toHaveLength(2);
  });

  it('rebuilds once the snapshot is older than 24 h', async () => {
    http.route(referenceRoute());
    const first = await service.getReference(ctxFor());
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 25 * 60 * 60 * 1000);

    const second = await service.getReference(ctxFor());
    expect(second).not.toBe(first);
    expect(http.calls).toHaveLength(4);
  });

  it('serves the stale snapshot when a refresh fails', async () => {
    http.route(referenceRoute());
    const first = await service.getReference(ctxFor());
    http.reset();
    route(SEARCH2_URL, json({ message: 'Missing Authentication Token' }, 403));
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 25 * 60 * 60 * 1000);

    const second = await service.getReference(ctxFor());
    expect(second).toBe(first);
    expect(http.calls.length).toBeGreaterThan(0);
  });

  it('throws when the first build fails, then builds on the next call', async () => {
    route(SEARCH2_URL, json({ message: 'Missing Authentication Token' }, 403));
    const error = await rejection(() => service.getReference(ctxFor()));
    expect(error.data).toMatchObject({ reason: 'upstream_route_unavailable' });

    http.reset();
    http.route(referenceRoute());
    const snapshot = await service.getReference(ctxFor());
    expect(snapshot.agencies.size).toBeGreaterThan(0);
  });

  it('is not bound to the first caller’s cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller went away'));
    http.route(referenceRoute());
    const snapshot = await service.getReference(ctxFor({ signal: controller.signal }));
    expect(snapshot.topLevelAgencies).toHaveLength(5);
  });

  it('uses the all-status facets for vocabulary and totals', async () => {
    http.route(referenceRoute());
    const snapshot = await service.getReference(ctxFor());
    expect(snapshot.eligibilities).toHaveLength(FACETS_ALL.eligibilities?.length ?? -1);
    expect(snapshot.statusCounts).toMatchObject({ archived: 73220 });
  });
});

describe('service accessor', () => {
  it('throws before initGrantsGovService() runs', async () => {
    vi.resetModules();
    const fresh = await import('@/services/grants-gov/grants-gov-service.js');
    expect(() => fresh.getGrantsGovService()).toThrow(/not initialized/);
    fresh.initGrantsGovService();
    const instance = fresh.getGrantsGovService();
    expect(instance).toBeInstanceOf(fresh.GrantsGovService);
    instance.dispose();
  });
});
