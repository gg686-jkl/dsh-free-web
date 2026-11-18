# Design log

Every decision here was made against a measurement, and the measurements are reproducible with
`node probe.mjs --bench` (52 queries whose answer URL is known) and `node --test bench/`.
Numbers are from one machine on 2026-11-18 and are a snapshot, not a promise.

## The rule that governs tuning

> If the 95% intervals overlap, the difference is not an improvement.

Wilson intervals are printed next to every recall figure. This rule exists because v1.3 shipped a
knob that had only ever moved the result by noise — see the rejected list.

## Adopted

### Weighted reciprocal rank fusion
`score = Σ weight × quality / (60 + rank)`.

Each backend carries a `trust` value. It is a knob for demoting a source that turns out unreliable
in *your* environment, not a claim that the ranking is better: measured, equal weights and measured
weights land inside the same interval. Exa 1.0, TinyFish 0.95, Keenable 0.9, AnySearch 0.85.

### Quality penalty, never removal
A listing whose title is just an address scores ×0.6; a titleless one ×0.5–0.7. Keenable returns
those for pages it could not parse (junk rate 15–24% in the top five). They are down-weighted
because the one result that answers a question may well be ugly.

### Near-duplicate collapse
After URL normalisation, a second pass merges entries whose normalised titles match *and* which
share a host or a snippet similarity ≥ 0.5. Title alone would merge genuinely different pages that
happen to share a headline; the tests pin that counter-example.

### Soft deadline (800 ms) with a floor and a ceiling
Return what has arrived by 800 ms, but only if at least 3 sources from 2 backends are in hand; the
wait then extends to a 2.5 s ceiling. Measured on 52 queries: p50 923 ms → 632 ms with recall
unchanged (51/52 both ways). The floor and ceiling were added after a real session where one slow
backend (TinyFish at 3.7 s under an hourly quota) dragged a search to 3.7 s — the bench models the
deadline but not that pathology.

### Breaker, opened immediately by a rate limit
Three consecutive failures take a backend out for 60 s. A 429 or 402 opens it at once: free tiers
throttle for a window, and retrying spends the reader's latency to earn the same answer. Measured
incident: after a 52-query bench run, Exa answered 429 to everything and AnySearch had spent its
daily quota; without a breaker every subsequent search would pay both timeouts.

### One retry, only where it helps
Retries on network errors and 5xx. Not on 401/402/403/429 — those are states, not accidents.

### Host diversity cap (2)
Measured before the change: `cordis.patch.yml example` returned **100% github.com** in the top five,
two other queries 80%. After: mean top-host share 53% → 35%, recall 51/52 → 50/52 (intervals
overlap). Worth it: five results from one site add less than four sites do.

### Keyless page text
Fetch chain is TinyFish → Exa's keyless MCP tier → direct HTTP. Exa answers markdown, so a key is
no longer needed to read a page. The direct hop keeps `kind: 'html'` on purpose: `dsh-tool-web`
already converts HTML to markdown with turndown, so the text is cleaned upstream.

### Charset from the page, size and type guards
Direct reads decode with the page's declared charset (a GB2312 page previously produced mojibake),
refuse bodies over 8 MB, and answer PDFs/images with `WEB_FETCH_UNSUPPORTED` instead of binary noise.

### Credential-shaped bodies are not echoed
AnySearch answers an exhausted anonymous quota with HTTP 402 **and a freshly generated account and
password in the body**. `failureFor` therefore never echoes 401/402/403 bodies. A test asserts the
password does not appear in the message, because this text reaches logs and model context.

## Rejected

| Idea | Why it was dropped |
| --- | --- |
| `bestRankBonus` (a bonus for a backend's own rank-1 hit) | Mathematically a no-op: it scales every entry by its own best score, so it can never change an order. It appeared to help by +7% on 15 queries — noise. Removed in v1.3 after a test proved it. |
| Writing our own HTML→markdown extractor | `dsh-tool-web` already converts HTML with turndown and strips script/style/noscript/template. A second implementation would only be worse. |
| Vendoring `@nite07/search-core` | Pulls a browser runtime (patchright) and its plugin registers six extra tools; both break "the model sees only `web_search` / `web_fetch`". Its backend survey is used as reference instead. |
| Lexical/BM25 blend into the final score | Measured +0 on recall@1 and recall@5 across 52 queries (59% vs 59%). Kept as an option (`lexical`) but defaults to 0 — an unproven knob in the default path is a liability. |
| Serving the fastest backend only | Fastest is not best: AnySearch answered in ~460 ms with 73–87% recall, Exa at ~680 ms with 100%. Fusion is what makes speed and coverage separable. |
| Caching failures | A throttle window would be frozen into the cache for its whole TTL. Only successes are cached. |

## Known limits

- The gold set is 52 hand-checked URLs, not a web-wide evaluation; it compares backends **to each
  other**, and a query whose answer I picked may have equally good alternatives.
- Free tiers change: AnySearch auto-generates an account at its anonymous limit, Exa throttles per
  IP, TinyFish slows down as its hourly quota fills. The breaker absorbs this, the bench reports it.
- `web_search` cannot show the model which backend failed — the seam's result shape has no field for
  it. Failures go to the host log and, with `DSH_WEB_DEBUG=1`, one line per search.
