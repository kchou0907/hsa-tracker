// Deploy this as a SEPARATE standalone Apps Script web app.
//
// Deployment:
//   Execute as: Me
//   Who has access: Anyone
//
// Replace SOURCE_SPREADSHEET_ID if you want to maintain your own public
// installation counter. This sample increments Instructions!B21.
//
// Keep this service separate from the HSA tracker project. The endpoint is
// intentionally narrow: callers cannot choose a spreadsheet, sheet, range,
// or value.

const SOURCE_SPREADSHEET_ID = 'PASTE_SOURCE_SPREADSHEET_ID_HERE';
const COUNTER_SHEET = 'Instructions';
const COUNTER_CELL = 'B21';

function doGet() {
  return ContentService
    .createTextOutput('HSA Tracker install counter is running.')
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = SpreadsheetApp
      .openById(SOURCE_SPREADSHEET_ID)
      .getSheetByName(COUNTER_SHEET);

    if (!sheet) {
      throw new Error('Counter sheet not found.');
    }

    const cell = sheet.getRange(COUNTER_CELL);
    const currentCount = Number(cell.getValue()) || 0;
    cell.setValue(currentCount + 1);

    return ContentService
      .createTextOutput('OK')
      .setMimeType(ContentService.MimeType.TEXT);
  } finally {
    lock.releaseLock();
  }
}
