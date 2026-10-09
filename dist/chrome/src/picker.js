// ChatGPT Export - in-page conversation picker.
// A large modal rendered inside the ChatGPT tab (in a shadow root, so the
// page styles cannot leak in). It talks to content.js through CGX_core.
(() => {
  if (globalThis.CGX_openPicker) return;

  const FORMAT_LABELS = { both: "Markdown + HTML", md: "Markdown", html: "HTML", jex: "Joplin (.jex)" };
  const PERIODS = [["any", "Any time"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 3 months"], ["365", "Last 12 months"], ["custom", "Custom dates…"]];
  const PLACES = [["all", "All locations"], ["active", "Chats"], ["project", "Projects"], ["archived", "Archived"], ["shared", "Shared"]];
  const SORTS = [["recent", "Newest first"], ["oldest", "Oldest first"], ["title-asc", "Title A–Z"], ["title-desc", "Title Z–A"]];
  const CHUNK = 150;
  const DAY = 86400000;

  const ICONS = {
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
    open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>'
  };

  const CSS = `
:host { all: initial; }
:host {
  --bg:#ffffff; --surface:#f6f7f9; --ink:#1d232b; --muted:#5d6775; --line:#e2e5ea; --line-strong:#c9ced6;
  --accent:#2b4c7e; --accent-ink:#ffffff; --accent-soft:rgba(43,76,126,.09);
  --danger:#b42318; --danger-soft:rgba(180,35,24,.08); --ok:#17784a; --ok-soft:rgba(23,120,74,.09);
  --shadow:0 24px 80px rgba(15,20,30,.28);
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--ink);
}
:host([data-theme="dark"]) {
  --bg:#1f2329; --surface:#262b32; --ink:#e8ebef; --muted:#a1abb8; --line:#343b45; --line-strong:#4a5360;
  --accent:#8fb0e0; --accent-ink:#13171c; --accent-soft:rgba(143,176,224,.13);
  --danger:#ff8b80; --danger-soft:rgba(255,139,128,.1); --ok:#6fd19b; --ok-soft:rgba(111,209,155,.1);
  --shadow:0 24px 80px rgba(0,0,0,.6);
  color-scheme: dark;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: 0 0 auto; }
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled { cursor: default; opacity: .45; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.backdrop { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 16px; background: rgba(10,14,20,.55); animation: fade .14s ease-out; }
@keyframes fade { from { opacity: 0; } }
@keyframes rise { from { opacity: 0; transform: translateY(8px) scale(.99); } }
.dialog { position: relative; display: grid; grid-template-rows: auto auto auto auto 1fr auto; width: min(1040px, 100%); height: min(820px, 100%); overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: var(--bg); box-shadow: var(--shadow); animation: rise .16s ease-out; }

.head { display: flex; align-items: flex-start; gap: 16px; padding: 20px 22px 14px; }
.head > div { flex: 1; min-width: 0; }
h2 { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -.01em; }
.sub { margin: 3px 0 0; color: var(--muted); font-size: 13px; }
.icon-btn { display: inline-grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--muted); }
.icon-btn:hover { background: var(--surface); color: var(--ink); }
.icon-btn svg { width: 18px; height: 18px; }

.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 22px 12px; }
.search { position: relative; flex: 1 1 260px; min-width: 200px; }
.search svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--muted); }
.search input[type=search] { width: 100%; padding-left: 34px; }
input[type=search], input[type=date], select { height: 36px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--bg); }
select { padding-right: 6px; }
input::placeholder { color: var(--muted); }
.custom { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
.ghost { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--bg); }
.ghost:not(:disabled):hover { background: var(--surface); }

.selbar { display: flex; align-items: center; gap: 14px; min-height: 42px; padding: 6px 22px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: var(--surface); font-size: 13px; }
.checkall { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; font-weight: 560; }
.sel-info { color: var(--muted); }
.link { padding: 0; border: 0; background: none; color: var(--accent); font-weight: 560; text-decoration: underline; text-underline-offset: 2px; }
.views { display: inline-flex; margin-left: auto; padding: 2px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--bg); }
.views button { height: 28px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font-size: 12.5px; }
.views button[aria-pressed=true] { background: var(--accent-soft); color: var(--ink); font-weight: 600; }
input[type=checkbox] { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); cursor: pointer; flex: 0 0 auto; }

.banner { display: flex; align-items: flex-start; gap: 10px; margin: 10px 22px 0; padding: 10px 12px; border-radius: 8px; border-left: 3px solid var(--accent); background: var(--accent-soft); font-size: 13px; }
.banner.ok { border-color: var(--ok); background: var(--ok-soft); }
.banner.error { border-color: var(--danger); background: var(--danger-soft); }
.banner .msg { flex: 1; white-space: pre-line; }
.banner button { flex: 0 0 auto; }

.list { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 0 8px; }
.rows { margin: 0; padding: 0; list-style: none; }
.row { display: grid; grid-template-columns: auto minmax(0,1fr) auto auto; align-items: center; gap: 12px; padding: 9px 22px; border-bottom: 1px solid var(--line); cursor: pointer; user-select: none; }
.row:hover { background: var(--surface); }
.row.on { background: var(--accent-soft); }
.title { overflow: hidden; font-weight: 540; text-overflow: ellipsis; white-space: nowrap; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.meta:empty { display: none; }
.badge { padding: 0 7px; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--muted); font-size: 11.5px; line-height: 18px; }
.date { min-width: 84px; color: var(--muted); font-size: 12.5px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.open { display: inline-grid; width: 28px; height: 28px; place-items: center; width: 28px; height: 28px; border-radius: 6px; color: var(--muted); opacity: 0; }
.row:hover .open, .open:focus-visible { opacity: 1; }
.open:hover { background: var(--bg); color: var(--accent); }
.empty { display: grid; place-items: center; gap: 10px; min-height: 240px; padding: 30px; color: var(--muted); text-align: center; }
.empty strong { color: var(--ink); font-size: 15px; }
.spinner { width: 28px; height: 28px; border: 3px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.more { padding: 14px; color: var(--muted); font-size: 12.5px; text-align: center; }

.foot { display: flex; align-items: center; gap: 14px; padding: 14px 22px; border-top: 1px solid var(--line); background: var(--bg); }
.foot-left { display: flex; flex: 1; flex-wrap: wrap; align-items: center; gap: 6px 18px; min-width: 0; }
.count { font-weight: 650; }
.count small { color: var(--muted); font-weight: 400; }
.fmt { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
.fmt select { color: var(--ink); }
.foot-right { display: flex; gap: 8px; }
.primary { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 16px; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent); color: var(--accent-ink); font-weight: 650; }
.primary:not(:disabled):hover { filter: brightness(1.08); }
.danger-ghost { height: 38px; padding: 0 14px; border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--line)); border-radius: 8px; background: transparent; color: var(--danger); font-weight: 560; }
.danger-ghost:not(:disabled):hover { background: var(--danger-soft); }
.danger { height: 38px; padding: 0 16px; border: 1px solid var(--danger); border-radius: 8px; background: var(--danger); color: #fff; font-weight: 650; }
:host([data-theme="dark"]) .danger { color: #1b1f24; }
.run { display: flex; flex: 1; align-items: center; gap: 14px; min-width: 0; }
.run-text { flex: 1; min-width: 0; }
.run-label { overflow: hidden; margin-bottom: 6px; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.bar { position: relative; height: 6px; overflow: hidden; border-radius: 99px; background: var(--line); }
.bar i { position: absolute; inset: 0 auto 0 0; width: 0; border-radius: inherit; background: var(--accent); transition: width .25s ease; }
.bar.indeterminate i { width: 35% !important; animation: slide 1.2s ease-in-out infinite; }
@keyframes slide { from { left: -35%; } to { left: 100%; } }

.confirm { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; padding: 16px; background: rgba(10,14,20,.45); }
.confirm-box { width: min(520px, 100%); max-height: 100%; overflow: auto; padding: 22px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg); box-shadow: var(--shadow); animation: rise .14s ease-out; }
.confirm-box h3 { margin: 0 0 8px; font-size: 17px; }
.warn { margin: 0 0 12px; padding: 10px 12px; border-left: 3px solid var(--danger); border-radius: 6px; background: var(--danger-soft); font-size: 13px; }
.preview { max-height: 132px; margin: 0 0 14px; padding-left: 20px; overflow: auto; color: var(--muted); font-size: 13px; }
.opt { display: flex; align-items: flex-start; gap: 10px; margin: 10px 0; font-size: 13.5px; cursor: pointer; }
.opt input { margin-top: 2px; }
.opt small { color: var(--muted); font-size: 12.5px; }
.note { margin: 0 0 12px; padding: 10px 12px; border-left: 3px solid var(--ok); border-radius: 6px; background: var(--ok-soft); font-size: 13px; white-space: pre-line; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }

.pill { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; display: flex; align-items: center; gap: 12px; width: 320px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg); box-shadow: var(--shadow); animation: rise .16s ease-out; }
.pill .run-text { flex: 1; }

@media (max-width: 720px) {
  .backdrop { padding: 0; }
  .dialog { width: 100%; height: 100%; border-radius: 0; border: 0; }
  .head, .toolbar, .selbar, .foot { padding-left: 14px; padding-right: 14px; }
  .row { padding-left: 14px; padding-right: 14px; grid-template-columns: auto minmax(0,1fr) auto; }
  .open { display: none; }
  .foot, .foot-left { flex-wrap: wrap; }
  .foot-right { width: 100%; }
  .foot-right .primary { flex: 1; justify-content: center; }
  .pill { left: 12px; right: 12px; width: auto; }
}
`;

  const HTML = `
<div class="pill" hidden role="status">
  <div class="run-text"><div class="run-label"></div><div class="bar"><i></i></div></div>
  <button class="ghost show" type="button">Show</button>
</div>
<div class="backdrop" hidden>
  <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="cgx-title">
    <header class="head">
      <div>
        <h2 id="cgx-title">Export conversations</h2>
        <p class="sub">1. Find and tick the conversations &nbsp;·&nbsp; 2. Pick a format &nbsp;·&nbsp; 3. Export</p>
      </div>
      <button class="icon-btn close" type="button" aria-label="Close" title="Close (Esc)">${ICONS.close}</button>
    </header>
    <div class="toolbar">
      <label class="search">${ICONS.search}<input class="q" type="search" placeholder="Search titles and projects" aria-label="Search titles and projects"></label>
      <select class="period" aria-label="Last updated">${PERIODS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
      <span class="custom" hidden><input class="from" type="date" aria-label="Updated from"> to <input class="to" type="date" aria-label="Updated until"></span>
      <select class="place" aria-label="Location">${PLACES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
      <select class="sort" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
      <button class="ghost refresh" type="button" title="Scan your ChatGPT history again">${ICONS.refresh}<span>Refresh</span></button>
    </div>
    <div class="selbar">
      <label class="checkall"><input class="all" type="checkbox"><span class="all-label">Select all</span></label>
      <span class="sel-info"></span>
      <div class="views" role="group" aria-label="Show">
        <button type="button" data-view="all" aria-pressed="true">All</button>
        <button type="button" data-view="selected" aria-pressed="false">Selected</button>
      </div>
    </div>
    <div class="banner" hidden role="status"><span class="msg"></span><button class="link banner-action" type="button" hidden></button><button class="link banner-close" type="button">Dismiss</button></div>
    <div class="list">
      <ul class="rows" aria-label="Conversations"></ul>
      <div class="empty" hidden></div>
      <div class="more" hidden></div>
    </div>
    <footer class="foot">
      <div class="foot-left idle-only">
        <span class="count">Nothing selected</span>
        <label class="fmt">Format <select class="format">${Object.entries(FORMAT_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
      </div>
      <div class="foot-right idle-only">
        <button class="danger-ghost delete" type="button" disabled>Delete…</button>
        <button class="primary export" type="button" disabled>${ICONS.download}<span>Export</span></button>
      </div>
      <div class="run" hidden>
        <div class="run-text"><div class="run-label">Working…</div><div class="bar"><i></i></div></div>
        <button class="ghost hide" type="button" title="Keep it running and use ChatGPT meanwhile">Run in background</button>
        <button class="danger-ghost cancel" type="button">Cancel</button>
      </div>
    </footer>
    <div class="confirm" hidden role="alertdialog" aria-modal="true" aria-labelledby="cgx-confirm-title">
      <div class="confirm-box">
        <h3 id="cgx-confirm-title">Delete conversations?</h3>
        <p class="note" hidden></p>
        <p class="warn"><strong>They are removed from your ChatGPT account, not archived, and cannot be restored.</strong> OpenAI then deletes them permanently within 30 days.</p>
        <ul class="preview"></ul>
        <label class="opt backup-row"><input class="backup" type="checkbox" checked><span><strong>Export a backup first</strong> (recommended)<br><small>Exports in the format chosen below the list. Nothing is deleted yet: once the download is done, you check the file and confirm the deletion in a second step.</small></span></label>
        <label class="opt ack-row"><input class="ack" type="checkbox"><span>I understand that deleted conversations cannot be restored.</span></label>
        <div class="confirm-actions"><button class="ghost no" type="button">Cancel</button><button class="danger yes" type="button" disabled>Delete</button></div>
      </div>
    </div>
  </section>
</div>`;

  let host = null, root = null, el = {};
  let items = [], filtered = [], rendered = 0;
  let listComplete = false;
  const selected = new Set();
  let formats = {}, format = "both";
  let phase = "idle"; // idle | loading | running
  let view = "all";
  let anchorKey = null, shiftHeld = false;
  let open = false, lastFocus = null, savedOverflow = "";

  const fmtNumber = (n) => Number(n || 0).toLocaleString();
  const plural = (n, one, many = `${one}s`) => `${fmtNumber(n)} ${n === 1 ? one : many}`;

  function relativeDate(ms) {
    if (!ms) return "Unknown date";
    const date = new Date(ms), now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= startOfToday) return `Today ${date.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}`;
    if (ms >= startOfToday - DAY) return "Yesterday";
    if (ms >= startOfToday - 6 * DAY) return date.toLocaleDateString("en", { weekday: "long" });
    return date.toLocaleDateString("en", { day: "numeric", month: "short", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
  }

  function conversationUrl(item) {
    try {
      const [, id] = JSON.parse(item.key);
      return id && !item.shared ? `${location.origin}/c/${encodeURIComponent(id)}` : null;
    } catch (_) { return null; }
  }

  function detectTheme() {
    const cls = document.documentElement.classList;
    const dark = cls.contains("dark") || (!cls.contains("light") && matchMedia("(prefers-color-scheme: dark)").matches);
    host.dataset.theme = dark ? "dark" : "light";
  }

  function build() {
    host = document.createElement("cgx-export-picker");
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style>${HTML}`;
    const q = (s) => root.querySelector(s);
    el = {
      pill: q(".pill"), pillLabel: q(".pill .run-label"), pillBar: q(".pill .bar"), show: q(".show"),
      backdrop: q(".backdrop"), dialog: q(".dialog"), close: q(".close"),
      toolbar: q(".toolbar"), search: q(".q"), period: q(".period"), custom: q(".custom"), from: q(".from"), to: q(".to"),
      place: q(".place"), sort: q(".sort"), refresh: q(".refresh"),
      selbar: q(".selbar"), all: q(".all"), allLabel: q(".all-label"), selInfo: q(".sel-info"), views: [...root.querySelectorAll(".views button")],
      banner: q(".banner"), bannerMsg: q(".banner .msg"), bannerAction: q(".banner-action"), bannerClose: q(".banner-close"),
      list: q(".list"), rows: q(".rows"), empty: q(".empty"), more: q(".more"),
      idle: [...root.querySelectorAll(".idle-only")], count: q(".count"), format: q(".format"), del: q(".delete"), exp: q(".export"),
      run: q(".run"), runLabel: q(".run .run-label"), runBar: q(".run .bar"), hide: q(".hide"), cancel: q(".cancel"),
      confirm: q(".confirm"), confirmTitle: q("#cgx-confirm-title"), note: q(".note"), warn: q(".warn"), preview: q(".preview"),
      backupRow: q(".backup-row"), backup: q(".backup"), ackRow: q(".ack-row"), ack: q(".ack"), no: q(".no"), yes: q(".yes")
    };

    // Keep ChatGPT's global shortcuts (which focus its composer) from
    // stealing keystrokes typed in the picker.
    for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (event) => event.stopPropagation());
    host.addEventListener("keydown", onKeydown);

    el.close.addEventListener("click", close);
    el.backdrop.addEventListener("mousedown", (event) => { if (event.target === el.backdrop) close(); });
    el.show.addEventListener("click", show);
    el.hide.addEventListener("click", close);
    el.refresh.addEventListener("click", () => load(true));
    el.search.addEventListener("input", applyFilters);
    el.period.addEventListener("change", () => { el.custom.hidden = el.period.value !== "custom"; applyFilters(); });
    for (const input of [el.from, el.to, el.place, el.sort]) input.addEventListener("change", applyFilters);
    el.all.addEventListener("change", () => {
      for (const item of filtered) el.all.checked ? selected.add(item.key) : selected.delete(item.key);
      if (view === "selected" && !el.all.checked) applyFilters(); else paintSelection();
    });
    el.views.forEach((button) => button.addEventListener("click", () => { view = button.dataset.view; applyFilters(); }));
    el.selInfo.addEventListener("click", (event) => {
      if (!event.target.matches(".clear")) return;
      selected.clear();
      if (view === "selected") applyFilters(); else paintSelection();
    });
    el.bannerClose.addEventListener("click", () => { el.banner.hidden = true; });
    el.format.addEventListener("change", () => { format = el.format.value; updateFooter(); });
    el.exp.addEventListener("click", () => runExport([...selected], false));
    el.del.addEventListener("click", () => openConfirm("choose", [...selected]));
    el.cancel.addEventListener("click", () => {
      el.cancel.disabled = true;
      el.cancel.textContent = "Cancelling…";
      globalThis.CGX_core.cancel();
    });
    el.no.addEventListener("click", closeConfirm);
    el.backup.addEventListener("change", updateConfirm);
    el.ack.addEventListener("change", updateConfirm);
    el.yes.addEventListener("click", () => {
      if (!confirmState) return;
      const { mode, keys } = confirmState;
      if (mode === "choose" && el.backup.checked) { closeConfirm(); runExport(keys, true); return; }
      if (!el.ack.checked) return;
      closeConfirm();
      runDelete(keys);
    });

    el.list.addEventListener("scroll", () => {
      if (el.list.scrollTop + el.list.clientHeight > el.list.scrollHeight - 300) renderMore();
    });
    el.rows.addEventListener("mousedown", (event) => { shiftHeld = event.shiftKey; if (event.shiftKey) event.preventDefault(); });
    el.rows.addEventListener("click", onRowClick);
    el.rows.addEventListener("keydown", (event) => { shiftHeld = event.shiftKey; });

    globalThis.CGX_core.onProgress(onProgress);
    document.documentElement.appendChild(host);
  }

  // ---------- Opening & closing ----------

  function show() {
    if (open) return;
    open = true;
    detectTheme();
    lastFocus = document.activeElement;
    savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    el.pill.hidden = true;
    el.backdrop.hidden = false;
    setTimeout(() => (phase === "idle" ? el.search : el.hide).focus(), 30);
  }

  function close() {
    if (!el.confirm.hidden) { closeConfirm(); return; }
    if (!open) return;
    open = false;
    el.backdrop.hidden = true;
    document.documentElement.style.overflow = savedOverflow;
    el.pill.hidden = phase === "idle";
    if (lastFocus && typeof lastFocus.focus === "function") try { lastFocus.focus(); } catch (_) {}
  }

  function onKeydown(event) {
    if (!open) return;
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key !== "Tab") return;
    const scope = el.confirm.hidden ? el.dialog : el.confirm;
    const focusable = [...scope.querySelectorAll("button, input, select, a[href]")].filter((node) => !node.disabled && !node.closest("[hidden]") && !node.closest("[inert]") && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    const active = root.activeElement;
    if (event.shiftKey && (active === first || !scope.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !scope.contains(active))) { event.preventDefault(); first.focus(); }
  }

  // ---------- Loading ----------

  async function load(force = false) {
    const core = globalThis.CGX_core;
    if (phase !== "idle") return;
    if (!force && items.length && listComplete) { applyFilters(); return; }
    if (!force && core.hasCachedList()) { items = core.cachedItems() || []; listComplete = true; applyFilters(); return; }
    if (core.isBusy()) {
      showBanner("Another export is running in this tab. Wait for it to finish, then try again.", "error", "Try again", () => load(force));
      renderEmpty("Busy", "An export started from the extension popup is still running.");
      return;
    }
    listComplete = false;
    setPhase("loading");
    el.banner.hidden = true;
    renderEmpty("loading", "Scanning your ChatGPT history…", "Large histories can take a minute. Archived, project and shared conversations are included.");
    const result = await core.listConversations();
    if (!result.ok) {
      setPhase("idle");
      const cancelled = result.cancelled;
      showBanner(cancelled ? "Scan cancelled. Partial results remain visible; refresh to complete the list." : `Could not load your conversations: ${result.error || "unknown error"}`, cancelled ? "" : "error", "Try again", () => load(true));
      if (items.length) applyFilters(true);
      else renderEmpty(cancelled ? "Scan cancelled" : "Nothing to show", cancelled ? "Click Refresh to scan again." : "Reload the ChatGPT tab if this keeps happening.");
      finish(cancelled ? "Scan cancelled." : "Scan failed. Open to see why.");
      return;
    }
    items = result.items || [];
    listComplete = true;
    const known = new Set(items.map((item) => item.key));
    for (const key of [...selected]) if (!known.has(key)) selected.delete(key);
    setPhase("idle");
    applyFilters(true);
    finish(`${plural(items.length, "conversation")} ready to pick.`);
  }

  // ---------- Filtering & rendering ----------

  function applyFilters(preservePosition = false) {
    const oldScrollTop = preservePosition ? el.list.scrollTop : 0;
    const oldRendered = preservePosition ? rendered : 0;
    const query = el.search.value.trim().toLocaleLowerCase();
    let from = -Infinity, to = Infinity;
    if (el.period.value === "custom") {
      if (el.from.value) from = new Date(`${el.from.value}T00:00:00`).getTime();
      if (el.to.value) to = new Date(`${el.to.value}T23:59:59.999`).getTime();
    } else if (el.period.value !== "any") {
      from = Date.now() - Number(el.period.value) * DAY;
    }
    const place = el.place.value;
    filtered = items.filter((item) => {
      if (view === "selected" && !selected.has(item.key)) return false;
      if (query && !`${item.title} ${item.project}`.toLocaleLowerCase().includes(query)) return false;
      if (from !== -Infinity || to !== Infinity) {
        if (!item.updatedAt || item.updatedAt < from || item.updatedAt > to) return false;
      }
      if (place === "active") return !item.archived && !item.shared && !item.project;
      if (place === "project") return !!item.project;
      if (place === "archived") return item.archived;
      if (place === "shared") return item.shared;
      return true;
    });
    const sort = el.sort.value;
    filtered.sort((a, b) => {
      if (sort === "title-asc" || sort === "title-desc") {
        const order = (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base", numeric: true });
        return sort === "title-asc" ? order : -order;
      }
      return sort === "oldest" ? (a.updatedAt || 0) - (b.updatedAt || 0) : (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    el.views.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === view)));
    el.rows.replaceChildren();
    rendered = 0;
    el.list.scrollTop = oldScrollTop;
    if (!filtered.length) {
      if (!items.length) renderEmpty("No conversations found", "This account has no conversations to export.");
      else if (view === "selected") renderEmpty("Nothing selected yet", "Switch back to All and tick the conversations you want.");
      else renderEmpty("No match", "Try another search, period or location.");
    } else {
      el.empty.hidden = true;
      renderMore();
      while (rendered < Math.min(filtered.length, Math.max(oldRendered, CHUNK))) renderMore();
    }
    paintSelection();
  }

  function renderEmpty(title, text, hint = "") {
    el.rows.replaceChildren();
    el.more.hidden = true;
    el.empty.hidden = false;
    el.empty.replaceChildren();
    const box = document.createElement("div");
    if (title === "loading") {
      const spin = document.createElement("div"); spin.className = "spinner"; spin.style.margin = "0 auto 12px";
      box.appendChild(spin);
      title = text; text = hint; hint = "";
    }
    const strong = document.createElement("strong"); strong.textContent = title;
    const p = document.createElement("div"); p.textContent = text;
    box.append(strong, p);
    if (hint) { const h = document.createElement("div"); h.textContent = hint; box.appendChild(h); }
    el.empty.appendChild(box);
  }

  function renderMore() {
    if (rendered >= filtered.length) return;
    const fragment = document.createDocumentFragment();
    const accounts = new Set(items.map((item) => item.accountId || ""));
    for (const item of filtered.slice(rendered, rendered + CHUNK)) {
      const row = document.createElement("li");
      row.className = "row";
      row.dataset.key = item.key;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.setAttribute("aria-label", item.title);
      const main = document.createElement("div");
      const title = document.createElement("div"); title.className = "title"; title.textContent = item.title; title.title = item.title;
      const meta = document.createElement("div"); meta.className = "meta";
      const badges = [item.project, item.archived && "Archived", item.shared && "Shared", accounts.size > 1 && item.accountLabel].filter(Boolean);
      for (const text of badges) { const b = document.createElement("span"); b.className = "badge"; b.textContent = text; meta.appendChild(b); }
      main.append(title, meta);
      const date = document.createElement("time");
      date.className = "date";
      date.textContent = relativeDate(item.updatedAt);
      if (item.updatedAt) { date.dateTime = new Date(item.updatedAt).toISOString(); date.title = new Date(item.updatedAt).toLocaleString("en"); }
      row.append(box, main, date);
      const url = conversationUrl(item);
      const link = document.createElement(url ? "a" : "span");
      link.className = "open";
      if (url) {
        link.href = url; link.target = "_blank"; link.rel = "noopener";
        link.title = "Open in a new tab"; link.setAttribute("aria-label", `Open “${item.title}” in a new tab`);
        link.innerHTML = ICONS.open;
      }
      row.appendChild(link);
      fragment.appendChild(row);
    }
    rendered = Math.min(filtered.length, rendered + CHUNK);
    el.rows.appendChild(fragment);
    el.more.hidden = rendered >= filtered.length;
    el.more.textContent = `Showing ${fmtNumber(rendered)} of ${fmtNumber(filtered.length)}${!listComplete ? " loaded so far" : ""} — scroll for more`;
    paintRows();
  }

  function onRowClick(event) {
    if (phase === "running" || event.target.closest("a")) return;
    const row = event.target.closest(".row");
    if (!row) return;
    const key = row.dataset.key;
    const turnOn = event.target.matches("input") ? event.target.checked : !selected.has(key);
    if (shiftHeld && anchorKey) {
      const a = filtered.findIndex((item) => item.key === anchorKey), b = filtered.findIndex((item) => item.key === key);
      if (a >= 0 && b >= 0) {
        for (const item of filtered.slice(Math.min(a, b), Math.max(a, b) + 1)) turnOn ? selected.add(item.key) : selected.delete(item.key);
      }
    } else {
      turnOn ? selected.add(key) : selected.delete(key);
    }
    anchorKey = key;
    shiftHeld = false;
    paintSelection();
  }

  function paintRows() {
    for (const row of el.rows.children) {
      const on = selected.has(row.dataset.key);
      row.classList.toggle("on", on);
      row.firstChild.checked = on;
      row.firstChild.disabled = phase === "running";
    }
  }

  function paintSelection() {
    paintRows();
    const shownSelected = filtered.reduce((n, item) => n + (selected.has(item.key) ? 1 : 0), 0);
    el.all.checked = filtered.length > 0 && shownSelected === filtered.length;
    el.all.indeterminate = shownSelected > 0 && shownSelected < filtered.length;
    el.all.disabled = !filtered.length || phase === "running";
    const filteredOut = filtered.length !== items.length && view === "all";
    el.allLabel.textContent = !filtered.length ? "Select all" : `Select all ${fmtNumber(filtered.length)}${filteredOut ? " shown" : ""}`;
    el.selInfo.replaceChildren();
    if (selected.size) {
      el.selInfo.append(`${fmtNumber(selected.size)} selected · `);
      const clear = document.createElement("button");
      clear.type = "button"; clear.className = "link clear"; clear.textContent = "Clear";
      el.selInfo.appendChild(clear);
    } else if (items.length) {
      el.selInfo.textContent = `${plural(items.length, "conversation")}${!listComplete ? phase === "loading" ? " loaded so far · scanning more…" : " loaded so far · scan incomplete" : " in total · Shift-click to select a range"}`;
    }
    el.views[1].textContent = selected.size ? `Selected (${fmtNumber(selected.size)})` : "Selected";
    updateFooter();
  }

  function updateFooter() {
    const n = selected.size;
    const shown = new Set(filtered.map((item) => item.key));
    const hidden = [...selected].filter((key) => !shown.has(key)).length;
    el.count.replaceChildren(n ? plural(n, "conversation") + " selected" : "Nothing selected");
    if (hidden && view === "all") {
      const small = document.createElement("small");
      small.textContent = ` (${fmtNumber(hidden)} hidden by filters)`;
      el.count.appendChild(small);
    }
    el.exp.disabled = !n || phase !== "idle" || !listComplete;
    el.del.disabled = !n || phase !== "idle" || !listComplete;
    el.exp.querySelector("span").textContent = n ? `Export ${plural(n, "conversation")}` : "Export";
    el.exp.title = n ? `Download as ${FORMAT_LABELS[format]}` : "Tick at least one conversation first";
  }

  function setPhase(next) {
    phase = next;
    const locked = phase === "running";
    for (const node of [el.toolbar, el.selbar]) node.toggleAttribute("inert", locked);
    el.idle.forEach((node) => { node.hidden = phase !== "idle"; });
    el.run.hidden = !locked;
    if (phase === "loading") el.run.hidden = false;
    el.refresh.disabled = phase !== "idle";
    el.cancel.disabled = false;
    el.cancel.textContent = "Cancel";
    if (phase === "running") setProgress(0, "Starting…");
    if (phase === "loading") setProgress(0, "Scanning your ChatGPT history…", true);
    paintSelection();
  }

  // Called when a job ends. If the user sent it to the background, the pill
  // stays with the outcome instead of the modal popping up by itself.
  function finish(summary) {
    if (open) { el.pill.hidden = true; return; }
    el.pill.hidden = false;
    el.pillBar.classList.remove("indeterminate");
    el.pillBar.firstChild.style.width = "100%";
    el.pillLabel.textContent = summary;
    el.pillLabel.title = summary;
  }

  // ---------- Progress ----------

  function setProgress(percent, label, indeterminate = false) {
    for (const [bar, text] of [[el.runBar, el.runLabel], [el.pillBar, el.pillLabel]]) {
      bar.classList.toggle("indeterminate", indeterminate);
      bar.firstChild.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      text.textContent = indeterminate ? label : `${Math.round(percent)}% · ${label}`;
      text.title = label;
    }
  }

  function onProgress(state) {
    if (!state) return;
    if (phase === "loading" && Array.isArray(state.items) && state.items.length) receiveItems(state.items);
    if (phase === "loading") setProgress(state.percent || 0, state.label || "Scanning…", true);
    if (phase === "running") setProgress(state.percent || 0, state.label || "Working…", !state.percent);
  }

  function receiveItems(batch) {
    const byKey = new Map(items.map((item) => [item.key, item]));
    for (const item of batch) {
      if (!item || !item.key) continue;
      const previous = byKey.get(item.key);
      byKey.set(item.key, previous ? {
        ...previous,
        ...item,
        archived: !!(previous.archived || item.archived),
        shared: !!(previous.shared || item.shared),
        project: item.project || previous.project || ""
      } : item);
    }
    items = [...byKey.values()];
    applyFilters(true);
  }

  // ---------- Actions ----------

  function exportOptions() {
    return formats[format] || { format, md: format !== "html", html: format === "html" || format === "both" };
  }

  // Deletion is always a separate, explicit decision:
  // - "choose": opened from Delete…. With "Export a backup first" ticked it
  //   only exports; nothing is deleted at that stage.
  // - "after-export": offered once an export finished. It lists only the
  //   conversations that were exported successfully, and the user confirms
  //   after checking the downloaded file. Browsers can block or cancel a
  //   download without the page knowing, so we never delete automatically.
  let confirmState = null;

  function openConfirm(mode, keys, exportInfo = "") {
    const chosen = items.filter((item) => keys.includes(item.key));
    if (!chosen.length || phase !== "idle") return;
    confirmState = { mode, keys: chosen.map((item) => item.key) };
    el.preview.replaceChildren();
    for (const item of chosen.slice(0, 8)) { const li = document.createElement("li"); li.textContent = item.title; el.preview.appendChild(li); }
    if (chosen.length > 8) { const li = document.createElement("li"); li.textContent = `…and ${fmtNumber(chosen.length - 8)} more`; el.preview.appendChild(li); }
    const shown = new Set(filtered.map((item) => item.key));
    const hidden = chosen.filter((item) => !shown.has(item.key)).length;
    if (hidden && mode === "choose") { const li = document.createElement("li"); li.textContent = `Including ${plural(hidden, "conversation")} hidden by your current filters.`; li.style.fontWeight = "600"; el.preview.appendChild(li); }
    el.note.hidden = mode !== "after-export";
    el.note.textContent = exportInfo;
    el.backupRow.hidden = mode !== "choose";
    el.backup.checked = true;
    el.ack.checked = false;
    updateConfirm();
    el.confirm.hidden = false;
    el.no.focus();
  }

  function updateConfirm() {
    if (!confirmState) return;
    const n = confirmState.keys.length;
    const exportFirst = confirmState.mode === "choose" && el.backup.checked;
    el.confirmTitle.textContent = exportFirst ? `Back up ${plural(n, "conversation")} before deleting` : `Delete ${plural(n, "conversation")} from ChatGPT?`;
    el.warn.hidden = exportFirst;
    el.ackRow.hidden = exportFirst;
    el.yes.className = exportFirst ? "primary yes" : "danger yes";
    el.yes.disabled = !exportFirst && !el.ack.checked;
    el.yes.textContent = exportFirst ? `Export ${fmtNumber(n)} as ${FORMAT_LABELS[format]}` : `Delete ${fmtNumber(n)} permanently`;
  }

  function closeConfirm() {
    el.confirm.hidden = true;
    confirmState = null;
    el.del.focus();
  }

  async function runJob(actions) {
    const core = globalThis.CGX_core;
    if (!actions.length || phase !== "idle" || !listComplete) return null;
    if (core.isBusy()) { showBanner("Another export is already running in this tab. Wait for it to finish.", "error"); return null; }
    el.banner.hidden = true;
    setPhase("running");
    el.hide.focus();
    const result = await core.runActions(actions, exportOptions());
    setPhase("idle");
    if (!result.ok) {
      if (result.cancelled) showBanner("Cancelled. Nothing else will be exported or deleted.", "");
      else if (/load the conversation list again/i.test(result.error || "")) showBanner("The conversation list is out of date.", "error", "Refresh list", () => load(true));
      else showBanner(`Something went wrong: ${result.error || "unknown error"}`, "error");
      finish(result.cancelled ? "Cancelled." : "Something went wrong. Open to see why.");
      return null;
    }
    return result;
  }

  async function runExport(keys, thenAskToDelete) {
    const result = await runJob(keys.map((key) => ({ key, action: "export" })));
    if (!result) return;
    const exp = result.exportResult;
    const lines = [];
    let problem = false;
    let exportedKeys = [];
    if (exp) {
      const failed = new Set((exp.failedIds || []).map((entry) => JSON.stringify([entry.accountId || "", entry.id || ""])));
      exportedKeys = keys.filter((key) => !failed.has(key));
      const target = exp.joplinHistory || exp.joplin ? "Import the downloaded .jex file into Joplin (File › Import › JEX)." : "Check your browser’s downloads.";
      lines.push(`${plural(exportedKeys.length, "conversation")} exported as ${FORMAT_LABELS[format]}. ${target}`);
      if (exp.failed) { problem = true; lines.push(`${plural(exp.failed, "conversation")} could not be exported (see the _erreurs.txt file in the archive). They will not be offered for deletion.`); }
      if (exp.imageFailures) lines.push(`${plural(exp.imageFailures, "image")} could not be downloaded and stayed as links.`);
      if (exp.fileFailures) lines.push(`${plural(exp.fileFailures, "file")} could not be downloaded.`);
    } else {
      problem = true;
      lines.push(`Export did not complete${result.exportError ? `: ${result.exportError}` : "."} Nothing can be deleted.`);
    }
    const offerDelete = () => openConfirm("after-export", exportedKeys,
      `${lines[0]}\nOpen the downloaded file and make sure it is complete before deleting. Only the conversations exported successfully are listed below.`);
    showBanner(lines.join("\n"), problem ? "error" : "ok", exportedKeys.length ? `Delete these ${fmtNumber(exportedKeys.length)} from ChatGPT…` : "", exportedKeys.length ? offerDelete : null, true);
    if (thenAskToDelete && exportedKeys.length) {
      if (open) offerDelete();
      else finish("Backup exported. Open to confirm the deletion.");
      return;
    }
    finish(problem ? "Export done, with some problems. Open to see details." : "Export done. Open to see the summary.");
  }

  async function runDelete(keys) {
    const result = await runJob(keys.map((key) => ({ key, action: "delete" })));
    if (!result) return;
    const deletes = result.deleteResults || [];
    const ok = deletes.filter((entry) => entry.ok);
    const failed = deletes.filter((entry) => !entry.ok);
    const lines = [`${plural(ok.length, "conversation")} permanently deleted.`];
    if (failed.length) {
      const names = failed.slice(0, 3).map((entry) => `“${entry.title}”`).join(", ");
      lines.push(`${plural(failed.length, "conversation")} kept: ${names}${failed.length > 3 ? "…" : ""} (${failed[0].error || "deletion failed"}).`);
    }
    const removed = new Set(ok.map((entry) => entry.key));
    items = items.filter((item) => !removed.has(item.key));
    for (const key of removed) selected.delete(key);
    applyFilters(true);
    showBanner(lines.join("\n"), failed.length ? "error" : "ok");
    finish(failed.length ? "Deletion done, with some problems. Open to see details." : "Deletion done.");
  }

  function showBanner(text, tone = "", actionLabel = "", action = null, keepOpen = false) {
    el.banner.className = `banner${tone ? ` ${tone}` : ""}`;
    el.banner.setAttribute("role", tone === "error" ? "alert" : "status");
    el.bannerMsg.textContent = text;
    el.bannerAction.hidden = !action;
    el.bannerAction.textContent = actionLabel;
    el.bannerAction.onclick = action ? () => { if (!keepOpen) el.banner.hidden = true; action(); } : null;
    el.banner.hidden = false;
  }

  globalThis.CGX_openPicker = (formatOptions = {}, initialFormat = "both") => {
    if (!globalThis.CGX_core) return;
    if (!host || !host.isConnected) build();
    formats = formatOptions || {};
    if (phase === "idle" && FORMAT_LABELS[initialFormat]) { format = initialFormat; el.format.value = format; }
    show();
    if (phase === "idle") load(false);
  };
})();
