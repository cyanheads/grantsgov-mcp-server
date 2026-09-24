/**
 * @fileoverview grantsgov_get_opportunity — reads the full Grants.gov record for
 * up to 5 opportunities by numeric id or opportunity number. Numbers resolve
 * across all statuses; a miss or an ambiguous number is an unresolved result
 * with guidance, never an error.
 * @module mcp-server/tools/definitions/grantsgov-get-opportunity.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getGrantsGovService,
  STATUSES,
  type Status,
} from '@/services/grants-gov/grants-gov-service.js';
import { htmlToText } from '@/services/grants-gov/html-to-text.js';
import {
  closeDateKind,
  daysBetween,
  decodeEntities,
  parseCount,
  parseLongDate,
  parseMoney,
  parseSlashDate,
  parseStrDate,
  todayET,
} from '@/services/grants-gov/normalize.js';
import type {
  FetchResult,
  NumberResolution,
  RawCodeDescription,
  RawDetail,
  RawHit,
} from '@/services/grants-gov/types.js';
import { OPPORTUNITY_NUMBER_INPUT, optionalList } from '../input-schemas.js';
import { blockquote, inline, tableCell } from '../render.js';

const MAX_IDENTIFIERS = 5;
const DESCRIPTION_CAP = 12_000;
const ELIGIBILITY_CAP = 6_000;
const CATEGORY_EXPLANATION_CAP = 2_000;
const ATTACHMENT_CAP = 30;
const PACKAGE_CAP = 10;
const RELATED_CAP = 10;

/** A numeric id, as a number or a digit string (search rows emit `"363423"`). */
const OPPORTUNITY_ID_INPUT = z
  .union([
    z.number().int().min(1),
    z.string().regex(/^\s*\d+\s*$/, 'An opportunity id is a positive whole number, e.g. 363423.'),
  ])
  .transform(Number)
  .pipe(z.number().int().min(1, 'An opportunity id is a positive whole number, e.g. 363423.'));

const DETAIL_URL = 'https://www.grants.gov/search-results-detail/';
const ATTACHMENT_URL = 'https://apply07.grants.gov/grantsws/rest/opportunity/att/download/';

const codeLabelList = (description: string) =>
  z
    .array(
      z
        .object({
          code: z.string().describe('The code, as grantsgov_search_opportunities filters take it.'),
          label: z.string().optional().describe('Human-readable name. Omitted when not listed.'),
        })
        .describe('One code with its label.'),
    )
    .describe(description);

