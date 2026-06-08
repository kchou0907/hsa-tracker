const STORAGE_KEY = "hsa-vault-receipts-v1";
const SETTINGS_KEY = "hsa-vault-settings-v1";

const state = {
  receipts: loadJson(STORAGE_KEY, []),
  settings: loadJson(SETTINGS_KEY, { folderId: "", folderInput: "", clientId: "" }),
  driveToken: null,
  currentMatch: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.receipts));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function toCents(value) { return Math.round(Number(value) * 100); }
function fromCents(value) { return money.format(value / 100); }
function receiptCents(receipt) { return toCents(receipt.amount); }
function formatDate(value) { return value ? dateFormat.format(new Date(`${value}T00:00:00Z`)) : "No date"; }
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}
function initials(provider) { return (provider || "?").trim().charAt(0).toUpperCase(); }

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.className = "toast", 3200);
}

function receiptMiniRow(receipt) {
  const detail = receipt.notes || formatDate(receipt.date);
  return `
    <div class="receipt-row">
      <span class="receipt-initial">${escapeHtml(initials(receipt.provider))}</span>
      <span class="receipt-info"><strong>${escapeHtml(receipt.provider)}</strong><small>${escapeHtml(detail)}</small></span>
      <span class="receipt-amount">${money.format(receipt.amount)}</span>
    </div>`;
}

function emptyState(title, caption) {
  return `<div class="empty-state"><span class="empty-symbol">+</span><h3>${title}</h3><p>${caption}</p></div>`;
}

function renderDashboard() {
  const available = state.receipts.filter(r => !r.reimbursed);
  const reimbursed = state.receipts.filter(r => r.reimbursed);
  const availableCents = available.reduce((sum, r) => sum + receiptCents(r), 0);
  const documentedCents = state.receipts.reduce((sum, r) => sum + receiptCents(r), 0);
  const reimbursedCents = reimbursed.reduce((sum, r) => sum + receiptCents(r), 0);
  const largest = available.slice().sort((a, b) => b.amount - a.amount)[0];

  $("#availableTotal").textContent = fromCents(availableCents);
  $("#availableCount").textContent = available.length;
  $("#documentedTotal").textContent = fromCents(documentedCents);
  $("#documentedCaption").textContent = `Across ${state.receipts.length} receipt${state.receipts.length === 1 ? "" : "s"}`;
  $("#reimbursedTotal").textContent = fromCents(reimbursedCents);
  $("#reimbursedCaption").textContent = reimbursed.length ? `${reimbursed.length} receipt${reimbursed.length === 1 ? "" : "s"} claimed` : "Nothing claimed yet";
  $("#largestReceipt").textContent = largest ? money.format(largest.amount) : "$0.00";
  $("#largestCaption").textContent = largest ? largest.provider : "Add your first receipt";
  $("#matcherAvailableTotal").textContent = fromCents(availableCents);
  $("#navReceiptCount").textContent = state.receipts.length;

  const recent = state.receipts.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
  $("#recentReceipts").innerHTML = recent.length ? recent.map(receiptMiniRow).join("") : emptyState("No receipts yet", "Add your first qualified expense to start the archive.");
}

function getFilteredReceipts() {
  const query = $("#receiptSearch").value.trim().toLowerCase();
  const filter = $("#receiptFilter").value;
  const sort = $("#receiptSort").value;
  const result = state.receipts.filter(receipt => {
    const matchesQuery = !query || `${receipt.provider} ${receipt.notes || ""} ${receipt.amount}`.toLowerCase().includes(query);
    const matchesFilter = filter === "all" || (filter === "available" ? !receipt.reimbursed : receipt.reimbursed);
    return matchesQuery && matchesFilter;
  });
  return result.sort((a, b) => {
    if (sort === "oldest") return a.date.localeCompare(b.date);
    if (sort === "high") return b.amount - a.amount;
    if (sort === "low") return a.amount - b.amount;
    return b.date.localeCompare(a.date);
  });
}

function renderReceiptTable() {
  const receipts = getFilteredReceipts();
  $("#receiptTable").innerHTML = receipts.length ? receipts.map(receipt => `
    <div class="receipt-table-row">
      <div class="receipt-row">
        <span class="receipt-initial">${escapeHtml(initials(receipt.provider))}</span>
        <span class="receipt-info"><strong>${escapeHtml(receipt.provider)}</strong><small>${escapeHtml(receipt.fileName || receipt.notes || "No attachment")}</small></span>
      </div>
      <span>${formatDate(receipt.date)}</span>
      <span class="status-badge ${receipt.reimbursed ? "reimbursed" : ""}">${receipt.reimbursed ? "Reimbursed" : "Available"}</span>
      <strong>${money.format(receipt.amount)}</strong>
      <span class="row-actions">
        <button class="more-button" data-action="menu" data-id="${receipt.id}" aria-label="Receipt actions">...</button>
      </span>
    </div>`).join("") : emptyState("No matching receipts", "Try a different search or add another receipt.");
}

