/**
 * @fileoverview Barrel collecting every grantsgov tool definition for `createApp()`.
 * @module mcp-server/tools/definitions
 */

import { grantsgovGetOpportunity } from './grantsgov-get-opportunity.tool.js';
import { grantsgovListReference } from './grantsgov-list-reference.tool.js';
import { grantsgovSearchOpportunities } from './grantsgov-search-opportunities.tool.js';

export const allToolDefinitions = [
  grantsgovSearchOpportunities,
  grantsgovGetOpportunity,
  grantsgovListReference,
];
