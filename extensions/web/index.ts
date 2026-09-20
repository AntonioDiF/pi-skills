/**
 * pi-web — web search & fetch for pi
 *
 * Tools:
 *   web_search — search the web. Tries SearXNG instances round-robin (with
 *                per-instance health tracking/cooldowns) and falls back to
 *                DuckDuckGo. This spreads load so no single backend throttles you.
 *   web_fetch  — fetch a URL and return it as text. Supports:
 *                 - heading:  "Install"   → only the section under that heading
 *                 - pattern:  "foo.*bar"  → grep mode (line numbers + context)
 *                 - offset/limit → line window over the converted text
 *                 - max_chars  → hard output cap
 *
 * Commands:
 *   /web search <query> [count]
 *   /web fetch <url>
 *   /web instances        → show SearXNG instance health
 *   /web help
 *
 * Config (env vars):
 *   PI_WEB_SEARXNG      comma/space separated SearXNG instance base URLs
 *                       (overrides the built-in list; run your own instance
 *                       for the most reliable results)
 *   PI_WEB_USER_AGENT   custom User-Agent for search + fetch
 *   PI_WEB_MAX_CHARS    default max_chars for web_fetch (default 12000)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ============================== config ==============================

const DEFAULT_SEARXNG_INSTANCES = [
	"https://searx.be",
	"https://search.sapti.me",
	"https://paulgo.io",
	"https://priv.au",
	"https://searx.tiekoetter.com",
	"https://search.disroot.org",
	"https://baresearch.org",
	"https://search.hbubli.cc",
	"https://searxng.site",
	"https://search.ononoki.org",
	"https://searx.work",
	"https://search.neet.me",
	"https://searxng.ch",
	"https://search.mdosch.de",
	"https://searx.sev.monster",
	"https://search.zhenyapav.com",
	"https://search.sethforprivacy.com",
	"https://search.inetol.net",
	"https://search.im-in.space",
	"https://etsi.me",
	"https://opnxng.com",
];

const DEFAULT_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

function envInstances(): string[] {
	const raw = process.env.PI_WEB_SEARXNG?.trim();
	if (!raw) return DEFAULT_SEARXNG_INSTANCES;
	return raw
		.split(/[\s,]+/)
		.filter(Boolean)
		.map((u) => u.replace(/\/+$/, ""));
}
function userAgent(): string {
	return process.env.PI_WEB_USER_AGENT?.trim() || DEFAULT_UA;
}
function defaultMaxChars(): number {
	const n = Number(process.env.PI_WEB_MAX_CHARS);
	return Number.isFinite(n) && n > 0 ? n : 12000;
}

// ========================= search backends ===========================

export interface SearchResult {
	title: string;
	url: string;
	snippet?: string;
}

export interface SearchOptions {
	query: string;
	count?: number;
	language?: string;
	time_range?: "day" | "week" | "month" | "year";
	category?: string;
	engines?: string;
	provider?: "auto" | "searxng" | "duckduckgo";
}

// Per-instance health: failures escalate into a cooldown; empty results
// briefly demote an instance so healthy ones get first pick.
interface Health {
	fails: number;
	cooldownUntil: number;
}
const health = new Map<string, Health>();
let rrCursor = 0;

function markFail(base: string) {
	const h = health.get(base) ?? { fails: 0, cooldownUntil: 0 };
	h.fails = Math.min(h.fails + 1, 6);
	h.cooldownUntil = Date.now() + Math.min(10 * 60_000, 30_000 * 2 ** (h.fails - 1));
	health.set(base, h);
}
function markWeak(base: string) {
	const h = health.get(base) ?? { fails: 0, cooldownUntil: 0 };
	if (h.fails < 1) {
		h.fails = 1;
		h.cooldownUntil = Date.now() + 60_000;
		health.set(base, h);
	}
}
function markOk(base: string) {
	health.delete(base);
}

/** Next instances to try, starting at the round-robin cursor, cooldowns skipped. */
function candidateInstances(maxTries: number): string[] {
	const all = envInstances();
	if (all.length === 0) return [];
	const now = Date.now();
	const fresh = all.filter((b) => (health.get(b)?.cooldownUntil ?? 0) <= now);
	const pool = fresh.length > 0 ? fresh : all;
	const out: string[] = [];
	for (let i = 0; i < pool.length && out.length < maxTries; i++) {
		out.push(pool[(rrCursor + i) % pool.length]);
	}
	rrCursor = (rrCursor + out.length) % pool.length;
	return out;
}

