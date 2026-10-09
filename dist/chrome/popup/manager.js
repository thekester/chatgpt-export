const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const pageSize = 50;
const sourceTabParam = new URLSearchParams(location.search).get("tabId");
const sourceTabId = sourceTabParam == null ? null : Number(sourceTabParam);
let items = [];
let currentPage = 0;
let selectedRows = new Set();
let actions = new Map();
let running = false;

function setStatus(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

function visibleItems() {
  const query = $("search").value.trim().toLocaleLowerCase();
  const from = $("date-from").value ? new Date(`${$("date-from").value}T00:00:00`).getTime() : -Infinity;
  const to = $("date-to").value ? new Date(`${$("date-to").value}T23:59:59.999`).getTime() : Infinity;
  const filtered = items.filter((item) => {
    const updated = item.updatedAt ? new Date(item.updatedAt).getTime() : NaN;
    return `${item.title} ${item.project} ${item.archived ? "archived" : ""} ${item.shared ? "shared" : ""}`.toLocaleLowerCase().includes(query)
      && (Number.isNaN(updated) ? from === -Infinity && to === Infinity : updated >= from && updated <= to);
  });
  const sort = $("sort-by").value;
  filtered.sort((a, b) => {
    if (sort === "title-asc" || sort === "title-desc") {
      const order = (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
      return sort === "title-asc" ? order : -order;
    }
    const order = (Date.parse(a.updatedAt) || 0) - (Date.parse(b.updatedAt) || 0);
    return sort === "oldest" ? order : -order;
  });
  return filtered;
}

function render() {
  const filtered = visibleItems();
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  currentPage = Math.max(0, Math.min(currentPage, pages - 1));
  const pageItems = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const tbody = $("rows");
  tbody.replaceChildren();
  if (!pageItems.length) {
    const row = document.createElement("tr"), cell = document.createElement("td");
    cell.colSpan = 4; cell.className = "muted"; cell.textContent = items.length ? "No conversations match these search and date filters." : "No conversations loaded yet. The account history is still being scanned.";
    row.appendChild(cell); tbody.appendChild(row);
  }
  for (const item of pageItems) {
    const row = document.createElement("tr");
    const markCell = document.createElement("td"), mark = document.createElement("input");
    mark.type = "checkbox"; mark.checked = selectedRows.has(item.key); mark.setAttribute("aria-label", `Select ${item.title}`);
    mark.disabled = running;
    mark.addEventListener("change", () => { mark.checked ? selectedRows.add(item.key) : selectedRows.delete(item.key); updateSummary(); updateVisibleCheckbox(); });
    markCell.appendChild(mark);
    const title = document.createElement("td"); title.className = "title"; title.textContent = item.title;
    const date = document.createElement("td"); date.className = "date";
    date.textContent = item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "Unknown";
    const scope = document.createElement("td"); scope.className = "scope";
    scope.textContent = [item.accountLabel || "", item.project || "", item.archived ? "Archived" : "", item.shared ? "Shared" : ""].filter(Boolean).join(" · ") || "Active";
    row.append(markCell, title, date, scope); tbody.appendChild(row);
  }
  $("counts").textContent = `${filtered.length.toLocaleString()} shown of ${items.length.toLocaleString()} · ${selectedRows.size.toLocaleString()} checked`;
  $("page-label").textContent = `Page ${currentPage + 1} of ${pages}`;
  $("previous").disabled = currentPage === 0 || running;
  $("next").disabled = currentPage >= pages - 1 || running;
  $("reload").disabled = running;
  $("search").disabled = running;
  $("sort-by").disabled = running;
  $("date-from").disabled = running;
  $("date-to").disabled = running;
  $("select-visible").disabled = running;
  updateVisibleCheckbox(); updateSummary();
}

function updateVisibleCheckbox() {
  const visible = visibleItems().slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const checked = visible.filter((item) => selectedRows.has(item.key)).length;
  const input = $("select-visible");
  input.checked = visible.length > 0 && checked === visible.length;
  input.indeterminate = checked > 0 && checked < visible.length;
}

function updateSummary() {
  const count = selectedRows.size;
  $("selection-summary").textContent = count ? `${count.toLocaleString()} conversation(s) selected. Choose what to do:` : "Select conversations using the checkboxes.";
  $("export-selected").disabled = running || !count;
  $("delete-selected").disabled = running || !count;
  $("export-delete-selected").disabled = running || !count;
}

async function sendToChatGPT(message) {
  if (!Number.isInteger(sourceTabId)) throw new Error("Open this manager from the extension popup on a ChatGPT tab.");
  try { return await api.tabs.sendMessage(sourceTabId, message); }
  catch (_) { throw new Error("Could not reach the ChatGPT tab. Reload ChatGPT, then reload this manager page."); }
}

async function loadConversations() {
  if (running) return;
  running = true; $("cancel-job").hidden = false; render(); $("progress").hidden = false; $("progress").value = 0;
  setStatus("Scanning conversations…");
  try {
    const result = await sendToChatGPT({ type: "cgx-manager-list" });
    if (!result || !result.ok) throw new Error((result && result.error) || "Could not load the conversation list.");
    items = result.items || []; selectedRows.clear(); actions.clear(); currentPage = 0;
    setStatus(`${result.total.toLocaleString()} conversations loaded. Choose an action per row.`);
    $("progress").value = 100;
  } catch (error) {
    if (error.cancelled || /cancelled by user/i.test(error.message || "")) setStatus("Scan cancelled. You can start it again whenever you’re ready.");
    else setStatus(error.message || String(error), true);
  }
  finally { running = false; $("cancel-job").hidden = true; render(); }
}

function makeExportOptions() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("cgx-options") || "{}"); } catch (_) {}
  const format = ["md", "html", "both", "jex"].includes(saved.format) ? saved.format : "both";
  const jex = format === "jex";
  return {
    format, md: jex || format !== "html", html: !jex && format !== "md",
    images: jex || saved.images !== false, files: jex || saved.files !== false,
    json: !jex && !!saved.json, thinking: !!saved.thinking,
    mdHtml: saved.mdHtml !== false, embeddedMd: jex || !!saved.embeddedMd,
    modernEmbeddedMd: jex, branches: !jex && !!saved.branches,
    incremental: false, checksums: !jex && saved.checksums !== false,
    partSizeMB: Math.max(100, Math.min(4096, Number(saved.partSizeMB) || 1024)),
    jexDelayMs: Math.max(0, Math.min(30000, Number(saved.jexDelayMs ?? 2000)))
  };
}