const OpportunityRecord = z
  .object({
    opportunity_id: z.number().int().describe('Numeric Grants.gov id.'),
    opportunity_number: z.string().describe('Agency-assigned opportunity number.'),
    title: z.string().describe('Opportunity title (HTML entities decoded).'),
    status: z.enum(STATUSES).describe('Lifecycle status.'),
    doc_type: z
      .enum(['synopsis', 'forecast'])
      .describe('Whether the record is a posted synopsis or a forecast.'),
    category_code: z
      .string()
      .optional()
      .describe(
        'Opportunity category: D discretionary, M mandatory, C continuation, E earmark, O other. Omitted when not listed.',
      ),
    category_label: z
      .string()
      .optional()
      .describe('Opportunity category name. Omitted when not listed.'),
    agency_code: z
      .string()
      .optional()
      .describe('Owning agency code, e.g. HHS-HRSA. Omitted when the record lists none.'),
    agency_name: z
      .string()
      .optional()
      .describe('Owning agency name. Omitted when the record lists none.'),
    top_agency_code: z
      .string()
      .optional()
      .describe('Top-level agency code, e.g. HHS. Omitted when not listed.'),
    top_agency_name: z
      .string()
      .optional()
      .describe('Top-level agency name. Omitted when not listed.'),
    grants_gov_url: z.string().describe('Public Grants.gov page for the opportunity.'),
    close_date: z
      .string()
      .optional()
      .describe(
        'Close date, YYYY-MM-DD: the application due date, or the estimated one on a forecast. Omitted when none is listed.',
      ),
    close_date_kind: z
      .enum(['fixed', 'none_listed', 'placeholder'])
      .describe(
        'fixed = a real (or, on a forecast, estimated) deadline; none_listed = no close date; placeholder = a far-future stand-in date the agency uses for "accepted anytime".',
      ),
    close_date_is_estimate: z
      .boolean()
      .describe('True on forecasts, whose close date is an estimate.'),
    days_until_close: z
      .number()
      .int()
      .optional()
      .describe(
        'Days from today (US Eastern) to close_date. Present only when close_date_kind is fixed; negative once the date has passed.',
      ),
    close_date_explanation: z
      .string()
      .optional()
      .describe(
        'Agency text about the deadline, often the submission time rule. Omitted when not listed.',
      ),
    original_close_date: z
      .string()
      .optional()
      .describe(
        'The original due date, YYYY-MM-DD. Present only when listed and different from close_date.',
      ),
    posted_date: z
      .string()
      .optional()
      .describe('Posting date, YYYY-MM-DD. Omitted when not listed.'),
    archive_date: z
      .string()
      .optional()
      .describe(
        'Archive date, YYYY-MM-DD. Omitted when not listed (common on rolling and open-ended records).',
      ),
    last_updated: z
      .string()
      .optional()
      .describe('Date the record was last updated, YYYY-MM-DD. Omitted when not listed.'),
    past_revision_count: z
      .number()
      .int()
      .describe(
        'Earlier revisions of the synopsis and forecast (the history itself is not returned).',
      ),
    money_source: z
      .enum(['synopsis', 'forecast'])
      .describe(
        'Which block the funding, eligibility, and contact fields come from: the synopsis on a posted record, the forecast on a forecast.',
      ),
    award_ceiling_usd: z
      .number()
      .optional()
      .describe(
        'Largest single award, in US dollars. Omitted when not listed; 0 means listed as 0.',
      ),
    award_floor_usd: z
      .number()
      .optional()
      .describe(
        'Smallest single award, in US dollars. Omitted when not listed; 0 means listed as 0.',
      ),
    estimated_total_funding_usd: z
      .number()
      .optional()
      .describe(
        'Estimated total program funding, in US dollars. Omitted when not listed; 0 means listed as 0.',
      ),
    expected_awards: z
      .number()
      .int()
      .optional()
      .describe('Expected number of awards. Omitted when not listed.'),
    cost_sharing_required: z
      .boolean()
      .optional()
      .describe('Whether cost sharing or matching is required. Omitted when not listed.'),
    forecast_estimates: z
      .object({
        est_post_date: z.string().optional().describe('Estimated posting date, YYYY-MM-DD.'),
        est_close_date: z.string().optional().describe('Estimated close date, YYYY-MM-DD.'),
        est_award_date: z.string().optional().describe('Estimated award date, YYYY-MM-DD.'),
        est_project_start_date: z
          .string()
          .optional()
          .describe('Estimated project start date, YYYY-MM-DD.'),
        fiscal_year: z.number().int().optional().describe('Fiscal year of the funding.'),
      })
      .optional()
      .describe('Forecasts only: the agency estimates of the synopsis timeline.'),
    applicant_types: codeLabelList(
      'Eligible applicant types; read with eligibility_narrative, which often narrows them.',
    ),
    eligibility_narrative: z
      .string()
      .optional()
      .describe('Agency text on eligibility (up to 6,000 characters). Omitted when not listed.'),
    eligibility_narrative_truncated: z
      .boolean()
      .optional()
      .describe('True when eligibility_narrative was cut at 6,000 characters.'),
    funding_instruments: codeLabelList('Funding instruments (grant, cooperative agreement, ...).'),
    funding_categories: codeLabelList('Funding activity categories.'),
    funding_category_explanation: z
      .string()
      .optional()
      .describe(
        'Agency text explaining the Other category (up to 2,000 characters). Omitted when not listed.',
      ),
    funding_category_explanation_truncated: z
      .boolean()
      .optional()
      .describe('True when funding_category_explanation was cut at 2,000 characters.'),
    assistance_listings: z
      .array(
        z
          .object({
            number: z.string().describe('Assistance listing number (ALN, formerly CFDA).'),
            program_title: z.string().optional().describe('Program title.'),
          })
          .describe('One assistance listing.'),
      )
      .describe('Assistance listings funding the opportunity.'),
    description: z
      .string()
      .optional()
      .describe(
        'Opportunity description as plain text (up to 12,000 characters). Omitted when not listed.',
      ),
    description_truncated: z
      .boolean()
      .optional()
      .describe('True when description was cut at 12,000 characters.'),
    agency_contact: z
      .object({
        name: z.string().optional().describe('Contact name or office.'),
        email: z.string().optional().describe('Contact email.'),
        phone: z.string().optional().describe('Contact phone.'),
        details: z.string().optional().describe('Further contact text published by the agency.'),
      })
      .optional()
      .describe('Applicant-facing agency contact as published. Omitted when none is listed.'),
    additional_info_url: z
      .string()
      .optional()
      .describe('Agency link for more information (not fetched by this server).'),
    additional_info_label: z
      .string()
      .optional()
      .describe('Label of the additional-information link.'),
    attachments: z
      .array(
        z
          .object({
            attachment_id: z.number().int().describe('Attachment id.'),
            folder_type: z
              .string()
              .optional()
              .describe('Attachment folder, e.g. Full Announcement.'),
            file_name: z.string().optional().describe('File name.'),
            description: z.string().optional().describe('File description.'),
            mime_type: z.string().optional().describe('File MIME type.'),
            size_in_bytes: z.number().optional().describe('File size in bytes.'),
            download_url: z.string().describe('Direct download link (no login needed).'),
          })
          .describe('One NOFO or supporting attachment.'),
      )
      .describe('Attachments, up to 30.'),
    attachment_count: z.number().int().describe('Total attachments on the record.'),
    application_packages: z
      .array(
        z
          .object({
            package_id: z.string().describe('Application package id, e.g. PKG00294168.'),
            competition_id: z.string().optional().describe('Competition id.'),
            competition_title: z.string().optional().describe('Competition title.'),
            opening_date: z.string().optional().describe('Package opening date, YYYY-MM-DD.'),
            closing_date: z.string().optional().describe('Package closing date, YYYY-MM-DD.'),
            electronic_required: z
              .boolean()
              .optional()
              .describe('Whether electronic submission is required.'),
          })
          .describe('One open application package.'),
      )
      .describe('Open application packages, up to 10.'),
    application_package_count: z.number().int().describe('Total open application packages.'),
    closed_package_count: z.number().int().describe('Closed application packages on the record.'),
    related_opportunities: z
      .array(
        z
          .object({
            opportunity_id: z
              .number()
              .int()
              .describe(
                'Related opportunity id; pass to grantsgov_get_opportunity.opportunity_ids.',
              ),
            opportunity_number: z.string().optional().describe('Related opportunity number.'),
            title: z.string().optional().describe('Related opportunity title.'),
            agency_code: z.string().optional().describe('Related opportunity agency code.'),
            posted_date: z.string().optional().describe('Posting date, YYYY-MM-DD.'),
            close_date: z.string().optional().describe('Close date, YYYY-MM-DD.'),
            note: z.string().optional().describe('Agency note on the relationship.'),
          })
          .describe('One related opportunity.'),
      )
      .describe('Related opportunities, up to 10.'),
    related_opportunity_count: z.number().int().describe('Total related opportunities.'),
  })
  .describe('One full opportunity record.');

