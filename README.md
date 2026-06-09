# HSA Receipt Vault

A private, dependency-free browser app for tracking HSA-eligible receipts and finding the best set of unreimbursed receipts for a target withdrawal.

## Run it

Serve the folder with any local web server:

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080`.

Receipt metadata is stored in browser `localStorage`. Use **Settings > Export ledger** to create a JSON backup.

## Run with Docker

```powershell
docker build -t hsa-receipt-vault .
docker run --rm -p 8080:80 hsa-receipt-vault
```

Then open `http://localhost:8080`.

## Google Drive setup

1. Create or choose a folder in Google Drive.
2. In [Google Cloud Console](https://console.cloud.google.com/), enable the Google Drive API.
3. Create an OAuth 2.0 Client ID for a Web application.
4. Add your app origin, such as `http://localhost:8080`, under **Authorized JavaScript origins**.
5. On the OAuth consent screen, leave the app in **Testing** mode and add your Google account under **Test users**.
6. In the app's settings, paste the Drive folder link and OAuth client ID.

The app requests the Google Drive scope so it can upload into the folder whose link or ID you provide. It does not browse or list your Drive contents, and it stores the temporary access token only for the current browser session.

### Google Error 403: access_denied

If Google says the app is still being tested and only developer-approved testers can access it:

1. Open the same Google Cloud project used to create the OAuth client ID.
2. Go to **Google Auth Platform > Audience**.
3. Under **Test users**, add the exact Google account you use to sign in.
4. Save, wait a few minutes, and reconnect from the app.

Keeping the OAuth app in Testing mode is appropriate for a personal app. Publishing an app that requests broad Google Drive access may require Google's verification process.

## Notes

- Receipt amounts, providers, notes, and reimbursement status stay in the browser.
- Attached receipt files upload directly to the configured Google Drive folder.
- Deleting a ledger entry does not delete its linked Drive file.
- The reimbursement matcher finds an exact subset when possible, otherwise the closest subset based on your selected preference.
