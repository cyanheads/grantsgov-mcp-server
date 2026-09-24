/**
 * @fileoverview Trimmed Grants.gov fixtures recorded from the live legacy API
 * (`search2`, `fetchOpportunity`), plus builders for envelopes, responses, and
 * date-relative search rows. Agency contact fields are synthetic.
 * @module tests/fixtures/grants-gov
 */

import type { FetchMockRoute } from '@cyanheads/mcp-ts-core/testing';
import { addDays, todayET } from '@/services/grants-gov/normalize.js';
import type { RawFacets, RawHit, Search2Body } from '@/services/grants-gov/types.js';

export const SEARCH2_URL = 'https://api.grants.gov/v1/api/search2';
export const FETCH_URL = 'https://api.grants.gov/v1/api/fetchOpportunity';

/** The `{ errorcode, msg, token, data }` envelope every 200 carries. */
export const envelope = (data: unknown, errorcode = 0) => ({
  errorcode,
  msg: errorcode === 0 ? 'Webservice Succeeds' : 'Webservice Fails',
  token: 'fixture-token',
  data,
});

/** A 200 JSON response wrapping `data` in the success envelope. */
export const ok = (data: unknown): Response => Response.json(envelope(data));

/** A JSON response at an arbitrary status. */
export const json = (body: unknown, status: number, headers?: Record<string, string>): Response =>
  Response.json(body, { status, ...(headers && { headers }) });