type OpportunityRecordValue = z.infer<typeof OpportunityRecord>;

const Candidate = z
  .object({
    opportunity_id: z.string().describe('Numeric id as a digit string; pass to opportunity_ids.'),
    opportunity_number: z.string().describe('Opportunity number.'),
    title: z.string().describe('Title (HTML entities decoded).'),
    agency_code: z.string().optional().describe('Owning agency code. Omitted when not listed.'),
    agency_name: z.string().optional().describe('Owning agency name. Omitted when not listed.'),
    status: z.enum(STATUSES).describe('Lifecycle status.'),
    open_date: z.string().optional().describe('Posting date, YYYY-MM-DD. Omitted when not listed.'),
    close_date: z
      .string()
      .optional()
      .describe('Close date as listed in search, YYYY-MM-DD. Omitted when none is listed.'),
  })
  .describe('One opportunity carrying the ambiguous number.');

const UnresolvedEntry = z
  .object({
    input: z.string().describe('The id or number as given.'),
    input_kind: z
      .enum(['opportunity_id', 'opportunity_number'])
      .describe('Which list it came from.'),
    outcome: z
      .enum(['not_found', 'ambiguous'])
      .describe('not_found = no record; ambiguous = the number matches more than one opportunity.'),
    candidates: z
      .array(Candidate)
      .optional()
      .describe('For ambiguous numbers: every match, to re-request by id.'),
    guidance: z.string().describe('The next call to make.'),
  })
  .describe('One input that did not resolve to exactly one record.');

type Unresolved = z.infer<typeof UnresolvedEntry>;

/** Normalized agency text, or `undefined` when blank or the literal `"undefined"` some records carry. */
function text(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return;
  const normalized = htmlToText(raw).trim();
  return normalized === '' || normalized === 'undefined' ? undefined : normalized;
}

/** A plain upstream string, trimmed; blank → `undefined`. */
function plain(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Caps text at `max` characters, reporting whether it was cut. */
function cap(value: string | undefined, max: number): { text?: string; truncated: boolean } {
  if (value === undefined) return { truncated: false };
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max).trimEnd(), truncated: true };
}

function codeLabels(entries: readonly RawCodeDescription[] | null | undefined) {
  return (entries ?? []).flatMap((entry) => {
    const code = plain(entry.id);
    if (!code) return [];
    const label = plain(entry.description);
    return [{ code, ...(label && { label }) }];
  });
}

