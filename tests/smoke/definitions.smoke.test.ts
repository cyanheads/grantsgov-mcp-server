/**
 * @fileoverview Smoke coverage for every registered definition, on the paths
 * that need no upstream call.
 * @module tests/smoke/definitions.smoke.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { grantsgovGetOpportunity } from '@/mcp-server/tools/definitions/grantsgov-get-opportunity.tool.js';
import { grantsgovListReference } from '@/mcp-server/tools/definitions/grantsgov-list-reference.tool.js';
import { grantsgovSearchOpportunities } from '@/mcp-server/tools/definitions/grantsgov-search-opportunities.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

describe('definition smoke test', () => {
  it('registers every tool through the barrel', () => {
    expect(allToolDefinitions.map((definition) => definition.name)).toEqual([
      'grantsgov_search_opportunities',
      'grantsgov_get_opportunity',
      'grantsgov_list_reference',
    ]);
  });

  it('rejects a conflicting search before any upstream call', async () => {
    const ctx = createMockContext({ errors: grantsgovSearchOpportunities.errors });
    const input = grantsgovSearchOpportunities.input.parse({
      keyword: '',
      statuses: ['Closed'],
      closing_within_days: '7',
    });

    await expect(grantsgovSearchOpportunities.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'filter_conflict' },
    });
  });

  it('rejects a get with no identifiers before any upstream call', async () => {
    const ctx = createMockContext({ errors: grantsgovGetOpportunity.errors });
    const input = grantsgovGetOpportunity.input.parse({
      opportunity_ids: [],
      opportunity_numbers: [' '],
    });

    await expect(grantsgovGetOpportunity.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_identifiers' },
    });
  });

  it('lists a static reference topic and renders it', async () => {
    const ctx = createMockContext({ errors: grantsgovListReference.errors });
    const result = await grantsgovListReference.handler(
      grantsgovListReference.input.parse({
        topic: 'keyword_syntax',
        name_contains: '',
        parent_code: '',
      }),
      ctx,
    );
    const [block] = grantsgovListReference.format?.(result) ?? [];

    expect(result).toEqual(expect.schemaMatching(grantsgovListReference.output));
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.snapshot_date).toBeUndefined();
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: result.entries.length });
    expect(block).toMatchObject({
      type: 'text',
      text: expect.stringContaining('| Code | Label | Notes |'),
    });
  });
});