function reviewActions(action) {
  const planned = [...selectedRows].map((key) => ({ item: items.find((entry) => entry.key === key), action })).filter((entry) => entry.item);
  actions.clear();
  for (const { item } of planned) actions.set(item.key, action);
  const deletes = planned.filter(({ action }) => action === "delete" || action === "export-delete");
  if (!deletes.length) { runActions(planned); return; }
  $("delete-summary").textContent = `${deletes.length} conversation(s) are marked for permanent deletion. ${planned.filter(({ action }) => action === "export" || action === "export-delete").length} will be exported first.`;
  const list = $("delete-preview"); list.replaceChildren();
  for (const { item } of deletes.slice(0, 12)) { const li = document.createElement("li"); li.textContent = item.title; list.appendChild(li); }
  if (deletes.length > 12) { const li = document.createElement("li"); li.textContent = `…and ${deletes.length - 12} more`; list.appendChild(li); }
  $("delete-ack").checked = false; $("confirm-delete").disabled = true;
  $("delete-dialog").showModal();
}

async function runActions(planned) {
  $("delete-dialog").close(); running = true; $("cancel-job").hidden = false; render(); $("progress").hidden = false; $("progress").value = 0;
  setStatus("Running selected actions…");
  try {
    const result = await sendToChatGPT({
      type: "cgx-manager-run",
      actions: planned.map(({ item, action }) => ({ key: item.key, action })),
      options: makeExportOptions()
    });
    if (!result || !result.ok) { const error = new Error((result && result.error) || "Selected actions failed."); error.cancelled = !!(result && result.cancelled); throw error; }
    const exportResult = result.exportResult;
    const deleted = (result.deleteResults || []).filter((entry) => entry.ok);
    const deleteFailures = (result.deleteResults || []).filter((entry) => !entry.ok);
    const deleteFailureDetails = deleteFailures.slice(0, 3).map((entry) => `${entry.title}${entry.status ? ` (HTTP ${entry.status})` : ` (${entry.error || "unknown error"})`}`).join("; ");
    if (exportResult) {
      const failed = exportResult.failed || 0;
      setStatus(`${exportResult.count || 0} conversation(s) exported${failed ? `; ${failed} export failed` : ""}. ${deleted.length} permanently deleted${deleteFailures.length ? `; ${deleteFailures.length} deletion(s) failed or skipped: ${deleteFailureDetails}${deleteFailures.length > 3 ? "; …" : ""}` : ""}.` , !!(failed || deleteFailures.length));
    } else {
      setStatus(`${result.exportError ? `Export did not complete: ${result.exportError}. ` : ""}${deleted.length} conversation(s) permanently deleted${deleteFailures.length ? `; ${deleteFailures.length} deletion(s) failed or skipped: ${deleteFailureDetails}${deleteFailures.length > 3 ? "; …" : ""}` : ""}.`, !!(result.exportError || deleteFailures.length));
    }
    const removed = new Set(deleted.map((entry) => entry.key));
    items = items.filter((item) => !removed.has(item.key));
    for (const key of removed) actions.delete(key);
    const failedExportKeys = new Set((exportResult && exportResult.failedIds || []).map((entry) => JSON.stringify([entry.accountId || "", entry.id || ""])));
    const deleteResultByKey = new Map((result.deleteResults || []).map((entry) => [entry.key, entry]));
    for (const task of planned) {
      if (task.action === "export" && exportResult && !failedExportKeys.has(task.item.key)) actions.delete(task.item.key);
      if ((task.action === "delete" || task.action === "export-delete") && deleteResultByKey.get(task.item.key)?.ok) actions.delete(task.item.key);
    }
    $("progress").value = 100;
  } catch (error) {
    if (error.cancelled || /cancelled by user/i.test(error.message || "")) setStatus("Action cancelled. You can start a new action whenever you’re ready.");
    else setStatus(error.message || String(error), true);
  }
  finally { running = false; $("cancel-job").hidden = true; render(); }
}

