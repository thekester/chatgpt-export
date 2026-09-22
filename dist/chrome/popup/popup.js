const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const btnCurrent = $("current");
const btnAll = $("all");
const btnGrant = $("grant");
const bar = $("bar");
const progressWrap = $("progress-wrap");
const progressPercent = $("progress-percent");
const activityWrap = $("activity-wrap");
const activityList = $("activity-list");
const status = $("status");
const btnLog = $("download-log");
const btnFailures = $("download-failures");
const help = $("help");
const optImages = $("opt-images");
const optJson = $("opt-json");
const optThinking = $("opt-thinking");
const optFiles = $("opt-files");
const optBranches = $("opt-branches");
const optIncremental = $("opt-incremental");
const optChecksums = $("opt-checksums");
const optPartSize = $("opt-part-size");
const formatInputs = [...document.querySelectorAll('input[name="format"]')];
const mediaModeInputs = [...document.querySelectorAll('input[name="media-mode"]')];
const mdHtmlInputs = [...document.querySelectorAll('input[name="md-html"]')];
const ALL_SITES = { origins: ["<all_urls>"] };

let tabId = null;
let tabChecked = false;
let exportTabId = null;
let activeTabUrl = null;
let diagnostic = null;
let diagnosticDownload = null;
let diagnosticCreatedAt = null;
let lastProgressLabel = "";
let liveFailures = [];

function manifestVersion() {
  try { return api.runtime.getManifest().version || "unknown"; } catch (_) { return "unknown"; }
}

function safePageUrl(raw) {
  try {
    const u = new URL(raw || "");
    const path = u.pathname.split("/").map((part) => /^[A-Za-z0-9_-]{16,}$/.test(part) ? `<id:${part.length}>` : part).join("/");
    return `${u.origin}${path}`;
  } catch (_) { return "unavailable"; }
}

function errorDetails(error) {
  if (!error) return null;
  return {
    name: String(error.name || "Error"),
    message: String(error.message || error),
    stack: error.stack ? String(error.stack) : null
  };
}

function startDiagnostic(type) {
  diagnostic = {
    schema: 1,
    extension: { name: "ChatGPT Markdown Export", version: manifestVersion() },
    started_at: new Date().toISOString(),
    export_type: type,
    page: safePageUrl(activeTabUrl),
    browser: { user_agent: navigator.userAgent, platform: navigator.platform || null },
    options: currentOptions(),
    events: []
  };
  diagnosticDownload = null;
  diagnosticCreatedAt = null;
  lastProgressLabel = "";
  btnLog.hidden = true;
  btnLog.textContent = "Download diagnostic log";
}

function addDiagnostic(event, details = null) {
  if (!diagnostic) return;
  diagnostic.events.push({ at: new Date().toISOString(), event, ...(details ? { details } : {}) });
  if (diagnostic.events.length > 250) diagnostic.events.splice(0, diagnostic.events.length - 250);
}

function prepareDiagnosticLog({ error = null, remote = null, result = null } = {}) {
  if (!diagnostic) startDiagnostic("unknown");
  diagnostic.finished_at = new Date().toISOString();
  diagnostic.page = safePageUrl(activeTabUrl);
  if (error) diagnostic.error = errorDetails(error);
  if (result) diagnostic.result = result;
  const payload = {
    notice: "Diagnostic log generated locally by ChatGPT Markdown Export. Conversation text, authentication tokens, query strings, and raw message content are intentionally not included.",
    popup: diagnostic,
    content_script: remote || null
  };
  diagnosticDownload = JSON.stringify(payload, null, 2) + "\n";
  diagnosticCreatedAt = new Date().toISOString();
  try { localStorage.setItem("cgx-last-diagnostic", JSON.stringify({ created_at: diagnosticCreatedAt, text: diagnosticDownload })); } catch (_) {}
  btnLog.textContent = "Download diagnostic log";
  btnLog.hidden = false;
}

function restoreDiagnosticLog() {
  try {
    const saved = JSON.parse(localStorage.getItem("cgx-last-diagnostic") || "null");
    if (!saved || typeof saved.text !== "string" || !saved.text) return;
    diagnosticDownload = saved.text;
    diagnosticCreatedAt = saved.created_at || null;
    btnLog.textContent = "Download last diagnostic log";
    btnLog.hidden = false;
  } catch (_) {}
}

