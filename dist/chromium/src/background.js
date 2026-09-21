// Downloads images hosted outside chatgpt.com (search thumbnails, products).
// A content script cannot bypass CORS in Chrome; the background context can
// do so with host permission.
const api = globalThis.browser ?? globalThis.chrome;
const FETCH_TIMEOUT_MS = 20000;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "cgx-fetch") return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  fetch(msg.url, { credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type") || "";
      sendResponse({ ok: true, type, data: toBase64(await res.arrayBuffer()) });
    })
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }))
    .finally(() => clearTimeout(timer));
  return true;
});
