const PROP_KEYS = {
  SPREADSHEET_ID: 'SPREADSHEET_ID',
};

const CACHE_KEYS = {
  DASHBOARD: 'dashboard-v2',
  SETTINGS: 'settings-v2',
};

const DASHBOARD_CACHE_SECONDS = 300;
const SETTINGS_CACHE_SECONDS = 3600;

let spreadsheetHandle_ = null;

const SHEETS = {
  EXPENSES: 'Expenses',
  REIMBURSEMENTS: 'Reimbursements',
  ITEMS: 'ReimbursementItems',
  SETTINGS: 'Settings',
  DOCUMENTS: 'Documents',
  EXPENSE_DOCUMENTS: 'ExpenseDocuments',
};

const EXPENSE_HEADERS = [
  'Expense ID',
  'Expense Date',
  'Amount',
  'Provider',
  'Label',
  'Notes',
  'Receipt File ID',
  'Receipt URL',
  'Uploaded At',
  'Original Cents',
  'Reimbursed Cents',
  'Remaining Cents',
  'Status',
  'Last Reimbursement ID',
];

const REIMBURSEMENT_HEADERS = [
  'Reimbursement ID',
  'Reimbursement Date',
  'Requested Amount',
  'Matched Amount',
  'Difference',
  'Requested Cents',
  'Matched Cents',
  'Notes',
  'Created At',
];

const ITEM_HEADERS = [
  'Reimbursement ID',
  'Expense ID',
  'Applied Amount',
  'Applied Cents',
  'Receipt URL',
];

const SETTINGS_HEADERS = ['Key', 'Value', 'Notes'];

const DOCUMENT_HEADERS = [
  'Document ID',
  'Type',
  'Title',
  'Description',
  'Issue Date',
  'Expiration Date',
  'File ID',
  'File URL',
  'Mime Type',
  'Uploaded At',
];

const EXPENSE_DOCUMENT_HEADERS = [
  'Expense ID',
  'Document ID',
  'Relation Type',
  'Linked At',
];

function setup(spreadsheetId) {
  const props = PropertiesService.getScriptProperties();
  if (spreadsheetId) {
    props.setProperty(PROP_KEYS.SPREADSHEET_ID, spreadsheetId);
  } else if (!props.getProperty(PROP_KEYS.SPREADSHEET_ID)) {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (!active) {
      throw new Error('No spreadsheet is configured. Run setup("YOUR_SPREADSHEET_ID") once.');
    }
    props.setProperty(PROP_KEYS.SPREADSHEET_ID, active.getId());
  }

  ensureSchema_();
  const folderInfo = ensureFoldersConfigured_();
  invalidateRuntimeCaches_();
  getDashboardData();

  return {
    ok: true,
    spreadsheetId: getSpreadsheet_().getId(),
    folders: folderInfo,
  };
}

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('HSA Receipt Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function getAppBootstrap() {
  return {
    configured: true,
    dashboard: getDashboardData(),
  };
}

function getDashboardData() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEYS.DASHBOARD);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      // Ignore a malformed cache entry and rebuild it from the sheet.
    }
  }

  const dashboard = computeDashboardData_();
  cache.put(CACHE_KEYS.DASHBOARD, JSON.stringify(dashboard), DASHBOARD_CACHE_SECONDS);
  return dashboard;
}