/** Maps a raw detail record, reading block-scoped fields from the block named by `docType`. */
function toRecord(raw: RawDetail & { id: number }, today: string): OpportunityRecordValue {
  const isForecast = raw.docType?.toLowerCase() === 'forecast';
  const block = (isForecast ? raw.forecast : raw.synopsis) ?? {};
  const { id } = raw;

  const closeDate = parseStrDate(
    isForecast ? block.estApplicationResponseDateStr : block.responseDateStr,
  );
  const kind = closeDateKind(closeDate, today);
  const originalClose = parseLongDate(raw.originalDueDate);
  const explanation = text(
    isForecast ? block.estApplicationResponseDateDesc : block.responseDateDesc,
  );
  const description = cap(
    text(isForecast ? block.forecastDesc : block.synopsisDesc),
    DESCRIPTION_CAP,
  );
  const eligibility = cap(text(block.applicantEligibilityDesc), ELIGIBILITY_CAP);
  const categoryExplanation = cap(
    text(block.fundingActivityCategoryDesc),
    CATEGORY_EXPLANATION_CAP,
  );

  const ceiling = parseMoney(block.awardCeiling);
  const floor = parseMoney(block.awardFloor);
  const totalFunding = parseMoney(block.estimatedFunding);
  const awards = parseCount(block.numberOfAwards);

  const forecastEstimates = isForecast
    ? Object.fromEntries(
        Object.entries({
          est_post_date: parseStrDate(block.estSynopsisPostingDateStr),
          est_close_date: parseStrDate(block.estApplicationResponseDateStr),
          est_award_date: parseStrDate(block.estAwardDateStr),
          est_project_start_date: parseStrDate(block.estProjectStartDateStr),
          fiscal_year: Number.isInteger(block.fiscalYear) ? block.fiscalYear : undefined,
        }).filter(([, value]) => value !== undefined),
      )
    : {};

  const contactName = plain(block.agencyContactName);
  const contactEmail = plain(block.agencyContactEmail);
  const contactPhone = plain(block.agencyContactPhone);
  const emailLabel = text(block.agencyContactEmailDesc);
  const contactDetails =
    text(block.agencyContactDesc) ?? (emailLabel !== contactEmail ? emailLabel : undefined);
  const contact = {
    ...(contactName && { name: contactName }),
    ...(contactEmail && { email: contactEmail }),
    ...(contactPhone && { phone: contactPhone }),
    ...(contactDetails && { details: contactDetails }),
  };

  const allAttachments = (raw.synopsisAttachmentFolders ?? []).flatMap((folder) =>
    (folder.synopsisAttachments ?? []).flatMap((attachment) => {
      if (typeof attachment.id !== 'number') return [];
      const folderType = plain(folder.folderType);
      const fileName = plain(attachment.fileName);
      const fileDescription = plain(attachment.fileDescription);
      const mimeType = plain(attachment.mimeType);
      return [
        {
          attachment_id: attachment.id,
          ...(folderType && { folder_type: folderType }),
          ...(fileName && { file_name: fileName }),
          ...(fileDescription && { description: fileDescription }),
          ...(mimeType && { mime_type: mimeType }),
          ...(typeof attachment.fileLobSize === 'number' && {
            size_in_bytes: attachment.fileLobSize,
          }),
          download_url: `${ATTACHMENT_URL}${attachment.id}`,
        },
      ];
    }),
  );

  const allPackages = (raw.opportunityPkgs ?? []).flatMap((pkg) => {
    const packageId = plain(pkg.packageId);
    if (!packageId) return [];
    const competitionId = plain(pkg.competitionId);
    const competitionTitle = plain(pkg.competitionTitle);
    const opening = parseStrDate(pkg.openingDate);
    const closing = parseStrDate(pkg.closingDate);
    const electronic = pkg.electronicRequired?.trim().toUpperCase();
    return [
      {
        package_id: packageId,
        ...(competitionId && { competition_id: competitionId }),
        ...(competitionTitle && { competition_title: decodeEntities(competitionTitle) }),
        ...(opening && { opening_date: opening }),
        ...(closing && { closing_date: closing }),
        ...((electronic === 'Y' || electronic === 'N') && {
          electronic_required: electronic === 'Y',
        }),
      },
    ];
  });

  const allRelated = (raw.relatedOpps ?? []).flatMap((related) => {
    if (typeof related.opportunityId !== 'number') return [];
    const number = plain(related.opportunityNum);
    const title = plain(related.opportunityTitle);
    const agency = plain(related.agencyCode);
    const posted = parseLongDate(related.postedDate) ?? parseSlashDate(related.postedDate);
    const closes = parseLongDate(related.closeDate) ?? parseSlashDate(related.closeDate);
    const note = text(related.comments);
    return [
      {
        opportunity_id: related.opportunityId,
        ...(number && { opportunity_number: number }),
        ...(title && { title: decodeEntities(title) }),
        ...(agency && { agency_code: agency }),
        ...(posted && { posted_date: posted }),
        ...(closes && { close_date: closes }),
        ...(note && { note }),
      },
    ];
  });

  const categoryCode = plain(raw.opportunityCategory?.category);
  const categoryLabel = plain(raw.opportunityCategory?.description);
  const agencyCode = plain(raw.agencyDetails?.agencyCode) ?? plain(raw.owningAgencyCode);
  const agencyName = plain(raw.agencyDetails?.agencyName);
  const topCode = plain(raw.topAgencyDetails?.agencyCode);
  const topName = plain(raw.topAgencyDetails?.agencyName);
  const postedDate = parseStrDate(block.postingDateStr);
  const archiveDate = parseStrDate(block.archiveDateStr);
  const lastUpdated = parseLongDate(block.lastUpdatedDate);
  const infoUrl = plain(block.fundingDescLinkUrl);
  const infoLabel = plain(block.fundingDescLinkDesc);

  return {
    opportunity_id: id,
    opportunity_number: raw.opportunityNumber?.trim() ?? '',
    title: decodeEntities(raw.opportunityTitle?.trim() ?? ''),
    status: raw.ost?.trim().toLowerCase() as Status,
    doc_type: isForecast ? 'forecast' : 'synopsis',
    ...(categoryCode && { category_code: categoryCode }),
    ...(categoryLabel && { category_label: categoryLabel }),
    ...(agencyCode && { agency_code: agencyCode }),
    ...(agencyName && { agency_name: agencyName }),
    ...(topCode && { top_agency_code: topCode }),
    ...(topName && { top_agency_name: topName }),
    grants_gov_url: `${DETAIL_URL}${id}`,
    ...(closeDate && { close_date: closeDate }),
    close_date_kind: kind,
    close_date_is_estimate: isForecast,
    ...(closeDate && kind === 'fixed' && { days_until_close: daysBetween(today, closeDate) }),
    ...(explanation && { close_date_explanation: explanation }),
    ...(originalClose && originalClose !== closeDate && { original_close_date: originalClose }),
    ...(postedDate && { posted_date: postedDate }),
    ...(archiveDate && { archive_date: archiveDate }),
    ...(lastUpdated && { last_updated: lastUpdated }),
    past_revision_count: (raw.synopsisHistCount ?? 0) + (raw.forecastHistCount ?? 0),
    money_source: isForecast ? 'forecast' : 'synopsis',
    ...(ceiling !== undefined && { award_ceiling_usd: ceiling }),
    ...(floor !== undefined && { award_floor_usd: floor }),
    ...(totalFunding !== undefined && { estimated_total_funding_usd: totalFunding }),
    ...(awards !== undefined && { expected_awards: awards }),
    ...(typeof block.costSharing === 'boolean' && { cost_sharing_required: block.costSharing }),
    ...(Object.keys(forecastEstimates).length > 0 && { forecast_estimates: forecastEstimates }),
    applicant_types: codeLabels(block.applicantTypes),
    ...(eligibility.text !== undefined && { eligibility_narrative: eligibility.text }),
    ...(eligibility.truncated && { eligibility_narrative_truncated: true }),
    funding_instruments: codeLabels(block.fundingInstruments),
    funding_categories: codeLabels(block.fundingActivityCategories),
    ...(categoryExplanation.text !== undefined && {
      funding_category_explanation: categoryExplanation.text,
    }),
    ...(categoryExplanation.truncated && { funding_category_explanation_truncated: true }),
    assistance_listings: (raw.cfdas ?? []).flatMap((cfda) => {
      const number = plain(cfda.cfdaNumber);
      if (!number) return [];
      const programTitle = plain(cfda.programTitle);
      return [{ number, ...(programTitle && { program_title: decodeEntities(programTitle) }) }];
    }),
    ...(description.text !== undefined && { description: description.text }),
    ...(description.truncated && { description_truncated: true }),
    ...(Object.keys(contact).length > 0 && { agency_contact: contact }),
    ...(infoUrl && { additional_info_url: infoUrl }),
    ...(infoLabel && { additional_info_label: infoLabel }),
    attachments: allAttachments.slice(0, ATTACHMENT_CAP),
    attachment_count: allAttachments.length,
    application_packages: allPackages.slice(0, PACKAGE_CAP),
    application_package_count: allPackages.length,
    closed_package_count: raw.closedOpportunityPkgs?.length ?? 0,
    related_opportunities: allRelated.slice(0, RELATED_CAP),
    related_opportunity_count: allRelated.length,
  };
}

