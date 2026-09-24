/**
 * @fileoverview Additional trimmed Grants.gov shapes recorded from the live
 * legacy API for the search and get tool suites: forecast search rows with
 * sub-agency facets, a zero-hit facet block, and four sparse `fetchOpportunity`
 * records (forecast-only, NSF "accepted anytime", DOS `"undefined"` explanation,
 * DOD `"0"` ceiling with related opportunities). Every contact field is synthetic.
 * @module tests/fixtures/grants-gov-records
 */

import type { RawFacets, RawHit } from '@/services/grants-gov/types.js';

/** `search2` `{ agencies: 'HHS-CDC|HHS-CDC-*', oppStatuses: 'forecasted', rows: 2 }`: forecast rows carry no close date. */
export const CDC_FORECAST_HITS: RawHit[] = [
  {
    id: '361918',
    number: 'CDC-RFA-PS-27-0001',
    title: 'National HIV Behavioral Surveillance',
    agencyCode: 'HHS-CDC-NCHHSTP',
    agency: 'Centers for Disease Control - NCHHSTP',
    openDate: '04/16/2026',
    closeDate: '',
    oppStatus: 'forecasted',
    docType: 'forecast',
    cfdaList: ['93.940'],
  },
  {
    id: '361997',
    number: 'CDC-RFA-CK-27-0007',
    title: 'Centers of Excellence in Healthcare Quality and Safety',
    agencyCode: 'HHS-CDC-NCEZID',
    agency: 'Centers for Disease Control - NCEZID',
    openDate: '04/21/2026',
    closeDate: '',
    oppStatus: 'forecasted',
    docType: 'forecast',
    cfdaList: ['93.084'],
  },
];

/** Facets for the {@link CDC_FORECAST_HITS} search (hitCount 58), trimmed. One sub-agency label carries a double space. */
export const CDC_FACETS: RawFacets = {
  oppStatusOptions: [
    { label: 'posted', value: 'posted', count: 35 },
    { label: 'closed', value: 'closed', count: 69 },
    { label: 'archived', value: 'archived', count: 3758 },
    { label: 'forecasted', value: 'forecasted', count: 58 },
  ],
  eligibilities: [
    { label: 'State governments', value: '00', count: 41 },
    { label: 'Nonprofits', value: '12', count: 37 },
  ],
  fundingCategories: [{ label: 'Health', value: 'HL', count: 58 }],
  fundingInstruments: [
    { label: 'Cooperative Agreement', value: 'CA', count: 44 },
    { label: 'Grant', value: 'G', count: 14 },
  ],
  agencies: [
    {
      label: 'Department of Health and Human Services',
      value: 'HHS',
      count: 58,
      subAgencyOptions: [
        { label: 'CENTERS FOR DISEASE CONTROL  CSTLTS', value: 'HHS-CDC-CSTLTS', count: 1 },
        { label: 'Centers for Disease Control - NCBDDD', value: 'HHS-CDC-NCBDDD', count: 2 },
        { label: 'Centers for Disease Control - NCCDPHP', value: 'HHS-CDC-NCCDPHP', count: 3 },
      ],
    },
  ],
};

/**
 * `search2` `{ agencies: 'NSF', oppStatuses: 'forecasted', rows: 2 }`: zero hits.
 * The other facets come back empty, but `oppStatusOptions` still counts every
 * status for the other filters, which the zero-hit notice reads.
 */
export const NSF_ZERO_HIT_FACETS: RawFacets = {
  oppStatusOptions: [
    { label: 'posted', value: 'posted', count: 124 },
    { label: 'closed', value: 'closed', count: 236 },
    { label: 'archived', value: 'archived', count: 972 },
    { label: 'forecasted', value: 'forecasted', count: 0 },
  ],
  eligibilities: [],
  fundingCategories: [],
  fundingInstruments: [],
  agencies: [],
};

