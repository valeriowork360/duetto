// Duetto – ponte per leggere canali e playlist YouTube (Cloudflare Worker, gratuito)
// Uso: https://TUO-WORKER.workers.dev/?u=<link canale, @nome, ID canale o link playlist>
// Risponde con JSON: { type, id, title, videos: [{ id, title, date, dur }] }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const YT_HEADERS = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.8", "Cookie": "SOCS=CAI; CONSENT=YES+cb" };
const CACHE_SECONDS = 3600; // stesso risultato per un'ora: veloce e leggero

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const u = (url.searchParams.get("u") || "").trim();
    if (!u) return json({ ok: true, info: "Duetto bridge. Usa ?u=link" });

    const cache = caches.default;
    const cacheKey = new Request(url.origin + "/?u=" + encodeURIComponent(u.toLowerCase()));
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    let res;
    try {
      res = json(await resolve(u));
    } catch (e) {
      return json({ error: String(e.message || e) }, 400);
    }
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};

async function resolve(input) {
  const ref = parseRef(input);
  if (!ref) throw new Error("Link non riconosciuto: usa il link di un canale o di una playlist YouTube");
  if (ref.type === "playlist") return playlist(ref.id);
  const id = ref.type === "channelId" ? ref.id : await channelIdFrom(ref.url);
  return channel(id);
}

function parseRef(s) {
  s = s.trim();
  if (/^UC[\w-]{22}$/.test(s)) return { type: "channelId", id: s };
  if (/^(PL|OL|UU|FL|RD)[\w-]{10,}$/.test(s)) return { type: "playlist", id: s };
  if (/^@[\w.\-]{3,}$/.test(s)) return { type: "handle", url: "https://www.youtube.com/" + s };
  let u;
  try { u = new URL(/^https?:/i.test(s) ? s : "https://" + s); } catch { return null; }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(u.hostname)) return null;
  const list = u.searchParams.get("list");
  if (list) return { type: "playlist", id: list };
  const p = u.pathname.split("/").filter(Boolean);
  if (p[0] === "channel" && /^UC[\w-]{22}$/.test(p[1] || "")) return { type: "channelId", id: p[1] };
  if (p[0] && (p[0].startsWith("@") || p[0] === "c" || p[0] === "user"))
    return { type: "handle", url: "https://www.youtube.com/" + p.slice(0, p[0].startsWith("@") ? 1 : 2).join("/") };
  return null;
}

async function channelIdFrom(pageUrl) {
  const r = await fetch(pageUrl, { headers: YT_HEADERS });
  if (!r.ok) throw new Error("Canale non trovato");
  const html = await r.text();
  const m = html.match(/<meta itemprop="identifier" content="(UC[\w-]{22})"/) ||
            html.match(/"externalId":"(UC[\w-]{22})"/) ||
            html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/);
  if (!m) throw new Error("Canale non trovato");
  return m[1];
}

async function channel(id) {
  // UULF = solo video lunghi (senza Shorts). Se non esiste, usa tutti i caricamenti.
  let feed = await rss("playlist_id=UULF" + id.slice(2));
  if (!feed || !feed.videos.length) feed = await rss("channel_id=" + id);
  if (!feed) throw new Error("Impossibile leggere il canale");
  return { type: "channel", id, title: feed.author || feed.title, videos: feed.videos };
}

async function playlist(id) {
  // La pagina della playlist dà fino a ~100 video con durata; il feed RSS (15 video) è la riserva.
  try {
    const r = await fetch("https://www.youtube.com/playlist?list=" + id, { headers: YT_HEADERS });
    if (r.ok) {
      const html = await r.text();
      const data = pageData(html);
      if (data && data.videos.length) return { type: "playlist", id, title: data.title, videos: data.videos };
    }
  } catch {}
  const feed = await rss("playlist_id=" + id);
  if (!feed) throw new Error("Playlist non trovata o privata");
  return { type: "playlist", id, title: feed.title, videos: feed.videos };
}

function pageData(html) {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return null;
  const root = JSON.parse(m[1]);
  const t = html.match(/<meta property="og:title" content="([^"]*)"/);
  const videos = [], seen = new Set();
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    const l = o.lockupViewModel;
    if (l && l.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" && l.contentId && !seen.has(l.contentId)) {
      seen.add(l.contentId);
      const title = l.metadata?.lockupMetadataViewModel?.title?.content || "";
      const d = JSON.stringify(l.contentImage || {}).match(/"text":"(\d{1,2}(?::\d{2}){1,2})"/);
      videos.push({ id: l.contentId, title, date: null, dur: d ? toSec(d[1]) : 0 });
    }
    for (const k in o) walk(o[k]);
  })(root);
  return { title: t ? decode(t[1]) : "Playlist", videos };
}

async function rss(q) {
  const r = await fetch("https://www.youtube.com/feeds/videos.xml?" + q, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const x = await r.text();
  const title = decode((x.match(/<feed[^>]*>[\s\S]*?<title>([^<]*)<\/title>/) || [])[1] || "");
  const author = decode((x.match(/<author>\s*<name>([^<]*)<\/name>/) || [])[1] || "");
  const videos = [...x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: (e.match(/<yt:videoId>([^<]+)</) || [])[1],
    title: decode((e.match(/<title>([^<]*)<\/title>/) || [])[1] || ""),
    date: (e.match(/<published>([^<]+)</) || [])[1] || null,
    dur: 0,
  })).filter(v => v.id);
  return { title, author, videos };
}

const toSec = s => s.split(":").reduce((a, n) => a * 60 + +n, 0);
const decode = s => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status,
  headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
});
