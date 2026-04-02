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

function extractContent(html, pageUrl) {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim() || "";

  // Remove non-content elements
  $("script, style, nav, header, footer, iframe, noscript, svg, img, form").remove();
  $("[role='navigation'], [role='banner'], [role='complementary'], [role='contentinfo']").remove();
  // Remove code blocks — these waste context and aren't useful for best-practice extraction
  $("pre, code, .highlight, .code-sample, .codehilite, .prism-code").remove();
  // Remove sidebars, comments, navigation aids, related content
  $("aside, .sidebar, .related, .related-articles, .recommended").remove();
  $(".comments, #comments, .comment-section, .disqus").remove();
  $(".breadcrumb, .pagination, .toc, .table-of-contents, .page-nav").remove();

  // Target article body first, fall back to <main>, then <body>
  let container = $("article").first();
  if (!container.length || container.text().trim().length < 200) container = $("main").first();
  if (!container.length || container.text().trim().length < 200) container = $("body");

  const text = container.text().replace(/\s+/g, " ").trim();

  let domain = "";
  try { domain = new URL(pageUrl).hostname; } catch {}
  const favicon = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : "";

  return { text, title, favicon, domain };
}

// Shared Playwright browser instance to avoid launching multiple Chromium processes
let _playwrightBrowser = null;
let _browserCloseTimer = null;

async function getSharedBrowser() {
  if (_playwrightBrowser?.isConnected()) return _playwrightBrowser;
  const { chromium } = await import("playwright");
  _playwrightBrowser = await chromium.launch({ headless: true });
  return _playwrightBrowser;
}

function scheduleBrowserClose() {
  if (_browserCloseTimer) clearTimeout(_browserCloseTimer);
  _browserCloseTimer = setTimeout(() => {
    if (_playwrightBrowser) {
      _playwrightBrowser.close().catch(() => {});
      _playwrightBrowser = null;
    }
  }, 60000); // Close after 60s idle
}

async function fetchWithPlaywright(pageUrl) {
  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 8000 });
    await page.waitForTimeout(1500);
    const html = await page.content();
    return html;
  } finally {
    await page.close().catch(() => {});
    scheduleBrowserClose();
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

async function fetchPageWithMeta(pageUrl) {
  const cached = cacheGet(pageUrl, "fetch");
  if (cached) {
    console.error(`[CACHE HIT] fetch_page: "${pageUrl}"`);
    return cached;
  }

  // Phase 1: Try plain HTTP fetch
  let result;
  try {
    const resp = await fetch(pageUrl, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      throw new Error(`Fetch failed ${resp.status}: ${resp.statusText}`);
    }

    const html = await resp.text();
    result = extractContent(html, pageUrl);

    // If the page returned virtually no text, it likely requires JS rendering
    if (result.text.length < 100) {
      throw new Error("Page content too short, likely requires JS rendering");
    }
  } catch (htmlErr) {
    // Phase 2: Fall back to Playwright for JS-rendered pages (with 45s total timeout)
    console.error(`[FETCH] HTML-only failed for "${pageUrl}": ${htmlErr.message} — retrying with Playwright`);
    try {
      const html = await withTimeout(fetchWithPlaywright(pageUrl), 10000, "Playwright fetch");
      result = extractContent(html, pageUrl);
    } catch (pwErr) {
      // Don't cache failures
      throw new Error(`Failed both HTML (${htmlErr.message}) and Playwright (${pwErr.message})`);
    }
  }

  // Only cache successful results with meaningful content
  if (result.text.length >= 100) {
    cacheSet(pageUrl, "fetch", result);
  }

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