$("reload").addEventListener("click", loadConversations);
$("cancel-job").addEventListener("click", async () => {
  const button = $("cancel-job"); button.disabled = true; button.textContent = "Cancelling…";
  try {
    const result = await sendToChatGPT({ type: "cgx-cancel-job" });
    if (!result || !result.ok) throw new Error((result && result.error) || "Could not cancel the running action.");
    setStatus("Cancellation requested. Waiting for the current request to finish safely…");
  } catch (error) { setStatus(error.message || String(error), true); }
});
$("search").addEventListener("input", () => { currentPage = 0; render(); });
$("sort-by").addEventListener("change", () => { currentPage = 0; render(); });
$("date-from").addEventListener("change", () => { currentPage = 0; render(); });
$("date-to").addEventListener("change", () => { currentPage = 0; render(); });
$("previous").addEventListener("click", () => { currentPage--; render(); });
$("next").addEventListener("click", () => { currentPage++; render(); });
$("select-visible").addEventListener("change", (event) => {
  const visible = visibleItems().slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  for (const item of visible) event.target.checked ? selectedRows.add(item.key) : selectedRows.delete(item.key);
  render();
});
$("export-selected").addEventListener("click", () => reviewActions("export"));
$("delete-selected").addEventListener("click", () => reviewActions("delete"));
$("export-delete-selected").addEventListener("click", () => reviewActions("export-delete"));
$("delete-ack").addEventListener("change", (event) => { $("confirm-delete").disabled = !event.target.checked; });
$("cancel-delete").addEventListener("click", () => $("delete-dialog").close());
$("confirm-delete").addEventListener("click", () => {
  if (!$("delete-ack").checked) return;
  const planned = [...actions].map(([key, action]) => ({ item: items.find((entry) => entry.key === key), action })).filter((entry) => entry.item);
  runActions(planned);
});

api.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "cgx-progress" || (sender.tab && sender.tab.id !== sourceTabId)) return;
  $("progress").hidden = false;
  $("progress").value = Math.max(0, Math.min(100, Number(message.percent) || 0));
  if (message.label) setStatus(message.label);
});

render();
loadConversations();