function computeDashboardData_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.EXPENSES);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return { availableCents: 0, availableCount: 0, recent: [] };
  }

  // One sheet read supplies both the running total and recent-receipt list.
  // The old path read Expenses twice and ExpenseDocuments once on every launch.
  const rows = sheet.getRange(2, 1, lastRow - 1, EXPENSE_HEADERS.length).getValues();
  let availableCents = 0;
  let availableCount = 0;

  rows.forEach(function(row) {
    const remainingCents = Number(row[11] || 0);
    const status = String(row[12] || '');
    if (remainingCents > 0) {
      availableCents += remainingCents;
      availableCount += 1;
    }
  });

  const recent = rows.slice(-15).reverse().map(function(row) {
    const id = String(row[0] || '');
    return {
      id: id,
      date: formatDate_(row[1]),
      amountCents: Number(row[9] || 0),
      remainingCents: Number(row[11] || 0),
      provider: String(row[3] || ''),
      label: String(row[4] || ''),
      receiptUrl: String(row[7] || ''),
      status: String(row[12] || ''),
    };
  }).filter(function(x) { return x.id; });

  return {
    availableCents: availableCents,
    availableCount: availableCount,
    recent: recent,
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

    if (!payload.receipt || !payload.receipt.fileBase64) {
      throw new Error('Please attach a receipt or expense document.');
    }

    const expenseId = makeId_('EXP');
    const receiptFolder = getReceiptFolder_();
    const receipt = createStoredFile_({
      folder: receiptFolder,
      payload: payload.receipt,
      prefix: expenseId,
      date: expenseDate,
      descriptor: payload.provider || payload.label || 'receipt',
    });
    const uploadedAt = new Date();

    const row = [
      expenseId,
      expenseDate,
      amountCents / 100,
      String(payload.provider || '').trim(),
      String(payload.label || '').trim(),
      String(payload.notes || '').trim(),
      receipt.fileId,
      receipt.fileUrl,
      uploadedAt,
      amountCents,
      0,
      amountCents,
      'AVAILABLE',
      '',
    ];

    const ss = getSpreadsheet_();
    ss.getSheetByName(SHEETS.EXPENSES).appendRow(row);

    const documents = normalizeDocumentPayloads_(payload.documents || []);
    if (documents.length) {
      createAndLinkDocuments_(expenseId, documents);
    }

    invalidateDashboardCache_();

    return {
      ok: true,
      expenseId: expenseId,
      receiptUrl: receipt.fileUrl,
      amountCents: amountCents,
      documentCount: documents.length,
    };
  } finally {
    lock.releaseLock();
  }
}

function attachDocumentsToExpense(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    if (!payload || !payload.expenseId) throw new Error('Missing expense ID.');

    if (!expenseExists_(payload.expenseId)) {
      throw new Error('Expense not found.');
    }

    const documents = normalizeDocumentPayloads_(payload.documents || []);
    if (!documents.length) throw new Error('Please add at least one document.');

    const created = createAndLinkDocuments_(payload.expenseId, documents);

    return {
      ok: true,
      expenseId: payload.expenseId,
      createdCount: created.length,
      documents: created,
    };
  } finally {
    lock.releaseLock();
  }
}

function getExpenseDocuments(expenseId) {
  if (!expenseId) throw new Error('Missing expense ID.');

  const docSheet = getSpreadsheet_().getSheetByName(SHEETS.DOCUMENTS);
  const linkSheet = getSpreadsheet_().getSheetByName(SHEETS.EXPENSE_DOCUMENTS);

  const documentMap = {};
  const docLastRow = docSheet.getLastRow();
  if (docLastRow > 1) {
    const docs = docSheet.getRange(2, 1, docLastRow - 1, DOCUMENT_HEADERS.length).getValues();
    docs.forEach(function(row) {
      documentMap[String(row[0] || '')] = {
        id: String(row[0] || ''),
        type: String(row[1] || ''),
        title: String(row[2] || ''),
        description: String(row[3] || ''),
        issueDate: formatDate_(row[4]),
        expirationDate: formatDate_(row[5]),
        fileId: String(row[6] || ''),
        fileUrl: String(row[7] || ''),
        mimeType: String(row[8] || ''),
        uploadedAt: formatDateTime_(row[9]),
      };
    });
  }

  const items = [];
  const linkLastRow = linkSheet.getLastRow();
  if (linkLastRow > 1) {
    const links = linkSheet.getRange(2, 1, linkLastRow - 1, EXPENSE_DOCUMENT_HEADERS.length).getValues();
    links.forEach(function(row) {
      const linkedExpenseId = String(row[0] || '');
      const documentId = String(row[1] || '');
      if (linkedExpenseId !== expenseId) return;

      const doc = documentMap[documentId];
      if (!doc) return;

      items.push({
        expenseId: linkedExpenseId,
        documentId: documentId,
        relationType: String(row[2] || ''),
        linkedAt: formatDateTime_(row[3]),
        document: doc,
      });
    });
  }

  items.sort(function(a, b) {
    return String(b.linkedAt).localeCompare(String(a.linkedAt));
  });

  return items;
}

