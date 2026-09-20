// Turns conversation JSON (/backend-api/conversation/{id}) into Markdown and HTML.
// Images are not downloaded here: each image receives a CGXIMG<n>Z marker,
// later replaced with a local path or remote URL (see content.js).
(() => {
  const ROLE_LABELS = { user: "User", assistant: "ChatGPT", thinking: "Thinking" };
  const PUA = /[\uE200-\uE2FF]/;
  const markedLib = globalThis.marked;

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const mdLabel = (s) => String(s ?? "").replace(/([\[\]|\\])/g, "\\$1").replace(/\s+/g, " ").trim();
  const mdUrl = (u) => String(u ?? "").replace(/[\s()<>]/g, (c) => encodeURIComponent(c));

  // Raw HTML that may be present in a response is displayed, never interpreted.
  markedLib.use({
    gfm: true,
    renderer: {
      html(t) {
        return esc(typeof t === "string" ? t : (t && t.text) || "");
      },
    },
  });

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  // ---------- Parcours de l’arbre ----------

  // Messages are stored as a tree (regenerations, edits): walk back from
  // the current node to obtain exactly the displayed thread.
  function linearize(conv, startNode = null) {
    const out = [];
    let nodeId = startNode || conv.current_node;
    while (nodeId && conv.mapping[nodeId]) {
      const node = conv.mapping[nodeId];
      if (node.message) out.push(node.message);
      nodeId = node.parent;
    }
    return out.reverse();
  }

  const isImagePart = (p) => p && typeof p === "object" && p.content_type === "image_asset_pointer";
  const isCanvasPart = (p) => p && typeof p === "object" && p.content_type === "canvas_asset_pointer";
  const isFilePart = (p) => p && typeof p === "object" && /file_asset_pointer|audio_asset_pointer|video_asset_pointer|file_pointer|artifact/.test(p.content_type || "");
  const visibleToolTypes = new Set(["text","multimodal_text","code","execution_output","computer_output","reasoning_recap","system_error","super_widget","sonic_webpage","tether_quote","tether_browsing_display"]);

  function isVisible(msg) {
    const role = msg.author && msg.author.role;
    if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) return false;
    if (role === "tool") {
      const c = msg.content || {};
      const parts = c.parts || [];
      return visibleToolTypes.has(c.content_type) || parts.some((p) => isImagePart(p) || isCanvasPart(p) || isFilePart(p));
    }
    if (role !== "user" && role !== "assistant") return false;
    if (msg.recipient && msg.recipient !== "all") return false; // appel d’outil
    return true;
  }

  // ---------- Reference extraction (sources, images, products) ----------

  // Remove the tracking parameter added by ChatGPT (utm_source=chatgpt.com).
  function cleanUrl(url) {
    try {
      const u = new URL(url);
      if (u.searchParams.get("utm_source") === "chatgpt.com") u.searchParams.delete("utm_source");
      return u.href;
    } catch {
      return url;
    }
  }

  // Walk an arbitrary object to find URLs, separated into images and links.
  // This is a safety net for unknown or malformed reference types.
  function deepUrls(obj, out = { images: [], links: [] }, key = "", depth = 0) {
    if (obj == null || depth > 6) return out;
    if (typeof obj === "string") {
      if (/^https?:\/\//.test(obj)) {
        const isImg = /image|thumb|img|photo|picture|content_url/i.test(key) || /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(obj);
        const list = isImg ? out.images : out.links;
        if (!list.includes(obj)) list.push(obj);
      }
    } else if (Array.isArray(obj)) {
      for (const v of obj) deepUrls(v, out, key, depth + 1);
    } else if (typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) deepUrls(v, out, k, depth + 1);
    }
    return out;
  }

  function linkItems(ref) {
    const raw = [];
    for (const it of [...(ref.items || []), ...(ref.sources || []), ...(ref.fallback_items || [])]) {
      raw.push(it);
      for (const sub of (it && it.supporting_websites) || []) raw.push(sub);
      for (const sub of (it && it.refs) || []) if (sub && sub.url) raw.push(sub);
    }
    const seen = new Set();
    const out = [];
    for (const it of raw) {
      const url = it && (it.url || it.link);
      if (!url) continue;
      const clean = cleanUrl(url);
      if (seen.has(clean)) continue;
      seen.add(clean);
      out.push({ url: clean, title: it.title || "", label: it.attribution || hostOf(clean) || it.title || "source" });
    }
    return out;
  }

  const asUrl = (i) => (typeof i === "string" ? i : i && (i.url || i.content_url || i.image_url));

  function imageItems(ref) {
    const list = ref.images || ref.image_results || ref.items || [];
    let out = list
      .map((im) => {
        if (typeof im === "string") return { candidates: [im], title: "", page: "" };
        let candidates = [im.content_url, im.image_url, im.original, im.src, im.thumbnail_url, im.thumbnail].filter(
          (u) => typeof u === "string"
        );
        if (!candidates.length) candidates = deepUrls(im).images;
        return { candidates, title: im.title || im.alt || "", page: cleanUrl(im.url || im.page_url || im.source_url || "") };
      })
      .filter((x) => x.candidates.length);
    if (!out.length) out = deepUrls(ref).images.map((u) => ({ candidates: [u], title: "", page: "" }));
    return out;
  }

  function productItems(ref) {
    const list = ref.products || ref.items || (ref.product ? [ref.product] : []);
    return list.map((p) => {
      const imgs = p.image_urls || p.images || (p.image_url && [p.image_url]) || [];
      const offer = (p.offers && p.offers[0]) || (p.merchants && p.merchants[0]) || {};
      const found = deepUrls(p);
      const price = [p.price, offer.price, p.price_text].find((x) => typeof x === "string" && x) || "";
      return {
        title: p.title || p.name || "Produit",
        url: cleanUrl(p.url || offer.url || found.links[0] || ""),
        price,
        desc:
          [p.description, p.rationale, p.summary, p.tagline, p.subtitle, p.snippet, p.featured_tag, p.caption].find(
            (x) => typeof x === "string" && x
          ) || "",
        image: imgs.map(asUrl).find(Boolean) || found.images[0] || null,
      };
    });
  }

  // Entity markers without an associated reference contain JSON ["type", "Name", …].
  function clean(text) {
    return text
      .replace(/\uE200entity\uE202(.*?)\uE201/g, (_, json) => {
        try {
          const arr = JSON.parse(json);
          return Array.isArray(arr) ? String(arr[1] ?? "") : "";
        } catch {
          return "";
        }
      })
      .replace(/\uE200[^\uE201]*\uE201/g, "")
      .replace(/[\uE200-\uE2FF]/g, "");
  }

  // ---------- Rendu d’un texte d’assistant ----------

  // Returns { md, html }: markers are replaced with Markdown on one side,
  // and CGXT<n>Z tokens (converted to HTML after marked) on the other.
  function preprocessWritingBlocks(text) {
    return String(text || "").replace(/:::writing\{([^}]*)\}\s*([\s\S]*?)\s*:::/g, (_m, meta, body) => {
      const attrs = {};
      for (const m of meta.matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
      const label = attrs.subject || attrs.title || attrs.variant || "Writing block";
      return `\n\n> **${label}**\n>\n${String(body).trim().split("\n").map((x) => `> ${x}`).join("\n")}\n\n`;
    });
  }

  function fileRefInfo(ref) {
    const f = ref.file || {};
    const id = ref.file_id || ref.asset_id || ref.upload_id || f.id || f.file_id || f.asset_id;
    const name = ref.file_name || ref.filename || ref.title || f.name || f.filename || "file";
    const page = ref.page_number || ref.page || (ref.location && ref.location.page);
    const start = ref.start_line || (ref.location && ref.location.start_line);
    const end = ref.end_line || (ref.location && ref.location.end_line);
    const sandboxPath = ref.sandbox_path || f.sandbox_path || null;
    const messageId = ref.message_id || f.message_id || null;
    const urls = [ref.url, ref.download_url, ref.signed_url, ref.href, f.url, f.download_url, f.signed_url, f.href].filter((x) => typeof x === "string" && x);
    return { id, name, page, start, end, sandboxPath, messageId, urls };
  }

  function renderRichText(text, refs, ctx, messageId = null) {
    text = preprocessWritingBlocks(text);
    // Sandbox links are files generated by ChatGPT. Replace them with a file
    // marker so content.js can try sandbox endpoints, then keep the original
    // link if no endpoint is available for the account.
    text = String(text).replace(/\[([^\]]+)\]\((sandbox:\/[^)]+)\)/g, (_m, label, url) => {
      const ph = ctx.file([url], label || "file", { messageId, sandboxPath: url.replace(/^sandbox:/, "") });
      return `[${label}](${ph})`;
    });
    let md = text;
    let src = text;
    const tokens = new Map();
    const token = (html, block) => {
      const t = `CGXT${tokens.size}Z`;
      tokens.set(t, html);
      return block ? `\n\n${t}\n\n` : t;
    };

    const sorted = refs
      .filter((r) => r && typeof r.matched_text === "string" && PUA.test(r.matched_text))
      .sort((a, b) => b.matched_text.length - a.matched_text.length);

    const galleryHtml = (imgs) =>
      `<div class="gallery">${imgs
        .map((i) => `<a href="${esc(i.page || i.ph)}" title="${esc(i.title)}"><img src="${i.ph}" alt="${esc(i.title)}" loading="lazy"></a>`)
        .join("")}</div>`;
    const galleryMd = (imgs) =>
      "\n\n" +
      imgs.map((i) => (i.page ? `[![${mdLabel(i.title)}](${i.ph})](${mdUrl(i.page)})` : `![${mdLabel(i.title)}](${i.ph})`)).join(" ") +
      "\n\n";
    const citeHtml = (links) => {
      const first = links[0];
      const pop =
        links.length > 1
          ? `<span class="pop">${links.map((l) => `<a href="${esc(l.url)}">${esc(l.title || l.label)}<small>${esc(hostOf(l.url))}</small></a>`).join("")}</span>`
          : "";
      return (
        `<span class="cite"><a href="${esc(first.url)}" title="${esc(first.title || first.url)}">${esc(first.label)}` +
        (links.length > 1 ? `<span class="more">+${links.length - 1}</span>` : "") +
        `</a>${pop}</span>`
      );
    };
    const citeMd = (links) => ` (${links.map((l) => `[${mdLabel(l.label)}](${mdUrl(l.url)})`).join(", ")})`;

    for (const ref of sorted) {
      const type = ref.type || "";
      let mdOut = "";
      let srcOut = "";

      if (type === "hidden" || type === "attribution") {
        // rien
      } else if (/product/.test(type)) {
        const prods = productItems(ref).map((p) => ({ ...p, ph: p.image ? ctx.image([p.image], false) : null }));
        mdOut =
          "\n\n" +
          prods
            .map((p) => {
              const img = p.ph ? (p.url ? `[![${mdLabel(p.title)}](${p.ph})](${mdUrl(p.url)})\n` : `![${mdLabel(p.title)}](${p.ph})\n`) : "";
              const name = p.url ? `**[${mdLabel(p.title)}](${mdUrl(p.url)})**` : `**${mdLabel(p.title)}**`;
              const extra = [p.price, p.desc].filter(Boolean).join(". ");
              return `${img}${name}${extra ? " : " + extra : ""}`;
            })
            .join("\n\n") +
          "\n\n";
        srcOut = token(
          `<div class="carousel">${prods
            .map((p) => {
              const tag = p.url ? "a" : "div";
              const href = p.url ? ` href="${esc(p.url)}"` : "";
              return (
                `<${tag} class="product"${href}>` +
                (p.ph ? `<img src="${p.ph}" alt="" loading="lazy">` : `<span class="noimg"></span>`) +
                `<strong>${esc(p.title)}</strong>` +
                `<span class="meta">${[p.price, p.desc].filter(Boolean).map(esc).join(" • ")}</span>` +
                `</${tag}>`
              );
            })
            .join("")}</div>`,
          true
        );
      } else if (/file|filecite/.test(type)) {
        const info = fileRefInfo(ref);
        const candidates = [];
        if (info.id) candidates.push(`asset:${String(info.id).replace(/^file-service:\/\//, "")}`);
        if (info.sandboxPath) candidates.push(`sandbox:${info.sandboxPath}`);
        candidates.push(...info.urls);
        const ph = candidates.length ? ctx.file(candidates, info.name, { messageId: info.messageId || messageId, sandboxPath: info.sandboxPath }) : null;
        const loc = [info.page != null ? `p. ${info.page}` : "", info.start != null ? `l. ${info.start}${info.end != null ? `-${info.end}` : ""}` : ""].filter(Boolean).join(", ");
        const label = `${info.name}${loc ? ` (${loc})` : ""}`;
        mdOut = ph ? ` [${mdLabel(label)}](${ph})` : ` [${mdLabel(label)}]`;
        srcOut = ph ? `<a class="filecite" href="${ph}">${esc(label)}</a>` : `<span class="filecite">${esc(label)}</span>`;
      } else if (/image/.test(type)) {
        const imgs = imageItems(ref).map((i) => ({ ...i, ph: ctx.image(i.candidates, false) }));
        if (imgs.length) {
          mdOut = galleryMd(imgs);
          srcOut = token(galleryHtml(imgs), true);
        }
      } else if (type === "entity") {
        mdOut = srcOut = ref.alt || ref.name || "";
      } else {
        const links = linkItems(ref);
        if (links.length) {
          mdOut = citeMd(links);
          srcOut = " " + token(citeHtml(links), false);
        } else if (typeof ref.alt === "string" && ref.alt) {
          mdOut = srcOut = ref.alt;
        } else {
        // Unknown type: recover at least the images and links it contains.
          const found = deepUrls(ref);
          if (found.images.length) {
            const imgs = found.images.map((u) => ({ candidates: [u], title: "", page: "", ph: ctx.image([u], false) }));
            mdOut = galleryMd(imgs);
            srcOut = token(galleryHtml(imgs), true);
          } else if (found.links.length) {
            const links = found.links.map((u) => ({ url: cleanUrl(u), title: "", label: hostOf(u) || "lien" }));
            mdOut = citeMd(links);
            srcOut = " " + token(citeHtml(links), false);
          }
        }
      }

      md = md.split(ref.matched_text).join(mdOut);
      src = src.split(ref.matched_text).join(srcOut);
    }

    md = clean(md).replace(/ {2,}\(\[/g, " ([").replace(/\n{3,}/g, "\n\n").trim();
    let html = markedLib.parse(clean(src).replace(/ {2,}(CGXT\d+Z)/g, " $1").trim());
    for (const [t, h] of tokens) html = html.split(`<p>${t}</p>`).join(h).split(t).join(h);
    html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
    return { md, html };
  }

  // ---------- Rendu d’un message ----------

  function thinkingSeconds(text) {
    const source = String(text || '').toLowerCase().replace(',', '.');
    let total = 0;
    for (const match of source.matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|heure|heures|m|min|mins|minute|minutes|s|sec|secs|second|seconds|seconde|secondes)/gi)) {
      const value = Number(match[1]);
      const unit = match[2];
      total += /^(h|hr|hrs|hour|hours|heure|heures)$/.test(unit) ? value * 3600 : /^(m|min|mins|minute|minutes)$/.test(unit) ? value * 60 : value;
    }
    return total;
  }

  function isThinkingDurationOnly(text) {
    return /^(?:worked|thought|reasoned|réfléchi|reflechi|temps de réflexion|thinking)\s*(?:for|pendant|:)?\s*\d+(?:[.,]\d+)?\s*(?:h|hr|hrs|hour|hours|heure|heures|m|min|mins|minute|minutes|s|sec|secs|second|seconds|seconde|secondes)$/i.test(String(text || '').trim().replace(/^\*+|\*+$/g, ''));
  }

  function renderMessage(msg, ctx, options = {}) {
    const role = msg.author.role === "user" ? "user" : "assistant";
    const c = msg.content || {};
    const refs = (msg.metadata && msg.metadata.content_references) || [];
    const mdParts = [];
    const htmlParts = [];

    const addText = (text) => {
      if (!text || !text.trim()) return;
      if (role === "user") {
        // ChatGPT displays user messages as-is, without Markdown interpretation.
        const t = clean(text).trim();
        mdParts.push(t);
        htmlParts.push(`<div class="plain">${esc(t)}</div>`);
      } else {
        const r = renderRichText(text, refs, ctx, msg.id || null);
        if (r.md) mdParts.push(r.md);
        if (r.html.trim()) htmlParts.push(r.html);
      }
    };

    const addAsset = (part) => {
      const id = String(part.asset_pointer || "").replace(/^[a-z-]+:\/\//, "");
      if (!id) return;
      const prompt = (part.metadata && part.metadata.dalle && part.metadata.dalle.prompt) || "";
      const ph = ctx.image([`asset:${id}`], true);
      mdParts.push(`![${mdLabel(prompt || "image")}](${ph})`);
      htmlParts.push(`<figure class="asset"><img src="${ph}" alt="${esc(prompt)}" loading="lazy"></figure>`);
    };

    const addFileAsset = (part, fallback = "file") => {
      const id = String(part.asset_pointer || part.file_id || part.asset_id || "").replace(/^[a-z-]+:\/\//, "");
      const name = part.name || part.filename || part.file_name || (part.metadata && (part.metadata.name || part.metadata.filename || part.metadata.file_name)) || fallback;
      const sandboxPath = part.sandbox_path || (part.metadata && part.metadata.sandbox_path) || null;
      const messageId = part.message_id || (part.metadata && part.metadata.message_id) || msg.id || null;
      const candidates = [];
      if (id) candidates.push(`asset:${id}`);
      if (sandboxPath) candidates.push(`sandbox:${sandboxPath}`);
      for (const u of [part.url, part.download_url, part.signed_url, part.href]) if (typeof u === "string" && u) candidates.push(u);
      if (!candidates.length) return;
      const ph = ctx.file(candidates, name, { messageId, sandboxPath });
      mdParts.push(`[${mdLabel(name)}](${ph})`);
      htmlParts.push(`<p class="attachment"><a href="${ph}">${esc(name)}</a></p>`);
    };

    switch (c.content_type) {
      case "text":
        addText((c.parts || []).filter((p) => typeof p === "string").join("\n\n"));
        break;
      case "multimodal_text":
        for (const p of c.parts || []) {
          if (typeof p === "string") addText(p);
          else if (isImagePart(p)) addAsset(p);
          else if (isCanvasPart(p) || isFilePart(p)) addFileAsset(p, isCanvasPart(p) ? "canvas" : "file");
        }
        break;
      case "reasoning_recap":
        if (!options.thinking) return null;
        if (typeof c.content === "string" && c.content.trim()) return { kind: "thinking", text: c.content.trim(), seconds: thinkingSeconds(c.content) };
        break;
      case "code":
        if (c.text) addText("```" + (c.language && c.language !== "unknown" ? c.language : "") + "\n" + c.text + "\n```");
        break;
      case "execution_output":
      case "computer_output":
      case "system_error":
        addText(c.text || c.content || (c.parts || []).filter((p) => typeof p === "string").join("\n"));
        break;
      case "super_widget":
      case "sonic_webpage":
      case "tether_quote":
      case "tether_browsing_display": {
        const pieces = [];
        const seen = new Set();
        const walk = (v, key = "", depth = 0) => {
          if (v == null || depth > 5) return;
          if (typeof v === "string") {
            if (/^(title|text|content|snippet|description|caption|label|quote|url|href)$/i.test(key) && v.trim() && !seen.has(v)) { seen.add(v); pieces.push(v); }
            return;
          }
          if (Array.isArray(v)) { for (const x of v) walk(x, key, depth + 1); return; }
          if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
        };
        walk(c);
        if (pieces.length) addText(pieces.join("\n\n"));
        break;
      }
      default:
        if (Array.isArray(c.parts)) for (const p of c.parts) { if (typeof p === "string") addText(p); else if (isImagePart(p)) addAsset(p); else if (isCanvasPart(p) || isFilePart(p)) addFileAsset(p); }
        break;
    }

    const meta = msg.metadata || {};
    const files = [...(Array.isArray(meta.attachments) ? meta.attachments : []), ...(Array.isArray(meta.files) ? meta.files : []), ...(Array.isArray(meta.artifacts) ? meta.artifacts : [])];
    for (const f of files) {
      if (!f || typeof f !== "object" || /^image\//.test(f.mime_type || f.content_type || "")) continue;
      const nested = f.file && typeof f.file === "object" ? f.file : {};
      const name = f.name || f.filename || f.file_name || nested.name || nested.filename || "file";
      const id = f.id || f.file_id || f.asset_id || nested.id || nested.file_id || String(f.asset_pointer || nested.asset_pointer || "").replace(/^[a-z-]+:\/\//, "");
      const sandboxPath = f.sandbox_path || nested.sandbox_path || null;
      const messageId = f.message_id || nested.message_id || msg.id || null;
      const candidates = [];
      if (id) candidates.push(`asset:${String(id).replace(/^file-service:\/\//, "")}`);
      if (sandboxPath) candidates.push(`sandbox:${sandboxPath}`);
      for (const u of [f.url, f.download_url, f.signed_url, f.href, nested.url, nested.download_url, nested.signed_url, nested.href]) if (typeof u === "string" && u) candidates.push(u);
      if (candidates.length) {
        const ph = ctx.file(candidates, name, { messageId, sandboxPath });
        mdParts.push(`*Attachment: [${mdLabel(name)}](${ph})*`);
        htmlParts.push(`<p class="attachment">Attachment: <a href="${ph}">${esc(name)}</a></p>`);
      } else {
        mdParts.push(`*Attachment: ${mdLabel(name)}*`);
        htmlParts.push(`<p class="attachment">Attachment: ${esc(name)}</p>`);
      }
    }

    if (!mdParts.some((part) => String(part).trim()) && !htmlParts.some((part) => String(part).trim())) return null;
    return { role, md: mdParts.join("\n\n"), html: htmlParts.join("\n") };
  }

  // ---------- Documents complets ----------

  // Dates arrive as Unix seconds (conversation) or ISO 8601 (history list).
  function toDate(v) {
    if (v == null || v === "") return null;
    const d = typeof v === "number" ? new Date(v * 1000) : new Date(v);
    return isNaN(d) ? null : d;
  }

  function formatDate(v) {
    const d = toDate(v);
    return d ? d.toLocaleString("en-US") : "unknown date";
  }

  function buildTurns(conv, ctx, nodeId = null, options = {}) {
    const turns = [];
    const thinking = [];
    let totalThinkingSeconds = 0;
    for (const msg of linearize(conv, nodeId)) {
      if (!isVisible(msg)) continue;
      const r = renderMessage(msg, ctx, options);
      if (!r) continue;
      if (r.kind === "thinking") {
        totalThinkingSeconds += r.seconds || 0;
        if (!isThinkingDurationOnly(r.text)) thinking.push(r.text);
        continue;
      }
      turns.push({ role: r.role, md: [r.md], html: [r.html], messageId: msg.id || null, createdAt: msg.create_time || null });
    }
    if (options.thinking && (thinking.length || totalThinkingSeconds)) {
      const duration = totalThinkingSeconds ? `*Total thinking time: ${formatThinkingDuration(totalThinkingSeconds)}*` : '';
      const htmlDuration = totalThinkingSeconds ? `<p><em>Total thinking time: ${esc(formatThinkingDuration(totalThinkingSeconds))}</em></p>` : '';
      turns.push({ role: "thinking", md: [[duration, ...thinking].filter(Boolean).join("\n\n")], html: [`${htmlDuration}${thinking.map((text) => `<div class="thought">${esc(text)}</div>`).join("\n")}`], messageId: null, createdAt: null });
    }
    return turns;
  }

  function formatThinkingDuration(seconds) {
    const value = Math.round(seconds);
    const parts = [];
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const rest = value % 60;
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (rest || !parts.length) parts.push(`${rest}s`);
    return parts.join(' ');
  }

  function branchLeaves(conv) {
    const mapping = conv.mapping || {};
    const leaves = [];
    for (const [id, node] of Object.entries(mapping)) {
      if (!node || !node.message) continue;
      const children = Array.isArray(node.children) ? node.children.filter((c) => mapping[c]) : [];
      if (!children.length) leaves.push(id);
    }
    const current = conv.current_node;
    leaves.sort((a, b) => (a === current ? -1 : b === current ? 1 : 0));
    return leaves;
  }

  function toMarkdown(conv, turns) {
    const lines = [`# ${conv.title || "Untitled"}`, ""];
    turns.forEach((t, index) => {
      if (index) lines.push("---", "");
      const content = t.md.join("\n\n");
      if (t.role === "user" && !/[\r\n]/.test(content.trim())) {
        const question = content.trim().replace(/\|/g, "\\|");
        lines.push("| **User question** |", "| :--- |", `| ${question} |`, "");
      } else {
        lines.push(`> **${ROLE_LABELS[t.role]}**`, "", content, "");
      }
    });
    return lines.join("\n").trimEnd() + "\n";
  }

  function toHtml(conv, turns) {
    const title = conv.title || "Untitled";
    const body = turns
      .map((t) => t.role === "user"
        ? `<section class="turn user" aria-label="${ROLE_LABELS.user}"><div class="turn-label">${ROLE_LABELS.user}</div><div class="bubble">${t.html.join("\n")}</div></section>`
        : t.role === "thinking"
          ? `<section class="turn thinking" aria-label="${ROLE_LABELS.thinking}"><div class="turn-label">${ROLE_LABELS.thinking}</div><div class="body">${t.html.join("\n")}</div></section>`
          : `<section class="turn assistant" aria-label="${ROLE_LABELS.assistant}"><div class="turn-label">${ROLE_LABELS.assistant}</div><div class="body">${t.html.join("\n")}</div></section>`)
      .join("\n");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="page">
<header class="conv"><h1>${esc(title)}</h1></header>
${body}
<footer>Exported with ChatGPT Markdown Export.</footer>
</main>
</body>
</html>
`;
  }

  function indexHtml(entries) {
    const rows = entries
      .map((e) => {
        const meta = [e.project ? `Project: ${e.project}` : "", e.archived ? "Archived" : "", e.shared ? "Shared" : "", e.messages != null ? `${e.messages} messages` : "", e.size ? e.size : ""].filter(Boolean).join(" · ");
        const search = `${e.title || ""} ${e.project || ""} ${e.date || ""} ${meta} ${e.search || ""}`.toLowerCase();
        return `<li data-search="${esc(search)}"><div><a href="${esc(e.href)}">${esc(e.title)}</a>${meta ? `<small>${esc(meta)}</small>` : ""}</div><span>${esc(e.date)}</span></li>`;
      })
      .join("\n");
    return `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Export ChatGPT</title><style>${PAGE_CSS}
.search{width:100%;padding:10px 12px;margin:0 0 18px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font:inherit}.index li>div{min-width:0}.index small{display:block;color:var(--muted);font-size:12px;margin-top:2px}
</style></head>
<body><main class="page">
<header class="conv"><h1>ChatGPT Export</h1><p><span id="count">${entries.length}</span> conversation(s)</p></header>
<input id="q" class="search" type="search" placeholder="Search titles, projects, dates…" aria-label="Search">
<ul class="index" id="idx">${rows}</ul>
<script>const q=document.getElementById('q'), rows=[...document.querySelectorAll('#idx li')], count=document.getElementById('count');q.addEventListener('input',()=>{const x=q.value.trim().toLowerCase();let n=0;for(const r of rows){const show=!x||r.dataset.search.includes(x);r.hidden=!show;if(show)n++;}count.textContent=n;});<\/script>
</main></body></html>
`;
  }

  const PAGE_CSS = `
:root{--bg:#ffffff;--ink:#0d0d0d;--muted:#5d5d5d;--line:#e5e5e5;--chip:#f0f0f0;--chip-ink:#4a4a4a;--bubble:#e3ebf8;--bubble-ink:#0d0d0d;--link:#1f5fbf;--card:#f7f7f8;--pop:#ffffff;
--font:ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#000000;--ink:#ececec;--muted:#afafaf;--line:#303030;--chip:#2f2f2f;--chip-ink:#cdcdcd;--bubble:#1c3b73;--bubble-ink:#ffffff;--link:#8ab4f8;--card:#171717;--pop:#2a2a2a}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.75 var(--font);-webkit-font-smoothing:antialiased}
.page{max-width:768px;margin:0 auto;padding:32px 20px 80px}
header.conv{margin-bottom:40px}
header.conv h1{font-size:18px;font-weight:600;line-height:1.4;margin:0}
header.conv p{margin:2px 0 0;color:var(--muted);font-size:13px}
.turn{margin-bottom:40px}
.turn-label{margin-bottom:10px;color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.turn.assistant{border-left:3px solid var(--accent);padding-left:20px}
.turn.user{display:flex;justify-content:flex-end}
.turn.user .turn-label{align-self:flex-start;margin:10px 14px 0 0}
.bubble{background:var(--bubble);color:var(--bubble-ink);padding:10px 20px;border-radius:24px;max-width:70%;line-height:1.6}
.bubble .plain{white-space:pre-wrap;overflow-wrap:anywhere}
.bubble figure{margin:6px 0}
.bubble img{max-width:100%;border-radius:16px}
.thought{color:var(--muted);font-size:15px;margin-bottom:12px}.thinking{border-left:3px solid var(--accent);padding-left:16px;opacity:.9}
.body{overflow-wrap:break-word}
.body p{margin:0 0 16px}
.body strong{font-weight:600}
.body h1{font-size:26px}.body h2{font-size:22px}.body h3{font-size:20px}.body h4{font-size:17px}
.body h1,.body h2,.body h3,.body h4{font-weight:600;line-height:1.35;margin:28px 0 10px}
.body a{color:var(--link);text-decoration:none}
.body ul,.body ol{margin:0 0 16px;padding-left:26px}
.body li{margin:4px 0}
.body hr{border:0;border-top:1px solid var(--line);margin:28px 0}
.body pre{background:var(--card);border-radius:12px;padding:14px 16px;overflow-x:auto;font-size:14px;line-height:1.55}
.body code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.875em}
.body :not(pre)>code{background:var(--chip);padding:2px 5px;border-radius:5px}
.body blockquote{margin:0 0 16px;padding-left:16px;border-left:3px solid var(--line);color:var(--muted)}
.table-wrap{overflow-x:auto;margin:4px 0 20px}
table{border-collapse:collapse;width:100%;font-size:15px;line-height:1.7}
th,td{padding:10px 20px 10px 0;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
th:last-child,td:last-child{padding-right:0}
th{font-weight:600}
tbody tr:last-child td{border-bottom:0}
th[align=right],td[align=right]{text-align:right;white-space:nowrap}
th[align=center],td[align=center]{text-align:center}
.cite{position:relative;display:inline-block;vertical-align:1px}
.cite>a{display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:1;background:var(--chip);color:var(--chip-ink);padding:5px 9px;border-radius:999px;white-space:nowrap;max-width:190px;overflow:hidden;text-overflow:ellipsis}
.cite>a:hover{filter:brightness(1.15)}
.cite .more{opacity:.7}
.cite .pop{display:none;position:absolute;left:0;top:100%;z-index:5;min-width:260px;max-width:360px;background:var(--pop);border:1px solid var(--line);border-radius:12px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.cite:hover .pop,.cite:focus-within .pop{display:block}
.pop a{display:block;padding:6px 8px;border-radius:8px;font-size:13px;line-height:1.35;color:var(--ink)}
.pop a:hover{background:var(--chip)}
.pop small{display:block;color:var(--muted);font-size:11.5px}
.gallery{display:flex;gap:4px;overflow-x:auto;margin:4px 0 20px;scrollbar-width:thin}
.gallery a{flex:0 0 calc((100% - 8px) / 3)}
.gallery img{display:block;width:100%;height:222px;border-radius:12px;object-fit:cover;object-position:top}
.carousel{display:flex;gap:20px;overflow-x:auto;scroll-snap-type:x mandatory;margin:8px 0 24px;padding-bottom:6px;scrollbar-width:thin}
.product{flex:0 0 300px;scroll-snap-align:start;display:flex;flex-direction:column;color:inherit;text-decoration:none}
.body a.product{color:inherit}
.product img,.product .noimg{width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:16px;background:var(--card);display:block;margin-bottom:10px}
.product strong{font-size:16px;font-weight:500;line-height:1.4}
.product .meta{color:var(--muted);font-size:15px;line-height:1.5}
figure.asset{margin:0 0 16px}
figure.asset img{max-width:min(100%,600px);border-radius:24px;display:block}
.attachment{font-size:14px;color:var(--muted)}
.filecite{font-size:12px;background:var(--chip);color:var(--chip-ink);padding:3px 7px;border-radius:999px;text-decoration:none}
.index{list-style:none;padding:0;margin:0}
.index li{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--line)}
.index a{color:var(--link);text-decoration:none}
.index span{color:var(--muted);font-size:14px;white-space:nowrap}
footer{margin-top:56px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
footer code{overflow-wrap:anywhere}
@media (max-width:560px){.bubble{max-width:90%}.gallery a{flex-basis:45%}.gallery img{height:160px}.product{flex-basis:240px}}
`;

  function safeName(conv) {
    const d = toDate(conv.create_time);
    const date = d ? d.toISOString().slice(0, 10) : "sans-date";
    const slug =
      (conv.title || "sans-titre")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase()
        .slice(0, 60) || "sans-titre";
    return `${date}_${slug}`;
  }

  // Image context for a conversation: each distinct image receives a unique marker.
  function createContext() {
    const images = [];
    const files = [];
    const byKey = new Map();
    const fileKey = new Map();
    return {
      images, files,
      image(candidates, isAsset) {
        const key = candidates[0];
        if (byKey.has(key)) return byKey.get(key).ph;
        const entry = { ph: `CGXIMG${images.length}Z`, candidates, isAsset };
        images.push(entry); byKey.set(key, entry); return entry.ph;
      },
      file(candidates, name, meta = {}) {
        const key = `${candidates[0] || ""}|${meta.messageId || ""}`;
        if (fileKey.has(key)) return fileKey.get(key).ph;
        const entry = { ph: `CGXFILE${files.length}Z`, candidates, name: name || `file-${files.length + 1}`, ...meta };
        files.push(entry); fileKey.set(key, entry); return entry.ph;
      },
    };
  }

  globalThis.CGX = { createContext, buildTurns, branchLeaves, toMarkdown, toHtml, indexHtml, safeName, formatDate };
})();
