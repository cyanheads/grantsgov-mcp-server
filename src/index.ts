#!/usr/bin/env node
/**
 * @fileoverview grantsgov-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import {
  getGrantsGovService,
  initGrantsGovService,
} from './services/grants-gov/grants-gov-service.js';

await createApp({
  name: 'grantsgov-mcp-server',
  title: 'grantsgov-mcp-server',
  tools: allToolDefinitions,
  instructions:
    'Find federal funding with grantsgov_search_opportunities, then read full records (award range, eligibility narrative, attachments) with grantsgov_get_opportunity using the opportunity_id from each row. Search returns forecasted and posted opportunities unless statuses says otherwise; filter codes for agencies, applicant eligibility, and funding categories come from grantsgov_list_reference. Each record carries its assistance listing number (ALN) and opportunity number, the keys other federal spending and research-funding sources use.',
  setup() {
    initGrantsGovService();
  },
  teardown() {
    getGrantsGovService().dispose();
  },
});
