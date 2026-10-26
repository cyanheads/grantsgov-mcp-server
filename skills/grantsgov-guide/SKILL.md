---
name: grantsgov-guide
description: Use grantsgov_* tools to shortlist federal funding, assess applicant fit, review deadlines, or prepare an application checklist. Load before recommending an opportunity as eligible, treating a date as a submission deadline, or claiming application requirements are complete.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use Grants.gov for federal funding opportunity discovery and review. The server is keyless and read-only. It provides announcement records, attachment links, and application package metadata; it does not read attachment contents or submit applications.

## Identifiers

An agency-assigned opportunity number can identify several records, including older opportunities. When number lookup returns candidates, match the agency and title to the user's target before requesting the selected numeric opportunity ID. Do not choose the first candidate solely because it shares the number.

An assistance listing number (ALN, formerly CFDA) identifies a funding program, rather than one solicitation. Keep it distinct from the opportunity number when carrying identifiers into other funding sources.

## Gates

- Before calling an opportunity eligible, read its complete relevant eligibility narrative and announcement material. An applicant-type match is a discovery candidate: the narrative can narrow the listed types, and detailed requirements may appear only in an attachment. If necessary material or applicant facts are missing, state what remains unresolved.
- Before presenting a submission deadline, check the record's lifecycle, date kind, forecast estimate, and agency deadline explanation. A forecast date remains an estimate. A placeholder date is not a fixed deadline, and a missing date does not establish that applications are accepted indefinitely. Do not infer a submission time from a date-only value.
- Before claiming a search or record review is complete, follow the returned continuations for the results and sections needed by the task. Preserve the search criteria while paging. Report any stated coverage limitation; an incomplete result cannot establish that no suitable opportunity exists.
- Before declaring an application checklist complete, inspect the relevant announcement and supporting attachments through a document-reading tool. Application package metadata does not supply the required forms. When attachment contents cannot be read, identify the unchecked material and provide its link.

## Workflows

### Build a funding shortlist

Translate the user's organization and project into applicant types and subject terms before searching. Use reference vocabulary for categorical filters rather than guessing codes. Include unrestricted opportunities when looking for everything the applicant may pursue; excluding them can hide valid candidates. An opportunity listing the applicant's type may also accept other types, so that match alone does not establish exclusive targeting.

Treat an empty narrow search as evidence about that query. Review its applied filters and keyword interpretation before concluding the topic has no funding. Use grouped alternatives for synonymous terms; consult the keyword syntax reference when constructing a more complex query.

Read promising records before ranking them against the user's constraints. Award amount and cost sharing require detail review because search cannot filter on them. Compare a requested award against the single-award range, rather than total program funding. Keep an omitted amount or matching requirement unknown; do not turn it into zero or no requirement.

### Review imminent deadlines

Use the closing-window search for posted opportunities. Review forecasts separately when the user also wants upcoming funding: their estimated deadlines are available on detail records, rather than search rows. Keep estimated, placeholder, and unlisted dates separate from confirmed fixed deadlines in the resulting shortlist.

For each recommended opportunity, read the deadline explanation and relevant announcement material before turning the listed date into an actionable submission schedule.

### Prepare an application review

For a known opportunity number, start with grantsgov_get_opportunity rather than a discovery search that may omit older statuses. Resolve ambiguity before evaluating the record.

Review eligibility, the description, funding range, cost sharing, deadline explanation, and relevant attachments. Use open package metadata to identify the available application packages, then read announcement material for forms and detailed requirements. Return a checklist tied to the selected opportunity and distinguish verified requirements from unresolved questions.
