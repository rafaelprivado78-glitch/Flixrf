// FlixRF Stream API — Vercel Serverless
// Extrai links diretos M3U8/MP4 sem iframe, sem popup
// Tenta 4 fontes em paralelo, retorna o primeiro que funcionar

const https = require("https");
const http  = require("http");
const urlMod = require("url");

function get(targetUrl, extraHeaders = {}) {
  return new Promise((resolve) => {
    try {
      const parsed = urlMod.parse(targetUrl);
      const lib = targetUrl.startsWith("https") ? https : http;
      const req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.path || "/",
        method: "GET",
        timeout: 8000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
          "Referer": "https://google.com/",
          ...extraHeaders,
        },
      }, (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location;
          const next = loc.startsWith("http") ? loc : `${parsed.protocol}//${parsed.hostname}${loc}`;
          return get(next, extraHeaders).then(resolve);
        }
        let body = "";
        res.on("data", (d) => { body += d; if (body.length > 300000) req.destroy(); });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", () => resolve({ status: 0, body: "" }));
      req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "" }); });
      req.end();
    } catch(e) { resolve({ status: 0, body: "" }); }
  });
}

function extractStream(html) {
  if (!html) return null;
  const m3u8 = html.match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/i);
  if (m3u8) return { url: m3u8[0], type: "hls" };
  const mp4 = html.match(/https?:\/\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*/i);
  if (mp4) return { url: mp4[0], type: "mp4" };
  return null;
}

async function fromSource(baseUrl, referer) {
  const r = await get(baseUrl, { Referer: referer });
  if (!r.body) return null;
  // Tentar extração direta
  let stream = extractStream(r.body);
  if (stream) return stream;
  // Tentar seguir iframe interno
  const iMatch = r.body.match(/(?:src|file):\s*["']((?:https?:)?\/\/[^"']+)["']/i)
    || r.body.match(/iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i);
  if (iMatch) {
    const src = iMatch[1].startsWith("//") ? "https:" + iMatch[1] : iMatch[1];
    if (!src.includes(urlMod.parse(baseUrl).hostname)) {
      const r2 = await get(src, { Referer: baseUrl });
      stream = extractStream(r2.body);
      if (stream) return stream;
    }
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=300");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { tmdb, type, s, e } = req.query;
  if (!tmdb) return res.status(400).json({ error: "tmdb required" });

  const isMovie = type !== "tv";
  const season  = parseInt(s) || 1;
  const episode = parseInt(e) || 1;

  const sources = isMovie ? [
    [`https://vidsrc.me/embed/movie?tmdb=${tmdb}`,      "https://vidsrc.me/"],
    [`https://vidsrc.xyz/embed/movie?tmdb=${tmdb}`,     "https://vidsrc.xyz/"],
    [`https://vidsrc.in/embed/movie?tmdb=${tmdb}`,      "https://vidsrc.in/"],
    [`https://vidsrc.pm/embed/movie?tmdb=${tmdb}`,      "https://vidsrc.pm/"],
  ] : [
    [`https://vidsrc.me/embed/tv?tmdb=${tmdb}&season=${season}&episode=${episode}`,  "https://vidsrc.me/"],
    [`https://vidsrc.xyz/embed/tv?tmdb=${tmdb}&season=${season}&episode=${episode}`, "https://vidsrc.xyz/"],
    [`https://vidsrc.in/embed/tv?tmdb=${tmdb}&season=${season}&episode=${episode}`,  "https://vidsrc.in/"],
    [`https://vidsrc.pm/embed/tv?tmdb=${tmdb}&season=${season}&episode=${episode}`,  "https://vidsrc.pm/"],
  ];

  // Tentar todas em paralelo
  const stream = await Promise.any(
    sources.map(([url, ref]) => fromSource(url, ref).then(r => r || Promise.reject()))
  ).catch(() => null);

  if (!stream) return res.status(404).json({ error: "Stream not found" });

  res.status(200).json({ ...stream, tmdb, type: isMovie ? "movie" : "tv" });
};
