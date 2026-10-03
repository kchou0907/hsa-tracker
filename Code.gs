const SHEETS = {
  EXPENSES: 'Expenses',
  REIMBURSEMENTS: 'Reimbursements',
  ITEMS: 'ReimbursementItems',
  SETTINGS: 'Settings',
};

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('HSA Receipt Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function getDashboardData() {
  const expenses = getAvailableExpenses_();
  const availableCents = expenses.reduce((sum, e) => sum + e.remainingCents, 0);

  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.EXPENSES);
  const lastRow = sheet.getLastRow();
  let recent = [];

  if (lastRow > 1) {
    const start = Math.max(2, lastRow - 9);
    const rows = sheet.getRange(start, 1, lastRow - start + 1, 14).getValues();
    recent = rows.reverse().map(row => ({
      id: row[0],
      date: formatDate_(row[1]),
      amountCents: Number(row[9] || 0),
      remainingCents: Number(row[11] || 0),
      provider: row[3] || '',
      label: row[4] || '',
      receiptUrl: row[7] || '',
      status: row[12] || '',
    }));
  }

  return {
    availableCents,
    availableCount: expenses.length,
    recent,
  };
}

function saveReceipt(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    if (!payload) throw new Error('Missing receipt data.');

    const amountCents = dollarsToCents_(payload.amount);
    if (amountCents <= 0) throw new Error('Amount must be greater than $0.');

    const expenseDate = parseDate_(payload.expenseDate);
    if (!expenseDate) throw new Error('Please enter a valid expense date.');

    if (!payload.imageBase64) throw new Error('Please attach a receipt photo.');

    const mimeType = payload.mimeType || 'image/jpeg';
    const originalName = sanitizeFileName_(payload.fileName || 'receipt.jpg');
    const bytes = Utilities.base64Decode(payload.imageBase64);
    const blob = Utilities.newBlob(bytes, mimeType, originalName);

    const expenseId = makeId_('EXP');
    const folder = getReceiptFolder_();
    const dateText = Utilities.formatDate(expenseDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const descriptor = sanitizeFileName_(
      payload.provider || payload.label || originalName.replace(/\.[^.]+$/, '') || 'receipt'
    );
    const extension = extensionForMime_(mimeType);
    blob.setName(`${expenseId}_${dateText}_${descriptor}.${extension}`);

    const file = folder.createFile(blob);
    const uploadedAt = new Date();

    const row = [
      expenseId,
      expenseDate,
      amountCents / 100,
      String(payload.provider || '').trim(),
      String(payload.label || '').trim(),
      String(payload.notes || '').trim(),
      file.getId(),
      file.getUrl(),
      uploadedAt,
      amountCents,
      0,
      amountCents,
      'AVAILABLE',
      '',
    ];

    const sheet = getSpreadsheet_().getSheetByName(SHEETS.EXPENSES);
    sheet.appendRow(row);

    return {
      ok: true,
      expenseId,
      receiptUrl: file.getUrl(),
      availableCents: getAvailableExpenses_().reduce((sum, e) => sum + e.remainingCents, 0),
    };
  } finally {
    lock.releaseLock();
  }
}

function findMatches(requestedAmount) {
  const targetCents = dollarsToCents_(requestedAmount);
  if (targetCents <= 0) throw new Error('Enter an amount greater than $0.');

  const expenses = getAvailableExpenses_();
  if (!expenses.length) return [];

  const settings = getSettings_();
  const optionCount = Math.max(1, Math.min(5, Number(settings.MATCH_OPTION_COUNT || 3)));

  // Sorting larger receipts first tends to produce combinations with fewer receipts
  // when multiple combinations reach the same total.
  const items = expenses.slice().sort((a, b) => {
    if (b.remainingCents !== a.remainingCents) return b.remainingCents - a.remainingCents;
    return new Date(a.date).getTime() - new Date(b.date).getTime();
  });

  const largest = Math.max(...items.map(x => x.remainingCents));
  const maxSum = targetCents + largest;

  // Exact cent-level subset sum for normal personal-use searches.
  // Larger searches use the bounded fallback below to keep the web UI responsive.
  if (maxSum <= 1_000_000 && items.length <= 200) {
    return exactMatches_(items, targetCents, optionCount);
  }

  // For unusually large targets/search spaces, use several deterministic greedy
  // passes so the web app remains responsive instead of timing out.
  return heuristicMatches_(items, targetCents, optionCount);
}

