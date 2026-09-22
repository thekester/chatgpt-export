// ChatGPT Export v0.6.20 - content script
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const pageFetch = globalThis.content && globalThis.content.fetch ? globalThis.content.fetch.bind(globalThis.content) : fetch;
  const PAGE_SIZE = 100;
  const DELAY_MS = 300;
  const JEX_CONVERSATION_DELAY_MS = 600;
  const MIME_EXT = {
    "image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif","image/svg+xml":"svg","image/avif":"avif",
    "application/pdf":"pdf","text/plain":"txt","text/csv":"csv","application/json":"json","application/zip":"zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":"docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":"pptx"
  };

  const EXT_MIME = {
    jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", webp:"image/webp", gif:"image/gif", svg:"image/svg+xml", avif:"image/avif",
    pdf:"application/pdf", txt:"text/plain", md:"text/markdown", csv:"text/csv", json:"application/json", zip:"application/zip",
    docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation",
    html:"text/html", htm:"text/html", xml:"application/xml", js:"text/javascript", css:"text/css",
    mp3:"audio/mpeg", wav:"audio/wav", ogg:"audio/ogg", mp4:"video/mp4", webm:"video/webm"
  };

  let sessionCache = null;
  let busy = false;
  let progressState = null;
  let activityState = [];
  let lastExportState = null;
  let liveFailureDetails = [];
  let lastProgressFailureCount = 0;
  const capabilityState = {};
  const diagnosticEvents = [];
  const DIAGNOSTIC_LIMIT = 250;

  function redactDiagnosticText(value) {
    return String(value == null ? '' : value)
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer <redacted>')
      .replace(/([?&](?:access_token|token|auth|key|signature|sig)=)[^&#\s]+/gi, '$1<redacted>')
      .replace(/(\/(?:conversation|share|files(?:\/download)?)\/)[A-Za-z0-9_-]{8,}/gi, '$1<id>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
  }

  function diagnosticDetails(value, depth = 0) {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return redactDiagnosticText(value);
    if (value instanceof Error) return {name:value.name||'Error', message:redactDiagnosticText(value.message||value), stack:value.stack?redactDiagnosticText(value.stack):null, status:value.status||null};
    if (depth > 3) return '[truncated]';
    if (Array.isArray(value)) return value.slice(0, 30).map(v=>diagnosticDetails(v, depth+1));
    if (typeof value === 'object') {
      const out={};
      for (const [k,v] of Object.entries(value)) {
        if (/token|authorization|cookie|content|message|text|body|data/i.test(k)) { out[k]='<omitted>'; continue; }
        out[k]=diagnosticDetails(v, depth+1);
      }
      return out;
    }
    return redactDiagnosticText(value);
  }

  function diag(event, details = null) {
    diagnosticEvents.push({at:new Date().toISOString(), event, ...(details==null?{}:{details:diagnosticDetails(details)})});
    if (diagnosticEvents.length > DIAGNOSTIC_LIMIT) diagnosticEvents.splice(0, diagnosticEvents.length-DIAGNOSTIC_LIMIT);
  }

  function resetDiagnostics(kind, opts = null) {
    diagnosticEvents.length=0;
    diag('export.start',{kind, options:opts ? {
      format:opts.format||null, md:!!opts.md, html:!!opts.html, images:!!opts.images, files:!!opts.files, json:!!opts.json,
      thinking:!!opts.thinking, embeddedMd:!!opts.embeddedMd, modernEmbeddedMd:!!opts.modernEmbeddedMd, branches:!!opts.branches,
      incremental:!!opts.incremental, checksums:!!opts.checksums, partSizeMB:opts.partSizeMB
    }:null});
  }

  function safeDiagnosticPath() {
    return location.pathname.split('/').map(part=>/^[A-Za-z0-9_-]{16,}$/.test(part)?`<id:${part.length}>`:part).join('/');
  }

  function targetDiagnosticSummary() {
    const t=currentTarget();
    if(!t)return null;
    return {type:t.type, shareRoute:t.shareRoute||null, id_length:String(t.id||'').length};
  }

  function diagnosticSnapshot(extra = {}) {
    let version='unknown'; try{version=api.runtime.getManifest().version||'unknown';}catch(_){}
    return {
      schema:1, extension_version:version, generated_at:new Date().toISOString(),
      page:{origin:location.origin, path:safeDiagnosticPath()}, target:targetDiagnosticSummary(), busy,
      capabilities:capabilitySnapshot(), events:diagnosticEvents.slice(), ...diagnosticDetails(extra)
    };
  }

  function diagnosticLog(extra = {}) {
    return JSON.stringify({
      notice:'Diagnostic log generated locally. Conversation text, authentication tokens, query strings, and raw message content are intentionally omitted.',
      ...diagnosticSnapshot(extra)
    },null,2)+'\n';
  }
  function setCapability(name, status, detail = '') {
    const prev = capabilityState[name];
    if (prev && prev.status === 'available' && status !== 'available') return;
    capabilityState[name] = { status, detail: redactDiagnosticText(detail || ''), checked_at: new Date().toISOString() };
    diag('capability',{name,status,detail});
  }
  function capabilitySnapshot() { return JSON.parse(JSON.stringify(capabilityState)); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getSession(force = false) {
    if (sessionCache && !force) return sessionCache;
    const res = await pageFetch('/api/auth/session', {credentials:'include', cache:'no-store'});
    if (!res.ok) throw new Error(`Session not found (HTTP ${res.status}). Sign in to ChatGPT again.`);
    const data = await res.json();
    // Certains workspaces utilisent surtout les cookies de session. Le Bearer token est
    // Used when available, but its absence must not prevent DOM/cookie fallbacks.
    if (!data.accessToken) setCapability('bearer_token', 'unavailable', 'Session sans accessToken; mode cookies/fallback.');
    else setCapability('bearer_token', 'available');
    sessionCache = data;
    return data;
  }

  function cookieAccountId() {
    const m = document.cookie.match(/(?:^|;\s*)_account=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function collectAccountIds(session) {
    const ids = [];
    const add = (x) => { if (typeof x === 'string' && x && !ids.includes(x)) ids.push(x); };
    add(session && session.account && session.account.id);
    add(session && session.activeAccount && (session.activeAccount.id || session.activeAccount.account_id));
    add(session && session.workspace && (session.workspace.id || session.workspace.account_id || session.workspace.workspace_id));
    add(session && session.accountId);
    add(session && session.user && session.user.account_id);
    for (const arr of [session && session.accounts, session && session.workspaces, session && session.user && session.user.accounts, session && session.user && session.user.workspaces]) {
      if (Array.isArray(arr)) for (const a of arr) add(typeof a === 'string' ? a : a && (a.id || a.account_id || a.workspace_id));
    }
    add(cookieAccountId());
    setCapability('workspace_discovery', ids.length ? 'available' : 'fallback', `${ids.length} workspace/account ID(s) detected`);
    return ids.length ? ids : [null];
  }

  async function authFetch(url, attempt = 0, accountId = null, allowAccountFallback = true) {
    const session = await getSession();
    const headers = {Accept:'*/*'};
    if (session.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
    if (accountId) headers['ChatGPT-Account-ID'] = accountId;
    let res = await pageFetch(url, {credentials:'include', cache:'no-store', headers});
    if (res.status === 429 && attempt < 5) { const delayMs=1000*2**attempt; diag('api.retry',{status:429,attempt:attempt+1,delay_ms:delayMs,url}); await sleep(delayMs); return authFetch(url, attempt + 1, accountId, allowAccountFallback); }
    if (res.status === 401 && attempt === 0) { await getSession(true); return authFetch(url, 1, accountId, allowAccountFallback); }
    // On some personal/Business accounts, the explicit account header may be
    // rejected even though the cookie already points to the correct workspace. Retry without it.
    if (accountId && allowAccountFallback && (res.status === 403 || res.status === 404)) {
      const h2 = {...headers}; delete h2['ChatGPT-Account-ID'];
      const fallback = await pageFetch(url, {credentials:'include', cache:'no-store', headers:h2});
      if (fallback.ok) { setCapability('account_header_fallback', 'available', 'Request succeeded without ChatGPT-Account-ID.'); return fallback; }
    }
    if (!res.ok) { const e = new Error(`HTTP ${res.status} sur ${url}`); e.status = res.status; diag('api.error',{status:res.status,url}); throw e; }
    return res;
  }
  const apiGet = async (path, accountId = null) => (await authFetch(path, 0, accountId)).json();
  async function tryApiGet(path, accountId = null, capability = null) {
    try { const data = await apiGet(path, accountId); if (capability) setCapability(capability, 'available'); return {ok:true,data,status:200}; }
    catch (e) { if (capability) setCapability(capability, 'unavailable', e.message); return {ok:false,data:null,status:e.status||0,error:e}; }
  }

  function b64ToBytes(b64) {
    const bin=atob(b64), out=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
    return out;
  }

  async function resolveAsset(fileId, convId, accountId) {
    const id = String(fileId || '').replace(/^file-service:\/\//, '');
    const variants = [
      `/backend-api/files/download/${encodeURIComponent(id)}?conversation_id=${encodeURIComponent(convId)}&inline=false`,
      `/backend-api/files/download/${encodeURIComponent(id)}?conversation_id=${encodeURIComponent(convId)}`,
      `/backend-api/files/${encodeURIComponent(id)}/download?conversation_id=${encodeURIComponent(convId)}`
    ];
    let last = null;
    for (const path of variants) {
      const r = await tryApiGet(path, accountId, 'file_asset_download');
      if (!r.ok) { last = r.error; continue; }
      const u = r.data && (r.data.download_url || r.data.url || r.data.signed_url);
      if (u) return new URL(u, location.origin).href;
    }
    throw last || new Error('Download URL is missing');
  }

  async function fetchSandboxBytes(convId, messageId, sandboxPath, accountId) {
    if (!sandboxPath) throw new Error('sandbox_path absent');
    const qs = new URLSearchParams({sandbox_path:String(sandboxPath).replace(/^sandbox:/,'' )});
    if (messageId) qs.set('message_id', messageId);
    const base = `/backend-api/conversation/${encodeURIComponent(convId)}`;
    const variants = [
      `${base}/download_from_sandbox/v2?${qs}`,
      `${base}/interpreter/download?${qs}`,
      `${base}/download_from_sandbox?${qs}`
    ];
    let last = null;
    for (const path of variants) {
      try {
        const res = await authFetch(path, 0, accountId);
        const type = res.headers.get('content-type') || '';
        if (/application\/json/i.test(type)) {
          const data = await res.json();
          const u = data && (data.download_url || data.url || data.signed_url);
          if (!u) throw new Error('Sandbox response has no download_url');
          const out = await fetchBytes(u, accountId);
          setCapability('sandbox_download', 'available', path.split('?')[0]);
          return out;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!bytes.length) throw new Error('Fichier sandbox vide');
        setCapability('sandbox_download', 'available', path.split('?')[0]);
        return {type, bytes};
      } catch (e) { last = e; }
    }
    setCapability('sandbox_download', 'unavailable', last && last.message);
    throw last || new Error('Sandbox download unavailable');
  }

  async function fetchBytes(url, accountId = null) {
    const u = new URL(url, location.origin);
    if (u.origin === location.origin) {
      const res = await authFetch(u.href, 0, accountId);
      return {type:res.headers.get('content-type')||'', bytes:new Uint8Array(await res.arrayBuffer())};
    }
    const r = await api.runtime.sendMessage({type:'cgx-fetch', url:u.href});
    if (!r || !r.ok) { const e=new Error((r && r.error) || 'Download failed'); diag('external-media.error',{host:u.hostname,error:e}); throw e; }
    return {type:r.type||'', bytes:b64ToBytes(r.data)};
  }

  function cleanFilename(name, fallback='file') {
    const s=String(name||fallback).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').trim();
    return (s || fallback).slice(0,180);
  }

  function extensionFor(type,url,name='') {
    const t=String(type||'').split(';')[0].trim().toLowerCase();
    if (MIME_EXT[t]) return MIME_EXT[t];
    const m=String(name||url).match(/\.([a-z0-9]{1,8})(?:[?#]|$)/i);
    return m ? m[1].toLowerCase() : 'bin';
  }

  function mimeFor(type, url='', name='') {
    const t=String(type||'').split(';')[0].trim().toLowerCase();
    if (t && t !== 'application/octet-stream' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(t)) return t;
    const ext=extensionFor('', url, name);
    return EXT_MIME[ext] || (t || 'application/octet-stream');
  }

  function bytesToBase64(bytes) {
    // Chaque bloc non final a une taille multiple de 3 : ses fragments Base64 peuvent
    // concatenated without invalid intermediate padding. This limits peak memory usage.
    const chunk=3*8192; let out='';
    for(let i=0;i<bytes.length;i+=chunk){
      const end=Math.min(i+chunk,bytes.length);
      let part='';
      for(let j=i;j<end;j++) part+=String.fromCharCode(bytes[j]);
      out+=btoa(part);
    }
    return out;
  }

  function dataUri(file) {
    const bytes=file.content instanceof Uint8Array ? file.content : new Uint8Array(file.content);
    return `data:${mimeFor(file.mime,'',file.name)};base64,${bytesToBase64(bytes)}`;
  }

  function yamlValue(value) {
    return JSON.stringify(String(value ?? '').replace(/\r?\n/g, ' ').trim());
  }

  function joplinDate(value) {
    if (value == null || value === '') return null;
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function embedAssetsInMarkdown(markdown, assetFiles, prefix='', modern=false, conv=null, source={}) {
    let out=String(markdown||'');
    // Les documents de branche peuvent utiliser ../images/... alors que le document principal
    // utilise images/.... On remplace les deux formes, ainsi que ./... .
    if (!modern) {
      const entries=[];
      for(const f of assetFiles){
        let rel=f.name;
        if(prefix && rel.startsWith(prefix)) rel=rel.slice(prefix.length);
        if(!/^(?:images|files)\//.test(rel)) continue;
        entries.push({rel,uri:dataUri(f)});
      }
      entries.sort((a,b)=>b.rel.length-a.rel.length);
      for(const {rel,uri} of entries){
        for(const candidate of [`../${rel}`,`./${rel}`,rel]) out=out.split(candidate).join(uri);
      }
      return out;
    }
    const title = conv && conv.title ? conv.title : 'Untitled';
    const created = joplinDate(conv && conv.create_time);
    const updated = joplinDate(conv && conv.update_time);
    const conversationId = conv && (conv.conversation_id || conv.id);
    const sourceUrl = conversationId ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}` : '';
    const header = [
      '---',
      `title: ${yamlValue(title)}`,
      ...(created ? [`created: ${created}`] : []),
      ...(updated ? [`updated: ${updated}`] : []),
      ...(sourceUrl ? [`source: ${yamlValue(sourceUrl)}`] : []),
      'author: "ChatGPT"',
      'tags:',
      '  - chatgpt',
      '  - export',
      '  - joplin',
      '---',
      '',
    ].join('\n');
    const body = out.replace(/^# [^\r\n]*(?:\r?\n){1,2}/, '');
    return header+body;
  }

  async function collectImages(ctx, convId, enabled, prefix, accountId, onProgress=null) {
    const map=new Map(), files=[]; let failed=0;
    for (let i=0;i<ctx.images.length;i++) {
      const img=ctx.images[i]; let target=null;
      if (enabled) for (const cand of img.candidates) try {
        const url=cand.startsWith('asset:') ? await resolveAsset(cand.slice(6),convId,accountId) : cand;
        const {type,bytes}=await fetchBytes(url, accountId);
        if (!bytes.length) throw new Error('Empty file');
        const ext=extensionFor(type,url);
        const name=`images/img-${String(i+1).padStart(3,'0')}.${ext}`;
        files.push({name:prefix+name,content:bytes,mime:mimeFor(type,url,name)}); target=name; break;
      } catch(_) {}
      if (!target) {
        target=img.candidates.find(c=>!c.startsWith('asset:') && CGX.isArchiveSafeUrl(c)) || '#image-non-recuperee';
        if(enabled) failed++;
      }
      map.set(img.ph,target);
      if(onProgress) onProgress(i+1,ctx.images.length);
    }
    return {map,files,failed};
  }

  async function collectFiles(ctx, convId, enabled, prefix, accountId, onProgress=null) {
    const map=new Map(), files=[]; let failed=0;
    for (let i=0;i<ctx.files.length;i++) {
      const f=ctx.files[i]; let target=null;
      if (enabled) for (const cand of f.candidates) try {
        let type, bytes, url = cand;
        if (cand.startsWith('sandbox:')) ({type,bytes}=await fetchSandboxBytes(convId,f.messageId,cand.slice(8),accountId));
        else {
          url=cand.startsWith('asset:') ? await resolveAsset(cand.slice(6),convId,accountId) : cand;
          ({type,bytes}=await fetchBytes(url, accountId));
        }
        if(!bytes.length) throw new Error('Empty file');
        let name=cleanFilename(f.name,`file-${i+1}`);
        if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) name += '.' + extensionFor(type,url,name);
        name=`files/${String(i+1).padStart(3,'0')}-${name}`;
        files.push({name:prefix+name,content:bytes,mime:mimeFor(type,url,name)}); target=name; break;
      } catch(_) {}
      if (!target) {
        target=f.candidates.find(c=>/^https?:/.test(c) && CGX.isArchiveSafeUrl(c)) || f.candidates.find(c=>c.startsWith('sandbox:')) || '#file-not-downloaded';
        if(enabled) failed++;
      }
      map.set(f.ph,target);
      if(onProgress) onProgress(i+1,ctx.files.length);
    }
    return {map,files,failed};
  }

  const fill=(text,map)=>text.replace(/CGX(?:IMG|FILE)\d+Z/g,ph=>map.get(ph)||'#');

  async function localizeEmbeddedImages(documents, prefix, enabled, accountId, onProgress=null) {
    if (!enabled) return {documents,files:[],failed:0};
    const urls=new Set();
    for (const d of documents) {
      if (/\.html$/i.test(d.name) && typeof DOMParser !== 'undefined') {
        try {
          const doc = new DOMParser().parseFromString(d.content, 'text/html');
          for (const el of doc.querySelectorAll('img[src]')) if (/^https?:/i.test(el.getAttribute('src')||'') && CGX.isArchiveSafeUrl(el.getAttribute('src')||'')) urls.add(el.getAttribute('src'));
        } catch(_) {}
      }
      for (const m of d.content.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+(?:\([^)]*\)[^\s)]*)?)\)/g)) if (CGX.isArchiveSafeUrl(m[1])) urls.add(m[1]);
      for (const m of d.content.matchAll(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi)) if (CGX.isArchiveSafeUrl(m[1])) urls.add(m[1]);
    }
    const repl=new Map(), files=[]; let failed=0, n=0;
    for (const url of urls) {
      try {
        const {type,bytes}=await fetchBytes(url, accountId);
        const ext=extensionFor(type,url);
        const name=`images/embedded-${String(++n).padStart(3,'0')}.${ext}`;
        files.push({name:prefix+name,content:bytes,mime:mimeFor(type,url,name)}); repl.set(url,name);
      } catch(_) { failed++; }
      if(onProgress) onProgress(repl.size+failed,urls.size);
    }
    return {documents:documents.map(d=>({...d,content:[...repl].reduce((s,[a,b])=>s.split(a).join(b),d.content)})),files,failed};
  }

  const plainSearch = (turns) => turns.map(t => t.md.join('\n')).join('\n').replace(/[`*_>#\[\]()|]/g,' ').replace(/\s+/g,' ').trim();

  function conversationMetadata(conv, turns, source={}, branchCount=1, opts={}) {
    return {
      schema_version:2,
      conversation_id:conv.conversation_id||conv.id||null,
      title:conv.title||'Untitled',
      created_at:conv.create_time||null,
      updated_at:conv.update_time||null,
      exported_at:new Date().toISOString(),
      message_count:turns.length,
      branch:'current', branch_count:branchCount,
      project_id:source.projectId||null, project_title:source.projectTitle||null,
      archived:!!source.archived, shared:!!source.shared, share_id:source.shareId||null,
      workspace_id:source.accountId||null,
      export_formats:{markdown:!!opts.md,html:!!opts.html,embedded_markdown:!!opts.embeddedMd,raw_json:!!opts.json,thinking_summaries:!!opts.thinking},
      capability_snapshot: capabilitySnapshot()
    };
  }

  async function exportConversation(convId, opts, prefix, source={}, convOverride=null, onProgress=null) {
    const report=(percent,label)=>{if(onProgress)onProgress(percent,label);};
    const accountId=source.accountId||null;
    report(3,'Reading conversation…');
    let conv=convOverride || await apiGet(`/backend-api/conversation/${convId}`, accountId);
    if (conv && conv.conversation) conv=conv.conversation;
    conv.conversation_id=conv.conversation_id||conv.id||convId;
    report(10,'Preparing messages…');
    const ctx=CGX.createContext();
    const currentTurns=CGX.buildTurns(conv,ctx,conv.current_node,opts);
    const leaves=opts.branches ? CGX.branchLeaves(conv) : [conv.current_node].filter(Boolean);
    const branchData=[];
    if (opts.branches && leaves.length>1) {
      let n=0;
      for (const nodeId of leaves) {
        if (nodeId===conv.current_node) continue;
        const turns=CGX.buildTurns(conv,ctx,nodeId,opts);
        if (turns.length) branchData.push({nodeId, n:++n, turns});
      }
    }

    report(18,ctx.images.length?`Processing images (0/${ctx.images.length})…`:'No conversation images to download.');
    const imgs=await collectImages(ctx,conv.conversation_id,opts.images||opts.embeddedMd,prefix,accountId,(done,total)=>{
      report(18+Math.round(30*done/Math.max(total,1)),`Processing images (${done}/${total})…`);
    });
    report(50,ctx.files.length?`Processing files (0/${ctx.files.length})…`:'No attachments to download.');
    const atts=await collectFiles(ctx,conv.conversation_id,opts.files||opts.embeddedMd,prefix,accountId,(done,total)=>{
      report(50+Math.round(20*done/Math.max(total,1)),`Processing files (${done}/${total})…`);
    });
    const allMap=new Map([...imgs.map,...atts.map]);
    report(72,'Rendering conversation…');
    const base=CGX.safeName(conv); let docs=[];
    // In a history export, keep the main document next to its metadata and
    // give it the same basename as the conversation folder.
    const folderName = prefix ? prefix.replace(/\/+$/,'').split('/').pop() : base;
    const mainName = folderName || base;
    if(opts.md||opts.embeddedMd) docs.push({name:`${prefix}${mainName}.md`,content:CGX.sanitizeMarkdownLinks(fill(CGX.toMarkdown(conv,currentTurns,opts),allMap))});
    if(opts.html) docs.push({name:`${prefix}${mainName}.html`,content:fill(CGX.toHtml(conv,currentTurns),allMap)});
    for (const b of branchData) {
      const stem=`branches/branch-${String(b.n).padStart(3,'0')}-${String(b.nodeId).slice(0,8)}`;
      if(opts.md||opts.embeddedMd) docs.push({name:`${prefix}${stem}.md`,content:CGX.sanitizeMarkdownLinks(fill(CGX.toMarkdown({...conv,title:`${conv.title||'Untitled'} - branch ${b.n}`},b.turns,opts),allMap))});
      if(opts.html) docs.push({name:`${prefix}${stem}.html`,content:fill(CGX.toHtml({...conv,title:`${conv.title||'Untitled'} - branch ${b.n}`},b.turns),allMap)});
    }
    report(78,'Localizing embedded images…');
    const localized=await localizeEmbeddedImages(docs,prefix,opts.images||opts.embeddedMd,accountId,(done,total)=>{
      report(78+Math.round(10*done/Math.max(total,1)),`Localizing embedded images (${done}/${total})…`);
    }); docs=localized.documents;
    report(89,'Finalizing documents…');
    const assetFiles=[...imgs.files,...atts.files,...localized.files];
    if(opts.embeddedMd){
      const embedded=[];
      for(const d of docs){
        if(!/\.md$/i.test(d.name) || typeof d.content!=='string') continue;
        const name=d.name.replace(/\.md$/i,opts.modernEmbeddedMd?'.modern.joplin.md':'.embedded.md');
        embedded.push({name,content:embedAssetsInMarkdown(d.content,assetFiles,prefix,!!opts.modernEmbeddedMd,conv,source),mime:'text/markdown'});
      }
      docs.push(...embedded);
      if(!opts.md) docs=docs.filter(d=>!/\.md$/i.test(d.name)||/\.embedded\.md$/i.test(d.name));
    }
    const files=[...docs,...assetFiles];
    if(opts.json) files.push({name:`${prefix}${prefix?'raw':base}.json`,content:JSON.stringify(conv,null,2)});
    files.push({name:`${prefix}${prefix?'metadata':base+'.metadata'}.json`,content:JSON.stringify(conversationMetadata(conv,currentTurns,source,leaves.length||1,opts),null,2)});
    report(94,'Conversation prepared.');
    return {conv,base,mainName,files,imageFailures:imgs.failed+localized.failed,fileFailures:atts.failed, turns:currentTurns, branchCount:leaves.length||1};
  }

  function download(filename,blob){
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }

  function jexId() {
    const raw = globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    return raw.replace(/[^a-f0-9]/gi, '').padEnd(32, '0').slice(0, 32).toLowerCase();
  }

  function stripFrontMatter(text) {
    return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimStart();
  }

  function buildJexEntries(conversation, files, parentId='') {
    const note = files.find(f => /\.modern\.joplin\.md$/i.test(f.name));
    if (!note) throw new Error('Modern Joplin note is missing.');
    const noteId = jexId();
    const resources = [];
    const now = new Date().toISOString();
    let body = stripFrontMatter(note.content);
    for (const file of files) {
      if (!/^(?:images|files)\//.test(file.name)) continue;
      const resourceId = jexId();
      const base = file.name.split('/').pop() || 'resource.bin';
      const ext = (base.match(/\.([a-z0-9]{1,12})$/i) || [,'bin'])[1].toLowerCase();
      const resourceName = `${resourceId}.${ext}`;
      const candidates = [`../${file.name}`, `./${file.name}`, file.name];
      for (const candidate of candidates) body = body.split(candidate).join(`:/` + resourceId);
      const mime = file.mime || 'application/octet-stream';
      const size = typeof file.content === 'string'
        ? new TextEncoder().encode(file.content).byteLength
        : file.content.byteLength;
      const resourceMetadata = [
        `title: ${base}`,
        `id: ${resourceId}`,
        `mime: ${mime}`,
        `file_extension: ${ext}`,
        `size: ${size}`,
        `created_time: ${now}`,
        `updated_time: ${now}`,
        'is_shared: 0',
        'share_id:',
        'encryption_cipher_text:',
        'encryption_applied: 0',
        'type_: 4'
      ].join('\n');
      resources.push({name:`${resourceId}.md`,content:resourceMetadata});
      resources.push({name:`resources/${resourceName}`,content:file.content});
    }
    const title = conversation.title || 'Untitled';
    const created = joplinDate(conversation.create_time) || new Date().toISOString();
    const updated = joplinDate(conversation.update_time) || created;
    const sourceUrl = `https://chatgpt.com/c/${encodeURIComponent(conversation.conversation_id || conversation.id || '')}`;
    const serialized = [
      title,
      '',
      body,
      '',
      `id: ${noteId}`,
      `parent_id: ${parentId}`,
      `created_time: ${created}`,
      `updated_time: ${updated}`,
      'is_conflict: 0',
      'latitude: 0',
      'longitude: 0',
      'altitude: 0',
      'author: ChatGPT',
      `source_url: ${sourceUrl}`,
      'is_todo: 0',
      'todo_due: 0',
      'todo_completed: 0',
      'source: chatgpt',
      'source_application: chatgpt-markdown-export',
      'application_data:',
      'order: 0',
      `user_created_time: ${created}`,
      `user_updated_time: ${updated}`,
      'encryption_cipher_text:',
      'encryption_applied: 0',
      'markup_language: 1',
      'is_shared: 0',
      'share_id:',
      'conflict_original_id:',
      'type_: 1'
    ].join('\n');
    return [{name:`${noteId}.md`,content:serialized}, ...resources];
  }

  function buildJex(conversation, files) {
    return CGX_buildTar(buildJexEntries(conversation,files));
  }

  function jexNotebookEntry(id,title,noteCount){
    const now=new Date().toISOString();
    const serialized=[
      `id: ${id}`,'parent_id:',`title: ${title}`,
      `created_time: ${now}`,`updated_time: ${now}`,
      `user_updated_time: ${now}`,'share_id:','is_shared: 0',
      'deleted_time: 0',`note_count: ${noteCount}`,'type_: 2'
    ].join('\n');
    return{name:`${id}.md`,content:serialized};
  }
  function progressPercent(percent,label='',done=null,total=null){
    const value=Math.max(0,Math.min(100,Math.round(Number(percent)||0)));
    progressState={percent:value,label,done,total,updatedAt:Date.now()};
    if(label && (!activityState.length || activityState[activityState.length-1].label!==label)){
      activityState.push({label,at:Date.now()});
      if(activityState.length>8)activityState.shift();
    }
    diag('progress',{percent:value,label,done,total});
    try{const message={type:'cgx-progress',percent:value,label,done,total,activity:activityState};if(liveFailureDetails.length!==lastProgressFailureCount){message.failures=liveFailureDetails;lastProgressFailureCount=liveFailureDetails.length;}Promise.resolve(api.runtime.sendMessage(message)).catch(()=>{});}catch(_){}
  }

  function currentTarget(){
    // Conversation identifiers have historically been UUIDs, but the web app
    // can use opaque identifiers too. Shared links can also contain a route
    // namespace, e.g. /share/e/<id>. Detect the route structurally and use the
    // last sufficiently long path segment as the share identifier.
    let m=location.pathname.match(/\/c\/([A-Za-z0-9_-]{8,})(?:\/|$)/);
    if(m)return{type:'conversation',id:m[1]};
    const parts=location.pathname.split('/').filter(Boolean);
    const shareIndex=parts.indexOf('share');
    if(shareIndex>=0){
      const tail=parts.slice(shareIndex+1);
      const valid=part=>/^[A-Za-z0-9_-]{8,}$/.test(part||'');
      // Standard links are /share/<id>; newer shared-page variants can use
      // one namespace segment first, e.g. /share/e/<id>. Deliberately inspect
      // only these first two slots so trailing route fragments cannot be
      // mistaken for the conversation identifier.
      const id=valid(tail[0])?tail[0]:(valid(tail[1])?tail[1]:null);
      if(id)return{type:'share',id,shareRoute:id===tail[1]?tail[0]:null};
    }
    return null;
  }

  async function sha256Hex(content) {
    const bytes=typeof content==='string'?new TextEncoder().encode(content):content;
    const hash=await crypto.subtle.digest('SHA-256',bytes);
    return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  const sizeOf=(f)=>typeof f.content==='string'?new TextEncoder().encode(f.content).length:f.content.byteLength;
  const formatBytes=(n)=>n>=1073741824?`${(n/1073741824).toFixed(1)} Gio`:n>=1048576?`${(n/1048576).toFixed(1)} Mio`:n>=1024?`${(n/1024).toFixed(1)} Kio`:`${n} o`;

  async function addManifest(files, meta, checksums=true, onProgress=null) {
    const listing=[]; const total=files.length;
    for (let i=0;i<files.length;i++) {
      const f=files[i];
      listing.push({path:f.name,size:sizeOf(f),sha256:checksums?await sha256Hex(f.content):null});
      if(onProgress) onProgress(i+1,total);
    }
    files.push({name:'manifest.json',content:JSON.stringify({...meta,files:listing},null,2)});
  }

  function conversationFromDom(targetId = null) {
    const nodes = [...document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')];
    if (!nodes.length) throw new Error('No visible messages found in the DOM.');
    const mapping = {}; let parent = null; let n = 0;
    for (const node of nodes) {
      const role = node.getAttribute('data-message-author-role');
      const host = node.closest('article') || node.closest('[data-testid^="conversation-turn"]') || node;
      let text = (node.innerText || host.innerText || '').trim();
      const extra = [];
      for (const a of host.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || ''; const label = (a.innerText || a.getAttribute('aria-label') || 'lien').trim();
        if (/^sandbox:/i.test(href) && !text.includes(href)) extra.push(`[${label || 'lien'}](${href})`);
        else if (/^https?:/i.test(href) && CGX.isArchiveSafeUrl(href) && !text.includes(href)) extra.push(`[${label || 'lien'}](${href})`);
      }
      for (const img of host.querySelectorAll('img[src]')) {
        const src = img.getAttribute('src') || ''; if (/^https?:/i.test(src) && CGX.isArchiveSafeUrl(src)) extra.push(`![${img.getAttribute('alt') || 'image'}](${src})`);
      }
      if (extra.length) text += `\n\n${extra.join('\n')}`;
      const id = host.getAttribute('data-message-id') || `dom-${++n}`;
      mapping[id] = {id,parent,children:[],message:{id,author:{role},create_time:null,content:{content_type:'text',parts:[text]},metadata:{dom_fallback:true}}};
      if (parent && mapping[parent]) mapping[parent].children.push(id); parent = id;
    }
    setCapability('dom_fallback', 'available', 'Conversation reconstruite depuis les messages visibles.');
    return {id:targetId||`dom-${Date.now()}`,conversation_id:targetId||`dom-${Date.now()}`,title:document.title.replace(/\s*[|·-]\s*ChatGPT.*$/i,'')||'Conversation ChatGPT',create_time:null,update_time:null,current_node:parent,mapping};
  }

  async function exportCurrent(opts){
    progressPercent(1,'Starting export…');
    const target=currentTarget(); if(!target){const e=new Error('No conversation or shared page is open.');diag('target.missing',{path:safeDiagnosticPath()});throw e;}
    diag('target.detected',targetDiagnosticSummary());
    let accountId=null; try { const session=await getSession(); accountId=(session.account&&session.account.id)||cookieAccountId()||null; } catch(e) { setCapability('session_api','unavailable',e.message); }
    progressPercent(4,'Session ready.');
    let r;
    try {
      if(target.type==='share'){
        const data=await apiGet(`/backend-api/share/${encodeURIComponent(target.id)}`,accountId);
        setCapability('share_current','available');
        const conv=data.conversation||data;
        const cid=conv.conversation_id||conv.id||target.id;
        r=await exportConversation(cid,opts,'',{accountId,shared:true,shareId:target.id},conv,(p,label)=>progressPercent(5+p*0.9,label));
      } else r=await exportConversation(target.id,opts,'',{accountId},null,(p,label)=>progressPercent(5+p*0.9,label));
      setCapability('conversation_api','available');
    } catch (e) {
      diag('conversation-api.fallback',{error:e});
      setCapability('conversation_api','unavailable',e.message);
      const conv=conversationFromDom(target.id);
      r=await exportConversation(conv.conversation_id,opts,'',{accountId,shared:target.type==='share',shareId:target.type==='share'?target.id:null},conv,(p,label)=>progressPercent(5+p*0.9,label));
    }
    if(r.imageFailures||r.fileFailures){
      diag('export.partial',{imageFailures:r.imageFailures,fileFailures:r.fileFailures});
      r.files.push({name:'_diagnostic.log',content:diagnosticLog({result:{image_failures:r.imageFailures,file_failures:r.fileFailures}})});
    }
    const embeddedOnly = opts.embeddedMd && !opts.modernEmbeddedMd && opts.md && !opts.html && !opts.images && !opts.files && !opts.json && !opts.branches && !opts.incremental;
    if (embeddedOnly) {
      const embedded = r.files.find(f => /(?:\.embedded\.md|\.modern\.joplin\.md)$/i.test(f.name));
      if (!embedded) throw new Error('Self-contained Markdown could not be generated.');
      const suffix = opts.modernEmbeddedMd ? '.modern.joplin.md' : '.embedded.md';
      progressPercent(98,'Preparing download…');
      download(`${r.base}${suffix}`, new Blob([embedded.content], {type:'text/markdown;charset=utf-8'}));
      progressPercent(100,'Export ready.');
      return{count:1,failed:0,imageFailures:r.imageFailures,fileFailures:r.fileFailures,parts:1,embeddedOnly:true};
    }
    const markdownOnly = opts.md && !opts.html && !opts.embeddedMd && !opts.images && !opts.files && !opts.json && !opts.branches && !opts.incremental;
    if (markdownOnly) {
      const markdown = r.files.find(f => f.name === `${r.base}.md`);
      if (!markdown) throw new Error('Markdown could not be generated.');
      progressPercent(98,'Preparing download…');
      download(`${r.base}.md`, new Blob([markdown.content], {type:'text/markdown;charset=utf-8'}));
      progressPercent(100,'Export ready.');
      return{count:1,failed:0,imageFailures:r.imageFailures,fileFailures:r.fileFailures,parts:1,markdownOnly:true};
    }
    if (opts.modernEmbeddedMd) {
      progressPercent(97,'Building JEX archive…');
      download(`${r.base}.jex`, buildJex(r.conv, r.files));
      progressPercent(100,'Export ready.');
      return{count:1,failed:0,imageFailures:r.imageFailures,fileFailures:r.fileFailures,parts:1,joplin:true};
    }
    progressPercent(96,'Building manifest…');
    r.files.push({name:'_capabilities.json',content:JSON.stringify(capabilitySnapshot(),null,2)});
    await addManifest(r.files,{schema_version:4,exported_at:new Date().toISOString(),conversation_count:1,embedded_markdown:!!opts.embeddedMd,capabilities:capabilitySnapshot()},opts.checksums,(done,total)=>progressPercent(96+2*done/Math.max(total,1),`Building manifest (${done}/${total})…`));
    progressPercent(99,'Building ZIP archive…');
    download(`${r.base}.zip`,CGX_buildZip(r.files));
    progressPercent(100,'Export ready.');
    return{count:1,failed:0,imageFailures:r.imageFailures,fileFailures:r.fileFailures,parts:1};
  }

  async function pagedOffset(pathBuilder, accountId,onPage=()=>{}){
    const out=[];let offset=0,total=Infinity;
    while(offset<total){const page=await apiGet(pathBuilder(offset),accountId);const batch=page.items||page.conversations||[];if(!batch.length)break;out.push(...batch);total=typeof page.total==='number'?page.total:Infinity;offset+=batch.length;onPage(out.length,batch.length,total);if(batch.length<PAGE_SIZE&&total===Infinity)break;await sleep(DELAY_MS);}return out;
  }

  async function listProjects(accountId){
    const projects=[]; const seen=new Set(); let cursor=null; let first=true;
    const variants=(cur)=>{
      const qs=[];
      const a=new URLSearchParams({owned_only:'true',conversations_per_gizmo:'0'}); if(cur)a.set('cursor',cur); qs.push(`/backend-api/gizmos/snorlax/sidebar?${a}`);
      const b=new URLSearchParams({conversations_per_gizmo:'0'}); if(cur)b.set('cursor',cur); qs.push(`/backend-api/gizmos/snorlax/sidebar?${b}`);
      const c=new URLSearchParams(); if(cur)c.set('cursor',cur); qs.push(`/backend-api/gizmos/snorlax/sidebar${String(c)?`?${c}`:''}`);
      return qs;
    };
    do {
      let data=null;
      for (const path of variants(first?null:cursor)) { const r=await tryApiGet(path,accountId,'projects_list'); if(r.ok){data=r.data;break;} }
      if(!data) break; first=false;
      for(const it of data.items||data.gizmos||data.projects||[]){const g=(it&&it.gizmo&&it.gizmo.gizmo)||(it&&it.gizmo)||it;if(!g)continue;const id=g.id||g.gizmo_id||g.project_id;if(id&&!seen.has(id)){seen.add(id);projects.push({...g,_cgxSidebarItem:it});}}
      cursor=data.cursor||data.next_cursor||null; if(cursor)await sleep(DELAY_MS);
    } while(cursor);
    if(!projects.length && !capabilityState.projects_list) setCapability('projects_list','unavailable','No Projects endpoint available or no Project exists in this workspace.');
    return projects;
  }

  async function listProjectConversations(project,accountId,onCount=()=>{}){
    const projectId=typeof project==='string'?project:(project.id||project.gizmo_id||project.project_id);
    const preview=(project && project._cgxSidebarItem && (project._cgxSidebarItem.conversations||project._cgxSidebarItem.items)) || project.conversations || [];
    const out=[...preview]; let cursor='0'; let fetched=false;onCount(out.length);
    while(cursor!=null){
      const r=await tryApiGet(`/backend-api/gizmos/${encodeURIComponent(projectId)}/conversations?cursor=${encodeURIComponent(cursor)}`,accountId,'project_conversations');
      if(!r.ok) break; fetched=true; const data=r.data; out.push(...(data.items||data.conversations||[]));onCount(out.length); cursor=data.cursor||data.next_cursor||null;if(cursor)await sleep(DELAY_MS);
    }
    const seen=new Map(); for(const x of out){const id=x&& (x.conversation_id||x.id);if(id)seen.set(id,x);} 
    if(!fetched && preview.length) setCapability('project_conversations','fallback','Using previews available in the Projects sidebar.');
    return [...seen.values()];
  }

  async function listShared(accountId,onCount=()=>{}){
    try{const xs=await pagedOffset(o=>`/backend-api/shared_conversations?offset=${o}&limit=${PAGE_SIZE}&order=created`,accountId,n=>onCount(n));setCapability('shared_list','available');return xs;}
    catch(e){
      const r=await tryApiGet('/backend-api/shared_conversations?order=created',accountId,'shared_list');
      if(r.ok){const xs=r.data.items||r.data.conversations||[];onCount(xs.length);return xs;}
      return[];
    }
  }

  async function listRegular(accountId, archived=false,onCount=()=>{}){
    try {
      const xs=await pagedOffset(o=>`/backend-api/conversations?offset=${o}&limit=${PAGE_SIZE}&order=updated&is_archived=${archived}`,accountId,n=>onCount(n));
      setCapability(archived?'archived_list':'conversation_list','available'); return xs;
    } catch(e) {
      if(!archived){
        try { const xs=await pagedOffset(o=>`/backend-api/conversations?offset=${o}&limit=${PAGE_SIZE}&order=updated`,accountId,n=>onCount(n)); setCapability('conversation_list','fallback','Endpoint sans is_archived.'); return xs; } catch(e2){ setCapability('conversation_list','unavailable',e2.message); }
      } else setCapability('archived_list','unavailable',e.message);
      return [];
    }
  }

  function timeMs(v){if(v==null)return 0;if(typeof v==='number')return v>1e12?v:v*1000;const t=Date.parse(v);return Number.isFinite(t)?t:0;}

  async function listAll(opts,onProgress=()=>{}){
    const startedAt=Date.now(); let stage='Connecting to the account…';
    const found=[]; const projectsIndex=[];let observed=0;
    const elapsed=()=>{const s=Math.floor((Date.now()-startedAt)/1000);return s>=60?`${Math.floor(s/60)}m ${s%60}s`:`${s}s`;};
    const announce=count=>{if(count!=null)observed=Math.max(observed,count);else observed=Math.max(observed,found.length);onProgress(`${stage} · ${observed} found · ${elapsed()} elapsed`);};
    const heartbeat=setInterval(announce,5000);
    try{
      announce();
      const session=await getSession(); const accounts=collectAccountIds(session);
      for(let accountNo=0;accountNo<accounts.length;accountNo++){
        const accountId=accounts[accountNo], accountLabel=accounts.length>1?`workspace ${accountNo+1}/${accounts.length}: `:'';
        stage=`${accountLabel}scanning active conversations`;announce();
        const active=await listRegular(accountId,false,count=>announce(found.length+count)); for(const x of active)found.push({...x,_cgxArchived:false,_cgxAccountId:accountId});announce();
        stage=`${accountLabel}scanning archived conversations`;announce();
        const archived=await listRegular(accountId,true,count=>announce(found.length+count)); for(const x of archived)found.push({...x,_cgxArchived:true,_cgxAccountId:accountId});announce();
        stage=`${accountLabel}finding projects`;announce();
        try{
          const projects=await listProjects(accountId);
          for(let projectNo=0;projectNo<projects.length;projectNo++){
            const p=projects[projectNo],pid=p.id||p.gizmo_id||p.project_id;if(!pid)continue;
            const pname=(p.display&&p.display.name)||p.name||p.title||'Project';
            stage=`${accountLabel}scanning project ${projectNo+1}/${projects.length}`;announce();
            let xs=[];try{xs=await listProjectConversations(p,accountId,count=>announce(found.length+count));}catch(e){setCapability('project_conversations','unavailable',e.message);}
            projectsIndex.push({id:pid,name:pname,workspace_id:accountId,conversation_count:xs.length});
            for(const x of xs)found.push({...x,_cgxProjectId:pid,_cgxProjectTitle:pname,_cgxAccountId:accountId});
          }
        }catch(_){}
        stage=`${accountLabel}scanning shared conversations`;announce();
        for(const sh of await listShared(accountId,count=>announce(found.length+count))) found.push({...sh,_cgxShared:true,_cgxShareId:sh.share_id||sh.id,_cgxAccountId:accountId});announce();
      }
      stage='Removing duplicates and preparing the export';announce();
      const byKey=new Map();
      for(const x of found){const id=x.conversation_id||x.id;if(!id)continue;const key=`${x._cgxAccountId||'personal'}:${id}`;const prev=byKey.get(key);if(prev){byKey.set(key,{...x,...prev,_cgxShared:!!(prev._cgxShared||x._cgxShared),_cgxShareId:prev._cgxShareId||x._cgxShareId,_cgxProjectId:prev._cgxProjectId||x._cgxProjectId,_cgxProjectTitle:prev._cgxProjectTitle||x._cgxProjectTitle,_cgxArchived:!!(prev._cgxArchived||x._cgxArchived)});}else byKey.set(key,x);}
      let items=[...byKey.values()];
      if(opts.since){const since=Number(opts.since)||0;items=items.filter(x=>timeMs(x.update_time||x.create_time)>since);}
      onProgress(`${items.length} unique conversations found · ${elapsed()} elapsed`);
      return{items,projectsIndex,accounts};
    }finally{clearInterval(heartbeat);}
  }

  async function exportAllJex(opts, listed){
    const entries=[]; let errors=[], failureDetails=[], exported=0, failed=0;
    const notebookId=jexId();
    const concurrency=1;
    let nextIndex=0,completed=0;
    const active=new Set();
    const stamp=new Date().toISOString().slice(0,10);
    const startedAt=Date.now();
    const durationLabel=seconds=>{
      const value=Math.max(0,Math.ceil(seconds));
      const hours=Math.floor(value/3600), minutes=Math.floor((value%3600)/60), rest=value%60;
      if(hours)return `${hours}h ${minutes}m`;
      if(minutes)return `${minutes}m ${rest}s`;
      return `${rest}s`;
    };
    const report=(detail)=>{
      const total=listed.items.length;
      const elapsed=(Date.now()-startedAt)/1000;
      const average=completed>0?elapsed/completed:0;
      const remaining=completed>0?average*(total-completed):null;
      const eta=remaining==null?'estimating time left…':`~${durationLabel(remaining)} left`;
      const inProgress=active.size?`processing ${[...active].join(', ')} (${active.size} active)`:'waiting for workers';
      const label=`${completed}/${total} conversations · ${exported} exported · ${failed} failed · elapsed ${durationLabel(elapsed)} · ${eta} · ${detail||inProgress}`;
      progressPercent(total?Math.round(7+90*completed/total):97,label,completed,total);
    };
    const worker=async()=>{
      while(true){
        const i=nextIndex++;
        if(i>=listed.items.length)return;
        const item=listed.items[i], id=item.conversation_id||item.id, accountId=item._cgxAccountId||null;
        active.add(String(i+1));report();
        try{
          let convOverride=null;
          if(item._cgxShared && !item.mapping && item._cgxShareId){
            try{const sd=await apiGet(`/backend-api/share/${encodeURIComponent(item._cgxShareId)}`,accountId);convOverride=sd.conversation||sd;}catch(_){}
          }
          const jexOpts={...opts,md:true,html:false,images:true,files:true,json:false,embeddedMd:true,modernEmbeddedMd:true,branches:false};
          const r=await exportConversation(id,jexOpts,'',{projectId:item._cgxProjectId,projectTitle:item._cgxProjectTitle,archived:item._cgxArchived,shared:item._cgxShared,shareId:item._cgxShareId,accountId},convOverride);
          entries.push(...buildJexEntries(r.conv,r.files,notebookId));
          exported++;
        }catch(e){
          const detail={conversation_index:i+1,conversation_title:redactDiagnosticText(item.title||'Untitled').slice(0,200),error_type:e.name||'Error',http_status:e.status||null,message:redactDiagnosticText(e.message||e),stack:e.stack?redactDiagnosticText(e.stack):null};
          errors.push(`Conversation ${i+1} (${item.title||'untitled'}) : ${detail.http_status?`HTTP ${detail.http_status} — `:''}${detail.message}`);
          failureDetails.push(detail);liveFailureDetails=failureDetails;failed++;diag('conversation.error',{index:i+1,error:e});
        }
        active.delete(String(i+1));completed++;report(`conversation ${i+1} processed`);
        if(nextIndex<listed.items.length)await sleep(JEX_CONVERSATION_DELAY_MS);
      }
    };
    await Promise.all(Array.from({length:Math.min(concurrency,listed.items.length)},()=>worker()));
    if(!exported) throw new Error(errors.length?'No conversations could be exported as JEX.':'No conversations found.');
    entries.unshift(jexNotebookEntry(notebookId,'ChatGPT conversations',exported));
    progressPercent(98,`Building one JEX notebook with ${exported} conversation notes…`,listed.items.length,listed.items.length);
    download(`chatgpt-joplin-export_${stamp}.jex`,CGX_buildTar(entries));
    if(errors.length){
      download(`chatgpt-joplin-export_${stamp}_errors.txt`,new Blob([errors.join('\n')+'\n'],{type:'text/plain;charset=utf-8'}));
      download(`chatgpt-joplin-export_${stamp}_errors.log`,new Blob([diagnosticLog({result:{conversation_failures:failureDetails}})],{type:'application/json;charset=utf-8'}));
    }
    progressPercent(100,`${listed.items.length}/${listed.items.length} conversations · ${exported} exported · ${failed} failed · one JEX notebook ready`,listed.items.length,listed.items.length);
    return{count:exported,failed,parts:1,joplinHistory:true,failureDetails};
  }

  async function storageGet(key){try{const r=await api.storage.local.get(key);return r[key];}catch(_){return null;}}
  async function storageSet(obj){try{await api.storage.local.set(obj);}catch(_){} }

  async function finalizePart(files,index,meta,opts,partNo){
    if(opts.html&&index.length)files.push({name:'index.html',content:CGX.indexHtml(index)});
    if(meta.projectsIndex&&meta.projectsIndex.length)files.push({name:'projects/project-index.json',content:JSON.stringify(meta.projectsIndex,null,2)});
    if(meta.errors&&meta.errors.length)files.push({name:'_erreurs.txt',content:meta.errors.join('\n')+'\n'});
    if((meta.errors&&meta.errors.length)||meta.imageFailures||meta.fileFailures)files.push({name:'_diagnostic.log',content:diagnosticLog({result:{conversation_failures:(meta.errors||[]).length,image_failures:meta.imageFailures||0,file_failures:meta.fileFailures||0,part:partNo}})});
    files.push({name:'_capabilities.json',content:JSON.stringify(capabilitySnapshot(),null,2)});
    await addManifest(files,{schema_version:4,exported_at:new Date().toISOString(),embedded_markdown:!!opts.embeddedMd,conversation_count:index.length,failures:(meta.errors||[]).length,image_failures:meta.imageFailures||0,file_failures:meta.fileFailures||0,workspace_ids:meta.accounts||[],part:partNo,incremental_since:meta.since||null,capabilities:capabilitySnapshot()},opts.checksums);
    const stamp=new Date().toISOString().slice(0,10);const suffix=partNo>1?`_part-${String(partNo).padStart(3,'0')}`:'';
    download(`chatgpt-export_${stamp}${suffix}.zip`,CGX_buildZip(files));
  }

  async function exportAll(opts){
    progressPercent(1,'Searching account history…');
    const last=opts.incremental?await storageGet('cgx-last-full-export'):null;
    const previousIndex=opts.incremental?((await storageGet('cgx-export-index'))||{}):{};
    const listed=await listAll({...opts,since:null},label=>progressPercent(1,label));
    progressPercent(7,`Found ${listed.items.length} conversation${listed.items.length===1?'':'s'}.`);
    if(opts.format==='jex') return exportAllJex(opts,listed);
    const nextIndex={...previousIndex}; const items=[];
    for (const item of listed.items) {
      const id=item.conversation_id||item.id; const key=`${item._cgxAccountId||'personal'}:${id}`;
      const fingerprint=await sha256Hex(JSON.stringify([item.update_time||item.create_time||null,item.title||'',!!item._cgxArchived,item._cgxProjectId||null,item._cgxShareId||null]));
      item._cgxFingerprint=fingerprint; item._cgxIndexKey=key;
      if (!opts.incremental || !previousIndex[key] || previousIndex[key].fingerprint!==fingerprint) items.push(item);
    }
    if(!items.length)throw new Error(opts.incremental?'No new or modified conversations since the last export.':'No conversations found.');
    let files=[],index=[],used=new Set(),errors=[];let imageFailures=0,fileFailures=0,totalErrors=0,totalImageFailures=0,totalFileFailures=0,part=1,parts=0,bytes=0;
    const maxBytes=Math.max(100,Number(opts.partSizeMB)||1024)*1024*1024;
    const flush=async(force=false)=>{if(!files.length&&!force)return;totalErrors+=errors.length;totalImageFailures+=imageFailures;totalFileFailures+=fileFailures;await finalizePart(files,index,{projectsIndex:listed.projectsIndex,errors,imageFailures,fileFailures,accounts:listed.accounts,since:opts.since},opts,part);parts++;part++;files=[];index=[];errors=[];imageFailures=0;fileFailures=0;bytes=0;await sleep(500);};
    for(let i=0;i<items.length;i++){
      const item=items[i],id=item.conversation_id||item.id,accountId=item._cgxAccountId||null;
      const overall=(sub,label='')=>{
        // Keep the displayed percentage aligned with the conversation count:
        // 271/271 must reach 100%, rather than stopping at the old 92% cap.
        // The finalization steps below stay at 100% so the indicator never
        // jumps backwards after the last conversation has been read.
        const progress=i+Math.max(0,Math.min(100,sub))/100;
        const percent=Math.min(100,Math.round(100*progress/items.length));
        progressPercent(percent,`Conversation ${i+1}/${items.length}${label?` — ${label}`:''}`,i,items.length);
      };
      overall(0,'Starting…');
      try{
        let root=item._cgxProjectId?`projects/${cleanFilename(item._cgxProjectTitle,'Project')}/`:(item._cgxArchived?'archived/':(item._cgxShared?'shared/':'conversations/'));
        if(listed.accounts.filter(Boolean).length>1)root=`workspaces/${cleanFilename(accountId||'personal')}/${root}`;
        let folder=CGX.safeName(item);const key=`${root}${folder}`;if(used.has(key))folder+=`_${String(id).slice(0,8)}`;used.add(`${root}${folder}`);const prefix=`${root}${folder}/`;
        let convOverride=null;
        if(item._cgxShared && !item.mapping && item._cgxShareId){try{const sd=await apiGet(`/backend-api/share/${encodeURIComponent(item._cgxShareId)}`,accountId);convOverride=sd.conversation||sd;}catch(_){} }
        const r=await exportConversation(id,opts,prefix,{projectId:item._cgxProjectId,projectTitle:item._cgxProjectTitle,archived:item._cgxArchived,shared:item._cgxShared,shareId:item._cgxShareId,accountId},convOverride,(p,label)=>overall(p,label));
        const rBytes=r.files.reduce((n,f)=>n+sizeOf(f),0);
        if(files.length&&bytes+rBytes>maxBytes)await flush();
        files.push(...r.files);bytes+=rBytes;imageFailures+=r.imageFailures;fileFailures+=r.fileFailures;
        index.push({title:r.conv.title||'Untitled',href:`${prefix}${r.mainName}.${opts.html?'html':'md'}`,date:CGX.formatDate(r.conv.update_time),project:item._cgxProjectTitle||'',archived:!!item._cgxArchived,shared:!!item._cgxShared,messages:r.turns.length,size:formatBytes(rBytes),search:plainSearch(r.turns)});
        nextIndex[item._cgxIndexKey]={fingerprint:item._cgxFingerprint,updated_at:item.update_time||item.create_time||null,exported_at:new Date().toISOString()};
      }catch(e){diag('conversation.error',{index:i+1,error:e});errors.push(`${item.title||id} : ${e.message}`);}
      overall(100,'Done.');
      await sleep(DELAY_MS);
    }
    progressPercent(100,'Finalizing archive…',items.length,items.length);await flush(true);
    progressPercent(100,'Saving export state…',items.length,items.length);
    await storageSet({'cgx-export-index':nextIndex,'cgx-last-full-export':Date.now()});
    progressPercent(100,'Export ready.',items.length,items.length);
    return{count:items.length,failed:totalErrors,imageFailures:totalImageFailures,fileFailures:totalFileFailures,parts};
  }

  api.runtime.onMessage.addListener((msg,_sender,sendResponse)=>{
    if(msg.type==='cgx-ping'){const t=currentTarget();storageGet('cgx-last-full-export').then(last=>sendResponse({ok:true,busy,hasConversation:!!t,lastExport:last||null,progress:progressState,activity:activityState,failures:liveFailureDetails,lastJob:lastExportState}));return true;}
    if(msg.type!=='cgx-export-current'&&msg.type!=='cgx-export-all')return false;
    if(busy){sendResponse({ok:false,error:'An export is already running in this tab.',diagnostics:diagnosticSnapshot({error:{message:'Export already running.'}})});return false;}
    const opts={md:true,html:true,images:true,files:true,json:false,thinking:false,embeddedMd:false,modernEmbeddedMd:false,branches:false,checksums:true,incremental:false,partSizeMB:1024,...(msg.options||{})};
    opts.modernEmbeddedMd = opts.format === 'jex' || !!opts.modernEmbeddedMd;
    opts.embeddedMd = !!(opts.embeddedMd || opts.modernEmbeddedMd);
    if(opts.embeddedMd&&!opts.md) opts.md=true;
    resetDiagnostics(msg.type,opts);
    if(!opts.md&&!opts.html){sendResponse({ok:false,error:'Choisis au moins un format.',diagnostics:diagnosticSnapshot({error:{message:'No export format selected.'}})});return false;}
    busy=true;activityState=[];liveFailureDetails=[];lastProgressFailureCount=0;progressState={percent:0,label:'Starting export…',done:null,total:null,updatedAt:Date.now()};lastExportState=null;
    const job=msg.type==='cgx-export-current'?exportCurrent(opts):exportAll(opts);
    job.then(r=>{
      const hasIssues=!!(r.failed||r.imageFailures||r.fileFailures);
      diag('export.complete',{count:r.count||0,failed:r.failed||0,imageFailures:r.imageFailures||0,fileFailures:r.fileFailures||0,parts:r.parts||0});
      lastExportState={finishedAt:Date.now(),ok:true,count:r.count||0,failed:r.failed||0,parts:r.parts||0,joplinHistory:!!r.joplinHistory,joplin:!!r.joplin};
      sendResponse({ok:true,...r,diagnostics:hasIssues?diagnosticSnapshot({result:{failed:r.failed||0,image_failures:r.imageFailures||0,file_failures:r.fileFailures||0,parts:r.parts||0}}):null});
    }).catch(e=>{
      diag('export.failure',{error:e});
      lastExportState={finishedAt:Date.now(),ok:false,error:redactDiagnosticText(e.message||e)};
      sendResponse({ok:false,error:redactDiagnosticText(e.message||e),diagnostics:diagnosticSnapshot({error:e})});
    }).finally(()=>{busy=false;});return true;
  });
})();
