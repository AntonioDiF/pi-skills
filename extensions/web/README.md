# pi-web

Web access for [pi](https://pi.dev): two tools + one command.

## Tools (callable by the model)

### `web_search`

Searches the web and returns titles, URLs and snippets.

- Tries **SearXNG instances round-robin** (up to 4 per query) with per-instance
  health tracking: failures escalate into cooldowns (30 s → 10 min), instances
  that return 0 results are briefly demoted.
- Falls back to **DuckDuckGo** (HTML endpoint) if all SearXNG instances fail.
- `provider` parameter can force `searxng` or `duckduckgo` (default `auto`).
- Optional filters: `language`, `time_range` (day/week/month/year), `category`,
  `engines` (SearXNG engine list), `count` (≤ 20).

### `web_fetch`

Fetches a URL and returns it as text (HTML → markdown-like lines: headings,
lists, fenced code blocks, tables, links as `text (url)`; `<nav>`,
`<header>`, `<footer>`, `<aside>`, forms and scripts are stripped;
`<main>`/`<article>` is preferred when present). JSON is pretty-printed.

View options (all combinable where sensible):

| Parameter      | Effect                                                                  |
| -------------- | ----------------------------------------------------------------------- |
| `heading`      | Return only the section under that heading (substring, case-insensitive). If not found, lists the page's available headings so you can retry. |
| `pattern`      | Grep mode: JS regex over lines, returns numbered matches with `context` lines (default 3), capped at 40 matches. |
| `offset`       | Start line (0-based) of the converted text                              |
| `limit`        | Max lines to return (default 400)                                       |
| `max_chars`    | Hard output cap (default 12000)                                         |
| `ignore_case`  | Case-insensitive grep (default true)                                    |

Typical workflow: `web_fetch url` (or with `pattern=`) → if the page is big,
refetch with `heading=`/`offset`+`limit` to page through it.

## Command

```
/web search <query> [count]
/web fetch <url>
/web instances     # SearXNG instance health + rotation cursor
/web help
```

In the TUI the output opens in a scrollable overlay (j/k scroll, q close).

## Configuration (env vars)

| Variable             | Default | Description |
| -------------------- | ------- | ----------- |
| `PI_WEB_SEARXNG`     | 20 public instances | Comma/space-separated SearXNG base URLs. Public instances are often throttled (especially from datacenter IPs) — for reliable JSON results run your own (`docker run -p 8080:8080 searxng/searxng` + `search.formats: [html, json]`) and set `PI_WEB_SEARXNG=https://localhost:8080`. |
| `PI_WEB_USER_AGENT`  | Firefox 130 UA | UA for search + fetch |
| `PI_WEB_MAX_CHARS`   | 12000  | Default `max_chars` for `web_fetch` |

## Notes

- Zero dependencies (uses global `fetch`; Node ≥ 20.3 for `AbortSignal.any`).
- No cookies/state: search backends are treated as anonymous.
- Responses are capped (5 MB raw) and output is capped by `max_chars` to keep
  the LLM context small.
