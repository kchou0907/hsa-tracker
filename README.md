
# HSA Receipt Tracker (Apps Script)

A mobile-friendly Google Apps Script web app for long-term HSA receipt storage and reimbursement tracking.

This version supports:

- receipt photo upload from your phone
- HSA-eligible amount / date / label / notes
- Google Drive storage for original files
- Google Sheets ledger + audit trail
- reimbursement matching by closest total
- immutable reimbursement history
- **supporting documents** like:
  - Letters of Medical Necessity
  - Prescriptions
  - Explanation of Benefits
  - Invoices
  - Other supporting files

---

## Why this exists

A common HSA strategy is:

1. pay qualified medical expenses out of pocket
2. keep the receipts for years
3. let the HSA grow tax-free
4. reimburse yourself later

This app helps you keep the receipt ledger organized while preserving an audit trail.

---

## Architecture

```text
Phone / Browser
      ↓
Google Apps Script Web App
      ├── Google Sheets ledger
      └── Google Drive files
            ├── Receipts
            └── Supporting Documents
```

Sheets used by the app:

- `Expenses`
- `Reimbursements`
- `ReimbursementItems`
- `Settings`
- `Documents`
- `ExpenseDocuments`

The `Documents` + `ExpenseDocuments` pair lets one expense have multiple supporting documents and keeps the schema flexible for future reuse.

---

## Files in this repo

- `Code.gs` — server-side Apps Script logic
- `Index.html` — mobile web UI
- `appsscript.json` — Apps Script manifest
- `README.md`

---

## Setup

### 1. Create the spreadsheet

Create a blank Google Sheet. You can name it something like:

```text
HSA Receipt Ledger
```

Copy the spreadsheet ID from the URL:

```text
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
```

### 2. Open Apps Script

From that spreadsheet:

- `Extensions → Apps Script`

This is the easiest path because it gives the script an active spreadsheet context.

### 3. Add the project files

Replace the default files with:

- `Code.gs`
- `Index.html`
- `appsscript.json`

### 4. Run setup once

In the Apps Script editor, run:

```javascript
setup()
```

If you are using a standalone Apps Script project instead of one attached to a Sheet, run:

```javascript
setup('YOUR_SPREADSHEET_ID')
```

`setup()` will:

- remember the spreadsheet ID in Script Properties
- create any missing sheets
- add default settings rows
- create Drive folders automatically if they do not exist:
  - `Receipts`
  - `Supporting Documents`

If you are upgrading from the earlier version, `setup()` also acts as a schema migration and adds:

- `Documents`
- `ExpenseDocuments`
- `SUPPORTING_DOCS_FOLDER_ID`

### 5. Deploy the web app

- `Deploy → New deployment`
- Select **Web app**
- Recommended:
  - **Execute as:** Me
  - **Who has access:** Only myself (or the narrowest option available)

Approve the requested permissions.

### 6. Add to your phone home screen

Open the `/exec` URL on your phone and add it to your home screen.

---

## How it works

### Add receipt

You can:

- take a receipt photo directly from your phone camera
- enter amount / expense date / provider / label / notes
- optionally add one or more supporting documents

Each supporting document includes:

- document type
- file upload
- optional title
- optional description
- optional issue date
- optional expiration date

### Supporting document examples

Useful document types include:

- Letter of Medical Necessity
- Prescription
- Explanation of Benefits
- Invoice
- Other

### Reimburse

Enter the amount you want to reimburse.

The app supports **partial reimbursements**. If your unreimbursed eligible expenses total at least the requested amount, it can hit the target exactly by using whole receipt balances and, when necessary, only part of the final receipt.

Example:

```text
Requested reimbursement: $100

Receipt A remaining: $72  → apply $72
Receipt B remaining: $81  → apply $28

Receipt B remains available for $53 later.
```

If the total remaining across all eligible expenses is less than the request, the app allocates everything still available and shows the shortfall.

### Redeem / reimburse

When you mark a match reimbursed, the app:

- creates a reimbursement record
- creates reimbursement-to-expense rows
- marks the selected expense balances as reimbursed
- **does not delete anything**

This preserves the audit trail.

---

## Data model

### `Expenses`

One row per expense / receipt.

Important columns include:

- `Expense ID`
- `Amount`
- `Receipt URL`
- `Original Cents` — the HSA-eligible amount entered for the expense
- `Reimbursed Cents`
- `Remaining Cents`
- `Status` — `AVAILABLE`, `PARTIAL`, or `REIMBURSED`

### `Documents`

One row per supporting document.

Important columns include:

- `Document ID`
- `Type`
- `Title`
- `Description`
- `Issue Date`
- `Expiration Date`
- `File URL`

### `ExpenseDocuments`

Join table linking supporting documents to expenses.

This is what lets one expense have multiple supporting files.

---

## Notes

- This app **does not** initiate a withdrawal from your HSA provider. It only manages your documentation and ledger.
- Receipts and supporting documents are stored in Google Drive.
- Keep your reimbursement history. Do not delete old reimbursed rows.
- You should still use your own judgment on whether an expense is HSA-eligible.

---

## Performance

The runtime path is intentionally kept small:

- schema and Drive-folder checks run during `setup()`, not on every web request
- the dashboard uses one Sheets read on a cache miss and is cached for 5 minutes
- settings are cached for 1 hour
- supporting-document relationships are loaded only when you tap **View docs**
- receipt images are resized/compressed on the phone before upload
- multi-document metadata rows are written to Sheets in batches

Receipt uploads can still take a moment because Apps Script web apps send the file through the Apps Script runtime and Google Drive. A completely cold Apps Script invocation can also be slower than a warm one.

If you edit ledger rows manually in Google Sheets, the dashboard may show cached data for up to about 5 minutes. Normal writes through the web app invalidate the dashboard cache immediately.

## Suggested future improvements

- OCR for receipt autofill
- export reimbursement packet (selected receipts + supporting docs)
- expiration reminders for letters of medical necessity
- ability to reuse one supporting document across multiple expenses from the UI
- search / filter by provider, date, reimbursement status, or document type