export function instanceHealthReport(): string {
	const lines = envInstances().map((b) => {
		const h = health.get(b);
		if (!h || h.cooldownUntil <= Date.now()) return `  ok      ${b}`;
		const secs = Math.ceil((h.cooldownUntil - Date.now()) / 1000);
		return `  down    ${b}  (cooldown ${secs}s, fails=${h.fails})`;
	});
	lines.push("");
	lines.push(`rotation cursor: ${rrCursor} | override with PI_WEB_SEARXNG`);
	return lines.join("\n");
}

async function fetchWithTimeout(
	url: string | URL,
	ms: number,
	signal?: AbortSignal,
	init?: RequestInit,
): Promise<Response> {
	return fetch(url, {
		...init,
		redirect: "follow",
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms),
	});
}

export async function searxngSearch(
	base: string,
	q: string,
	opts: SearchOptions,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const u = new URL(base + "/search");
	u.searchParams.set("q", q);
	u.searchParams.set("format", "json");
	if (opts.language) u.searchParams.set("language", opts.language);
	if (opts.time_range) u.searchParams.set("time_range", opts.time_range);
	if (opts.category) u.searchParams.set("categories", opts.category);
	if (opts.engines) u.searchParams.set("engines", opts.engines);
	const res = await fetchWithTimeout(u, 8000, signal, {
		headers: { "User-Agent": userAgent(), Accept: "application/json" },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const ct = res.headers.get("content-type") ?? "";
	if (!ct.includes("json")) throw new Error("JSON format disabled on this instance");
	const data: unknown = await res.json();
	const results = (data as { results?: unknown })?.results;
	if (!Array.isArray(results)) throw new Error("unexpected response shape");
	return (results as Array<Record<string, unknown>>)
		.map((r) => ({
			title: String(r.title ?? "").trim(),
			url: String(r.url ?? "").trim(),
			snippet: typeof r.content === "string" && r.content.trim() ? r.content.trim() : undefined,
		}))
		.filter((r) => r.url)
		.slice(0, 20);
}

const DDG_DUR: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };

const DDG_LANG: Record<string, string> = {
	en: "us-en",
	de: "de-de",
	fr: "fr-fr",
	es: "es-es",
	it: "it-it",
	pt: "br-pt",
	nl: "nl-nl",
	pl: "pl-pl",
	ru: "ru-ru",
	ja: "jp-jp",
	zh: "cn-zh",
	ko: "kr-ko",
	sv: "se-sv",
	no: "no-no",
	fi: "fi-fi",
	da: "da-da",
	cs: "cz-cs",
	tr: "tr-tr",
};

function ddgDecodeUrl(href: string): string {
	try {
		if (href.startsWith("//")) href = "https:" + href;
		const u = new URL(href);
		const uddg = u.searchParams.get("uddg");
		return uddg ?? href;
	} catch {
		return href;
	}
}

export function parseDdgHtml(html: string): SearchResult[] {
	const links: { url: string; title: string }[] = [];
	const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	let m: RegExpExecArray | null;
	while ((m = linkRe.exec(html))) {
		links.push({
			url: ddgDecodeUrl(m[1]),
			title: decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
		});
	}
	const snippets: string[] = [];
	const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
	while ((m = snipRe.exec(html))) {
		snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim());
	}
	return links.map((l, i) => ({ ...l, snippet: snippets[i] || undefined }));
}

export async function ddgSearch(q: string, opts: SearchOptions, signal?: AbortSignal): Promise<SearchResult[]> {
	const u = new URL("https://html.duckduckgo.com/html/");
	u.searchParams.set("q", q);
	u.searchParams.set("kl", (opts.language && DDG_LANG[opts.language]) || "wt-wt");
	if (opts.time_range) u.searchParams.set("df", DDG_DUR[opts.time_range]);
	const res = await fetchWithTimeout(u, 10_000, signal, {
		headers: { "User-Agent": userAgent(), Accept: "text/html" },
	});
	if (res.status === 202 || res.status === 429) {
		throw new Error("throttled (anomaly check) — try again shortly");
	}
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const html = await res.text();
	const results = parseDdgHtml(html);
	if (results.length === 0 && /anomaly|challenge|captcha/i.test(html)) {
		throw new Error("blocked by anomaly check");
	}
	return results;
}