function toCandidate(hit: RawHit): z.infer<typeof Candidate> {
  const agencyCode = plain(hit.agencyCode);
  const agencyName = plain(hit.agency);
  const openDate = parseSlashDate(hit.openDate);
  const closeDate = parseSlashDate(hit.closeDate);
  return {
    opportunity_id: hit.id ?? '',
    opportunity_number: hit.number?.trim() ?? '',
    title: decodeEntities(hit.title?.trim() ?? ''),
    ...(agencyCode && { agency_code: agencyCode }),
    ...(agencyName && { agency_name: agencyName }),
    status: hit.oppStatus?.toLowerCase() as Status,
    ...(openDate && { open_date: openDate }),
    ...(closeDate && { close_date: closeDate }),
  };
}

const usd = (value: number | undefined) =>
  value === undefined
    ? 'Not available'
    : value === 0
      ? '$0 (as listed)'
      : `$${value.toLocaleString('en-US')}`;

/** One record as markdown. Agency text is flattened in inline slots and blockquoted when multi-line. */
function renderRecord(record: OpportunityRecordValue): string[] {
  const lines: string[] = [`## ${inline(record.title)}`, ''];
  const agency = (name: string | undefined, code: string | undefined) =>
    [name && inline(name), code && `\`${inline(code)}\``].filter(Boolean).join(' ') || 'Not listed';
  lines.push(
    `**Opportunity number:** \`${inline(record.opportunity_number)}\` · **ID:** ${record.opportunity_id} · **Status:** ${record.status} (${record.doc_type})`,
    `**Category:** ${[record.category_code && inline(record.category_code), record.category_label && inline(record.category_label)].filter(Boolean).join(' ') || 'Not listed'}`,
    `**Agency:** ${agency(record.agency_name, record.agency_code)}${record.top_agency_code !== undefined || record.top_agency_name !== undefined ? ` · **Top-level agency:** ${agency(record.top_agency_name, record.top_agency_code)}` : ''}`,
    `**Grants.gov page:** ${record.grants_gov_url}`,
    '',
    '### Deadline',
  );

  const estimate = record.close_date_is_estimate ? ' (estimated, from the forecast)' : '';
  if (record.close_date_kind === 'none_listed') {
    lines.push(`**Close date:** None listed${estimate}`);
  } else if (record.close_date_kind === 'placeholder') {
    lines.push(
      `**Close date:** ${record.close_date} — a placeholder date the agency uses for open-ended acceptance, not a deadline${estimate}`,
    );
  } else {
    const days = record.days_until_close;
    const relative =
      days === undefined
        ? ''
        : days === 0
          ? ' (closes today)'
          : days > 0
            ? ` (${days} days from today)`
            : ` (${-days} days ago)`;
    lines.push(`**Close date:** ${record.close_date}${relative}${estimate}`);
  }
  if (record.original_close_date)
    lines.push(`**Original close date:** ${record.original_close_date}`);
  if (record.close_date_explanation) {
    lines.push('**Close date explanation:**', blockquote(record.close_date_explanation));
  }
  lines.push(
    `**Posted:** ${record.posted_date ?? 'Not listed'} · **Archive date:** ${record.archive_date ?? 'Not listed'} · **Last updated:** ${record.last_updated ?? 'Not listed'} · **Past revisions:** ${record.past_revision_count}`,
    '',
    `### Funding (from the ${record.money_source} block)`,
    `- **Award ceiling:** ${usd(record.award_ceiling_usd)}`,
    `- **Award floor:** ${usd(record.award_floor_usd)}`,
    `- **Estimated total funding:** ${usd(record.estimated_total_funding_usd)}`,
    `- **Expected awards:** ${record.expected_awards ?? 'Not available'}`,
    `- **Cost sharing required:** ${record.cost_sharing_required === undefined ? 'Not available' : record.cost_sharing_required ? 'Yes' : 'No'}`,
  );

  const estimates = record.forecast_estimates;
  if (estimates) {
    lines.push(
      '',
      '### Forecast estimates',
      `- **Estimated posting date:** ${estimates.est_post_date ?? 'Not listed'}`,
      `- **Estimated close date:** ${estimates.est_close_date ?? 'Not listed'}`,
      `- **Estimated award date:** ${estimates.est_award_date ?? 'Not listed'}`,
      `- **Estimated project start date:** ${estimates.est_project_start_date ?? 'Not listed'}`,
      `- **Fiscal year:** ${estimates.fiscal_year ?? 'Not listed'}`,
    );
  }

  const codes = (entries: OpportunityRecordValue['applicant_types']) =>
    entries.length === 0
      ? 'None listed'
      : entries
          .map(
            (entry) => `\`${inline(entry.code)}\`${entry.label ? ` ${inline(entry.label)}` : ''}`,
          )
          .join('; ');
  lines.push('', '### Eligibility', `**Applicant types:** ${codes(record.applicant_types)}`);
  if (record.eligibility_narrative) {
    lines.push(
      `**Eligibility narrative${record.eligibility_narrative_truncated ? ' (truncated at 6,000 characters)' : ''}:**`,
      blockquote(record.eligibility_narrative),
    );
  } else {
    lines.push('No additional eligibility text listed; see the attachments.');
  }

  lines.push(
    '',
    '### Funding type',
    `**Funding instruments:** ${codes(record.funding_instruments)}`,
    `**Funding categories:** ${codes(record.funding_categories)}`,
  );
  if (record.funding_category_explanation) {
    lines.push(
      `**Funding category explanation${record.funding_category_explanation_truncated ? ' (truncated at 2,000 characters)' : ''}:**`,
      blockquote(record.funding_category_explanation),
    );
  }
  lines.push(
    `**Assistance listings:** ${
      record.assistance_listings.length === 0
        ? 'None listed'
        : record.assistance_listings
            .map(
              (aln) =>
                `${inline(aln.number)}${aln.program_title ? ` ${inline(aln.program_title)}` : ''}`,
            )
            .join('; ')
    }`,
  );

  if (record.description) {
    lines.push(
      '',
      `### Description${record.description_truncated ? ' (truncated at 12,000 characters)' : ''}`,
      blockquote(record.description),
    );
  }

  const contact = record.agency_contact;
  lines.push('', '### Agency contact');
  if (contact) {
    if (contact.name) lines.push(`**Name:** ${inline(contact.name)}`);
    if (contact.email) lines.push(`**Email:** ${inline(contact.email)}`);
    if (contact.phone) lines.push(`**Phone:** ${inline(contact.phone)}`);
    if (contact.details) lines.push('**Details:**', blockquote(contact.details));
  } else {
    lines.push('None listed.');
  }
  if (record.additional_info_url || record.additional_info_label) {
    lines.push(
      `**Additional information:** ${[record.additional_info_label && inline(record.additional_info_label), record.additional_info_url && `<${inline(record.additional_info_url)}>`].filter(Boolean).join(' ')}`,
    );
  }

  lines.push('', `### Attachments (${record.attachments.length} of ${record.attachment_count})`);
  if (record.attachments.length > 0) {
    lines.push(
      '| ID | File | Folder | Type | Size (bytes) | Description | Download |',
      '|:---|:---|:---|:---|:---|:---|:---|',
    );
    for (const file of record.attachments) {
      lines.push(
        `| ${file.attachment_id} | ${file.file_name ? tableCell(file.file_name) : 'Not listed'} | ${file.folder_type ? tableCell(file.folder_type) : ''} | ${file.mime_type ? tableCell(file.mime_type) : ''} | ${file.size_in_bytes ?? ''} | ${file.description ? tableCell(file.description) : ''} | ${file.download_url} |`,
      );
    }
  }

  lines.push(
    '',
    `### Application packages (${record.application_packages.length} of ${record.application_package_count} open; ${record.closed_package_count} closed)`,
  );
  for (const pkg of record.application_packages) {
    const details = [
      pkg.competition_id && `competition \`${inline(pkg.competition_id)}\``,
      pkg.competition_title && inline(pkg.competition_title),
      pkg.opening_date && `opens ${pkg.opening_date}`,
      pkg.closing_date && `closes ${pkg.closing_date}`,
      pkg.electronic_required !== undefined &&
        `electronic submission ${pkg.electronic_required ? 'required' : 'not required'}`,
    ].filter(Boolean);
    lines.push(
      `- \`${inline(pkg.package_id)}\`${details.length > 0 ? `: ${details.join(', ')}` : ''}`,
    );
  }

  if (record.related_opportunity_count > 0) {
    lines.push(
      '',
      `### Related opportunities (${record.related_opportunities.length} of ${record.related_opportunity_count})`,
    );
    for (const related of record.related_opportunities) {
      const details = [
        related.opportunity_number && `\`${inline(related.opportunity_number)}\``,
        related.title && inline(related.title),
        related.agency_code && `\`${inline(related.agency_code)}\``,
        related.posted_date && `posted ${related.posted_date}`,
        related.close_date && `closes ${related.close_date}`,
        related.note && `note: ${inline(related.note)}`,
      ].filter(Boolean);
      lines.push(
        `- id ${related.opportunity_id}${details.length > 0 ? `: ${details.join(', ')}` : ''}`,
      );
    }
  }
  return lines;
}