function redeemMatch(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    if (!payload || !Array.isArray(payload.expenseIds) || !payload.expenseIds.length) {
      throw new Error('No receipts selected.');
    }

    const requestedCents = Number(payload.requestedCents || 0);
    const wantedIds = new Set(payload.expenseIds);

    const ss = getSpreadsheet_();
    const expensesSheet = ss.getSheetByName(SHEETS.EXPENSES);
    const lastRow = expensesSheet.getLastRow();
    if (lastRow < 2) throw new Error('No expenses found.');

    const rows = expensesSheet.getRange(2, 1, lastRow - 1, 14).getValues();

    const selected = [];
    rows.forEach((row, idx) => {
      const id = String(row[0] || '');
      if (!wantedIds.has(id)) return;

      const remainingCents = Number(row[11] || 0);
      const status = String(row[12] || '');
      if (remainingCents <= 0 || status !== 'AVAILABLE') {
        throw new Error(`Receipt ${id} is no longer available. Refresh and try again.`);
      }

      selected.push({
        sheetRow: idx + 2,
        id,
        remainingCents,
        receiptUrl: row[7] || '',
        originalCents: Number(row[9] || 0),
        reimbursedCents: Number(row[10] || 0),
      });
    });

    if (selected.length !== wantedIds.size) {
      throw new Error('One or more selected receipts could not be found.');
    }

    const matchedCents = selected.reduce((sum, x) => sum + x.remainingCents, 0);
    const reimbursementId = makeId_('RMB');
    const now = new Date();

    // Append the reimbursement summary.
    ss.getSheetByName(SHEETS.REIMBURSEMENTS).appendRow([
      reimbursementId,
      now,
      requestedCents / 100,
      matchedCents / 100,
      (matchedCents - requestedCents) / 100,
      requestedCents,
      matchedCents,
      String(payload.notes || '').trim(),
      now,
    ]);

    // Append immutable reimbursement-to-receipt links.
    const itemRows = selected.map(x => [
      reimbursementId,
      x.id,
      x.remainingCents / 100,
      x.remainingCents,
      x.receiptUrl,
    ]);
    const itemSheet = ss.getSheetByName(SHEETS.ITEMS);
    const itemStart = itemSheet.getLastRow() + 1;
    itemSheet.getRange(itemStart, 1, itemRows.length, 5).setValues(itemRows);

    // Mark each expense's remaining amount as reimbursed, preserving the row.
    selected.forEach(x => {
      const newReimbursed = x.reimbursedCents + x.remainingCents;
      expensesSheet.getRange(x.sheetRow, 11, 1, 4).setValues([[
        newReimbursed,
        0,
        'REIMBURSED',
        reimbursementId,
      ]]);
    });

    SpreadsheetApp.flush();

    return {
      ok: true,
      reimbursementId,
      requestedCents,
      matchedCents,
      differenceCents: matchedCents - requestedCents,
    };
  } finally {
    lock.releaseLock();
  }
}

function exactMatches_(items, targetCents, optionCount) {
  const largest = Math.max(...items.map(x => x.remainingCents));
  const maxSum = targetCents + largest;

  // -2 = unreachable, -1 = origin (sum 0), >=0 = item index used last.
  const prevItem = new Int32Array(maxSum + 1);
  prevItem.fill(-2);
  prevItem[0] = -1;

  let currentMax = 0;
  for (let i = 0; i < items.length; i++) {
    const amount = items[i].remainingCents;
    const upper = Math.min(currentMax, maxSum - amount);

    for (let sum = upper; sum >= 0; sum--) {
      if (prevItem[sum] === -2) continue;
      const next = sum + amount;
      if (prevItem[next] !== -2) continue; // keep first stable predecessor chain
      prevItem[next] = i;
    }

    currentMax = Math.min(maxSum, currentMax + amount);
  }

  const foundSums = [];
  for (let delta = 0; foundSums.length < optionCount && delta <= maxSum; delta++) {
    // Equal-distance tie: prefer at/above requested amount.
    const over = targetCents + delta;
    if (over > 0 && over <= maxSum && prevItem[over] !== -2 && !foundSums.includes(over)) {
      foundSums.push(over);
      if (foundSums.length >= optionCount) break;
    }

    if (delta > 0) {
      const under = targetCents - delta;
      if (under > 0 && prevItem[under] !== -2 && !foundSums.includes(under)) {
        foundSums.push(under);
      }
    }
  }

  return foundSums.map(sum => {
    const selected = [];
    let current = sum;

    while (current > 0) {
      const itemIndex = prevItem[current];
      if (itemIndex < 0) throw new Error('Could not reconstruct receipt match.');
      const item = items[itemIndex];
      selected.push(item);
      current -= item.remainingCents;
    }

    return matchResponse_(selected, targetCents, false);
  });
}

