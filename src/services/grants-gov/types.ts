/**
 * @fileoverview Raw Grants.gov API shapes (every field optional or nullable, as
 * the upstream sparsely populates them) and the service's return types.
 * @module services/grants-gov/types
 */

/**
 * The `search2` request body. Closed on purpose: an unknown key is ignored
 * upstream and silently widens the search to the default scope, so nothing
 * passes through by name. Multi-values are pre-joined with `|`; `oppNum` is
 * already double-quoted and `agencies` already encoded by their builders.
 */
export interface Search2Body {
  agencies?: string;
  cfda?: string;
  dateRange?: string;
  eligibilities?: string;
  fundingCategories?: string;
  fundingInstruments?: string;
  keyword?: string;
  oppNum?: string;
  oppStatuses?: string;
  rows?: number;
  sortBy?: string;
  startRecordNum?: number;
}

/** One `search2` result row. Dates are `MM/DD/YYYY` or `""`. */
export interface RawHit {
  agency?: string | null;
  agencyCode?: string | null;
  cfdaList?: string[] | null;
  closeDate?: string | null;
  docType?: string | null;
  id?: string | null;
  number?: string | null;
  openDate?: string | null;
  oppStatus?: string | null;
  title?: string | null;
}

/** One facet option: a filter code, its label, and a match count. */
export interface RawFacetOption {
  count?: number | null;
  label?: string | null;
  value?: string | null;
}

/** A top-level agency facet option. `subAgencyOptions` lists every descendant, flat. */
export interface RawAgencyOption extends RawFacetOption {
  subAgencyOptions?: RawFacetOption[] | null;
}

/** The facet block every `search2` response carries. */
export interface RawFacets {
  agencies?: RawAgencyOption[] | null | undefined;
  eligibilities?: RawFacetOption[] | null | undefined;
  fundingCategories?: RawFacetOption[] | null | undefined;
  fundingInstruments?: RawFacetOption[] | null | undefined;
  oppStatusOptions?: RawFacetOption[] | null | undefined;
}

/** `search2` `data`. `searchParams` is absent on a parameter-rejection skeleton, so it is never read. */
export interface RawSearchData extends RawFacets {
  hitCount?: number | null;
  oppHits?: RawHit[] | null;
}

/** A `{ id, description }` code pair on a detail record. */
export interface RawCodeDescription {
  description?: string | null;
  id?: string | null;
}

/** The `synopsis` or `forecast` block of a detail record. */
export interface RawDetailBlock {
  agencyContactDesc?: string | null;
  agencyContactEmail?: string | null;
  agencyContactEmailDesc?: string | null;
  agencyContactName?: string | null;
  agencyContactPhone?: string | null;
  applicantEligibilityDesc?: string | null;
  applicantTypes?: RawCodeDescription[] | null;
  archiveDateStr?: string | null;
  awardCeiling?: string | number | null;
  awardFloor?: string | number | null;
  costSharing?: boolean | null;
  estApplicationResponseDateDesc?: string | null;
  estApplicationResponseDateStr?: string | null;
  estAwardDateStr?: string | null;
  estimatedFunding?: string | number | null;
  estProjectStartDateStr?: string | null;
  estSynopsisPostingDateStr?: string | null;
  fiscalYear?: number | null;
  forecastDesc?: string | null;
  fundingActivityCategories?: RawCodeDescription[] | null;
  fundingActivityCategoryDesc?: string | null;
  fundingDescLinkDesc?: string | null;
  fundingDescLinkUrl?: string | null;
  fundingInstruments?: RawCodeDescription[] | null;
  lastUpdatedDate?: string | null;
  numberOfAwards?: string | number | null;
  postingDateStr?: string | null;
  responseDateDesc?: string | null;
  responseDateStr?: string | null;
  synopsisDesc?: string | null;
}

/** A NOFO attachment inside a `synopsisAttachmentFolders[]` entry. */
export interface RawAttachment {
  fileDescription?: string | null;
  fileLobSize?: number | null;
  fileName?: string | null;
  id?: number | null;
  mimeType?: string | null;
}

/** An application package (`opportunityPkgs[]`). Dates are already `YYYY-MM-DD`. */
export interface RawPackage {
  closingDate?: string | null;
  competitionId?: string | null;
  competitionTitle?: string | null;
  electronicRequired?: string | null;
  openingDate?: string | null;
  packageId?: string | null;
}