/** CDC-RFA-EH-27-0074 (`fetchOpportunity` 363917): a forecast. Only the `forecast` block is set; no attachments or packages. */
export const DETAIL_FORECAST = {
  id: 363917,
  revision: 0,
  opportunityNumber: 'CDC-RFA-EH-27-0074',
  opportunityTitle: 'State Biomonitoring Cooperative Agreement',
  owningAgencyCode: 'HHS-CDC-NCEH',
  flag2006: 'N',
  opportunityCategory: { category: 'D', description: 'Discretionary' },
  agencyDetails: {
    code: 'NCEH',
    seed: 'HHS-CDC-NCEH',
    agencyName: 'Centers for Disease Control - NCEH',
    agencyCode: 'HHS-CDC-NCEH',
    topAgencyCode: 'HHS',
  },
  topAgencyDetails: {
    code: 'HHS',
    seed: 'HHS',
    agencyName: 'Department of Health and Human Services',
    agencyCode: 'HHS',
    topAgencyCode: 'HHS',
  },
  forecast: {
    opportunityId: 363917,
    version: 1,
    forecastDesc:
      '<p>The purpose of this Notice of Funding Opportunity is to support state, local, tribal, and territorial public health laboratories in conducting high-quality biomonitoring.</p>',
    costSharing: false,
    numberOfAwards: '6',
    estimatedFunding: '15000000',
    awardCeiling: '900000',
    awardFloor: '750000',
    agencyContactName: 'Grants Contact',
    agencyContactPhone: '555-0100',
    agencyContactEmail: 'grants-contact@agency.example',
    agencyContactEmailDesc: 'grants-contact@agency.example',
    agencyCode: 'HHS-CDC-NCEH',
    applicantEligibilityDesc: 'N/A',
    estApplicationResponseDateDesc:
      'Electronically submitted applications must be submitted no later than 11:59 pm ET on the listed application due date.',
    fiscalYear: 2027,
    lastUpdatedDate: 'Sep 22, 2026 11:55:50 AM EDT',
    estimatedFundingFormatted: '15,000,000',
    awardCeilingFormatted: '900,000',
    applicantTypes: [
      { id: '07', description: 'Native American tribal governments (Federally recognized)' },
      {
        id: '12',
        description:
          'Nonprofits having a 501(c)(3) status with the IRS, other than institutions of higher education',
      },
      { id: '00', description: 'State governments' },
    ],
    fundingInstruments: [{ id: 'CA', description: 'Cooperative Agreement' }],
    fundingActivityCategories: [{ id: 'HL', description: 'Health' }],
    postingDateStr: '2026-09-22-00-00-00',
    archiveDateStr: '2027-05-19-00-00-00',
    estSynopsisPostingDateStr: '2027-02-16-00-00-00',
    estApplicationResponseDateStr: '2027-04-19-00-00-00',
    estAwardDateStr: '2027-09-01-00-00-00',
    estProjectStartDateStr: '2027-09-01-00-00-00',
  },
  synopsisAttachmentFolders: [],
  synopsisDocumentURLs: [],
  cfdas: [
    {
      id: 435468,
      opportunityId: 363917,
      cfdaNumber: '93.070',
      programTitle: 'Environmental Public Health and Emergency Response',
    },
  ],
  opportunityPkgs: [],
  closedOpportunityPkgs: [],
  errorMessages: [],
  docType: 'forecast',
  forecastHistCount: 0,
  synopsisHistCount: 0,
  relatedOpps: [],
  ost: 'FORECASTED',
  synopsis: null,
};

/**
 * NSF 26-523 (`fetchOpportunity` 363621): "Proposals accepted anytime" with a
 * 2076 stand-in close date, `"none"` ceiling and floor, no award count, a second
 * assistance listing with no number, and a multi-line contact description.
 */