function renderDriveStatus() {
  const configured = Boolean(state.settings.folderId && state.settings.clientId);
  $("#driveStatusDot").classList.toggle("connected", configured);
  $("#driveStatusText").textContent = configured ? "Drive configured" : "Drive not configured";
  $("#driveFolderName").textContent = configured ? `Folder: ${state.settings.folderId.slice(0, 12)}...` : "Choose where receipt files should live.";
  $("#driveFolderInput").value = state.settings.folderInput || state.settings.folderId || "";
  $("#clientIdInput").value = state.settings.clientId || "";
}

function renderAll() {
  renderDashboard();
  renderReceiptTable();
  renderDriveStatus();
}

function switchView(view) {
  const titles = {
    dashboard: ["Your HSA archive", "Receipt overview"],
    receipts: ["Your expense history", "All receipts"],
    reimburse: ["Plan a withdrawal", "Build reimbursement"],
  };
  $$(".view").forEach(el => el.classList.toggle("active", el.id === `${view}View`));
  $$(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.view === view));
  $("#pageEyebrow").textContent = titles[view][0];
  $("#pageTitle").textContent = titles[view][1];
  if (view === "receipts") renderReceiptTable();
}

function openReceiptDialog(receipt = null) {
  $("#receiptDialogTitle").textContent = receipt ? "Edit receipt" : "Add receipt";
  $("#receiptId").value = receipt?.id || "";
  $("#provider").value = receipt?.provider || "";
  $("#amount").value = receipt?.amount || "";
  $("#serviceDate").value = receipt?.date || new Date().toISOString().slice(0, 10);
  $("#notes").value = receipt?.notes || "";
  $("#isReimbursed").checked = Boolean(receipt?.reimbursed);
  $("#receiptFile").value = "";
  $("#fileDropTitle").textContent = receipt?.fileName || "Attach receipt file";
  $("#fileDropCaption").textContent = receipt?.driveWebViewLink ? "A Drive file is already linked. Choose a file to replace it." : "PDF, JPG, or PNG. Uploaded to Drive when connected.";
  $("#receiptDialog").showModal();
}

function extractFolderId(input) {
  const value = input.trim();
  const match = value.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : value;
}

async function connectDrive(interactive = true) {
  if (!state.settings.clientId) throw new Error("Add your Google OAuth client ID in settings first.");
  if (!window.google?.accounts?.oauth2) throw new Error("Google sign-in has not loaded. Check your internet connection and try again.");
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: state.settings.clientId,
      scope: "https://www.googleapis.com/auth/drive",
      callback: response => {
        if (response.error) return reject(new Error(response.error_description || response.error));
        state.driveToken = response.access_token;
        showToast("Google Drive connected for this session.");
        resolve(response.access_token);
      },
      error_callback: error => reject(new Error(error.message || "Google Drive connection was cancelled.")),
    });
    client.requestAccessToken({ prompt: interactive ? "consent" : "" });
  });
}

async function uploadToDrive(file, receipt) {
  if (!state.settings.folderId || !state.settings.clientId) throw new Error("Configure Google Drive before attaching receipt files.");
  const token = state.driveToken || await connectDrive();
  const safeProvider = receipt.provider.replace(/[^\w -]/g, "").trim() || "Receipt";
  const extension = file.name.includes(".") ? `.${file.name.split(".").pop()}` : "";
  const metadata = {
    name: `${receipt.date} - ${safeProvider} - ${Number(receipt.amount).toFixed(2)}${extension}`,
    parents: [state.settings.folderId],
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", file);
  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!response.ok) {
    if (response.status === 401) state.driveToken = null;
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error?.message || "Google Drive upload failed.");
  }
  return response.json();
}

