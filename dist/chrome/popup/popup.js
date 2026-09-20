const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const btnCurrent = $("current");
const btnAll = $("all");
const btnGrant = $("grant");
const bar = $("bar");
const status = $("status");
const help = $("help");
const optImages = $("opt-images");
const optJson = $("opt-json");
const optThinking = $("opt-thinking");
const optEmbedded = $("opt-embedded-md");
const optFiles = $("opt-files");
const optBranches = $("opt-branches");
const optIncremental = $("opt-incremental");
const optChecksums = $("opt-checksums");
const optPartSize = $("opt-part-size");
const formatInputs = [...document.querySelectorAll('input[name="format"]')];
const ALL_SITES = { origins: ["<all_urls>"] };

let tabId = null;
let hasConversation = false;

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
  optEmbedded.checked = saved.embeddedMd ?? false;
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
  if (jex) optEmbedded.checked = false;
  const embeddedMd = optEmbedded.checked || jex;
  return {
    format: f, md: jex || f !== "html", html: !jex && f !== "md", images: jex || optImages.checked, files: jex || optFiles.checked, json: jex ? false : optJson.checked, thinking: optThinking.checked,
    embeddedMd, modernEmbeddedMd: jex, branches: jex ? false : optBranches.checked, incremental: jex ? false : optIncremental.checked, checksums: jex ? false : optChecksums.checked,
    partSizeMB: Math.max(100, Math.min(4096, Number(optPartSize.value) || 1024))
  };
}

function updateFormatUI() {
  const jex = selectedFormat() === "jex";
  document.querySelectorAll(".jex-hidden").forEach((el) => { el.hidden = jex; });
  $("jex-note").hidden = !jex;
  if (jex) optEmbedded.checked = false;
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

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

let busy = false;
function refreshButtons() {
  btnCurrent.disabled = busy || !tabId || !hasConversation;
  btnAll.disabled = busy || !tabId || selectedFormat() === "jex";
}

function setBusy(b) {
  busy = b;
  refreshButtons();
}

// Images outside chatgpt.com (web search, products) require access to all sites.
async function checkPermission() {
  if ((!optImages.checked && !optFiles.checked && !optEmbedded.checked && selectedFormat() !== "jex") || !api.permissions) {
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
  } catch (_) {
    btnGrant.hidden = true;
  }
}

btnGrant.addEventListener("click", async () => {
  try {
    const granted = await api.permissions.contains(ALL_SITES);
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

async function send(msg) {
  return api.tabs.sendMessage(tabId, msg);
}

async function init() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const onChatGPT = tab && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "");
  if (!onChatGPT) {
    tabId = null;
    refreshButtons();
    setStatus("Open chatgpt.com in this tab to export.", true);
    return;
  }
  tabId = tab.id;
  try {
    const r = await send({ type: "cgx-ping" });
    hasConversation = r.hasConversation;
    setBusy(r.busy);
    if (r.busy) setStatus("An export is already running in this tab…");
  } catch {
    tabId = null;
    refreshButtons();
    setStatus("Reload the ChatGPT page, then reopen this window.", true);
  }
}

async function run(type) {
  setBusy(true);
  setStatus(type === "cgx-export-all" ? "Loading conversation list…" : "Exporting…");
  if (type === "cgx-export-all") bar.hidden = false;
  try {
    const r = await send({ type, options: currentOptions() });
    if (!r.ok) throw new Error(r.error);
    let text = r.joplin ? "Joplin JEX export ready. Import it with File > Import > JEX." : (r.count > 1 ? `${r.count} conversations exported.` : "Conversation exported.");
    if (r.failed) text += ` ${r.failed} failed; see _errors.txt.`;
    if (r.imageFailures) text += ` ${r.imageFailures} image(s) could not be downloaded; kept as remote links.`;
    if (r.fileFailures) text += ` ${r.fileFailures} file(s) could not be downloaded.`;
    if (currentOptions().embeddedMd && !currentOptions().modernEmbeddedMd) text += " Self-contained MIME/Base64 Markdown included.";
    setStatus(text, !!(r.failed || r.imageFailures));
  } catch (e) {
    setStatus(e.message || "Export failed.", true);
  } finally {
    setBusy(false);
    bar.hidden = true;
  }
}

api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "cgx-progress") return;
  bar.hidden = false;
  bar.max = msg.total;
  bar.value = msg.done;
  setStatus(`Conversation ${Math.min(msg.done + 1, msg.total)} of ${msg.total}…`);
});

[...formatInputs, optImages, optFiles, optJson, optThinking, optBranches, optIncremental, optChecksums, optPartSize].forEach((el) => el.addEventListener("change", saveOptions));
optEmbedded.addEventListener("change", () => {
  saveOptions();
});
btnCurrent.addEventListener("click", () => run("cgx-export-current"));
btnAll.addEventListener("click", () => run("cgx-export-all"));
loadOptions();
updateFormatUI();
checkPermission();
init();