export const DETAIL_NSF = {
  id: 363621,
  revision: 0,
  opportunityNumber: '26-523',
  opportunityTitle: 'MPS Physics Research Programs (MPS Physics)',
  owningAgencyCode: 'NSF',
  flag2006: 'N',
  opportunityCategory: { category: 'D', description: 'Discretionary' },
  synopsis: {
    opportunityId: 363621,
    version: 1,
    agencyCode: 'NSF',
    agencyContactPhone: '555-0100',
    agencyContactName: 'Grants Contact',
    agencyContactDesc: 'Grants Contact support\ngrants-contact@agency.example',
    agencyContactEmail: 'grants-contact@agency.example',
    agencyContactEmailDesc:
      'If you have any problems linking to this funding announcement, please contact the email address above.',
    synopsisDesc:
      '<p>The U.S. National Science Foundation Directorate for Mathematical and Physical Sciences (NSF MPS) supports multiple research programs at the frontiers of discovery in physics.</p>',
    responseDateDesc: 'Proposals accepted anytime',
    fundingDescLinkUrl: 'http://www.nsf.gov/publications/pub_summ.jsp?ods_key=nsf26523',
    fundingDescLinkDesc: 'NSF Publication 26-523',
    costSharing: false,
    estimatedFunding: '180000000',
    awardCeiling: 'none',
    awardFloor: 'none',
    lastUpdatedDate: 'Aug 17, 2026 10:29:50 AM EDT',
    applicantTypes: [
      {
        id: '99',
        description:
          'Unrestricted (i.e., open to any type of entity above), subject to any clarification in text field entitled "Additional Information on Eligibility"',
      },
    ],
    fundingInstruments: [{ id: 'G', description: 'Grant' }],
    fundingActivityCategories: [
      { id: 'ST', description: 'Science and Technology and other Research and Development' },
    ],
    responseDateStr: '2076-08-17-00-00-00',
    postingDateStr: '2026-08-17-00-00-00',
  },
  agencyDetails: {
    code: 'NSF',
    seed: 'NSF',
    agencyName: 'U.S. National Science Foundation',
    agencyCode: 'NSF',
    topAgencyCode: 'NSF',
  },
  topAgencyDetails: {
    code: 'NSF',
    seed: 'NSF',
    agencyName: 'U.S. National Science Foundation',
    agencyCode: 'NSF',
    topAgencyCode: 'NSF',
  },
  synopsisAttachmentFolders: [],
  synopsisDocumentURLs: [],
  cfdas: [
    {
      id: 435086,
      opportunityId: 363621,
      cfdaNumber: '47.049',
      programTitle: 'Mathematical and Physical Sciences',
    },
    { id: 435087, opportunityId: 363621 },
  ],
  opportunityPkgs: [
    {
      id: 293979,
      opportunityNumber: '26-523',
      openingDate: '2026-08-17',
      closingDate: '2076-08-17',
      electronicRequired: 'N',
      packageId: 'PKG00293979',
    },
  ],
  closedOpportunityPkgs: [],
  originalDueDate: 'Aug 17, 2076 12:00:00 AM EDT',
  originalDueDateDesc: 'Proposals accepted anytime',
  errorMessages: [],
  docType: 'synopsis',
  forecastHistCount: 0,
  synopsisHistCount: 0,
  relatedOpps: [],
  ost: 'POSTED',
  forecast: null,
};

/**
 * OFOP0001473 (`fetchOpportunity` 355211, DOS): the `01/01/2099` stand-in close
 * date with `responseDateDesc: "undefined"` (a literal string), a plain-text
 * description and eligibility narrative with real newlines and a bare numeric
 * entity, and cost sharing required.
 */
