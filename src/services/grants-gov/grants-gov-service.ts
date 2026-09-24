/**
 * @fileoverview Grants.gov legacy REST API client (`POST search2`,
 * `POST fetchOpportunity`). One plain-fetch boundary with a per-endpoint status
 * accept-list and body classification, `withRetry` around fetch + parse +
 * classify, and a process-wide pacer in front of every upstream call.
 * @module services/grants-gov/grants-gov-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  httpErrorFromResponse,
  type Pacer,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { parseSlashDate, todayET } from './normalize.js';
import { buildReferenceSnapshot } from './reference.js';
import type {
  ClosingWindowScan,
  FetchResult,
  NumberResolution,
  RawDetail,
  RawFacets,
  RawHit,
  RawSearchData,
  ReferenceSnapshot,
  Search2Body,
  SearchResult,
} from './types.js';

const BASE_URL = 'https://api.grants.gov/v1/api';

/** Every lifecycle status, pipe-joined as `search2` requires. */
export const ALL_STATUSES = 'forecasted|posted|closed|archived';

type Endpoint = 'search2' | 'fetchOpportunity';

/** Statuses parsed as data. Anything else is classified from the status alone. */
const ACCEPTED_STATUSES: Readonly<Record<Endpoint, ReadonlySet<number>>> = {
  search2: new Set([200]),
  fetchOpportunity: new Set([200, 404]),
};

const PER_ATTEMPT_TIMEOUT_MS = 15_000;
const REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_FAILURE_BACKOFF_MS = 60_000;
const SCAN_PAGE_SIZE = 500;
/** Rows the closing-window scan reads before it stops (the whole posted universe is under 1,000). */
export const SCAN_CEILING = 2_000;
const RESOLVE_ROWS = 10;

/**
 * Wraps an opportunity number in double quotes. `search2` parses `oppNum` as a
 * query, so an unquoted `*` is a wildcard and an unquoted space splits the
 * number into terms; quoting makes it literal.
 */
export function quoteOppNum(opportunityNumber: string): string {
  return `"${opportunityNumber.trim()}"`;
}

/**
 * Exact opportunity-number equality (trimmed, case-insensitive). `search2`
 * returns non-equal hits even for a quoted `oppNum` (`"1"` also matches
 * `21561-9-F017A`), so every number lookup post-filters with this.
 */
export function isSameOpportunityNumber(
  hitNumber: string | null | undefined,
  wanted: string,
): boolean {
  return hitNumber?.trim().toLowerCase() === wanted.trim().toLowerCase();
}

/**
 * Cuts posted rows in close-date order at the window `today ≤ close ≤ cutoffDate`.
 * Stops at the first row with a blank or later close date and returns it as
 * `nextCloseAfterWindow`. A row dated before today (a status flip the upstream
 * has not run yet) is skipped.
 */
export function cutClosingWindow(
  hits: readonly RawHit[],
  today: string,
  cutoffDate: string,
): Pick<ClosingWindowScan, 'windowHits' | 'nextCloseAfterWindow'> {
  const windowHits: RawHit[] = [];
  for (const hit of hits) {
    const closeDate = parseSlashDate(hit.closeDate);
    if (!closeDate || closeDate > cutoffDate) return { windowHits, nextCloseAfterWindow: hit };
    if (closeDate >= today) windowHits.push(hit);
  }
  return { windowHits };
}