async function handleReceiptSave(event) {
  event.preventDefault();
  const button = $("#saveReceiptButton");
  const id = $("#receiptId").value || crypto.randomUUID();
  const existing = state.receipts.find(r => r.id === id);
  const receipt = {
    id,
    provider: $("#provider").value.trim(),
    amount: Number($("#amount").value),
    date: $("#serviceDate").value,
    notes: $("#notes").value.trim(),
    reimbursed: $("#isReimbursed").checked,
    createdAt: existing?.createdAt || new Date().toISOString(),
    fileName: existing?.fileName || "",
    driveFileId: existing?.driveFileId || "",
    driveWebViewLink: existing?.driveWebViewLink || "",
  };
  const file = $("#receiptFile").files[0];
  button.disabled = true;
  button.textContent = file ? "Uploading..." : "Saving...";
  try {
    if (file) {
      const driveFile = await uploadToDrive(file, receipt);
      receipt.fileName = driveFile.name;
      receipt.driveFileId = driveFile.id;
      receipt.driveWebViewLink = driveFile.webViewLink;
    }
    const index = state.receipts.findIndex(r => r.id === id);
    if (index >= 0) state.receipts[index] = receipt;
    else state.receipts.unshift(receipt);
    saveState();
    renderAll();
    $("#receiptDialog").close();
    showToast(existing ? "Receipt updated." : "Receipt added to your vault.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Save receipt";
  }
}

function showActionMenu(button, receipt) {
  $$(".action-menu").forEach(menu => menu.remove());
  const menu = document.createElement("div");
  menu.className = "action-menu";
  menu.innerHTML = `
    <button data-action="edit" data-id="${receipt.id}">Edit receipt</button>
    <button data-action="toggle" data-id="${receipt.id}">Mark ${receipt.reimbursed ? "available" : "reimbursed"}</button>
    ${receipt.driveWebViewLink ? `<a href="${escapeHtml(receipt.driveWebViewLink)}" target="_blank" rel="noopener">Open Drive file</a>` : ""}
    <button class="danger" data-action="delete" data-id="${receipt.id}">Delete from ledger</button>`;
  button.parentElement.appendChild(menu);
}

function handleReceiptAction(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    $$(".action-menu").forEach(menu => menu.remove());
    return;
  }
  const receipt = state.receipts.find(r => r.id === target.dataset.id);
  if (!receipt) return;
  if (target.dataset.action === "menu") return showActionMenu(target, receipt);
  if (target.dataset.action === "edit") openReceiptDialog(receipt);
  if (target.dataset.action === "toggle") {
    receipt.reimbursed = !receipt.reimbursed;
    saveState(); renderAll(); showToast(`Receipt marked ${receipt.reimbursed ? "reimbursed" : "available"}.`);
  }
  if (target.dataset.action === "delete" && confirm(`Delete the ${money.format(receipt.amount)} ${receipt.provider} entry from this ledger? The Drive file will not be deleted.`)) {
    state.receipts = state.receipts.filter(r => r.id !== receipt.id);
    saveState(); renderAll(); showToast("Receipt removed from the ledger.");
  }
  $$(".action-menu").forEach(menu => menu.remove());
}

function findBestCombination(receipts, target, preference) {
  if (!receipts.length) return null;
  const maxItem = Math.max(...receipts.map(receiptCents));
  const total = receipts.reduce((sum, r) => sum + receiptCents(r), 0);
  const ceiling = preference === "under" ? target : Math.min(total, target + maxItem);
  let sums = new Map([[0, []]]);

  for (let index = 0; index < receipts.length; index++) {
    const amount = receiptCents(receipts[index]);
    const additions = [];
    for (const [sum, indexes] of sums) {
      const next = sum + amount;
      if (next <= ceiling && !sums.has(next)) additions.push([next, [...indexes, index]]);
    }
    for (const [sum, indexes] of additions) sums.set(sum, indexes);
    if (sums.size > 120000) {
      const ranked = [...sums.entries()].sort((a, b) => Math.abs(a[0] - target) - Math.abs(b[0] - target)).slice(0, 80000);
      sums = new Map(ranked);
    }
  }

  const candidates = [...sums.entries()].filter(([sum]) => sum > 0 && (
    preference === "under" ? sum <= target : preference === "over" ? sum >= target : true
  ));
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const distance = Math.abs(a[0] - target) - Math.abs(b[0] - target);
    if (distance) return distance;
    if (preference === "closest" && (a[0] >= target) !== (b[0] >= target)) return a[0] >= target ? -1 : 1;
    return a[1].length - b[1].length;
  });
  const [sum, indexes] = candidates[0];
  return { sum, receipts: indexes.map(index => receipts[index]), target };
}

function renderMatch(result) {
  if (!result) {
    $("#matchResults").innerHTML = emptyState("No eligible receipt set", "There are not enough available receipts for that preference.");
    return;
  }
  state.currentMatch = result;
  const diff = result.sum - result.target;
  const exact = diff === 0;
  const differenceText = exact ? "Exact match" : `${fromCents(Math.abs(diff))} ${diff > 0 ? "over" : "under"} target`;
  $("#matchResults").innerHTML = `
    <div class="result-summary">
      <div class="result-kicker"><span>${exact ? "Exact match found" : "Closest match found"}</span><span>${result.receipts.length} receipt${result.receipts.length === 1 ? "" : "s"}</span></div>
      <div class="result-total">${fromCents(result.sum)}</div>
      <div class="result-difference">${differenceText} for a ${fromCents(result.target)} request</div>
    </div>
    <div class="result-receipts">${result.receipts.map(receiptMiniRow).join("")}</div>
    <div class="result-actions">
      <button class="secondary-button" id="copyMatchButton">Copy summary</button>
      <button class="primary-button" id="markMatchButton">Mark reimbursed</button>
    </div>`;
}