function findMatches(requestedAmount) {
  const targetCents = dollarsToCents_(requestedAmount);
  if (targetCents <= 0) throw new Error('Enter an amount greater than $0.');

  const expenses = getAvailableExpenses_();
  if (!expenses.length) return [];

  const settings = getSettings_();
  const optionCount = Math.max(1, Math.min(5, Number(settings.MATCH_OPTION_COUNT || 3)));

  // Partial reimbursement means we can hit the requested amount exactly whenever
  // total unreimbursed HSA-eligible expenses are at least the target. The final
  // receipt in a plan may be consumed only partially.
  const orderings = [
    expenses.slice().sort(function(a, b) {
      if (b.remainingCents !== a.remainingCents) return b.remainingCents - a.remainingCents;
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    }),
    expenses.slice().sort(function(a, b) {
      const dateDiff = new Date(a.date).getTime() - new Date(b.date).getTime();
      if (dateDiff !== 0) return dateDiff;
      return b.remainingCents - a.remainingCents;
    }),
    expenses.slice().sort(function(a, b) {
      const dateDiff = new Date(b.date).getTime() - new Date(a.date).getTime();
      if (dateDiff !== 0) return dateDiff;
      return b.remainingCents - a.remainingCents;
    }),
  ];

  const seen = new Set();
  const matches = [];

  orderings.forEach(function(order) {
    const match = buildAllocationMatch_(order, targetCents);
    if (!match || !match.allocations.length) return;

    const key = match.allocations
      .map(function(a) { return a.expenseId + ':' + a.appliedCents; })
      .join('|');

    if (seen.has(key)) return;
    seen.add(key);
    matches.push(match);
  });

  matches.sort(function(a, b) {
    if (a.differenceCents !== b.differenceCents) {
      return Math.abs(a.differenceCents) - Math.abs(b.differenceCents);
    }
    if (a.receipts.length !== b.receipts.length) {
      return a.receipts.length - b.receipts.length;
    }
    return 0;
  });

  return matches.slice(0, optionCount);
}

function buildAllocationMatch_(orderedExpenses, targetCents) {
  let stillNeeded = targetCents;
  const allocations = [];
  const receipts = [];

  for (let i = 0; i < orderedExpenses.length && stillNeeded > 0; i++) {
    const expense = orderedExpenses[i];
    const appliedCents = Math.min(expense.remainingCents, stillNeeded);
    if (appliedCents <= 0) continue;

    allocations.push({
      expenseId: expense.id,
      appliedCents: appliedCents,
    });

    receipts.push({
      id: expense.id,
      date: formatDate_(expense.date),
      appliedCents: appliedCents,
      availableCents: expense.remainingCents,
      provider: expense.provider || '',
      label: expense.label || '',
      receiptUrl: expense.receiptUrl || '',
      isPartial: appliedCents < expense.remainingCents,
    });

    stillNeeded -= appliedCents;
  }

  const matchedCents = targetCents - stillNeeded;

  return {
    totalCents: matchedCents,
    requestedCents: targetCents,
    differenceCents: matchedCents - targetCents,
    approximate: false,
    allocations: allocations,
    expenseIds: allocations.map(function(a) { return a.expenseId; }),
    receipts: receipts,
  };
}