export const DETAIL_DOS = {
  id: 355211,
  revision: 0,
  opportunityNumber: 'OFOP0001473',
  opportunityTitle: 'U.S. EMBASSY TO LIBYA PAS ANNUAL PROGRAM STATEMENT',
  owningAgencyCode: 'DOS-TUN',
  flag2006: 'N',
  opportunityCategory: { category: 'D', description: 'Discretionary' },
  synopsis: {
    opportunityId: 355211,
    version: 1,
    agencyCode: 'DOS-TUN',
    agencyContactPhone: '555-0100',
    agencyContactName: 'Grants Contact',
    agencyContactDesc: 'grants-contact@agency.example',
    synopsisDesc:
      'U.S. DEPARTMENT OF STATE\nU.S. EMBASSY TO LIBYA, PUBLIC AFFAIRS SECTION\nNotice of Funding Opportunity (NOFO)\n\nFunding Opportunity Title: U.S. Embassy to Libya PAS Annual Program Statement',
    responseDateDesc: 'undefined',
    fundingDescLinkUrl:
      'https://mygrants.servicenowservices.com/mygrants?id=mygrants_form&table=x_g_usd4_o_grant_funding_opportunity&view=Default',
    fundingDescLinkDesc: 'Link to Opportunity in MyGrants',
    costSharing: true,
    numberOfAwards: '25',
    estimatedFunding: '25000',
    awardCeiling: '25000',
    awardFloor: '500',
    applicantEligibilityDesc:
      'The Public Affairs Office encourages applications from all sectors.&#8239; All grantees must have non-profit status. \n\nWe seek proposals for geographically and demographically diverse audiences within Libya.',
    lastUpdatedDate: 'Jun 28, 2024 10:21:19 AM EDT',
    applicantTypes: [
      {
        id: '25',
        description:
          'Others (see text field entitled "Additional Information on Eligibility" for clarification)',
      },
    ],
    fundingInstruments: [{ id: 'G', description: 'Grant' }],
    fundingActivityCategories: [{ id: 'CD', description: 'Community Development' }],
    responseDateStr: '2099-01-01-00-00-00',
    postingDateStr: '2024-06-28-00-00-00',
  },
  agencyDetails: {
    code: 'TUN',
    seed: 'DOS-TUN',
    agencyName: 'U.S. Mission to Tunisia',
    agencyCode: 'DOS-TUN',
    topAgencyCode: 'DOS',
  },
  topAgencyDetails: {
    code: 'DOS',
    seed: 'DOS',
    agencyName: 'Department of State',
    agencyCode: 'DOS',
    topAgencyCode: 'DOS',
  },
  synopsisAttachmentFolders: [],
  synopsisDocumentURLs: [],
  cfdas: [
    {
      id: 421784,
      opportunityId: 355211,
      cfdaNumber: '19.040',
      programTitle: 'Public Diplomacy Programs',
    },
  ],
  opportunityPkgs: [],
  closedOpportunityPkgs: [],
  originalDueDate: 'Jan 01, 2099 12:00:00 AM EST',
  originalDueDateDesc: 'undefined',
  errorMessages: [],
  docType: 'synopsis',
  forecastHistCount: 0,
  synopsisHistCount: 0,
  relatedOpps: [],
  ost: 'POSTED',
  forecast: null,
};

/**
 * HDTRA1-25-S-0001 (`fetchOpportunity` 356612, DOD): a `"0"` ceiling and floor
 * beside a real funding total, a 2034 close date (a real long-running BAA),
 * blank `responseDateDesc`, a funding-category explanation, an eligibility
 * narrative with a bare `&ldquo;` entity, attachments across three folders, a
 * package with a null opening date, 25 closed packages, and one related
 * opportunity. The contact name keeps the upstream's embedded newline.
 */