/** An HTML response, as a gateway error page arrives. */
export const html = (status = 200): Response =>
  new Response('<!DOCTYPE html><html><body><h1>Service Unavailable</h1></body></html>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  });

/** `search2` `data` for the given rows and facets. */
export const searchData = (hits: RawHit[], hitCount = hits.length, facets: RawFacets = {}) => ({
  searchParams: { resultType: 'json', searchOnly: false, keyword: '' },
  hitCount,
  startRecord: 0,
  oppHits: hits,
  ...facets,
  errorMsgs: [],
});

/** Reads a captured request's JSON body. */
export const bodyOf = async (request: Request): Promise<Search2Body & { opportunityId?: number }> =>
  (await request.clone().json()) as Search2Body & { opportunityId?: number };

/** `YYYY-MM-DD` → the `MM/DD/YYYY` form search rows use. */
export const slashDate = (iso: string): string =>
  `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

/** Today (US Eastern) shifted by `days`, as a search-row `MM/DD/YYYY` date. */
export const closingIn = (days: number): string => slashDate(addDays(todayET(), days));

/** Posted search rows, recorded from `search2` `{ oppStatuses: 'posted', sortBy: 'closeDate|asc' }`. */
export const POSTED_HITS: RawHit[] = [
  {
    id: '362180',
    number: 'HT942526AZRPTRRA',
    title: 'DoW Alzheimer&rsquo;s Transforming Research Award',
    agencyCode: 'DOD-AMRAA',
    agency: 'Defense Health Agency Contracting Activity - DHACA',
    openDate: '05/01/2026',
    closeDate: '09/24/2026',
    oppStatus: 'posted',
    docType: 'synopsis',
    cfdaList: ['12.420'],
  },
  {
    id: '360874',
    number: 'RFA-AI-27-004',
    title: 'Atopic Dermatitis Research Network (ADRN) (U19 Clinical Trial Optional)',
    agencyCode: 'HHS-NIH11',
    agency: 'National Institutes of Health',
    openDate: '06/29/2026',
    closeDate: '09/24/2026',
    oppStatus: 'posted',
    docType: 'synopsis',
    cfdaList: ['93.855'],
  },
];

/** A posted row closing `daysOut` days from today (ET), or with a blank close date. */
export const postedHit = (id: number, daysOut: number | 'blank'): RawHit => ({
  id: String(id),
  number: `FIXTURE-${id}`,
  title: `Fixture opportunity ${id}`,
  agencyCode: 'HHS-NIH11',
  agency: 'National Institutes of Health',
  openDate: '06/29/2026',
  closeDate: daysOut === 'blank' ? '' : closingIn(daysOut),
  oppStatus: 'posted',
  docType: 'synopsis',
  cfdaList: ['93.855'],
});

/** `search2` `{ oppNum: '"1"', oppStatuses: all four, rows: 10 }`: five exact matches plus one non-equal hit. */
export const OPP_NUM_1_HITS: RawHit[] = [
  {
    id: '47142',
    number: '21561-9-F017A',
    title: 'Vegetation Survey Hawks Nest Hollow',
    agencyCode: 'DOI-FWS',
    agency: 'Fish and Wildlife Service',
    openDate: '05/01/2009',
    closeDate: '05/10/2009',
    oppStatus: 'archived',
    docType: 'synopsis',
    cfdaList: ['15.650'],
  },
  {
    id: '169194',
    number: '1',
    title: 'McGovern-Dole International Food for Education and Child Nutrition Program',
    agencyCode: 'USDA-FAS',
    agency: 'Foreign Agricultural Service',
    openDate: '05/04/2012',
    closeDate: '08/03/2012',
    oppStatus: 'archived',
    docType: 'synopsis',
    cfdaList: ['10.608'],
  },
  {
    id: '169193',
    number: '1',
    title: 'Food for Progress Program',
    agencyCode: 'USDA-FAS',
    agency: 'Foreign Agricultural Service',
    openDate: '05/04/2012',
    closeDate: '08/03/2012',
    oppStatus: 'archived',
    docType: 'synopsis',
    cfdaList: ['10.606'],
  },
  {
    id: '53475',
    number: '1',
    title: "Afghan Women's Empowerment Grants Program",
    agencyCode: 'DOS-AFG',
    agency: 'U.S. Mission to Afghanistan',
    openDate: '04/05/2010',
    closeDate: '09/30/2012',
    oppStatus: 'archived',
    docType: 'synopsis',
  },
  {
    id: '252180',
    number: '1',
    title:
      'the Full-Scale Engineered Barrier Experiment in Crystalline Host Rock (FEBEX) - Dismantling Project.',
    agencyCode: 'DOE-ID',
    agency: 'Idaho Field Office',
    openDate: '03/04/2014',
    closeDate: '03/10/2014',
    oppStatus: 'archived',
    docType: 'synopsis',
    cfdaList: ['81.121'],
  },
  {
    id: '263109',
    number: '1',
    title: 'USDA FNS SNAP E&amp;T Pilots',
    agencyCode: 'USDA-FNS1',
    agency: 'Food and Nutrition Service',
    openDate: '08/25/2014',
    closeDate: '11/24/2014',
    oppStatus: 'archived',
    docType: 'synopsis',
    cfdaList: ['10.596'],
  },
];

/** The HRSA-27-005 search row. */
export const HRSA_HIT: RawHit = {
  id: '363423',
  number: 'HRSA-27-005',
  title: 'Fiscal Year (FY) 2027 Service Area Competition (SAC)',
  agencyCode: 'HHS-HRSA',
  agency: 'Health Resources and Services Administration',
  openDate: '09/18/2026',
  closeDate: '10/19/2026',
  oppStatus: 'posted',
  docType: 'synopsis',
  cfdaList: ['93.224'],
};

/**
 * All-status facets (`{ rows: 0, oppStatuses: all four }`), trimmed to five
 * agencies. Kept traits: `DOC` lists itself as a sub-entry; `DOT` carries the
 * space-bearing codes and the `DOT-FTA - TPM` non-hyphen child; `HHS-OS-*`
 * codes share a prefix that is not itself a code; `USDA-FS` is a non-hyphen
 * prefix of `USDA-FSA`/`USDA-FSIS`; `NSF` has no sub-agencies; one agency label
 * carries a trailing space.
 */
export const FACETS_ALL: RawFacets = {
  oppStatusOptions: [
    { label: 'posted', value: 'posted', count: 940 },
    { label: 'closed', value: 'closed', count: 8700 },
    { label: 'archived', value: 'archived', count: 73220 },
    { label: 'forecasted', value: 'forecasted', count: 591 },
  ],
  eligibilities: [
    {
      label:
        'Nonprofits having a 501(c)(3) status with the IRS, other than institutions of higher education',
      value: '12',
      count: 29418,
    },
    {
      label: 'Native American tribal governments (Federally recognized)',
      value: '07',
      count: 21591,
    },
    {
      label:
        'Unrestricted (i.e., open to any type of entity above), subject to any clarification in text field entitled "Additional Information on Eligibility"',
      value: '99',
      count: 11783,
    },
    {
      label:
        'Others (see text field entitled "Additional Information on Eligibility" for clarification)',
      value: '25',
      count: 49265,
    },
  ],
  fundingCategories: [
    { label: 'Health', value: 'HL', count: 22049 },
    { label: 'Agriculture', value: 'AG', count: 2864 },
    { label: 'Education', value: 'ED', count: 11649 },
    {
      label: 'Science and Technology and other Research and Development',
      value: 'ST',
      count: 13933,
    },
  ],
  fundingInstruments: [
    { label: 'Grant', value: 'G', count: 40938 },
    { label: 'Cooperative Agreement', value: 'CA', count: 47283 },
    { label: 'Procurement Contract', value: 'PC', count: 1073 },
    { label: 'Other', value: 'O', count: 2740 },
  ],
  agencies: [
    {
      label: 'Department of Agriculture',
      value: 'USDA',
      count: 2996,
      subAgencyOptions: [
        { label: 'Farm Service Agency', value: 'USDA-FSA', count: 28 },
        { label: 'Food Safety Inspection Service', value: 'USDA-FSIS', count: 17 },
        { label: 'Forest Service', value: 'USDA-FS', count: 145 },
      ],
    },
    {
      label: 'Department of Commerce',
      value: 'DOC',
      count: 1419,
      subAgencyOptions: [
        { label: 'Department of Commerce', value: 'DOC', count: 899 },
        { label: 'Economic Development Administration', value: 'DOC-EDA', count: 60 },
        { label: 'National Oceanic and Atmospheric Administration', value: 'DOC-NOAA', count: 53 },
      ],
    },
    {
      label: 'Department of Health and Human Services',
      value: 'HHS',
      count: 23899,
      subAgencyOptions: [
        {
          label: 'Assistant Secretary for Planning and Evaluation',
          value: 'HHS-OS-ASPE',
          count: 4,
        },
        {
          label: 'Assistant Secretary for Preparedness and Response',
          value: 'HHS-OS-ASPR',
          count: 69,
        },
        { label: 'Centers for Disease Control - NCCDPHP', value: 'HHS-CDC-NCCDPHP', count: 139 },
        { label: 'Centers for Disease Control and Prevention', value: 'HHS-CDC', count: 1728 },
        {
          label: 'CMS-Consumer Information & Insurance Oversight',
          value: 'HHS-OS-OCIIO',
          count: 24,
        },
        { label: 'National Institutes of Health', value: 'HHS-NIH11', count: 12853 },
        { label: 'Office of the National Coordinator', value: 'HHS-OS-ONC', count: 49 },
      ],
    },
    {
      label: 'Department of Transportation',
      value: 'DOT',
      count: 1492,
      subAgencyOptions: [
        {
          label: 'Airport Improvement Program Discretionary Grants',
          value: 'DOT-FAA-AIP',
          count: 5,
        },
        { label: 'DOT - FAA Aviation Research Grants', value: 'DOT-FAA-FAA ARG', count: 4 },
        { label: 'DOT - FAA Centers of Excellence', value: 'DOT-FAA-FAA COE', count: 4 },
        { label: 'DOT - Federal Transit Administration', value: 'DOT-FTA', count: 197 },
        { label: 'DOT Federal Aviation Administration ', value: 'DOT-FAA', count: 10 },
        {
          label: 'DOT-Federal Transit Administration - Inactive Site',
          value: 'DOT-FTA - TPM',
          count: 2,
        },
        { label: 'FAA-COE-AJFE', value: 'DOT-FAA-FAA COE-AJFE', count: 2 },
        { label: 'FAA-COE-GA', value: 'DOT-FAA-FAA COE-GACOE', count: 1 },
        { label: 'FAA-COE-JAMS', value: 'DOT-FAA-FAA COE-FAA JAMS', count: 1 },
      ],
    },
    { label: 'U.S. National Science Foundation', value: 'NSF', count: 1332, subAgencyOptions: [] },
  ],
};

/** Default-scope facets (`{ rows: 0 }`): open (forecasted + posted) counts, trimmed to match {@link FACETS_ALL}. */
export const FACETS_OPEN: RawFacets = {
  oppStatusOptions: [
    { label: 'posted', value: 'posted', count: 940 },
    { label: 'closed', value: 'closed', count: 8700 },
    { label: 'archived', value: 'archived', count: 73220 },
    { label: 'forecasted', value: 'forecasted', count: 591 },
  ],
  eligibilities: [
    { label: 'Nonprofits', value: '12', count: 883 },
    { label: 'Unrestricted', value: '99', count: 402 },
  ],
  fundingCategories: [{ label: 'Health', value: 'HL', count: 886 }],
  fundingInstruments: [
    { label: 'Grant', value: 'G', count: 1023 },
    { label: 'Cooperative Agreement', value: 'CA', count: 481 },
  ],
  agencies: [
    {
      label: 'Department of Health and Human Services',
      value: 'HHS',
      count: 940,
      subAgencyOptions: [
        { label: 'National Institutes of Health', value: 'HHS-NIH11', count: 697 },
      ],
    },
    { label: 'U.S. National Science Foundation', value: 'NSF', count: 124, subAgencyOptions: [] },
  ],
};

/**
 * Routes `search2` facets-only calls to the snapshot fixtures: a body with
 * `oppStatuses` gets {@link FACETS_ALL}, a bare `{ rows: 0 }` gets {@link FACETS_OPEN}.
 */
export const referenceRoute = (): FetchMockRoute => ({
  method: 'POST',
  match: SEARCH2_URL,
  respond: async (request) => {
    const body = await bodyOf(request);
    return body.oppStatuses
      ? ok(searchData([], 83451, FACETS_ALL))
      : ok(searchData([], 1531, FACETS_OPEN));
  },
});

/** `fetchOpportunity` for an unknown id: a 200 skeleton with `errorMessages`. */
export const DETAIL_NOT_FOUND = {
  revision: 0,
  flag2006: 'N',
  synopsisAttachmentFolders: [],
  synopsisDocumentURLs: [],
  cfdas: [],
  opportunityHistoryDetails: [],
  opportunityPkgs: [],
  closedOpportunityPkgs: [],
  errorMessages: ['There is no record found for your search.'],
  forecastHistCount: 0,
  synopsisHistCount: 0,
  relatedOpps: [],
  draftMode: 'N',
};

/** `fetchOpportunity` when the backend is down: a 200 carrying only a `message`. */
export const DETAIL_BACKEND_UNAVAILABLE = {
  message:
    'No response received, as the webservice at the backend server https://apply07.grants.gov/grantsws/rest/opportunity/details is not available.',
};

/** `fetchOpportunity` for id 0: an `errorMsgs` validation skeleton, neither a record nor a not-found. */
export const DETAIL_ID_REQUIRED = {
  errorMsgs: ['Opportunity ID or opportunity number is required.'],
};

/** HRSA-27-005 (`fetchOpportunity` 363423), trimmed; contact synthetic; one history entry kept to verify stripping. */
export const DETAIL_HRSA = {
  id: 363423,
  revision: 0,
  opportunityNumber: 'HRSA-27-005',
  opportunityTitle: 'Fiscal Year (FY) 2027 Service Area Competition (SAC)',
  owningAgencyCode: 'HHS-HRSA',
  ost: 'POSTED',
  docType: 'synopsis',
  listed: 'L',
  opportunityCategory: { category: 'D', description: 'Discretionary' },
  agencyDetails: {
    code: 'HRSA',
    seed: 'HHS-HRSA',
    agencyName: 'Health Resources and Services Administration',
    agencyCode: 'HHS-HRSA',
    topAgencyCode: 'HHS',
  },
  topAgencyDetails: {
    code: 'HHS',
    seed: 'HHS',
    agencyName: 'Department of Health and Human Services',
    agencyCode: 'HHS',
    topAgencyCode: 'HHS',
  },
  cfdas: [
    {
      id: 434853,
      opportunityId: 363423,
      cfdaNumber: '93.224',
      programTitle: 'Health Center Program',
    },
  ],
  originalDueDate: 'Oct 19, 2026 12:00:00 AM EDT',
  synopsis: {
    opportunityId: 363423,
    agencyCode: 'HHS-HRSA',
    agencyContactName: 'Grants Contact',
    agencyContactEmail: 'grants-contact@agency.example',
    agencyContactPhone: '555-0100',
    agencyContactEmailDesc: 'grants-contact@agency.example',
    awardCeiling: '10116100',
    awardFloor: '650000',
    estimatedFunding: '267773700',
    numberOfAwards: '63',
    costSharing: false,
    responseDateStr: '2026-10-19-00-00-00',
    responseDateDesc:
      'Electronically submitted applications must be submitted no later than 11:59 p.m., ET, on the listed application due date.',
    postingDateStr: '2026-09-18-00-00-00',
    archiveDateStr: '2027-10-02-00-00-00',
    lastUpdatedDate: 'Sep 18, 2026 02:07:27 PM EDT',
    applicantTypes: [
      { id: '02', description: 'City or township governments' },
      { id: '07', description: 'Native American tribal governments (Federally recognized)' },
    ],
    fundingInstruments: [{ id: 'G', description: 'Grant' }],
    fundingActivityCategories: [{ id: 'HL', description: 'Health' }],
    synopsisDesc:
      '<p>The FY 2027 Health Center Program Service Area Competition (SAC) funding improves the health of medically underserved communities.</p>',
  },
  forecast: {
    awardCeiling: '19182000',
    forecastDesc: '<p>Stale forecast block.</p>',
  },
  synopsisAttachmentFolders: [
    {
      id: 81306,
      opportunityId: 363423,
      folderType: 'Full Announcement',
      folderName: 'Full Announcement',
      synopsisAttachments: [
        {
          id: 355067,
          opportunityId: 363423,
          mimeType: 'application/pdf',
          fileName: 'hrsa-27-005_full announcement.pdf',
          fileDescription: 'hrsa-27-005_full announcement.pdf',
          fileLobSize: 1617015,
        },
      ],
    },
  ],
  opportunityPkgs: [
    {
      id: 294168,
      packageId: 'PKG00294168',
      opportunityNumber: 'HRSA-27-005',
      openingDate: '2026-09-18',
      closingDate: '2026-10-19',
      electronicRequired: 'Y',
    },
  ],
  closedOpportunityPkgs: [],
  relatedOpps: [],
  synopsisHistCount: 0,
  forecastHistCount: 11,
  opportunityHistoryDetails: [
    {
      oppHistId: 1,
      opportunityId: 363423,
      opportunityNumber: 'HRSA-27-005',
      forecast: { awardCeiling: '19182000' },
    },
  ],
};