function redeemMatch(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    if (!payload || !Array.isArray(payload.allocations) || !payload.allocations.length) {
      throw new Error('No reimbursement allocations selected.');
    }

    const requestedCents = Number(payload.requestedCents || 0);
    if (!Number.isInteger(requestedCents) || requestedCents <= 0) {
      throw new Error('Invalid requested reimbursement amount.');
    }

    const allocationMap = new Map();
    payload.allocations.forEach(function(allocation) {
      const expenseId = String(allocation.expenseId || '');
      const appliedCents = Number(allocation.appliedCents || 0);

      if (!expenseId || !Number.isInteger(appliedCents) || appliedCents <= 0) {
        throw new Error('Invalid reimbursement allocation.');
      }
      if (allocationMap.has(expenseId)) {
        throw new Error('Duplicate expense in reimbursement allocation.');
      }

      allocationMap.set(expenseId, appliedCents);
    });

    const ss = getSpreadsheet_();
    const expensesSheet = ss.getSheetByName(SHEETS.EXPENSES);
    const lastRow = expensesSheet.getLastRow();
    if (lastRow < 2) throw new Error('No expenses found.');

    const rows = expensesSheet.getRange(2, 1, lastRow - 1, EXPENSE_HEADERS.length).getValues();
    const selected = [];

    rows.forEach(function(row, idx) {
      const id = String(row[0] || '');
      if (!allocationMap.has(id)) return;

      const remainingCents = Number(row[11] || 0);
      const status = String(row[12] || '');
      const appliedCents = allocationMap.get(id);

      if (remainingCents <= 0 || status === 'REIMBURSED') {
        throw new Error('Receipt ' + id + ' is no longer available. Refresh and try again.');
      }
      if (appliedCents > remainingCents) {
        throw new Error('Receipt ' + id + ' no longer has enough unreimbursed balance. Refresh and try again.');
      }

      selected.push({
        sheetRow: idx + 2,
        id: id,
        appliedCents: appliedCents,
        remainingCents: remainingCents,
        receiptUrl: String(row[7] || ''),
        reimbursedCents: Number(row[10] || 0),
      });
    });

    if (selected.length !== allocationMap.size) {
      throw new Error('One or more selected receipts could not be found.');
    }

    const matchedCents = selected.reduce(function(sum, x) {
      return sum + x.appliedCents;
    }, 0);

    if (matchedCents > requestedCents) {
      throw new Error('Reimbursement allocations exceed the requested amount.');
    }

    const reimbursementId = makeId_('RMB');
    const now = new Date();

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

    const itemRows = selected.map(function(x) {
      return [
        reimbursementId,
        x.id,
        x.appliedCents / 100,
        x.appliedCents,
        x.receiptUrl,
      ];
    });

    const itemSheet = ss.getSheetByName(SHEETS.ITEMS);
    const itemStart = itemSheet.getLastRow() + 1;
    itemSheet.getRange(itemStart, 1, itemRows.length, ITEM_HEADERS.length).setValues(itemRows);

    selected.forEach(function(x) {
      const newReimbursed = x.reimbursedCents + x.appliedCents;
      const newRemaining = x.remainingCents - x.appliedCents;
      const newStatus = newRemaining === 0 ? 'REIMBURSED' : 'PARTIAL';

      expensesSheet.getRange(x.sheetRow, 11, 1, 4).setValues([[
        newReimbursed,
        newRemaining,
        newStatus,
        reimbursementId,
      ]]);
    });

    SpreadsheetApp.flush();
    invalidateDashboardCache_();

    return {
      ok: true,
      reimbursementId: reimbursementId,
      requestedCents: requestedCents,
      matchedCents: matchedCents,
      differenceCents: matchedCents - requestedCents,
    };
  } finally {
    lock.releaseLock();
  }
}

