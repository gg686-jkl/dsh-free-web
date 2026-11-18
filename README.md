# dsh-tinyfish

**Free web search and fetch for dsh — four backends behind the two tools your model already knows.**

English | [中文](README.zh.md)

![Same tools, free backend](assets/hero.png)

dsh ships `web_search` and `web_fetch`, backed by DeepSeek's paid Search & Fetch APIs (**$0.75 per
1,000 requests each**). This keeps those exact tools — same names, same parameters, same rendering —
and sends the calls to free backends instead: TinyFish, Keenable, AnySearch and Exa, queried in
parallel and fused. **No key is required to start**, and no MCP server or extra tool is mounted.

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

Restart dsh, open a **new session**. Search and fetch now run on the free backends.

Adding a [TinyFish key](https://agent.tinyfish.ai/api-keys) is optional and buys two things: a fourth
search voice, and page reading as clean extracted text instead of raw HTML.

```bash
node install.mjs --key sk-tinyfish-xxxx --force
```

## Check

```bash
dsh --profile "${DSH_PROFILE:-web}" --dump-config | grep -c web-tinyfish   # expect 1
```

## Undo

```bash
node install.mjs --revert
```

## FAQ

**What actually runs?** `web_search` fans out to TinyFish (with a key), Keenable and AnySearch
(keyless), and Exa (keyless MCP), then fuses the ranked lists by reciprocal rank fusion and drops
duplicate URLs. One backend failing is logged, not fatal. `web_fetch` reads through TinyFish when a
key exists and falls back to a direct HTTP read otherwise.

**Do the tools change?** No. `web_search` / `web_fetch` keep the official names, parameter schemas,
descriptions and output format. This only registers a `ctx.web` provider, so the model sees the tools
it was trained on — and no extra tools, no `mcp__*` names.

**What does it cost?** Nothing. TinyFish search and fetch are free (500 requests/hour, 1,000 fetches/
day), Keenable is 1,000 requests/hour keyless, AnySearch is 1,000/day keyless, and Exa's keyless MCP
tier is free at its rate limit. DeepSeek's own APIs would be $0.75 per 1,000 calls each.

**Is a key really optional?** Yes. Without one, search uses the three keyless backends and fetch
reads pages directly. A key adds TinyFish search and cleaner page text.

**How do I change which backends run?** Edit the `config:` block on the `web-tinyfish` row in your
profile's `cordis.patch.yml` — `backends: [tinyfish, keenable, anysearch, exa]` — and restart. Run
`node probe.mjs` first: it measures each backend's latency and results without starting dsh.

**Can I have all 24 backends and the settings page?** `node install.mjs --with-dsh-search` installs
[bestnite/search](https://github.com/bestnite/search)'s plugin (24 backends, GUI settings, ~17 MB).
It adds its own tools to the session; ours stays the default so the tool list stays clean.

**What about browser automation or deep research?** `--with-mcp` mounts TinyFish's MCP server for
those. TinyFish bills them; search and fetch are the free ones.

**Does it work on the dsh-go Android app?** Yes — same commands, no dependencies.

**Already installed the old TinyFish-only version?** `node install.mjs --force` upgrades in place.

## Notes

- Requires dsh ≥ 0.2 and Node ≥ 22. Nothing is installed but the repo itself.
- Backend endpoints, quotas and access rules are adapted from [bestnite/search](https://github.com/bestnite/search) (MIT),
  which surveys 24 providers; this project implements the free subset with no runtime dependency.
- The key lives in `$DSH_HOME/tinyfish.key` (mode 600) and never enters YAML.
- TinyFish's fetch API does not return an HTTP status, so the tool reports `200` for a successful
  extraction; the direct fallback reports the real status.

MIT