function downloadDiagnosticLog() {
  if (!diagnosticDownload) return;
  const stamp = String(diagnosticCreatedAt || new Date().toISOString()).replace(/[:.]/g, "-");
  const blob = new Blob([diagnosticDownload], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `chatgpt-export-diagnostic-${stamp}.log`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function updateFailureLog(failures) {
  if (!Array.isArray(failures)) return;
  liveFailures = failures;
  btnFailures.hidden = !liveFailures.length;
  btnFailures.textContent = `Download failure log (${liveFailures.length})`;
}

function downloadFailureLog() {
  if (!liveFailures.length) return;
  const payload = {
    notice: "Per-conversation export failures. Conversation contents and authentication data are omitted.",
    extension_version: manifestVersion(), generated_at: new Date().toISOString(), failures: liveFailures
  };
  const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url;
  a.download = `chatgpt-export-failures-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ---------- Saved options ----------

function loadOptions() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("cgx-options") || "{}");
  } catch (_) {}
  const format = ["md", "html", "both", "jex"].includes(saved.format) ? saved.format : "both";
  formatInputs.forEach((el) => (el.checked = el.value === format));
  optImages.checked = saved.images ?? true;
  optJson.checked = saved.json ?? false;
  optThinking.checked = saved.thinking ?? false;
  const mediaMode = saved.embeddedMd ? "embedded" : "links";
  mediaModeInputs.forEach((el) => (el.checked = el.value === mediaMode));
  const mdHtml = saved.mdHtml === false ? "pure" : "html";
  mdHtmlInputs.forEach((el) => (el.checked = el.value === mdHtml));
  if (saved.modernEmbeddedMd) {
    const jex = formatInputs.find((el) => el.value === "jex");
    if (jex) jex.checked = true;
  }
  optFiles.checked = saved.files ?? true;
  optBranches.checked = saved.branches ?? false;
  optIncremental.checked = saved.incremental ?? false;
  optChecksums.checked = saved.checksums ?? true;
  optPartSize.value = String(saved.partSizeMB ?? 1024);
}

function selectedFormat() {
  const el = formatInputs.find((i) => i.checked);
  return el ? el.value : "both";
}

function currentOptions() {
  const f = selectedFormat();
  const jex = f === "jex";
  const embeddedMd = !jex && mediaModeInputs.find((el) => el.checked)?.value === "embedded";
  return {
    format: f, md: jex || f !== "html", html: !jex && f !== "md", images: jex || optImages.checked, files: jex || optFiles.checked, json: jex ? false : optJson.checked, thinking: optThinking.checked,
    mdHtml: mdHtmlInputs.find((el) => el.checked)?.value !== "pure",
    embeddedMd, modernEmbeddedMd: jex, branches: jex ? false : optBranches.checked, incremental: jex ? false : optIncremental.checked, checksums: jex ? false : optChecksums.checked,
    partSizeMB: Math.max(100, Math.min(4096, Number(optPartSize.value) || 1024))
  };
}

function updateFormatUI() {
  const jex = selectedFormat() === "jex";
  document.querySelectorAll(".jex-hidden").forEach((el) => { el.hidden = jex; });
  $("jex-note").hidden = !jex;
  btnAll.textContent = jex ? "Export all history (one .jex)" : "Export all history (.zip)";
  refreshButtons();
  checkPermission();
}

function saveOptions() {
  try {
    localStorage.setItem("cgx-options", JSON.stringify(currentOptions()));
  } catch (_) {}
  updateFormatUI();
  refreshButtons();
  checkPermission();
}

// ---------- State ----------


function showProgress(percent = 0, label = "") {
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  progressWrap.hidden = false;
  bar.max = 100;
  bar.value = value;
  progressPercent.textContent = `${value}%`;
  if (label) {
    if (diagnostic && (label !== lastProgressLabel || value === 0 || value === 100)) {
      addDiagnostic("progress", { percent: value, label });
      lastProgressLabel = label;
    }
    setStatus(`${value}% — ${label}`);
  }
}

function updateActivity(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  activityList.replaceChildren();
  for (const entry of entries.slice(-8)) {
    const item = document.createElement("li");
    item.textContent = typeof entry === "string" ? entry : String(entry.label || "Working…");
    activityList.appendChild(item);
  }
  activityWrap.hidden = false;
}

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

let busy = false;
function refreshButtons() {
  // Keep the actions immediately clickable while the popup is resolving the
  // active tab. Conversation detection and export work happen only after a
  // click; we disable the buttons only once we know this is not a ChatGPT tab
  // or while an export launched from this popup is running.
  const unavailable = tabChecked && !tabId;
  btnCurrent.disabled = busy || unavailable;
  btnAll.disabled = busy || unavailable;
}

function setBusy(b) {
  busy = b;
  refreshButtons();
}

// Images outside chatgpt.com (web search, products) require access to all sites.
async function checkPermission() {
  const embedded = mediaModeInputs.find((el) => el.checked)?.value === "embedded";
  if ((!optImages.checked && !optFiles.checked && !embedded && selectedFormat() !== "jex") || !api.permissions) {
    btnGrant.hidden = true;
    return;
  }
  try {
    const granted = await api.permissions.contains(ALL_SITES);
    btnGrant.hidden = false;
    btnGrant.textContent = granted ? "Disable external media" : "Allow external media";
    btnGrant.title = granted
      ? "Remove permission to download media hosted outside ChatGPT"
      : "Optional permission to download media hosted outside ChatGPT";
    btnGrant.setAttribute("aria-pressed", String(granted));
    btnGrant.dataset.granted = String(granted);
  } catch (_) {
    btnGrant.hidden = true;
  }
}

btnGrant.addEventListener("click", async () => {
  try {
    // Read the state prepared by checkPermission so request() remains the
    // first permission API call made from this user-initiated event.
    const granted = btnGrant.dataset.granted === "true";
    if (granted) {
      const removed = await api.permissions.remove(ALL_SITES);
      setStatus(removed ? "External media permission disabled." : "Permission could not be disabled.", !removed);
    } else {
      const ok = await api.permissions.request(ALL_SITES);
      setStatus(ok ? "Access granted." : "Without this access, only generated images will be saved.", !ok);
    }
  } catch (e) {
    setStatus(e.message, true);
  }
  checkPermission();
});

document.querySelectorAll(".info").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    help.textContent = button.dataset.help || "";
    help.hidden = !help.textContent;
  });
});

const CONTENT_SCRIPT_FILES = [
  "lib/marked.umd.js",
  "src/zip.js",
  "src/render.js",
  "src/content.js"
];

function missingReceiver(error) {
  const text = String((error && error.message) || error || "");
  return /receiving end does not exist|could not establish connection|message port closed before/i.test(text);
}

async function injectContentScript() {
  if (!tabId) throw new Error("No active ChatGPT tab.");
  addDiagnostic("content-script.inject.start", { files: CONTENT_SCRIPT_FILES });
  showProgress(1, "Connecting extension to this tab...");

  if (api.scripting && api.scripting.executeScript) {
    // Inject sequentially so content.js always sees marked, ZIP and renderer globals.
    for (const file of CONTENT_SCRIPT_FILES) {
      await api.scripting.executeScript({ target: { tabId }, files: [file] });
      addDiagnostic("content-script.inject.file", { file });
    }
    return;
  }

  // Compatibility fallback for browsers exposing the legacy API.
  if (api.tabs && api.tabs.executeScript) {
    for (const file of CONTENT_SCRIPT_FILES) {
      await api.tabs.executeScript(tabId, { file, runAt: "document_idle" });
      addDiagnostic("content-script.inject.file", { file, legacy: true });
    }
    return;
  }

  throw new Error("The page connector could not be injected. Reload the ChatGPT tab and try again.");
}

async function send(msg, allowInjectionRetry = true) {
  try {
    return await api.tabs.sendMessage(tabId, msg);
  } catch (error) {
    addDiagnostic("message.send.error", errorDetails(error));
    if (!allowInjectionRetry || !missingReceiver(error)) throw error;
    addDiagnostic("message.send.retry", { reason: "missing receiver" });
    await injectContentScript();
    // Give the newly injected listener one event-loop turn to register.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return api.tabs.sendMessage(tabId, msg);
  }
}

async function resolveActiveTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const onChatGPT = tab && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "");
  tabChecked = true;
  activeTabUrl = tab && tab.url ? tab.url : null;
  tabId = onChatGPT ? tab.id : null;
  if (diagnostic) { diagnostic.page = safePageUrl(activeTabUrl); addDiagnostic("tab.resolved", { on_chatgpt: !!onChatGPT, page: diagnostic.page }); }
  refreshButtons();
  return !!tabId;
}

async function init() {
  try {
    const onChatGPT = await resolveActiveTab();
    const resumed = await restoreExportActivity();
    if (resumed) pollExportActivity();
    if (!onChatGPT && !resumed) setStatus("Open chatgpt.com in this tab to export.", true);
  } catch {
    tabChecked = true;
    tabId = null;
    refreshButtons();
    setStatus("Reload the ChatGPT page, then reopen this window.", true);
  }
}

function showFinishedExport(job) {
  if (!job) return;
  const key = `cgx-seen-export-${job.finishedAt}`;
  if (!job.finishedAt) return;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch (_) {}
  setBusy(false);
  if (!job.ok) {
    updateActivity([{ label: `Export failed: ${job.error || "Unknown error."}` }]);
    setStatus(`The previous export failed: ${job.error || "Unknown error."}`, true);
    return;
  }
  const message = job.joplinHistory
    ? `${job.count} conversations exported as notes in one JEX notebook. Import the single JEX file into Joplin.`
    : (job.joplin ? "Joplin JEX export ready. Import it with File > Import > JEX." : `${job.count} conversation(s) exported.`);
  setStatus(job.failed ? `${message} ${job.failed} failed; check the downloaded errors report and diagnostic log.` : message, !!job.failed);
  updateActivity([{ label: job.failed ? `Export completed with ${job.failed} failed conversation(s).` : "Export completed successfully." }]);
}

async function restoreExportActivity() {
  let tabs = [];
  try { tabs = await api.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] }); } catch (_) { return false; }
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      const state = await api.tabs.sendMessage(tab.id, { type: "cgx-ping" });
      if (state && state.busy) {
        exportTabId = tab.id;
        activeTabUrl = tab.url || null;
        setBusy(true);
        const progress = state.progress || { percent: 0, label: "Export is running in another tab…" };
        const activeElsewhere = tab.id !== tabId;
        showProgress(progress.percent, `${progress.label || "Export in progress…"}${activeElsewhere ? " · running in another tab" : ""}`);
        updateActivity(state.activity);
        updateFailureLog(state.failures);
        return true;
      }
      if (state && state.lastJob && Date.now() - state.lastJob.finishedAt < 10 * 60 * 1000) {
        showFinishedExport(state.lastJob);
      }
    } catch (_) {}
  }
  return false;
}

function pollExportActivity() {
  if (exportTabId == null || !busy) return;
  const sourceTabId = exportTabId;
  api.tabs.sendMessage(sourceTabId, { type: "cgx-ping" }).then((state) => {
    if (sourceTabId !== exportTabId) return;
    if (state && state.busy) {
      const progress = state.progress || {};
      showProgress(progress.percent, progress.label || "Export in progress…");
      updateActivity(state.activity);
      updateFailureLog(state.failures);
      setTimeout(pollExportActivity, 1200);
    } else {
      setBusy(false);
      exportTabId = null;
      if (state && state.lastJob) showFinishedExport(state.lastJob);
    }
  }).catch(() => setTimeout(pollExportActivity, 1800));
}

async function run(type) {
  if (busy) return;
  let keepBusy = false;
  startDiagnostic(type);
  addDiagnostic("export.requested");
  // Do not preflight the conversation when opening the popup. Resolve the
  // active ChatGPT tab at click time, then let the content script perform all
  // conversation detection, API access, fallbacks and export processing.
  if (!tabId) {
    try {
      if (!(await resolveActiveTab())) {
        const e = new Error("Open chatgpt.com in this tab to export.");
        addDiagnostic("export.error", errorDetails(e));
        prepareDiagnosticLog({ error: e });
        setStatus(`${e.message} Diagnostic log available below.`, true);
        return;
      }
    } catch (e) {
      addDiagnostic("export.error", errorDetails(e));
      prepareDiagnosticLog({ error: e });
      setStatus(`${e.message || "Could not access the active ChatGPT tab."} Diagnostic log available below.`, true);
      return;
    }
  }
  setBusy(true);
  exportTabId = tabId;
  activityWrap.hidden = false;
  updateFailureLog([]);
  updateActivity([{ label: type === "cgx-export-all" ? "Starting account history scan…" : "Starting conversation export…" }]);
  showProgress(0, type === "cgx-export-all" ? "Loading conversation list…" : "Starting export…");
  try {
    addDiagnostic("message.send", { type });
    const r = await send({ type, options: currentOptions() });
    if (!r.ok) {
      const err = new Error(r.error || "Export failed.");
      err.remoteDiagnostics = r.diagnostics || null;
      throw err;
    }
    addDiagnostic("export.response", { count: r.count || 0, failed: r.failed || 0, image_failures: r.imageFailures || 0, file_failures: r.fileFailures || 0, parts: r.parts || 0 });
    let text = r.joplinHistory
      ? `${r.count} conversations exported as notes in one JEX notebook. Import the single JEX file into Joplin.`
      : (r.joplin ? "Joplin JEX export ready. Import it with File > Import > JEX." : (r.count > 1 ? `${r.count} conversations exported.` : "Conversation exported."));
    if (r.failed) text += r.joplinHistory ? ` ${r.failed} failed; see the downloaded errors report and diagnostic log.` : ` ${r.failed} failed; see _erreurs.txt.`;
    updateFailureLog(r.failureDetails);
    if (r.imageFailures) text += ` ${r.imageFailures} image(s) could not be downloaded; kept as remote links.`;
    if (r.fileFailures) text += ` ${r.fileFailures} file(s) could not be downloaded.`;
    if (currentOptions().embeddedMd && !currentOptions().modernEmbeddedMd) text += " Self-contained MIME/Base64 Markdown included.";
    showProgress(100);
    const hasIssues = !!(r.failed || r.imageFailures || r.fileFailures);
    if (hasIssues) {
      prepareDiagnosticLog({
        remote: r.diagnostics || null,
        result: { failed: r.failed || 0, image_failures: r.imageFailures || 0, file_failures: r.fileFailures || 0, count: r.count || 0, parts: r.parts || 0, conversation_failures: r.failureDetails || [] }
      });
      text += " Diagnostic log available below.";
    }
    setStatus(text, hasIssues);
  } catch (e) {
    if (/already running in this tab/i.test(e.message || "")) {
      if (await restoreExportActivity()) { keepBusy = true; pollExportActivity(); return; }
    }
    addDiagnostic("export.error", errorDetails(e));
    prepareDiagnosticLog({ error: e, remote: e.remoteDiagnostics || null });
    updateActivity([{ label: `Export failed: ${e.message || "Unknown error."}` }]);
    setStatus(`${e.message || "Export failed."} Diagnostic log available below.`, true);
  } finally {
    if (!keepBusy) {
      setBusy(false);
      exportTabId = null;
    }
  }
}

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "cgx-progress") return;
  if (exportTabId != null && sender && sender.tab && sender.tab.id !== exportTabId) return;
  const percent = Number.isFinite(Number(msg.percent))
    ? Number(msg.percent)
    : (Number(msg.total) > 0 ? (Number(msg.done) / Number(msg.total)) * 100 : 0);
  showProgress(percent, msg.label || "Processing…");
  updateActivity(msg.activity);
  updateFailureLog(msg.failures);
  if (percent >= 100 && exportTabId != null) setTimeout(pollExportActivity, 150);
});

[...formatInputs, ...mediaModeInputs, ...mdHtmlInputs, optImages, optFiles, optJson, optThinking, optBranches, optIncremental, optChecksums, optPartSize].forEach((el) => el.addEventListener("change", saveOptions));
btnCurrent.addEventListener("click", () => run("cgx-export-current"));
btnAll.addEventListener("click", () => run("cgx-export-all"));
btnLog.addEventListener("click", downloadDiagnosticLog);
btnFailures.addEventListener("click", downloadFailureLog);
loadOptions();
updateFormatUI();
checkPermission();
restoreDiagnosticLog();
init();