function copyMatchSummary() {
  const result = state.currentMatch;
  if (!result) return;
  const lines = [
    `HSA reimbursement receipt set: ${fromCents(result.sum)}`,
    ...result.receipts.map(r => `${formatDate(r.date)} | ${r.provider} | ${money.format(r.amount)}`),
  ];
  navigator.clipboard.writeText(lines.join("\n")).then(() => showToast("Receipt summary copied."));
}

function markCurrentMatch() {
  if (!state.currentMatch) return;
  const ids = new Set(state.currentMatch.receipts.map(r => r.id));
  state.receipts.forEach(r => { if (ids.has(r.id)) r.reimbursed = true; });
  state.currentMatch = null;
  saveState();
  renderAll();
  $("#matchResults").innerHTML = emptyState("Reimbursement recorded", "Those receipts are now marked reimbursed and will not appear in future matches.");
  showToast("Matched receipts marked reimbursed.");
}

function exportLedger() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), receipts: state.receipts, settings: state.settings }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `hsa-receipt-ledger-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function importLedger(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.receipts)) throw new Error("This file does not contain an HSA receipt ledger.");
      state.receipts = data.receipts;
      if (data.settings) state.settings = data.settings;
      saveState(); renderAll(); showToast(`Imported ${state.receipts.length} receipts.`);
    } catch (error) { showToast(error.message, true); }
  };
  reader.readAsText(file);
}

function bindEvents() {
  $$(".nav-item").forEach(button => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$("[data-go-to]").forEach(button => button.addEventListener("click", () => switchView(button.dataset.goTo)));
  $("#addReceiptButton").addEventListener("click", () => openReceiptDialog());
  $("#settingsButton").addEventListener("click", () => $("#settingsDialog").showModal());
  $("#openSettingsButton").addEventListener("click", () => $("#settingsDialog").showModal());
  $$("[data-close-dialog]").forEach(button => button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close()));
  $("#receiptForm").addEventListener("submit", handleReceiptSave);
  $("#receiptSearch").addEventListener("input", renderReceiptTable);
  $("#receiptFilter").addEventListener("change", renderReceiptTable);
  $("#receiptSort").addEventListener("change", renderReceiptTable);
  $("#receiptTable").addEventListener("click", handleReceiptAction);
  document.addEventListener("click", event => {
    if (!event.target.closest(".row-actions")) $$(".action-menu").forEach(menu => menu.remove());
  });
  $("#receiptFile").addEventListener("change", event => {
    const file = event.target.files[0];
    if (file) {
      $("#fileDropTitle").textContent = file.name;
      $("#fileDropCaption").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB ready to upload`;
    }
  });
  $("#settingsForm").addEventListener("submit", event => {
    event.preventDefault();
    state.settings.folderInput = $("#driveFolderInput").value.trim();
    state.settings.folderId = extractFolderId(state.settings.folderInput);
    state.settings.clientId = $("#clientIdInput").value.trim();
    saveState(); renderDriveStatus(); $("#settingsDialog").close(); showToast("Drive settings saved.");
  });
  $("#connectDriveButton").addEventListener("click", async () => {
    state.settings.folderInput = $("#driveFolderInput").value.trim();
    state.settings.folderId = extractFolderId(state.settings.folderInput);
    state.settings.clientId = $("#clientIdInput").value.trim();
    saveState();
    try { await connectDrive(); renderDriveStatus(); }
    catch (error) { showToast(error.message, true); }
  });
  $("#matchForm").addEventListener("submit", event => {
    event.preventDefault();
    const target = toCents($("#targetAmount").value);
    const preference = $('input[name="matchPreference"]:checked').value;
    const result = findBestCombination(state.receipts.filter(r => !r.reimbursed), target, preference);
    renderMatch(result);
  });
  $("#matchResults").addEventListener("click", event => {
    if (event.target.id === "copyMatchButton") copyMatchSummary();
    if (event.target.id === "markMatchButton") markCurrentMatch();
  });
  $("#exportButton").addEventListener("click", exportLedger);
  $("#importInput").addEventListener("change", event => event.target.files[0] && importLedger(event.target.files[0]));
}

bindEvents();
renderAll();