/** A related opportunity (`relatedOpps[]`). Dates arrive as `Mar 20, 2015`. */
export interface RawRelatedOpportunity {
  agencyCode?: string | null;
  closeDate?: string | null;
  comments?: string | null;
  opportunityId?: number | null;
  opportunityNum?: string | null;
  opportunityTitle?: string | null;
  postedDate?: string | null;
}

/**
 * A `fetchOpportunity` record with its revision history removed. Money,
 * eligibility, codes, contact, description, and links live only inside the block
 * named by `docType`; a posted record also carries a stale `forecast` block.
 */
export interface RawDetail {
  agencyDetails?: { agencyCode?: string | null; agencyName?: string | null } | null;
  cfdas?: { cfdaNumber?: string | null; programTitle?: string | null }[] | null;
  closedOpportunityPkgs?: unknown[] | null;
  docType?: string | null;
  forecast?: RawDetailBlock | null;
  forecastHistCount?: number | null;
  id?: number | null;
  opportunityCategory?: { category?: string | null; description?: string | null } | null;
  opportunityNumber?: string | null;
  opportunityPkgs?: RawPackage[] | null;
  opportunityTitle?: string | null;
  originalDueDate?: string | null;
  ost?: string | null;
  owningAgencyCode?: string | null;
  relatedOpps?: RawRelatedOpportunity[] | null;
  synopsis?: RawDetailBlock | null;
  synopsisAttachmentFolders?:
    | { folderType?: string | null; synopsisAttachments?: RawAttachment[] | null }[]
    | null;
  synopsisHistCount?: number | null;
  topAgencyDetails?: { agencyCode?: string | null; agencyName?: string | null } | null;
}

/** `search()` result. */
export interface SearchResult {
  facets: RawFacets;
  hitCount: number;
  hits: RawHit[];
}

/** `scanClosingWindow()` result. */
export interface ClosingWindowScan {
  /** True when the 2,000-row ceiling was reached while still inside the window. */
  ceilingHit: boolean;
  /** Facets from the first page: the whole posted set matching the other filters, not the window. */
  facets: RawFacets;
  /** The first row past the window (blank or later close date), when one was reached. */
  nextCloseAfterWindow?: RawHit;
  /** Upstream `hitCount` for posted records matching the other filters. */
  postedTotal: number;
  /** Rows closing between today (ET) and the cutoff, inclusive, in close-date order. */
  windowHits: RawHit[];
}

/** `resolveNumber()` result. */
export type NumberResolution =
  | { kind: 'unique'; id: number }
  | { kind: 'ambiguous'; candidates: RawHit[] }
  | { kind: 'not_found' };

/** `fetchOpportunity()` result. A miss is a result, never thrown; a found record always has its numeric id. */
export type FetchResult =
  | { kind: 'found'; record: RawDetail & { id: number } }
  | { kind: 'not_found' };

/** A reference vocabulary entry with its opportunity counts. */
export interface ReferenceCode {
  code: string;
  label: string;
  /** Forecasted + posted opportunities carrying this code (0 when absent from the open-scope facets). */
  openCount: number;
  /** Opportunities carrying this code across all statuses. */
  totalCount: number;
}

/**
 * An agency code in the snapshot's tree. `openCount` and `totalCount` cover the
 * code and every descendant: the set an agencies filter on the code matches.
 */
export interface AgencyNode extends ReferenceCode {
  /** Direct children. */
  children: string[];
  /** Every code below this one, at any depth. */
  descendants: string[];
  /** Parent code; absent for top-level agencies. */
  parentCode?: string;
}

/** The live filter vocabulary, built from two facets-only `search2` calls. */
export interface ReferenceSnapshot {
  /** Every agency code (top-level and sub-agency), keyed by code. */
  agencies: ReadonlyMap<string, AgencyNode>;
  eligibilities: ReferenceCode[];
  /** ISO timestamp of the fetch. */
  fetchedAt: string;
  fundingCategories: ReferenceCode[];
  fundingInstruments: ReferenceCode[];
  /** Count per status (`forecasted`, `posted`, `closed`, `archived`) across all filters. */
  statusCounts: Readonly<Record<string, number>>;
  /** Top-level agency codes. */
  topLevelAgencies: string[];
}