function exactMatches_(items, targetCents, optionCount) {
  const largest = Math.max.apply(null, items.map(function(x) { return x.remainingCents; }));
  const maxSum = targetCents + largest;

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
      if (prevItem[next] !== -2) continue;
      prevItem[next] = i;
    }

    currentMax = Math.min(maxSum, currentMax + amount);
  }

  const foundSums = [];
  for (let delta = 0; foundSums.length < optionCount && delta <= maxSum; delta++) {
    const over = targetCents + delta;
    if (over > 0 && over <= maxSum && prevItem[over] !== -2 && foundSums.indexOf(over) === -1) {
      foundSums.push(over);
      if (foundSums.length >= optionCount) break;
    }

    if (delta > 0) {
      const under = targetCents - delta;
      if (under > 0 && prevItem[under] !== -2 && foundSums.indexOf(under) === -1) {
        foundSums.push(under);
      }
    }
  }

  return foundSums.map(function(sum) {
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
    items.slice().sort(function(a, b) { return b.remainingCents - a.remainingCents; }),
    items.slice().sort(function(a, b) { return a.remainingCents - b.remainingCents; }),
    items.slice().sort(function(a, b) { return new Date(a.date) - new Date(b.date); }),
    items.slice().sort(function(a, b) {
      return Math.abs(targetCents - a.remainingCents) - Math.abs(targetCents - b.remainingCents);
    }),
  ];

  orderings.forEach(function(order) {
    for (let skip = 0; skip < Math.min(12, order.length); skip++) {
      let total = 0;
      const selected = [];

      for (let i = 0; i < order.length; i++) {
        if (i === skip) continue;
        const item = order[i];
        const next = total + item.remainingCents;

        if (next <= targetCents || Math.abs(next - targetCents) < Math.abs(total - targetCents)) {
          selected.push(item);
          total = next;
        }
      }

      if (selected.length) candidates.push(matchResponse_(selected, targetCents, true));
    }
  });

  items.slice()
    .sort(function(a, b) {
      return Math.abs(a.remainingCents - targetCents) - Math.abs(b.remainingCents - targetCents);
    })
    .slice(0, 8)
    .forEach(function(item) {
      candidates.push(matchResponse_([item], targetCents, true));
    });

  const seen = new Set();
  return candidates
    .sort(compareMatches_)
    .filter(function(c) {
      const key = c.expenseIds.slice().sort().join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, optionCount);
}

function matchResponse_(selected, targetCents, approximate) {
  const totalCents = selected.reduce(function(sum, x) { return sum + x.remainingCents; }, 0);

  return {
    totalCents: totalCents,
    requestedCents: targetCents,
    differenceCents: totalCents - targetCents,
    approximate: approximate,
    expenseIds: selected.map(function(x) { return x.id; }),
    receipts: selected.map(function(x) {
      return {
        id: x.id,
        date: formatDate_(x.date),
        amountCents: x.remainingCents,
        provider: x.provider || '',
        label: x.label || '',
        receiptUrl: x.receiptUrl || '',
      };
    }),
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

function normalizeDocumentPayloads_(documents) {
  return (documents || []).map(function(doc) {
    return {
      documentType: String(doc.documentType || 'Other').trim() || 'Other',
      title: String(doc.title || '').trim(),
      description: String(doc.description || '').trim(),
      issueDate: parseDateOrBlank_(doc.issueDate),
      expirationDate: parseDateOrBlank_(doc.expirationDate),
      fileBase64: String(doc.fileBase64 || '').trim(),
      mimeType: String(doc.mimeType || '').trim(),
      fileName: String(doc.fileName || 'document').trim(),
    };
  }).filter(function(doc) {
    return doc.fileBase64;
  });
}

function createAndLinkDocuments_(expenseId, documents) {
  const docFolder = getSupportingDocsFolder_();
  const ss = getSpreadsheet_();
  const docSheet = ss.getSheetByName(SHEETS.DOCUMENTS);
  const linkSheet = ss.getSheetByName(SHEETS.EXPENSE_DOCUMENTS);
  const now = new Date();
  const documentRows = [];
  const linkRows = [];
  const created = [];

  documents.forEach(function(doc) {
    const stored = createStoredFile_({
      folder: docFolder,
      payload: {
        fileBase64: doc.fileBase64,
        mimeType: doc.mimeType,
        fileName: doc.fileName,
      },
      prefix: expenseId,
      date: doc.issueDate || now,
      descriptor: doc.documentType + '_' + (doc.title || doc.description || doc.fileName || 'document'),
    });

    const documentId = makeId_('DOC');
    const title = doc.title || stripExtension_(stored.fileName);

    documentRows.push([
      documentId,
      doc.documentType,
      title,
      doc.description,
      doc.issueDate || '',
      doc.expirationDate || '',
      stored.fileId,
      stored.fileUrl,
      stored.mimeType,
      now,
    ]);

    linkRows.push([expenseId, documentId, 'supporting', now]);
    created.push({
      documentId: documentId,
      type: doc.documentType,
      title: title,
      fileUrl: stored.fileUrl,
    });
  });

  if (documentRows.length) {
    docSheet.getRange(docSheet.getLastRow() + 1, 1, documentRows.length, DOCUMENT_HEADERS.length)
      .setValues(documentRows);
    linkSheet.getRange(linkSheet.getLastRow() + 1, 1, linkRows.length, EXPENSE_DOCUMENT_HEADERS.length)
      .setValues(linkRows);
  }

  return created;
}

function createStoredFile_(args) {
  const payload = args.payload || {};
  const mimeType = payload.mimeType || 'application/octet-stream';
  const originalName = sanitizeFileName_(payload.fileName || 'file');
  const bytes = Utilities.base64Decode(payload.fileBase64);
  const blob = Utilities.newBlob(bytes, mimeType, originalName);

  const date = args.date || new Date();
  const prefix = sanitizeFileName_(args.prefix || 'FILE');
  const dateText = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const descriptor = sanitizeFileName_(args.descriptor || originalName.replace(/\.[^.]+$/, '') || 'file');
  const extension = extensionForMime_(mimeType, originalName);
  const finalName = prefix + '_' + dateText + '_' + descriptor + '.' + extension;

  blob.setName(finalName);
  const file = args.folder.createFile(blob);

  return {
    fileId: file.getId(),
    fileUrl: file.getUrl(),
    fileName: finalName,
    mimeType: mimeType,
  };
}

function getAvailableExpenses_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.EXPENSES);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const rows = sheet.getRange(2, 1, lastRow - 1, EXPENSE_HEADERS.length).getValues();

  return rows.map(function(row, index) {
    const id = String(row[0] || '');
    return {
      row: index + 2,
      id: id,
      date: row[1],
      amountCents: Number(row[9] || 0),
      reimbursedCents: Number(row[10] || 0),
      remainingCents: Number(row[11] || 0),
      provider: String(row[3] || ''),
      label: String(row[4] || ''),
      receiptUrl: String(row[7] || ''),
      status: String(row[12] || ''),
    };
  }).filter(function(x) {
    return x.id && x.remainingCents > 0 && x.status !== 'REIMBURSED';
  });
}


function ensureSchema_() {
  const ss = getSpreadsheet_();

  ensureSheet_(ss, SHEETS.EXPENSES, EXPENSE_HEADERS);
  ensureSheet_(ss, SHEETS.REIMBURSEMENTS, REIMBURSEMENT_HEADERS);
  ensureSheet_(ss, SHEETS.ITEMS, ITEM_HEADERS);
  ensureSheet_(ss, SHEETS.SETTINGS, SETTINGS_HEADERS);
  ensureSheet_(ss, SHEETS.DOCUMENTS, DOCUMENT_HEADERS);
  ensureSheet_(ss, SHEETS.EXPENSE_DOCUMENTS, EXPENSE_DOCUMENT_HEADERS);

  upsertSetting_('SCHEMA_VERSION', '2', 'Schema version including supporting documents');
  upsertSetting_('MATCH_OPTION_COUNT', '3', 'Number of reimbursement combinations to return');
  upsertSetting_('PREFER_OVER_TARGET', 'TRUE', 'When equally close, prefer a total at or above the requested amount');
  upsertSetting_('RECEIPT_FOLDER_ID', getSetting_('RECEIPT_FOLDER_ID') || '', 'Drive folder containing receipt images');
  upsertSetting_('SUPPORTING_DOCS_FOLDER_ID', getSetting_('SUPPORTING_DOCS_FOLDER_ID') || '', 'Drive folder containing letters of medical necessity and other supporting docs');
}

function ensureFoldersConfigured_() {
  let receiptFolderId = getSetting_('RECEIPT_FOLDER_ID');
  let docsFolderId = getSetting_('SUPPORTING_DOCS_FOLDER_ID');

  if (!receiptFolderId && !docsFolderId) {
    const root = DriveApp.createFolder('HSA Receipt Tracker');
    const receipts = root.createFolder('Receipts');
    const docs = root.createFolder('Supporting Documents');
    receiptFolderId = receipts.getId();
    docsFolderId = docs.getId();
    upsertSetting_('RECEIPT_FOLDER_ID', receiptFolderId, 'Drive folder containing receipt images');
    upsertSetting_('SUPPORTING_DOCS_FOLDER_ID', docsFolderId, 'Drive folder containing letters of medical necessity and other supporting docs');
    return {
      createdRootFolder: root.getId(),
      receiptFolderId: receiptFolderId,
      supportingDocsFolderId: docsFolderId,
    };
  }

  if (receiptFolderId && !docsFolderId) {
    const receiptFolder = DriveApp.getFolderById(receiptFolderId);
    const parent = getFirstParentFolder_(receiptFolder) || DriveApp.getRootFolder();
    const docs = parent.createFolder('Supporting Documents');
    docsFolderId = docs.getId();
    upsertSetting_('SUPPORTING_DOCS_FOLDER_ID', docsFolderId, 'Drive folder containing letters of medical necessity and other supporting docs');
  }

  if (!receiptFolderId && docsFolderId) {
    const docsFolder = DriveApp.getFolderById(docsFolderId);
    const parent = getFirstParentFolder_(docsFolder) || DriveApp.getRootFolder();
    const receipts = parent.createFolder('Receipts');
    receiptFolderId = receipts.getId();
    upsertSetting_('RECEIPT_FOLDER_ID', receiptFolderId, 'Drive folder containing receipt images');
  }

  return {
    receiptFolderId: receiptFolderId,
    supportingDocsFolderId: docsFolderId,
  };
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  const existingHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  let shouldWriteHeaders = sheet.getLastRow() === 0;
  if (!shouldWriteHeaders) {
    for (let i = 0; i < headers.length; i++) {
      if (String(existingHeaders[i] || '') !== headers[i]) {
        shouldWriteHeaders = true;
        break;
      }
    }
  }

  if (shouldWriteHeaders) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

function getSettings_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEYS.SETTINGS);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      // Rebuild below.
    }
  }

  const sheet = getSpreadsheet_().getSheetByName(SHEETS.SETTINGS);
  const lastRow = sheet.getLastRow();
  const settings = {};

  if (lastRow >= 2) {
    const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    values.forEach(function(row) {
      if (row[0]) settings[String(row[0])] = row[1];
    });
  }

  cache.put(CACHE_KEYS.SETTINGS, JSON.stringify(settings), SETTINGS_CACHE_SECONDS);
  return settings;
}