export const DETAIL_DOD = {
  id: 356612,
  revision: 0,
  opportunityNumber: 'HDTRA1-25-S-0001',
  opportunityTitle: 'Fundamental Research to Counter Weapons of Mass Destruction',
  owningAgencyCode: 'DOD-DTRA',
  flag2006: 'N',
  opportunityCategory: { category: 'D', description: 'Discretionary' },
  synopsis: {
    opportunityId: 356612,
    agencyCode: 'DOD-DTRA',
    agencyContactName: 'Grants Contact\nGrantor',
    agencyContactDesc: 'grants-contact@agency.example',
    synopsisDesc:
      '<p>The Defense Threat Reduction Agency (DTRA) is soliciting white papers for fundamental research.</p><ul><li>Thrust Area 1</li><li>Thrust Area 2</li></ul>',
    responseDateDesc: '',
    fundingDescLinkUrl: null,
    fundingDescLinkDesc: null,
    costSharing: false,
    numberOfAwards: '10',
    estimatedFunding: '500000000',
    awardCeiling: '0',
    awardFloor: '0',
    fundingActivityCategoryDesc:
      'It is anticipated that a majority of the actions funded from this announcement will be in the form of grants; however, other instruments such as cooperative agreements (CAs) or other transactions (OTs) for research may also be awarded from this announcement.',
    applicantEligibilityDesc:
      'See Section 3. &ldquo;Eligibility Information&rdquo;, of the BAA for full Eligibility Requirements.',
    lastUpdatedDate: 'Jan 20, 2026 08:07:34 AM EST',
    applicantTypes: [
      {
        id: '99',
        description:
          'Unrestricted (i.e., open to any type of entity above), subject to any clarification in text field entitled "Additional Information on Eligibility"',
      },
    ],
    fundingInstruments: [
      { id: 'CA', description: 'Cooperative Agreement' },
      { id: 'G', description: 'Grant' },
    ],
    fundingActivityCategories: [
      { id: 'ST', description: 'Science and Technology and other Research and Development' },
    ],
    responseDateStr: '2034-09-30-00-00-00',
    postingDateStr: '2024-10-01-00-00-00',
    archiveDateStr: '2034-10-30-00-00-00',
  },
  agencyDetails: {
    code: 'DTRA',
    seed: 'DOD-DTRA',
    agencyName: 'Defense Threat Reduction Agency',
    agencyCode: 'DOD-DTRA',
    topAgencyCode: 'DOD',
  },
  topAgencyDetails: {
    code: 'DOD',
    seed: 'DOD',
    agencyName: 'Department of Defense',
    agencyCode: 'DOD',
    topAgencyCode: 'DOD',
  },
  synopsisAttachmentFolders: [
    {
      folderType: 'Full Announcement',
      synopsisAttachments: [
        {
          id: 350084,
          fileName: 'HDTRA125S0001_B+Topics+Release_Final_V2.pdf',
          fileDescription: 'Amendment 2 Topics B1-B6',
          mimeType: 'application/pdf',
          fileLobSize: 801349,
        },
      ],
    },
    {
      folderType: 'Full Announcement',
      synopsisAttachments: [
        {
          id: 342985,
          fileName: 'HDTRA1-25-S-0001 FRCWMD - Original Posting_Final 1 Oct 2024.pdf',
          fileDescription: 'FRCWMD - BAA - Original',
          mimeType: 'application/pdf',
          fileLobSize: 568753,
        },
      ],
    },
    {
      folderType: 'Revised Full Announcement',
      synopsisAttachments: [
        {
          id: 345298,
          fileName: '2 - HDTRA1-25-S-0001 FRCWMD - Amendment_1- Topics A1-A7 (December 2024).pdf',
          fileDescription: 'Amendment 1 Topics A1-A7',
          mimeType: 'application/pdf',
          fileLobSize: 742437,
        },
      ],
    },
  ],
  synopsisDocumentURLs: [],
  cfdas: [
    {
      id: 424009,
      opportunityId: 356612,
      cfdaNumber: '12.351',
      programTitle: 'Scientific Research - Combating Weapons of Mass Destruction',
    },
    { id: 426312, opportunityId: 356612 },
  ],
  opportunityPkgs: [
    {
      packageId: 'PKG00288034',
      competitionId: 'THRUSTAREA1-NOTOPIC-PHASEI-WHITE-PAPER',
      competitionTitle:
        'Thrust Area 1-Fundamental Science for Chemical and Biological Defense-NO TOPIC-Phase I White Paper',
      openingDate: '2024-10-01',
      closingDate: '2034-09-30',
      electronicRequired: 'Y',
    },
    {
      packageId: 'PKG00288395',
      competitionId: 'THRUSTAREA1-NOTOPIC-PHASEII-FULLPROPOSAL',
      competitionTitle:
        'Thrust Area 1-Fundamental Science for Chemical and Biological Defense-NO TOPIC-Phase II Full Proposal',
      openingDate: null,
      closingDate: '2034-09-30',
      electronicRequired: 'Y',
    },
  ],
  closedOpportunityPkgs: Array.from({ length: 25 }, (_, i) => ({
    packageId: `PKG0028${String(9663 + i).padStart(4, '0')}`,
  })),
  originalDueDate: 'Sep 30, 2034 12:00:00 AM EDT',
  errorMessages: [],
  docType: 'synopsis',
  forecastHistCount: 0,
  synopsisHistCount: 3,
  relatedOpps: [
    {
      sourceOpportunityId: 356612,
      opportunityId: 275322,
      opportunityNum: 'HDTRA1-14-24-FRCWMD-BAA',
      opportunityTitle: 'Fundamental Research to Counter Weapons of Mass Destruction',
      agencyCode: 'DOD-DTRA',
      postedDate: 'Mar 20, 2015',
      closeDate: 'Sep 30, 2024',
      comments: 'Legacy Fundamental Research BAA',
    },
  ],
  ost: 'POSTED',
  forecast: null,
};