export async function searchWeb(
	q: string,
	opts: SearchOptions,
	signal?: AbortSignal,
	onProgress?: (msg: string) => void,
): Promise<{ results: SearchResult[]; provider: string; errors: string[] }> {
	const count = Math.min(opts.count ?? 8, 20);
	const errors: string[] = [];
	let emptyProvider: string | undefined; // last backend that succeeded with 0 results

	if (opts.provider !== "duckduckgo") {
		const instances = candidateInstances(4); // cap: don't hammer every instance per query
		let emptyCount = 0;
		for (const base of instances) {
			if (signal?.aborted) break;
			const host = safeHost(base);
			try {
				onProgress?.(`searching searxng:${host}…`);
				const results = await searxngSearch(base, q, opts, signal);
				if (results.length > 0) {
					markOk(base);
					return { results: results.slice(0, count), provider: `searxng:${host}`, errors };
				}
				emptyCount++;
				emptyProvider = `searxng:${host}`;
				markWeak(base);
			} catch (e) {
				markFail(base);
				errors.push(`${host}: ${errMsg(e)}`);
			}
		}
		if (emptyCount > 0) errors.push(`${emptyCount} instance(s) returned 0 results`);
	}

	if (opts.provider !== "searxng") {
		try {
			onProgress?.("searching duckduckgo…");
			const results = await ddgSearch(q, opts, signal);
			if (results.length > 0) return { results: results.slice(0, count), provider: "duckduckgo", errors };
			emptyProvider = "duckduckgo";
			errors.push("duckduckgo: 0 results");
		} catch (e) {
			errors.push(`duckduckgo: ${errMsg(e)}`);
		}
	}

	if (emptyProvider) return { results: [], provider: emptyProvider, errors };
	throw new Error(`all search backends failed — ${errors.slice(0, 5).join("; ")}`);
}

export function formatSearchResults(query: string, provider: string, results: SearchResult[], errors: string[]): string {
	const lines: string[] = [];
	lines.push(`Web search: "${query}" — provider: ${provider} — ${results.length} result(s)`);
	if (results.length === 0) lines.push("(no results)");
	results.forEach((r, i) => {
		lines.push(`${i + 1}. ${r.title || "(untitled)"}`);
		lines.push(`   ${r.url}`);
		if (r.snippet) lines.push(`   ${truncate(r.snippet, 280)}`);
	});
	if (errors.length > 0) {
		lines.push("");
		lines.push(`backend notes: ${errors.slice(0, 4).join("; ")}`);
	}
	return lines.join("\n");
}

// ============================ html → text ============================

export function decodeEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}
function safeFromCodePoint(n: number): string {
	try {
		return String.fromCodePoint(n);
	} catch {
		return "";
	}
}
function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function safeHost(base: string): string {
	try {
		return new URL(base).host;
	} catch {
		return base;
	}
}
function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

interface HtmlToken {
	type: "text" | "tag" | "comment";
	value: string;
	start: number;
	end: number;
}

function tokenizeHtml(html: string): HtmlToken[] {
	const tokens: HtmlToken[] = [];
	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt === -1) {
			tokens.push({ type: "text", value: html.slice(i), start: i, end: html.length });
			break;
		}
		if (lt > i) tokens.push({ type: "text", value: html.slice(i, lt), start: i, end: lt });
		if (html.startsWith("<!--", lt)) {
			const close = html.indexOf("-->", lt + 4);
			const end = close === -1 ? html.length : close + 3;
			tokens.push({ type: "comment", value: html.slice(lt, end), start: lt, end });
			i = end;
			continue;
		}
		if (html.startsWith("<!", lt)) {
			const gt = html.indexOf(">", lt);
			const end = gt === -1 ? html.length : gt + 1;
			tokens.push({ type: "comment", value: html.slice(lt, end), start: lt, end });
			i = end;
			continue;
		}
		let j = lt + 1;
		let quote: string | null = null;
		while (j < html.length) {
			const c = html[j];
			if (quote) {
				if (c === quote) quote = null;
			} else if (c === '"' || c === "'") {
				quote = c;
			} else if (c === ">") {
				break;
			}
			j++;
		}
		const end = j >= html.length ? html.length : j + 1;
		tokens.push({ type: "tag", value: html.slice(lt, end), start: lt, end });
		i = end;
	}
	return tokens;
}

function tagInfo(value: string): { name: string; closing: boolean; selfClosing: boolean } | null {
	const m = value.match(/^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)/);
	const closing = !!m;
	const nameM = m ?? value.match(/^<\s*([a-zA-Z][a-zA-Z0-9-]*)/);
	if (!nameM) return null;
	return {
		name: nameM[1].toLowerCase(),
		closing,
		selfClosing: /\/\s*>$/.test(value),
	};
}

function tagAttr(tag: string, name: string): string | undefined {
	const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
	if (!m) return undefined;
	const v = m[1] ?? m[2] ?? m[3];
	return v === undefined ? "" : decodeEntities(v);
}

