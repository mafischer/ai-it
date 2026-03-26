import { z } from "zod";
import * as cheerio from "cheerio";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let _cacheDb;
function getCacheDb() {
  if (_cacheDb) return _cacheDb;
  const dbPath = join(__dirname, "..", "..", "web_cache.db");
  _cacheDb = new Database(dbPath);
  _cacheDb.pragma("journal_mode = WAL");
  _cacheDb.exec(`CREATE TABLE IF NOT EXISTS web_cache (
    key TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  return _cacheDb;
}

function cacheGet(key, type) {
  try {
    const db = getCacheDb();
    const row = db.prepare("SELECT data, created_at FROM web_cache WHERE key = ? AND type = ?").get(key, type);
    if (!row) return null;
    if (Date.now() - row.created_at > CACHE_TTL_MS) {
      db.prepare("DELETE FROM web_cache WHERE key = ? AND type = ?").run(key, type);
      return null;
    }
    return JSON.parse(row.data);
  } catch { return null; }
}

function cacheSet(key, type, data) {
  try {
    const db = getCacheDb();
    db.prepare("INSERT OR REPLACE INTO web_cache (key, type, data, created_at) VALUES (?, ?, ?, ?)").run(key, type, JSON.stringify(data), Date.now());
  } catch {}
}

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,es-CO;q=0.8,es;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Ch-Ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

// Load optional fingerprint config: tools/fingerprint.json
function loadBrowserHeaders() {
  try {
    const raw = readFileSync(join(__dirname, "..", "fingerprint.json"), "utf8");
    const custom = JSON.parse(raw);
    return { ...DEFAULT_HEADERS, ...custom };
  } catch {
    return DEFAULT_HEADERS;
  }
}

const BROWSER_HEADERS = loadBrowserHeaders();

async function searchDDG(query, maxResults = 10) {
  const cacheKey = `${query}::${maxResults}`;
  const cached = cacheGet(cacheKey, "search");
  if (cached) {
    console.error(`[CACHE HIT] web_search: "${query}"`);
    return cached;
  }

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: { ...BROWSER_HEADERS, Referer: "https://duckduckgo.com/" },
    redirect: "follow",
  });

  if (!resp.ok) {
    throw new Error(`DuckDuckGo returned ${resp.status}: ${resp.statusText}`);
  }

  const html = await resp.text();
  const $ = cheerio.load(html);
  const results = [];

  $(".result").each((i, el) => {
    if (results.length >= maxResults) return false;
    const titleEl = $(el).find(".result__a");
    const snippetEl = $(el).find(".result__snippet");
    const title = titleEl.text().trim();
    const snippet = snippetEl.text().trim();

    let href = titleEl.attr("href") || "";
    const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      href = decodeURIComponent(uddgMatch[1]);
    }

    if (title && href) {
      results.push({ title, url: href, snippet });
    }
  });

  cacheSet(cacheKey, "search", results);
  return results;
}

async function fetchPage(url) {
  const meta = await fetchPageWithMeta(url);
  return meta.text;
}

async function fetchPageWithMeta(pageUrl) {
  const cached = cacheGet(pageUrl, "fetch");
  if (cached) {
    console.error(`[CACHE HIT] fetch_page: "${pageUrl}"`);
    return cached;
  }

  const resp = await fetch(pageUrl, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    throw new Error(`Fetch failed ${resp.status}: ${resp.statusText}`);
  }

  const html = await resp.text();
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim() || "";

  $("script, style, nav, header, footer, iframe, noscript, svg, img, form").remove();
  $("[role='navigation'], [role='banner'], [role='complementary']").remove();

  const text = $("body").text().replace(/\s+/g, " ").trim();

  // Truncate at a generous limit to avoid catastrophic inference crashes but allow plenty of context
  const maxLen = 20000;
  let domain = "";
  try { domain = new URL(pageUrl).hostname; } catch {}
  const favicon = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : "";

  const result = {
    text: text.length > maxLen ? text.slice(0, maxLen) + "\n\n[...truncated]" : text,
    title,
    favicon,
    domain,
  };

  cacheSet(pageUrl, "fetch", result);
  return result;
}

export { searchDDG, fetchPage, fetchPageWithMeta };

/**
 * Register web-search tools on an McpServer instance.
 */
export function registerTools(server) {
  server.tool(
    "web_search",
    "Search the web using DuckDuckGo and return a list of results with titles, URLs, and snippets.",
    {
      query: z.string().describe("The search query"),
      max_results: z.number().min(1).max(25).default(10).describe("Maximum number of results to return"),
    },
    async ({ query, max_results }) => {
      try {
        const results = await searchDDG(query, max_results);
        if (!results.length) {
          return { content: [{ type: "text", text: `No results found for "${query}".` }] };
        }
        const formatted = results
          .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");
        return { content: [{ type: "text", text: formatted }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Search error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "fetch_page",
    "Fetch a web page and extract its text content.",
    {
      url: z.string().url().describe("The URL to fetch"),
    },
    async ({ url }) => {
      try {
        const text = await fetchPage(url);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Fetch error: ${err.message}` }], isError: true };
      }
    }
  );
}