function getSetting_(key) {
  return getSettings_()[key] || '';
}

function upsertSetting_(key, value, notes) {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.SETTINGS);
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const rows = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0] || '') === key) {
        sheet.getRange(i + 2, 1, 1, 3).setValues([[key, value, notes || rows[i][2] || '']]);
        CacheService.getScriptCache().remove(CACHE_KEYS.SETTINGS);
        return;
      }
    }
  }

  sheet.appendRow([key, value, notes || '']);
  CacheService.getScriptCache().remove(CACHE_KEYS.SETTINGS);
}

function invalidateDashboardCache_() {
  CacheService.getScriptCache().remove(CACHE_KEYS.DASHBOARD);
}

function invalidateRuntimeCaches_() {
  const cache = CacheService.getScriptCache();
  cache.remove(CACHE_KEYS.DASHBOARD);
  cache.remove(CACHE_KEYS.SETTINGS);
}

function expenseExists_(expenseId) {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.EXPENSES);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  return values.some(function(row) { return String(row[0] || '') === expenseId; });
}

function getReceiptFolder_() {
  const folderId = String(getSetting_('RECEIPT_FOLDER_ID') || '').trim();
  if (!folderId) throw new Error('RECEIPT_FOLDER_ID is not configured.');
  return DriveApp.getFolderById(folderId);
}