/** Content attribute of the first <meta> whose name matches (case-insensitive). */
function metaContent(html: string, name: string): string | undefined {
	const re = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		if ((tagAttr(m[0], "name") ?? "").toLowerCase() === name) return tagAttr(m[0], "content");
	}
	return undefined;
}

function stripTagsQuick(html: string): string {
	return decodeEntities(
		html
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
			.replace(/<[^>]+>/g, " "),
	).replace(/\s+/g, " ").trim();
}

/** Raw inner content of the first `<tag>…</tag>` (nesting-aware). */
function extractRegion(html: string, tag: string): string | null {
	let depth = 0;
	let start = -1;
	for (const t of tokenizeHtml(html)) {
		if (t.type !== "tag") continue;
		const info = tagInfo(t.value);
		if (!info || info.name !== tag) continue;
		if (!info.closing && !info.selfClosing) {
			if (depth === 0) start = t.end;
			depth++;
		} else if (info.closing && depth > 0) {
			depth--;
			if (depth === 0) return html.slice(start, t.start);
		}
	}
	return null;
}

const SKIP_TAGS = new Set(["script", "style", "noscript", "svg", "template", "iframe", "object", "canvas", "head"]);
const HIDE_TAGS = new Set(["nav", "aside", "form", "button", "label", "select", "option", "dialog", "header", "footer"]);
const BLOCK_TAGS = new Set([
	"p", "div", "section", "article", "blockquote", "li", "ul", "ol", "dl",
	"dd", "dt", "figcaption", "summary", "details", "pre", "h1", "h2", "h3", "h4", "h5", "h6",
]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

interface WalkerState {
	lines: string[];
	buf: string;
	listDepth: number;
	inPre: boolean;
	inTable: boolean;
	row: string[];
	headingLevel: number;
	inMain: boolean;
	skipStack: string[];
	anchors: { href: string; startLen: number }[];
}

function flushLine(s: WalkerState, listPrefix?: string) {
	if (s.inPre) return;
	const text = s.buf.replace(/\s+/g, " ").trim();
	s.buf = "";
	if (!text) return;
	if (s.inTable) {
		s.buf = text; // keep as cell content
		return;
	}
	if (s.headingLevel > 0) {
		s.lines.push("#".repeat(s.headingLevel) + " " + text.replace(/[\u00b6\u200b]+$/, "").trimEnd());
		s.headingLevel = 0;
	} else if (listPrefix !== undefined) {
		s.lines.push(listPrefix + text);
	} else {
		s.lines.push(text);
	}
}

export function htmlToLines(html: string): { lines: string[]; title: string; description?: string; usedMain: boolean } {
	const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleM ? decodeEntities(titleM[1]).replace(/\s+/g, " ").trim() : "";
	const description = (metaContent(html, "description") ?? "").trim() || undefined;

	let source: string;
	let usedMain = false;
	const mainRegion = extractRegion(html, "main") ?? extractRegion(html, "article");
	if (mainRegion && stripTagsQuick(mainRegion).length >= 150) {
		source = mainRegion;
		usedMain = true;
	} else {
		const bodyM = html.match(/<body[^>]*>([\s\S]*)<\/body>/i) ?? html.match(/<body[^>]*>([\s\S]*)$/i);
		source = bodyM ? bodyM[1] : stripTagsQuick(html);
	}

	const s: WalkerState = {
		lines: [],
		buf: "",
		listDepth: 0,
		inPre: false,
		inTable: false,
		row: [],
		headingLevel: 0,
		inMain: false,
		skipStack: [],
		anchors: [],
	};

	for (const t of tokenizeHtml(source)) {
		if (t.type === "text") {
			if (s.skipStack.length > 0) continue;
			s.buf += decodeEntities(t.value);
			continue;
		}
		if (t.type === "comment") continue;

		const info = tagInfo(t.value);
		if (!info) continue;
		const { name, closing, selfClosing } = info;

		if (closing) {
			// Unwind a skip region if this tag opened one.
			if (s.skipStack.length > 0 && s.skipStack[s.skipStack.length - 1] === name) {
				s.skipStack.pop();
				continue;
			}
			if (s.skipStack.length > 0) continue;

			switch (name) {
				case "a": {
					const a = s.anchors.pop();
					if (a && s.buf.length > a.startLen) {
						const inner = s.buf.slice(a.startLen);
						s.buf = s.buf.slice(0, a.startLen) + `${inner} (${a.href})`;
					}
					break;
				}
				case "pre": {
					const code = s.buf.replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n").trim();
					s.buf = "";
					s.inPre = false;
					if (code) {
						s.lines.push("```");
						s.lines.push(...code.split("\n"));
						s.lines.push("```");
					}
					break;
				}
				case "li": {
					flushLine(s, "  ".repeat(Math.max(0, s.listDepth - 1)) + "- ");
					break;
				}
				case "ul":
				case "ol": {
					s.listDepth = Math.max(0, s.listDepth - 1);
					break;
				}
				case "td":
				case "th": {
					s.row.push(s.buf.replace(/\s+/g, " ").trim());
					s.buf = "";
					break;
				}
				case "tr": {
					if (s.row.length > 0) s.lines.push("| " + s.row.join(" | ") + " |");
					s.row = [];
					break;
				}
				case "table": {
					s.inTable = false;
					break;
				}
				case "h1":
				case "h2":
				case "h3":
				case "h4":
				case "h5":
				case "h6":
				case "p":
				case "div":
				case "section":
				case "article":
				case "main":
				case "blockquote":
				case "figcaption":
				case "summary":
				case "details": {
					flushLine(s);
					if (name === "main" || name === "article") s.inMain = false;
					break;
				}
			}
			continue;
		}

		// Opening tag
		if (s.skipStack.length === 0 && !selfClosing) {
			if (SKIP_TAGS.has(name)) {
				s.skipStack.push(name);
				continue;
			}
			if (HIDE_TAGS.has(name)) {
				s.skipStack.push(name);
				continue;
			}
		}
		if (s.skipStack.length > 0) continue;
		if (selfClosing && name !== "br" && name !== "hr" && name !== "img") continue;

		switch (name) {
			case "br":
				s.buf += "\n";
				break;
			case "hr":
				flushLine(s);
				s.lines.push("----");
				break;
			case "img": {
				const alt = tagAttr(t.value, "alt");
				if (alt) s.buf += ` [img: ${alt}]`;
				break;
			}
			case "a": {
				const href = tagAttr(t.value, "href") ?? "";
				if (href && !href.startsWith("#") && !href.startsWith("javascript:") && !href.startsWith("mailto:")) {
					s.anchors.push({ href, startLen: s.buf.length });
				}
				break;
			}
			case "pre":
				flushLine(s);
				s.inPre = true;
				s.buf = "";
				break;
			case "h1":
			case "h2":
			case "h3":
			case "h4":
			case "h5":
			case "h6":
				flushLine(s);
				s.headingLevel = Number(name[1]);
				break;
			case "ul":
			case "ol":
				flushLine(s);
				s.listDepth++;
				break;
			case "table":
				flushLine(s);
				s.inTable = true;
				s.row = [];
				break;
			case "tr":
				s.row = [];
				break;
			case "main":
			case "article":
				s.inMain = true;
				// falls through to block-flush below
			case "p":
			case "div":
			case "section":
			case "blockquote":
			case "figcaption":
			case "summary":
			case "details":
				flushLine(s);
				break;
		}
	}
	flushLine(s);

	// Trim trailing empty lines
	while (s.lines.length > 0 && s.lines[s.lines.length - 1] === "") s.lines.pop();
	return { lines: s.lines, title, description, usedMain };
}

// ============================ fetch + view ===========================

export interface FetchOutcome {
	lines: string[] | null;
	note: string;
	title: string;
	description?: string;
	finalUrl: string;
	status: number;
	contentType: string;
}

function normalizeUrl(url: string): string {
	const u = url.trim();
	if (!/^https?:\/\//i.test(u)) return "https://" + u;
	return u;
}

const MAX_FETCH_BYTES = 5_000_000;

/**
 * Read a response body with a hard cap on buffered bytes. The stream is
 * aborted as soon as the cap is exceeded, so an oversized response is never
 * fully buffered in memory. Returns null when the cap is hit.
 */
async function readBodyCapped(res: Response): Promise<Buffer | null> {
	if (!res.body) return Buffer.alloc(0);
	const cl = Number(res.headers.get("content-length") ?? "");
	if (Number.isFinite(cl) && cl > MAX_FETCH_BYTES) {
		await res.body.cancel().catch(() => {});
		return null;
	}
	const parts: Uint8Array[] = [];
	let total = 0;
	try {
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
			total += (chunk as Uint8Array).byteLength;
			if (total > MAX_FETCH_BYTES) {
				await res.body.cancel().catch(() => {});
				return null;
			}
			parts.push(chunk as Uint8Array);
		}
	} catch (e) {
		throw new Error(`body read aborted: ${errMsg(e)}`);
	}
	return Buffer.concat(parts);
}

export async function fetchUrl(url: string, signal?: AbortSignal): Promise<FetchOutcome> {
	const target = normalizeUrl(url);
	const res = await fetchWithTimeout(target, 20_000, signal, {
		headers: {
			"User-Agent": userAgent(),
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,text/plain;q=0.9,*/*;q=0.8",
			"Accept-Language": "en",
		},
	});
	const status = res.status;
	const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
	const finalUrl = res.url || target;
	if (!res.ok) {
		let body = "";
		try {
			body = (await res.text()).replace(/\s+/g, " ").slice(0, 160);
		} catch {
			/* ignore */
		}
		throw new Error(`HTTP ${status} for ${finalUrl}${body ? ` — ${body}` : ""}`);
	}
	const raw = await readBodyCapped(res);
	if (raw === null) {
		return {
			lines: null,
			note: `Response too large: over ${MAX_FETCH_BYTES.toLocaleString("en-US")} bytes (limit 5MB)`,
			title: "",
			finalUrl,
			status,
			contentType,
		};
	}
	const text = raw.toString("utf-8");
	const trimmed = text.trimStart();
	const looksJson = contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[");
	const looksHtml =
		contentType.includes("html") || /^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text);

	if (looksJson) {
		let pretty = text;
		try {
			pretty = JSON.stringify(JSON.parse(text), null, 2);
		} catch {
			/* keep raw */
		}
		return { lines: pretty.split("\n"), note: "", title: "", finalUrl, status, contentType };
	}
	if (looksHtml) {
		const conv = htmlToLines(text);
		return {
			lines: conv.lines,
			note: conv.usedMain ? "" : "(no <main>/<article> found; extracted <body>)",
			title: conv.title,
			description: conv.description,
			finalUrl,
			status,
			contentType,
		};
	}
	if (contentType.startsWith("text/") || raw.length < 100_000) {
		return { lines: text.split("\n"), note: "", title: "", finalUrl, status, contentType };
	}
	return {
		lines: null,
		note: `Binary content: ${contentType || "unknown type"}, ${raw.length} bytes (not displayed)`,
		title: "",
		finalUrl,
		status,
		contentType,
	};
}

// ------------------------- view: section / grep ------------------------

/** Lines under `heading` (case-insensitive substring) until next same/higher-level heading. */
export function sectionByHeading(lines: string[], heading: string): string[] | null {
	const needle = heading.toLowerCase();
	let start = -1;
	let level = 0;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
		if (m && m[2].toLowerCase().includes(needle)) {
			start = i;
			level = m[1].length;
			break;
		}
	}
	if (start === -1) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const m = lines[i].match(/^(#{1,6})\s/);
		if (m && m[1].length <= level) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end);
}

export function listHeadings(lines: string[], max = 40): string[] {
	const out: string[] = [];
	for (let i = 0; i < lines.length && out.length < max; i++) {
		const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
		if (m) out.push(`  ${"#".repeat(m[1].length)} ${truncate(m[2], 70)}  (line ${i + 1})`);
	}
	return out;
}

export interface GrepOutcome {
	text: string;
	matchCount: number;
	shownMatches: number;
}

export function grepLines(
	lines: string[],
	pattern: string,
	ignoreCase: boolean,
	context: number,
	maxMatches = 40,
): GrepOutcome {
	let re: RegExp;
	try {
		re = new RegExp(pattern, ignoreCase ? "i" : "");
	} catch (e) {
		throw new Error(`invalid regex "${pattern}": ${errMsg(e)}`);
	}
	const matches: number[] = [];
	for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
		re.lastIndex = 0;
		if (re.test(lines[i])) matches.push(i);
	}
	const total = matches.length;
	const shown = Math.min(total, maxMatches);

	// Merge [i-context, i+context] ranges
	const ranges: [number, number][] = [];
	for (const i of matches.slice(0, shown)) {
		const lo = Math.max(0, i - context);
		const hi = Math.min(lines.length - 1, i + context);
		if (ranges.length > 0 && lo <= ranges[ranges.length - 1][1] + 1) {
			ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], hi);
		} else {
			ranges.push([lo, hi]);
		}
	}
	const out: string[] = [];
	ranges.forEach(([lo, hi], idx) => {
		if (idx > 0) out.push("---");
		for (let i = lo; i <= hi; i++) out.push(`${i + 1}: ${lines[i]}`);
	});
	return {
		text: out.join("\n"),
		matchCount: total,
		shownMatches: shown,
	};
}

