# dsh-tinyfish

**Free web search and fetch for dsh — four backends behind the two tools your model already knows.**

English | [中文](README.zh.md)

![Same tools, free backend](assets/hero.png)

dsh ships `web_search` and `web_fetch`, backed by DeepSeek's paid Search & Fetch APIs. This keeps
those exact tools — same names, same parameters, same rendering — and sends the calls to free
backends instead: TinyFish, Keenable, AnySearch and Exa, queried in parallel and fused.

## What you get

| | stock dsh | with this |
| --- | --- | --- |
| Cost | $0.75 per 1,000 searches / fetches | **$0** |
| Tools the model sees | `web_search`, `web_fetch` | `web_search`, `web_fetch` — unchanged |
| Sources per search | one paid API | four free backends, fused and deduplicated |
| Sign-up needed | a paid DeepSeek key | **none** — keyless backends and keyless page reads |
| Extra tools / MCP servers | — | none |
| Latency (measured) | — | p50 **~630 ms**, soft-deadlined at 800 ms |
| Reversible | — | one `--revert`, profile backed up |

## Let an agent install it

Copy this to any coding agent (dsh, Claude Code, Codex…). It carries its own steps and verification.

```text
Install free web search and fetch for this machine's dsh. Keep the official web_search / web_fetch
tools exactly as they are: do not remove, disable or replace tool-web.

git clone https://github.com/gg686-jkl/dsh-tinyfish.git && cd dsh-tinyfish
node install.mjs                              # add --profile <name> only if one was named

Then: report the printed lines (provider row mounted / web seam pointed at the free provider /
official web_search/web_fetch enabled / search backends), run
`dsh --profile "${DSH_PROFILE:-web}" --dump-config | grep -c web-tinyfish` (expect 1), and tell me to
restart the app and open a new session. Only the current profile's cordis.patch.yml may change (the
script backs it up first); do not write AGENTS.md. If a step fails, say so instead of claiming
success. Full version: https://github.com/gg686-jkl/dsh-tinyfish/blob/main/PROMPT.md
```

## Or do it yourself

```bash
git clone https://github.com/gg686-jkl/dsh-tinyfish.git
cd dsh-tinyfish
node install.mjs
```

No git (usual on a phone):

```bash
curl -fsSL https://codeload.github.com/gg686-jkl/dsh-tinyfish/tar.gz/refs/heads/main | tar xz
cd dsh-tinyfish-main && node install.mjs
```

Restart dsh, open a **new session**. That is the whole install.

A [TinyFish key](https://agent.tinyfish.ai/api-keys) is optional: it adds a fourth search voice and
page reading as extracted text instead of raw HTML.

```bash
node install.mjs --key sk-tinyfish-xxxx --force
```

## Check / undo

```bash
dsh --profile "${DSH_PROFILE:-web}" --dump-config | grep -c web-tinyfish   # expect 1
node install.mjs --revert                                                 # back to stock
```

## How it works

```
web_search ─► tinyfish(key) ┐
              keenable      ├─ parallel ─► weighted RRF ─► dedupe ─► 2 per host ─► top N
              anysearch     │
              exa(keyless)  ┘       800 ms soft deadline, 2.5 s ceiling, 5 min cache

web_fetch  ─► tinyfish extracted text ─► exa keyless markdown ─► direct HTTP (page charset)
```

Only a `ctx.web` provider is registered. `@deepseek-ai/dsh-tool-web` keeps owning the tool names,
schemas, descriptions and rendering, so the model sees exactly what it was trained on — no `mcp__*`
names, no extra tools.

Every design decision, the measurement behind it and what was rejected are in
[docs/DESIGN.md](docs/DESIGN.md). The numbers are reproducible:

```bash
node probe.mjs --bench     # per-backend recall/junk/latency + strategy comparison, with 95% intervals
node --test bench/         # fusion, cache, breaker, retry, redaction rules
```

## FAQ

**What happens when one backend is down or throttled?** The others answer. A failure is logged, and a
backend that keeps failing is skipped for a minute. Rate limits are not retried — the window would
just answer 429 again. An answer is never empty because one source misbehaved.

**Do the tools change?** No. Same names, parameter schemas, descriptions and output format.

**Is a key really optional?** Yes. Search uses the keyless backends and page reads go through Exa's
keyless tier, so nothing needs signing up for. A key adds TinyFish search and extraction.

**What does it cost?** Nothing at these quotas: TinyFish 500 searches/hour and 1,000 fetches/day,
Keenable 1,000/hour keyless, AnySearch 1,000/day keyless, Exa's keyless MCP tier at its rate limit.

**How do I change which backends run?** Edit `backends:` on the `web-tinyfish` row in your profile's
`cordis.patch.yml` and restart; unknown ids are ignored.

**How do I see what one search did?** Start dsh with `DSH_WEB_DEBUG=1`; each search logs one line with
every backend's latency, the fused count and any failure.

**Weights?** Each backend carries a `trust` (Exa 1.0, TinyFish 0.95, Keenable 0.9, AnySearch 0.85),
overridable with `weights:`. Measured, they land inside the same interval as equal weights — they are
for demoting a backend that misbehaves on *your* network, not a claim of better ranking.

**Can I have all 24 backends and a settings page?** `node install.mjs --with-dsh-search` installs
[bestnite/search](https://github.com/bestnite/search)'s plugin (24 backends, GUI, ~17 MB). It adds its
own tools to the session; ours stays the default so the tool list stays clean.

**Browser automation or deep research?** `--with-mcp` mounts TinyFish's MCP server. TinyFish bills
those; search and fetch are the free ones.

**Android (dsh-go)?** Same commands, no dependencies.

**Coming from the old TinyFish-only version?** `node install.mjs --force` upgrades in place.

## Notes

- Requires dsh ≥ 0.2 and Node ≥ 22. Nothing is installed but the repo itself.
- Backend endpoints, quotas and access rules adapted from [bestnite/search](https://github.com/bestnite/search)
  (MIT, surveys 24 providers); the free subset is implemented here with no runtime dependency.
- The key lives in `$DSH_HOME/tinyfish.key` (mode 600) and never enters YAML.
- TinyFish's fetch API returns no HTTP status, so an extracted page reports `200`; the direct hop
  reports the real status.

MIT
