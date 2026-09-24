/**
 * @fileoverview Fuzz tests for the three grantsgov tools: schema-generated valid
 * inputs and adversarial wrong-type inputs through each handler, over a fetch
 * mock serving the recorded fixtures. Asserts no crashes past the framework, no
 * stack or path leaks in error payloads, and no prototype pollution.
 * @module tests/fuzz/tools.fuzz.test
 */

import { createFetchMock, type FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import {
  getGrantsGovService,
  initGrantsGovService,
} from '@/services/grants-gov/grants-gov-service.js';
import {
  bodyOf,
  DETAIL_HRSA,
  FETCH_URL,
  HRSA_HIT,
  ok,
  POSTED_HITS,
  referenceResponse,
  SEARCH2_URL,
  searchData,
} from '../fixtures/grants-gov.js';

let http: FetchMockHarness;

beforeEach(() => {
  http = createFetchMock();
  http.install();
  http.route({
    method: 'POST',
    match: SEARCH2_URL,
    respond: async (request) => {
      const body = await bodyOf(request);
      if (body.rows === 0) return referenceResponse(body);
      return ok(searchData(body.oppNum ? [HRSA_HIT] : POSTED_HITS));
    },
  });
  http.route({ method: 'POST', match: FETCH_URL, respond: () => ok(DETAIL_HRSA) });
  initGrantsGovService();
});

afterEach(() => {
  getGrantsGovService().dispose();
  http.restore();
});

describe.each(allToolDefinitions.map((definition) => [definition.name, definition] as const))(
  '%s fuzz',
  (_name, definition) => {
    it('survives valid and adversarial inputs', async () => {
      const report = await fuzzTool(definition, {
        numRuns: 60,
        numAdversarial: 40,
        seed: 20260924,
        ctx: { errors: definition.errors },
      });
      expect(report.crashes).toEqual([]);
      expect(report.leaks).toEqual([]);
      expect(report.prototypePollution).toBe(false);
    });
  },
);