export interface ViewOptions {
	heading?: string;
	pattern?: string;
	ignore_case?: boolean;
	context?: number;
	offset?: number;
	limit?: number;
	max_chars?: number;
}

/** Apply heading/grep/window/char-cap to fetched lines; returns display text + header lines. */
export function applyView(lines: string[], opts: ViewOptions, meta: string[]): string {
	const limit = Math.max(1, opts.limit ?? 400);
	const maxChars = Math.max(500, opts.max_chars ?? defaultMaxChars());
	const header: string[] = [];

	if (opts.heading) {
		const section = sectionByHeading(lines, opts.heading);
		if (!section) {
			const heads = listHeadings(lines);
			header.push(`Heading "${opts.heading}" not found. Available headings:`);
			header.push(heads.length > 0 ? heads.join("\n") : "  (none — page has no headings)");
			return header.join("\n");
		}
		lines = section;
		header.push(`section: "${opts.heading}" (${lines.length} lines)`);
	}

	if (opts.pattern) {
		const g = grepLines(lines, opts.pattern, opts.ignore_case ?? true, Math.max(0, opts.context ?? 3));
		header.push(
			`grep: ${g.matchCount} match(es)${g.matchCount > 40 ? ", showing first 40" : ""} for /${opts.pattern}/${opts.ignore_case ?? true ? "i" : ""}`,
		);
		if (g.matchCount === 0) {
			return [...meta, ...header, "", "(no matches)"].join("\n");
		}
		const text = g.text;
		return capText([...meta, ...header, "", text].join("\n"), maxChars);
	}

	const offset = Math.max(0, opts.offset ?? 0);
	const slice = lines.slice(offset, offset + limit);
	const windowed = offset > 0 || offset + limit < lines.length;
	const viewNote = windowed ? `lines ${offset + 1}-${Math.min(lines.length, offset + limit)} of ${lines.length}` : opts.heading ? undefined : `${lines.length} lines`;
	if (viewNote) header.push(viewNote);
	return capText([...meta, ...header, "", ...slice].join("\n"), maxChars);
}