function heuristicMatches_(items, targetCents, optionCount) {
  const candidates = [];

  const orderings = [
    items.slice().sort((a, b) => b.remainingCents - a.remainingCents),
    items.slice().sort((a, b) => a.remainingCents - b.remainingCents),
    items.slice().sort((a, b) => new Date(a.date) - new Date(b.date)),
    items.slice().sort((a, b) =>
      Math.abs(targetCents - a.remainingCents) - Math.abs(targetCents - b.remainingCents)
    ),
  ];

  orderings.forEach(order => {
    for (let skip = 0; skip < Math.min(12, order.length); skip++) {
      let total = 0;
      const selected = [];

      for (let i = 0; i < order.length; i++) {
        if (i === skip) continue;
        const item = order[i];
        const next = total + item.remainingCents;

        if (
          next <= targetCents ||
          Math.abs(next - targetCents) < Math.abs(total - targetCents)
        ) {
          selected.push(item);
          total = next;
        }
      }

      if (selected.length) candidates.push(matchResponse_(selected, targetCents, true));
    }
  });

  // Add best single-receipt options too.
  items.slice()
    .sort((a, b) =>
      Math.abs(a.remainingCents - targetCents) - Math.abs(b.remainingCents - targetCents)
    )
    .slice(0, 8)
    .forEach(item => candidates.push(matchResponse_([item], targetCents, true)));

  const seen = new Set();
  return candidates
    .sort(compareMatches_)
    .filter(c => {
      const key = c.expenseIds.slice().sort().join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, optionCount);
}

function matchResponse_(selected, targetCents, approximate) {
  const totalCents = selected.reduce((sum, x) => sum + x.remainingCents, 0);

  return {
    totalCents,
    requestedCents: targetCents,
    differenceCents: totalCents - targetCents,
    approximate,
    expenseIds: selected.map(x => x.id),
    receipts: selected.map(x => ({
      id: x.id,
      date: formatDate_(x.date),
      amountCents: x.remainingCents,
      provider: x.provider || '',
      label: x.label || '',
      receiptUrl: x.receiptUrl || '',
    })),
  };
}

function compareMatches_(a, b) {
  const da = Math.abs(a.differenceCents);
  const db = Math.abs(b.differenceCents);
  if (da !== db) return da - db;

  const aOver = a.differenceCents >= 0;
  const bOver = b.differenceCents >= 0;
  if (aOver !== bOver) return aOver ? -1 : 1;

  if (a.receipts.length !== b.receipts.length) {
    return a.receipts.length - b.receipts.length;
  }

  return a.totalCents - b.totalCents;
}

function getAvailableExpenses_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.EXPENSES);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const rows = sheet.getRange(2, 1, lastRow - 1, 14).getValues();

  return rows
    .map((row, index) => ({
      row: index + 2,
      id: String(row[0] || ''),
      date: row[1],
      amountCents: Number(row[9] || 0),
      reimbursedCents: Number(row[10] || 0),
      remainingCents: Number(row[11] || 0),
      provider: String(row[3] || ''),
      label: String(row[4] || ''),
      receiptUrl: String(row[7] || ''),
      status: String(row[12] || ''),
    }))
    .filter(x => x.id && x.remainingCents > 0 && x.status === 'AVAILABLE');
}

function getSettings_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.SETTINGS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  return values.reduce((out, row) => {
    if (row[0]) out[String(row[0])] = row[1];
    return out;
  }, {});
}

function getReceiptFolder_() {
  const folderId = String(getSettings_().RECEIPT_FOLDER_ID || '').trim();
  if (!folderId) throw new Error('RECEIPT_FOLDER_ID is not configured.');
  return DriveApp.getFolderById(folderId);
}

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('Open this script from the HSA ledger spreadsheet, then run setup() again.');
  }

  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  return { spreadsheetId: ss.getId(), spreadsheetUrl: ss.getUrl() };
}

function getSpreadsheet_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('SPREADSHEET_ID is not configured. Run setup() once from the Apps Script editor.');
  }
  return SpreadsheetApp.openById(spreadsheetId);
}

function dollarsToCents_(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('Invalid dollar amount.');
  return Math.round((n + Number.EPSILON) * 100);
}

function parseDate_(yyyyMmDd) {
  if (!yyyyMmDd) return null;
  const parts = String(yyyyMmDd).split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
}

function formatDate_(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function makeId_(prefix) {
  return `${prefix}-${Utilities.getUuid().slice(0, 8).toUpperCase()}`;
}

function sanitizeFileName_(name) {
  return String(name || 'receipt')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'receipt';
}

function extensionForMime_(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('heic')) return 'heic';
  if (m.includes('heif')) return 'heif';
  return 'jpg';
}