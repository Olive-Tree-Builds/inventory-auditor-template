# Historical-data import

The historical upload is deliberately simple: one row represents the quantity of one product sold at one location on one local calendar date. There are no timestamps in the source template.

The app validates the entire file and shows a guided preview before it saves any sales rows. Select one brand first; every row in that file belongs to that brand.

## Required columns

Use these four headers exactly, in this order:

| Column | Required value | Example |
| --- | --- | --- |
| `date` | Local calendar date in `YYYY-MM-DD` format | `2026-07-15` |
| `product` | Product label from the source system | `Classic Croissant` |
| `location` | Location label, configured name, remembered alias, or unique import code | `King Street` |
| `quantity` | Whole number of units sold, zero or greater | `128` |

Example:

```csv
date,product,location,quantity
2026-07-15,Classic Croissant,King Street,128
2026-07-15,Blueberry Muffin,King Street,74
2026-07-15,Classic Croissant,Harbourfront,116
```

## Preparing a file

1. Create the brand, then open Configuration → Historical Data and select it.
2. Download the Excel template and keep the header row unchanged.
3. Use one local date per row. Do not add a time or timezone to the date cell.
4. Put the location label supplied by the source system in `location`. The first upload will ask the administrator to create or match any label it does not recognize.
5. Use stable product labels where possible. The preview automatically discovers new products and lets an administrator map a variation to an existing product instead of creating a duplicate.
6. Remove totals, blank separator rows, notes, formulas, merged cells, and extra columns.
7. Save a clean `.xlsx` or `.csv` file and upload it for validation.

## Validation behavior

Before saving anything, the importer shows the row count, date range, selected brand, locations, products, and exactly how many rows are new, unchanged, or corrections. It also identifies products that will be created automatically. It rejects the whole import when:

- a required header is missing, renamed, or duplicated
- a date is invalid or contains a timestamp
- a date is after the current local business date at that row's configured location
- a product or location is blank
- a location is unresolved, ambiguous, archived, or outside the selected brand
- quantity is blank, negative, fractional, or not numeric
- the file contains unsupported content or exceeds the configured size or row limit

Duplicate rows inside one file are rejected after all product and location mappings are applied. Re-importing the exact same file for the same brand is idempotent.

## New locations and products

Products are brand-scoped and normally require no manual setup. An unseen product defaults to **Create new product**. The administrator can instead map its source label to an existing product; that alias is remembered for later files. The importer never fuzzy-merges similar spellings without confirmation.

An unseen location cannot be created from its name alone. The guided location card requires a unique import code, full street address, country, and IANA timezone, or lets the administrator map the label to an existing active location. Confirmed source labels are remembered for future imports. Newly created locations are assigned to the administrator who created them.

Nothing from the spreadsheet is saved while any location remains unresolved.

## Repeat uploads and corrections

The canonical business fact is one complete daily total for one selected brand, location, and product. Later files follow these rules:

- a new date, location, or product combination is inserted;
- an identical existing quantity is unchanged and does not create a revision;
- a different quantity for the same date, location, and product is shown as a correction, then replaces that one total after confirmation;
- rows omitted from a later file remain untouched;
- the exact same file is reported as already imported and is not duplicated.

Quantities are never summed during re-import because that would double-count a complete daily total. Transaction-level exports must be aggregated to one daily row before upload.

## Dates and locations

The `date` value is the business date at the location. Today is allowed; a future date is not. Each configured location separately stores its timezone, and the importer checks future dates against that location's current local calendar date rather than the app server's UTC date. If a source system exports UTC timestamps, convert them to the location's local date before creating this file.

## After a successful import

The app stores an immutable import record with the administrator, selected brand, time, source filename, checksum, date range, row count, and inserted/unchanged/corrected result. Corrections retain the prior quantity in private revision history. Historical dashboards aggregate the saved quantities by day, week, month, quarter, or year.

An import does not automatically send an email. Review the historical dashboard and the first cited forecast, send an internal test, and only then enable the email schedule.

## Privacy checklist

- Include only the four required business fields; no customer names, phone numbers, email addresses, payment details, or employee notes.
- Confirm the file belongs to the correct workspace before uploading.
- Keep the source export in the receiving organization's approved storage.
- Do not attach a customer data file to a GitHub issue or support message.