function capText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const cut = text.slice(0, maxChars);
	return cut + `\n… [truncated at ${maxChars} chars — use offset/limit to page, or grep with pattern]`;
}

// =============================== tools ================================

const searchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	count: Type.Optional(Type.Number({ description: "Max results (default 8, max 20)" })),
	language: Type.Optional(Type.String({ description: "Language code, e.g. 'en', 'de'" })),
	time_range: Type.Optional(
		Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
			description: "Restrict to recent results",
		}),
	),
	category: Type.Optional(
		Type.String({ description: "SearXNG category: general, it, science, files, images, news" }),
	),
	engines: Type.Optional(Type.String({ description: "SearXNG engine filter, e.g. 'google,github'" })),
	provider: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("searxng"), Type.Literal("duckduckgo")], {
			description: "Backend (default auto: SearXNG rotation, then DuckDuckGo)",
		}),
	),
});

const fetchSchema = Type.Object({
	url: Type.String({ description: "URL to fetch (http/https)" }),
	heading: Type.Optional(
		Type.String({
			description:
				"Return only the section under this heading (case-insensitive substring). If not found, lists available headings.",
		}),
	),
	pattern: Type.Optional(
		Type.String({
			description:
				"JS regex — grep mode: returns matching lines (numbered) with context. Use this to find specific content on big pages.",
		}),
	),
	ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive grep (default true)" })),
	context: Type.Optional(Type.Number({ description: "Context lines around grep matches (default 3)" })),
	offset: Type.Optional(Type.Number({ description: "Start line (0-based) of the page text" })),
	limit: Type.Optional(Type.Number({ description: "Max lines to return (default 400)" })),
	max_chars: Type.Optional(Type.Number({ description: `Hard cap on output chars (default ${defaultMaxChars()})` })),
});