function getSupportingDocsFolder_() {
  const folderId = String(getSetting_('SUPPORTING_DOCS_FOLDER_ID') || '').trim();
  if (!folderId) throw new Error('SUPPORTING_DOCS_FOLDER_ID is not configured.');
  return DriveApp.getFolderById(folderId);
}

function getSpreadsheet_() {
  if (spreadsheetHandle_) return spreadsheetHandle_;

  const id = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.SPREADSHEET_ID);
  if (!id) {
    throw new Error('SPREADSHEET_ID is not configured. Run setup("YOUR_SPREADSHEET_ID") once.');
  }

  spreadsheetHandle_ = SpreadsheetApp.openById(id);
  return spreadsheetHandle_;
}

function getFirstParentFolder_(folder) {
  const parents = folder.getParents();
  return parents.hasNext() ? parents.next() : null;
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

function parseDateOrBlank_(value) {
  if (!value) return '';
  return parseDate_(value);
}

function formatDate_(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function formatDateTime_(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}

function makeId_(prefix) {
  return prefix + '-' + Utilities.getUuid().slice(0, 8).toUpperCase();
}

function sanitizeFileName_(name) {
  return String(name || 'file')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'file';
}

function stripExtension_(name) {
  return String(name || '').replace(/\.[^.]+$/, '');
}

function extensionForMime_(mimeType, fallbackName) {
  const m = String(mimeType || '').toLowerCase();
  if (m.indexOf('pdf') >= 0) return 'pdf';
  if (m.indexOf('png') >= 0) return 'png';
  if (m.indexOf('webp') >= 0) return 'webp';
  if (m.indexOf('heic') >= 0) return 'heic';
  if (m.indexOf('heif') >= 0) return 'heif';
  if (m.indexOf('jpeg') >= 0 || m.indexOf('jpg') >= 0) return 'jpg';

  const match = String(fallbackName || '').match(/\.([A-Za-z0-9]+)$/);
  if (match) return match[1].toLowerCase();
  return 'bin';
}