/** A service-layer `upstream_unavailable` error carrying the calling tool's recovery hint. */
function upstreamUnavailable(message: string, ctx: Context, cause?: unknown): McpError {
  return serviceUnavailable(
    message,
    { reason: 'upstream_unavailable', ...ctx.recoveryFor('upstream_unavailable') },
    cause === undefined ? undefined : { cause },
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Upstream text quoted into an error message: one line, bounded. */
const excerpt = (value: unknown) => String(value).replace(/\s+/g, ' ').trim().slice(0, 200);

/** Maps a status outside the accept-list to its error without ever parsing the body as data. */
async function statusError(
  response: Response,
  endpoint: Endpoint,
  ctx: Context,
): Promise<McpError> {
  if (response.status === 403) {
    return serviceUnavailable(
      `Grants.gov ${endpoint} answered HTTP 403 (Missing Authentication Token), which means the route no longer exists at the gateway.`,
      {
        reason: 'upstream_route_unavailable',
        retryable: false,
        status: 403,
        ...ctx.recoveryFor('upstream_route_unavailable'),
      },
    );
  }
  const reason =
    response.status >= 500
      ? 'upstream_unavailable'
      : response.status === 429
        ? 'rate_limited'
        : undefined;
  return await httpErrorFromResponse(response, {
    service: 'Grants.gov',
    // Every 5xx, 504 included, is the contract's ServiceUnavailable (the helper's default maps 504 to Timeout).
    codeOverride: (status) => (status >= 500 ? JsonRpcErrorCode.ServiceUnavailable : undefined),
    ...(reason && { data: { reason, ...ctx.recoveryFor(reason) } }),
  });
}

/**
 * Re-issues a shared-build failure with this caller's recovery hint. The
 * reference build runs once for every concurrent caller, so the error it raised
 * carries the hint of whichever tool started it.
 */
function withCallerRecovery(err: unknown, ctx: Context): unknown {
  const reason = err instanceof McpError ? err.data?.reason : undefined;
  if (!(err instanceof McpError) || typeof reason !== 'string') return err;
  const { recovery: _startersRecovery, ...data } = err.data ?? {};
  return new McpError(
    err.code,
    err.message,
    { ...data, ...ctx.recoveryFor(reason) },
    { cause: err.cause },
  );
}

/**
 * Parses the `{ errorcode, msg, data }` envelope every 200 carries. A non-JSON or
 * HTML body, a non-zero `errorcode`, or a missing `data` object is a transient
 * upstream failure.
 */
function parseEnvelope(text: string, endpoint: Endpoint, ctx: Context): Record<string, unknown> {
  if (/^\s*</.test(text))
    throw upstreamUnavailable(`Grants.gov ${endpoint} returned HTML instead of JSON.`, ctx);
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch (err) {
    throw upstreamUnavailable(
      `Grants.gov ${endpoint} returned a body that is not valid JSON.`,
      ctx,
      err,
    );
  }
  if (!isRecord(envelope))
    throw upstreamUnavailable(`Grants.gov ${endpoint} returned an unexpected body.`, ctx);
  if (envelope.errorcode !== 0) {
    throw upstreamUnavailable(
      `Grants.gov ${endpoint} reported error code ${excerpt(envelope.errorcode)}: ${excerpt(envelope.msg ?? 'no message')}.`,
      ctx,
    );
  }
  if (!isRecord(envelope.data))
    throw upstreamUnavailable(`Grants.gov ${endpoint} returned no data object.`, ctx);
  return envelope.data;
}

function toSearchResult(data: Record<string, unknown>, ctx: Context): SearchResult {
  const {
    hitCount,
    oppHits,
    oppStatusOptions,
    eligibilities,
    fundingCategories,
    fundingInstruments,
    agencies,
  } = data as RawSearchData;
  if (typeof hitCount !== 'number')
    throw upstreamUnavailable('Grants.gov search2 returned no hit count.', ctx);
  const facets: RawFacets = {
    oppStatusOptions,
    eligibilities,
    fundingCategories,
    fundingInstruments,
    agencies,
  };
  return { hitCount, hits: oppHits ?? [], facets };
}

function toFetchResult(status: number, text: string, ctx: Context): FetchResult {
  if (status === 404) return { kind: 'not_found' };
  const data = parseEnvelope(text, 'fetchOpportunity', ctx);
  if (typeof data.message === 'string' && /not available/i.test(data.message)) {
    throw upstreamUnavailable(
      `Grants.gov fetchOpportunity backend is unavailable: ${excerpt(data.message)}`,
      ctx,
    );
  }
  if (typeof data.id === 'number') {
    const { opportunityHistoryDetails: _history, ...record } = data;
    return { kind: 'found', record: record as RawDetail };
  }
  const messages = Array.isArray(data.errorMessages) ? data.errorMessages : [];
  if (messages.some((m) => typeof m === 'string' && /no record found/i.test(m)))
    return { kind: 'not_found' };
  throw upstreamUnavailable(
    'Grants.gov fetchOpportunity returned neither a record nor a not-found message.',
    ctx,
  );
}

/** Client for the keyless Grants.gov legacy API. One instance per process. */
export class GrantsGovService {
  private readonly pacer: Pacer = createPacer({ name: 'grants-gov', maxConcurrent: 4 });
  private reference: { snapshot: ReferenceSnapshot; fetchedAtMs: number } | undefined;
  private referenceInflight: Promise<ReferenceSnapshot> | undefined;
  /** After a failed refresh, the stale snapshot is served without an upstream call until this time. */
  private refreshBlockedUntilMs = 0;

  /** One `search2` call. */
  search(body: Search2Body, ctx: Context): Promise<SearchResult> {
    return this.post(
      'search2',
      body,
      (_status, text) => toSearchResult(parseEnvelope(text, 'search2', ctx), ctx),
      ctx,
    );
  }

  /** One `fetchOpportunity` call, revision history stripped. A miss is `not_found`, never thrown. */
  fetchOpportunity(opportunityId: number, ctx: Context): Promise<FetchResult> {
    return this.post(
      'fetchOpportunity',
      { opportunityId },
      (status, text) => toFetchResult(status, text, ctx),
      ctx,
    );
  }

  /**
   * Resolves an opportunity number across all four statuses. Sent quoted, as
   * given; on no exact match with lowercase letters present, retried once
   * uppercased (the upstream match is case-sensitive). Hits are post-filtered to
   * exact equality.
   */
  async resolveNumber(opportunityNumber: string, ctx: Context): Promise<NumberResolution> {
    const exactMatches = async (sent: string) => {
      const { hits } = await this.search(
        { oppNum: quoteOppNum(sent), oppStatuses: ALL_STATUSES, rows: RESOLVE_ROWS },
        ctx,
      );
      return hits.filter(
        (hit) =>
          isSameOpportunityNumber(hit.number, opportunityNumber) && /^\d+$/.test(hit.id ?? ''),
      );
    };
    let matches = await exactMatches(opportunityNumber);
    if (matches.length === 0 && /[a-z]/.test(opportunityNumber)) {
      matches = await exactMatches(opportunityNumber.toUpperCase());
    }
    const [only] = matches;
    if (!only) return { kind: 'not_found' };
    if (matches.length === 1) return { kind: 'unique', id: Number(only.id) };
    return { kind: 'ambiguous', candidates: matches };
  }

  /**
   * Scans posted opportunities in close-date order for those closing between
   * today (ET) and `cutoffDate` inclusive. Pages of 500, each cut by
   * {@link cutClosingWindow}; stops at the first row with a blank or later close
   * date, on a short page, or at 2,000 rows.
   */
  async scanClosingWindow(
    body: Search2Body,
    cutoffDate: string,
    ctx: Context,
  ): Promise<ClosingWindowScan> {
    const today = todayET();
    const windowHits: RawHit[] = [];
    let facets: RawFacets = {};
    let postedTotal = 0;

    for (let start = 0; start < SCAN_CEILING; start += SCAN_PAGE_SIZE) {
      ctx.signal.throwIfAborted();
      const page = await this.search(
        {
          ...body,
          oppStatuses: 'posted',
          sortBy: 'closeDate|asc',
          rows: SCAN_PAGE_SIZE,
          startRecordNum: start,
        },
        ctx,
      );
      if (start === 0) {
        facets = page.facets;
        postedTotal = page.hitCount;
      }
      const cut = cutClosingWindow(page.hits, today, cutoffDate);
      windowHits.push(...cut.windowHits);
      if (cut.nextCloseAfterWindow) {
        return {
          windowHits,
          postedTotal,
          facets,
          nextCloseAfterWindow: cut.nextCloseAfterWindow,
          ceilingHit: false,
        };
      }
      if (page.hits.length < SCAN_PAGE_SIZE)
        return { windowHits, postedTotal, facets, ceilingHit: false };
    }
    ctx.log.info('Closing-window scan reached its row ceiling', {
      ceiling: SCAN_CEILING,
      cutoffDate,
    });
    return { windowHits, postedTotal, facets, ceilingHit: true };
  }

  /**
   * The reference snapshot, cached in-process for 24 h behind one in-flight
   * build. A failed refresh serves the previous snapshot when one exists, and
   * keeps serving it without re-contacting Grants.gov for a minute after the
   * failure. A failure with no snapshot to fall back on throws, carrying this
   * caller's recovery hint.
   */
  async getReference(ctx: Context): Promise<ReferenceSnapshot> {
    const cached = this.reference;
    const now = Date.now();
    if (cached && (now - cached.fetchedAtMs < REFERENCE_TTL_MS || now < this.refreshBlockedUntilMs))
      return cached.snapshot;

    this.referenceInflight ??= this.buildReference(ctx).finally(() => {
      this.referenceInflight = undefined;
    });
    try {
      return await this.referenceInflight;
    } catch (err) {
      if (!cached) throw withCallerRecovery(err, ctx);
      this.refreshBlockedUntilMs = Date.now() + REFRESH_FAILURE_BACKOFF_MS;
      ctx.log.warning('Grants.gov reference refresh failed; serving the previous snapshot', {
        snapshotDate: cached.snapshot.fetchedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      return cached.snapshot;
    }
  }

  /** Clears the pacer's timer and rejects queued requests. Call from `createApp({ teardown })`. */
  dispose(): void {
    this.pacer.dispose();
  }

  /**
   * Two facets-only calls in parallel: all statuses (full vocabulary, total
   * counts) and the default scope (open counts). Not bound to the first caller's
   * cancellation, since other requests may be awaiting the same build.
   */
  private async buildReference(ctx: Context): Promise<ReferenceSnapshot> {
    const facetsOnly = (body: Search2Body) =>
      this.post(
        'search2',
        body,
        (_status, text) => toSearchResult(parseEnvelope(text, 'search2', ctx), ctx),
        ctx,
        {
          detached: true,
        },
      );
    const [all, open] = await Promise.all([
      facetsOnly({ rows: 0, oppStatuses: ALL_STATUSES }),
      facetsOnly({ rows: 0 }),
    ]);
    const fetchedAt = new Date();
    const snapshot = buildReferenceSnapshot(all.facets, open.facets, fetchedAt.toISOString());
    this.reference = { snapshot, fetchedAtMs: fetchedAt.getTime() };
    ctx.log.debug('Grants.gov reference snapshot built', {
      agencies: snapshot.agencies.size,
      eligibilities: snapshot.eligibilities.length,
      fundingCategories: snapshot.fundingCategories.length,
    });
    return snapshot;
  }

  /**
   * One upstream call: retry outside, pacer inside, so each attempt re-queues.
   * `detached` drops the caller's cancellation signal (the retry deadline still bounds it).
   */
  private post<T>(
    endpoint: Endpoint,
    body: Search2Body | { opportunityId: number },
    classify: (status: number, text: string) => T,
    ctx: Context,
    { detached = false }: { detached?: boolean } = {},
  ): Promise<T> {
    return withRetry(
      (attempt) =>
        this.pacer.run(
          (signal) => this.attempt(endpoint, body, classify, ctx, signal, attempt.remainingMs),
          {
            signal: attempt.signal,
          },
        ),
      {
        operation: `GrantsGov.${endpoint}`,
        context: ctx,
        maxRetries: 2,
        baseDelayMs: 500,
        deadlineMs: 25_000,
        ...(!detached && { signal: ctx.signal }),
      },
    );
  }

  /** A single fetch + status check + parse + classify, bounded by its own timeout. */
  private async attempt<T>(
    endpoint: Endpoint,
    body: Search2Body | { opportunityId: number },
    classify: (status: number, text: string) => T,
    ctx: Context,
    signal: AbortSignal,
    remainingMs: number,
  ): Promise<T> {
    const timeoutMs = Math.min(PER_ATTEMPT_TIMEOUT_MS, remainingMs);
    const perAttempt = new AbortController();
    const timer = setTimeout(
      () =>
        perAttempt.abort(
          upstreamUnavailable(
            `Grants.gov ${endpoint} did not respond within ${timeoutMs} ms.`,
            ctx,
          ),
        ),
      timeoutMs,
    );
    const combined = AbortSignal.any([signal, perAttempt.signal]);
    const network = <R>(pending: Promise<R>): Promise<R> =>
      pending.catch((err: unknown) => {
        throw combined.aborted
          ? (combined.reason ?? err)
          : upstreamUnavailable(
              `Could not reach Grants.gov ${endpoint}: ${excerpt(err instanceof Error ? err.message : err)}`,
              ctx,
              err,
            );
      });

    try {
      const response = await network(
        fetch(`${BASE_URL}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
          signal: combined,
        }),
      );
      if (!ACCEPTED_STATUSES[endpoint].has(response.status))
        throw await statusError(response, endpoint, ctx);
      const text = await network(response.text());
      return classify(response.status, text);
    } finally {
      clearTimeout(timer);
    }
  }
}

let service: GrantsGovService | undefined;

/** Creates the process-wide service. Call from `createApp({ setup })`. */
export function initGrantsGovService(): void {
  service = new GrantsGovService();
}

/** The process-wide service. */
export function getGrantsGovService(): GrantsGovService {
  if (!service)
    throw new Error('GrantsGovService not initialized — call initGrantsGovService() in setup()');
  return service;
}