// ============================== commands ==============================

function makeTextView(tui: { requestRender(): void }, title: string, lines: string[], done: () => void) {
	let scroll = 0;
	const height = 18;
	return {
		render(width: number): string[] {
			const out: string[] = [title.slice(0, width)];
			const end = Math.min(lines.length, scroll + height);
			for (let i = scroll; i < end; i++) out.push(lines[i] === "" ? " " : lines[i]);
			if (lines.length > end) out.push(`… ${lines.length - end} more — j/k scroll, q close`);
			else out.push("q to close");
			return out;
		},
		invalidate() {},
		handleInput(data: string): void {
			if (data === "q" || data === "\x1b" || data === "\r" || data === "\n") {
				done();
				return;
			}
			if (data === "j" || data === " " || data === "\x7f" || data === "\u001b[B") {
				scroll += height;
				tui.requestRender();
				return;
			}
			if (data === "k" || data === "\u001b[A") {
				scroll = Math.max(0, scroll - height);
				tui.requestRender();
			}
		},
	};
}

// ============================== extension =============================

export default function webExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using rotating SearXNG instances with DuckDuckGo fallback. Returns titles, URLs and snippets.",
		promptSnippet: "Search the web (SearXNG instance rotation + DuckDuckGo fallback)",
		promptGuidelines: [
			"Use web_search for web searches; use web_fetch to read page content (heading= for a section, pattern= to grep).",
		],
		parameters: searchSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			const res = await searchWeb(
				params.query,
				params,
				signal,
				(msg) => onUpdate?.({ content: [{ type: "text", text: msg }], details: {} }),
			);
			return {
				content: [{ type: "text", text: formatSearchResults(params.query, res.provider, res.results, res.errors) }],
				details: { provider: res.provider, count: res.results.length },
			};
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL and return its content as text. HTML is converted to markdown-like text (headings, lists, code blocks, tables, links). Use heading= to fetch one section, pattern= to grep lines, offset/limit to page through long pages.",
		promptSnippet: "Fetch a URL as text; supports heading sections, regex grep, line windows",
		parameters: fetchSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			const outcome = await fetchUrl(params.url, signal);
			onUpdate?.({ content: [{ type: "text", text: `fetched ${outcome.finalUrl} (${outcome.status})` }], details: { url: outcome.finalUrl } });
			if (outcome.lines === null) {
				return {
					content: [
						{
							type: "text",
							text: `URL: ${outcome.finalUrl}\nStatus: ${outcome.status}\n${outcome.note}`,
						},
					],
					details: { url: outcome.finalUrl, status: outcome.status },
				};
			}
			const meta = [`URL: ${outcome.finalUrl}`, `Status: ${outcome.status} | Type: ${outcome.contentType || "unknown"}`];
			if (outcome.title) meta.push(`Title: ${outcome.title}`);
			if (outcome.description) meta.push(`Description: ${truncate(outcome.description, 200)}`);
			if (outcome.note) meta.push(outcome.note);
			const text = applyView(outcome.lines, params, meta);
			return {
				content: [{ type: "text", text }],
				details: { url: outcome.finalUrl, status: outcome.status, totalLines: outcome.lines.length },
			};
		},
	});

	pi.registerCommand("web", {
		description: "Web: /web search <query> [count] | /web fetch <url> | /web instances | /web help",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const show = async (text: string) => {
				if (ctx.mode === "tui" && ctx.hasUI) {
					const lines = text.split("\n");
					const title = parts[0] ? parts.join(" ").slice(0, 60) : "pi-web";
					await ctx.ui.custom((tui, _theme, _kb, done) => makeTextView(tui, title, lines, () => done(undefined)));
				} else if (ctx.hasUI) {
					ctx.ui.notify(text.length > 500 ? text.slice(0, 500) + "…" : text, "info");
				}
			};
			if (parts.length === 0 || parts[0] === "help" || parts[0] === "-h") {
				const help = [
					"pi-web commands:",
					"  /web search <query> [count]   web search",
					"  /web fetch <url>              fetch page as text",
					"  /web instances                SearXNG instance health",
					"",
					"Tools: web_search, web_fetch (also callable by the model).",
					"Env: PI_WEB_SEARXNG (instance list), PI_WEB_USER_AGENT, PI_WEB_MAX_CHARS.",
				].join("\n");
				await show(help);
				return;
			}
			try {
				let text: string;
				if (parts[0] === "search") {
					const query = parts.slice(1).join(" ");
					if (!query) throw new Error("usage: /web search <query> [count]");
					const count = parts.length > 2 ? Number(parts[parts.length - 1]) || 8 : 8;
					const res = await searchWeb(query, { query, count });
					text = formatSearchResults(query, res.provider, res.results, res.errors);
				} else if (parts[0] === "fetch") {
					const url = parts[1];
					if (!url) throw new Error("usage: /web fetch <url>");
					const outcome = await fetchUrl(url);
					if (outcome.lines === null) {
						text = `URL: ${outcome.finalUrl}\nStatus: ${outcome.status}\n${outcome.note}`;
					} else {
						const meta = [`URL: ${outcome.finalUrl}`, `Status: ${outcome.status}`];
						if (outcome.title) meta.push(`Title: ${outcome.title}`);
						text = applyView(outcome.lines, {}, meta);
					}
				} else if (parts[0] === "instances") {
					text = instanceHealthReport();
				} else {
					throw new Error(`unknown subcommand "${parts[0]}" (try /web help)`);
				}
				await show(text);
			} catch (e) {
				ctx.ui.notify(`web: ${errMsg(e)}`, "error");
			}
		},
	});
}