export const grantsgovGetOpportunity = tool('grantsgov_get_opportunity', {
  title: 'Get Grants.gov Opportunity',
  description:
    'Read the full Grants.gov record for up to 5 opportunities, given numeric opportunity ids or opportunity numbers: deadline and its explanation, award ceiling and floor, total funding, expected awards, cost sharing, eligible applicant types with the eligibility narrative, description, assistance listings, agency contact, NOFO attachments with download links, and application packages. An opportunity number is resolved across all statuses. A miss or an ambiguous number comes back as an unresolved entry with guidance, not an error.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    opportunity_ids: optionalList(OPPORTUNITY_ID_INPUT, MAX_IDENTIFIERS).describe(
      'Numeric Grants.gov ids (e.g. 363423, or "363423" as search rows emit them), from grantsgov_search_opportunities opportunity_id. Up to 5 combined with opportunity_numbers.',
    ),
    opportunity_numbers: optionalList(OPPORTUNITY_NUMBER_INPUT, MAX_IDENTIFIERS).describe(
      'Agency-assigned opportunity numbers (e.g. HRSA-27-005), matched exactly and case-insensitively across all statuses; one pair of surrounding double quotes is removed. A number shared by several opportunities comes back as ambiguous with candidates. Up to 5 combined with opportunity_ids.',
    ),
  }),

  output: z.object({
    opportunities: z.array(OpportunityRecord).describe('Records found, in input order.'),
    unresolved: z
      .array(UnresolvedEntry)
      .describe('Inputs that did not resolve to exactly one record. Empty when all resolved.'),
  }),

  enrichment: {
    notice: z.string().optional().describe('Summary of unresolved inputs and what to call next.'),
  },

  errors: [
    {
      reason: 'no_identifiers',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both opportunity_ids and opportunity_numbers are empty or unset.',
      recovery:
        'Pass opportunity_ids from grantsgov_search_opportunities rows, or opportunity_numbers such as HRSA-27-005.',
    },
    {
      reason: 'too_many_identifiers',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than 5 ids and numbers combined after de-duplication.',
      recovery:
        'Request at most 5 opportunities per call; split the list across several grantsgov_get_opportunity calls.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Grants.gov did not respond, or returned a 5xx, a non-JSON body, a non-zero errorcode, or a backend-unavailable message, after retries.',
      recovery:
        'Grants.gov is not responding; wait a minute and call grantsgov_get_opportunity again.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Grants.gov answered HTTP 429 (rate limited) through every retry, or asked for a wait longer than the retry budget.',
      recovery:
        'Grants.gov is rate limiting requests; wait the retryAfter interval (or a minute) and call grantsgov_get_opportunity again.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_route_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Grants.gov answered HTTP 403 Missing Authentication Token on the detail route, or on the search route used to resolve opportunity numbers: the route no longer exists at the gateway.',
      recovery:
        'A Grants.gov API route is not answering; the legacy API may have been retired, so report this to the server maintainer.',
      retryable: false,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const ids = [...new Set(input.opportunity_ids ?? [])];
    const numbers: string[] = [];
    for (const number of input.opportunity_numbers ?? []) {
      if (!numbers.some((kept) => kept.toLowerCase() === number.toLowerCase()))
        numbers.push(number);
    }
    if (ids.length === 0 && numbers.length === 0) {
      throw ctx.fail(
        'no_identifiers',
        'Pass at least one opportunity id or opportunity number.',
        ctx.recoveryFor('no_identifiers'),
      );
    }
    if (ids.length + numbers.length > MAX_IDENTIFIERS) {
      throw ctx.fail(
        'too_many_identifiers',
        `${ids.length + numbers.length} opportunities were requested; the limit is ${MAX_IDENTIFIERS} per call.`,
        ctx.recoveryFor('too_many_identifiers'),
      );
    }

    const service = getGrantsGovService();
    const resolutions: NumberResolution[] = await Promise.all(
      numbers.map((number) => service.resolveNumber(number, ctx)),
    );
    const toFetch = [
      ...new Set([
        ...ids,
        ...resolutions.flatMap((resolution) =>
          resolution.kind === 'unique' ? [resolution.id] : [],
        ),
      ]),
    ];
    const fetched = new Map<number, FetchResult>(
      await Promise.all(
        toFetch.map(async (id) => [id, await service.fetchOpportunity(id, ctx)] as const),
      ),
    );

    const today = todayET();
    const opportunities: OpportunityRecordValue[] = [];
    const included = new Set<number>();
    const unresolved: Unresolved[] = [];
    const include = (id: number) => {
      const result = fetched.get(id);
      if (result?.kind !== 'found') return false;
      if (!included.has(id)) {
        included.add(id);
        opportunities.push(toRecord(result.record, today));
      }
      return true;
    };
    const numberNotFound = (number: string): Unresolved => ({
      input: number,
      input_kind: 'opportunity_number',
      outcome: 'not_found',
      guidance: `No opportunity numbered "${number}" in any status. Check the exact spelling and punctuation, or find it by full text: call grantsgov_search_opportunities with keyword "${number}", double quotes included, and statuses forecasted, posted, closed, and archived.`,
    });

    for (const id of ids) {
      if (!include(id)) {
        unresolved.push({
          input: String(id),
          input_kind: 'opportunity_id',
          outcome: 'not_found',
          guidance: `No opportunity with id ${id}. Ids come from grantsgov_search_opportunities rows (opportunity_id); search there to find the record.`,
        });
      }
    }
    for (const [index, number] of numbers.entries()) {
      const resolution = resolutions[index];
      if (resolution?.kind === 'unique') {
        if (!include(resolution.id)) unresolved.push(numberNotFound(number));
      } else if (resolution?.kind === 'ambiguous') {
        unresolved.push({
          input: number,
          input_kind: 'opportunity_number',
          outcome: 'ambiguous',
          candidates: resolution.candidates.map(toCandidate),
          guidance: `Opportunity number "${number}" matches ${resolution.candidates.length} opportunities; call grantsgov_get_opportunity with opportunity_ids set to the one you want.`,
        });
      } else {
        unresolved.push(numberNotFound(number));
      }
    }

    if (unresolved.length > 0) {
      const summary = unresolved
        .map((entry) =>
          entry.outcome === 'ambiguous'
            ? `"${entry.input}" is ambiguous (${entry.candidates?.length ?? 0} matches)`
            : `${entry.input_kind === 'opportunity_id' ? 'id ' : ''}"${entry.input}" was not found`,
        )
        .join('; ');
      ctx.enrich.notice(
        `${unresolved.length} of ${ids.length + numbers.length} inputs did not resolve to one record: ${summary}. Each unresolved entry carries the next call to make.`,
      );
    }

    ctx.log.info('Fetched Grants.gov opportunities', {
      requested: ids.length + numbers.length,
      found: opportunities.length,
      unresolved: unresolved.length,
    });
    return { opportunities, unresolved };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const record of result.opportunities) lines.push(...renderRecord(record), '');
    if (result.opportunities.length === 0) lines.push('No opportunity records resolved.', '');
    if (result.unresolved.length > 0) {
      lines.push('## Unresolved inputs');
      for (const entry of result.unresolved) {
        lines.push(
          `- \`${inline(entry.input)}\` (${entry.input_kind}): ${entry.outcome}. ${inline(entry.guidance)}`,
        );
        for (const candidate of entry.candidates ?? []) {
          lines.push(
            `  - id ${candidate.opportunity_id}: \`${inline(candidate.opportunity_number)}\` ${inline(candidate.title)} · ${[candidate.agency_name && inline(candidate.agency_name), candidate.agency_code && `\`${inline(candidate.agency_code)}\``].filter(Boolean).join(' ') || 'agency not listed'} · ${candidate.status}${candidate.open_date ? ` · posted ${candidate.open_date}` : ''}${candidate.close_date ? ` · closes ${candidate.close_date}` : ''}`,
          );
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
