# HSA Receipt Tracker

A lightweight HSA receipt ledger built with **Google Apps Script, Google Sheets, and Google Drive**.

The goal is to make the "save receipts now, reimburse yourself later" workflow easy enough to use from a phone:

1. Open the web app.
2. Take a picture of a qualified medical receipt.
3. Enter the amount, date, and an optional label/provider.
4. When you want to reimburse yourself, enter a target amount.
5. The app finds receipt combinations closest to that target and lets you mark one combination reimbursed.

The receipt files and reimbursement history are preserved rather than deleted, so the ledger keeps an audit trail of what has already been used.

> This project is a recordkeeping tool, not tax advice. You are responsible for determining whether an expense is HSA-eligible and for maintaining the records required for your tax situation.

## Features

- Mobile-friendly Apps Script web UI
- Direct camera / photo-library receipt upload on supported mobile browsers
- Receipt images stored in Google Drive
- Expense metadata stored in Google Sheets
- Dashboard showing total unreimbursed expenses
- Cent-accurate receipt matching for normal-sized searches
- Top matching reimbursement combinations
- Audit-preserving reimbursement history
- Receipt-to-reimbursement mapping to prevent accidental reuse
- Client-side image compression before upload
- Script locking around writes to avoid duplicate/concurrent ledger changes

For very large search spaces, the matcher falls back to a deterministic approximate search so the Apps Script request does not time out.

## Architecture

```text
Phone / browser
      |
      v
Apps Script Web App
  |             |
  v             v
Google Sheet   Google Drive
  ledger       receipt images
```

The spreadsheet acts as the database. The web app is only the UI/business-logic layer.

## Spreadsheet schema

Create a Google Sheet with these tabs and columns.

### `Expenses`

| Column | Purpose |
| --- | --- |
| Expense ID | Stable receipt identifier |
| Expense Date | Date the expense occurred |
| Amount | Original dollar amount |
| Provider | Optional merchant/provider |
| Label | Optional category/label |
| Notes | Free-form notes |
| Receipt File ID | Google Drive file ID |
| Receipt URL | Link to the saved receipt |
| Uploaded At | Upload timestamp |
| Original Cents | Original amount stored as integer cents |
| Reimbursed Cents | Amount already reimbursed |
| Remaining Cents | Amount still available |
| Status | `AVAILABLE` or `REIMBURSED` |
| Last Reimbursement ID | Most recent reimbursement using the expense |

### `Reimbursements`

| Column | Purpose |
| --- | --- |
| Reimbursement ID | Stable reimbursement identifier |
| Reimbursement Date | Date recorded |
| Requested Amount | Amount you wanted to cover |
| Matched Amount | Total of the selected receipts |
| Difference | Match minus requested amount |
| Requested Cents | Requested amount in integer cents |
| Matched Cents | Matched amount in integer cents |
| Notes | Optional notes |
| Created At | Creation timestamp |

### `ReimbursementItems`

| Column | Purpose |
| --- | --- |
| Reimbursement ID | Parent reimbursement |
| Expense ID | Receipt used |
| Applied Amount | Amount applied from that receipt |
| Applied Cents | Integer-cent amount |
| Receipt URL | Historical receipt link |

### `Settings`

| Key | Example | Purpose |
| --- | --- | --- |
| `RECEIPT_FOLDER_ID` | `1abc...` | Drive folder where images should be stored |
| `SCHEMA_VERSION` | `1` | Ledger schema version |
| `CURRENCY` | `USD` | Display currency |
| `MATCH_OPTION_COUNT` | `3` | Number of matches shown |
| `PREFER_OVER_TARGET` | `TRUE` | Reserved preference setting |

The app stores money internally as integer cents to avoid floating-point rounding problems.

## Setup

### 1. Create a receipt folder

Create a private folder in Google Drive for receipt images. Copy its folder ID from the URL and put it in the `Settings` sheet as `RECEIPT_FOLDER_ID`.

### 2. Create the ledger spreadsheet

Create the four tabs above and add the column headers exactly as shown. Keeping the spreadsheet and receipt folder private is recommended.

### 3. Add the Apps Script code

From the spreadsheet:

1. Open **Extensions -> Apps Script**.
2. Replace the default script with [`Code.gs`](./Code.gs).
3. Add a new HTML file named **`Index`** and paste in [`Index.html`](./Index.html).
4. If you manage the project with `clasp`, copy [`appsscript.json`](./appsscript.json) as well.

### 4. Initialize the script

Run `setup()` once from the Apps Script editor while the project is bound to the ledger spreadsheet.

This stores the spreadsheet ID in Apps Script **Script Properties**, so the public source code does not need to contain a personal Google Drive/Sheets ID.

Google will ask you to authorize the script the first time it accesses Sheets and Drive.

### 5. Deploy the web app

In Apps Script:

1. Select **Deploy -> New deployment**.
2. Choose **Web app**.
3. Set **Execute as** to **Me**.
4. Restrict access to yourself/the narrowest option appropriate for your account.
5. Deploy and approve the requested permissions.
6. Open the generated `/exec` URL.

On a phone, add that URL to your home screen for an app-like workflow.

## Usage

### Add a receipt

Open **Add receipt**, take or choose a photo, enter the amount/date, optionally add provider/label/notes, then save.

The browser resizes large images before uploading them to Drive. The ledger records the Drive file link along with the expense metadata.

### Find receipts for a reimbursement

Open **Reimburse**, enter the amount you want to cover, and choose **Find closest matches**.

For ordinary personal-use datasets, the server performs a subset-sum search in integer cents and returns the closest reachable totals. Equal-distance matches prefer a total at or above the requested amount.

### Mark a reimbursement

Choosing **Mark reimbursed** does **not** transfer money from an HSA account. It only updates this ledger.

The app:

1. Creates a reimbursement record.
2. Creates immutable mappings to the receipts used.
3. Marks those receipt balances as reimbursed.
4. Keeps the receipt images and original expense rows intact.

You still initiate the actual HSA distribution through your HSA provider separately.

## Branches

- `main` — current Google Apps Script / Sheets / Drive implementation
- `self-host-v0` — original self-hosted Docker/nginx implementation

## Security and privacy

Medical receipts can contain sensitive information. Recommended precautions:

- Keep the ledger spreadsheet and receipt folder private.
- Deploy the web app to the narrowest audience possible.
- Do not commit personal spreadsheet IDs, Drive folder IDs, receipt images, or exported ledger data to this repository.
- Review Google account sharing settings periodically.

## Limitations / roadmap

Potential next steps:

- OCR to pre-fill provider, date, and amount
- Partial reimbursement UI
- Exportable reimbursement/audit packet
- Receipt eligibility review states
- Better exact matching for extremely large ledgers
- Automated tests for the matching algorithm

## License

See [LICENSE](./LICENSE).