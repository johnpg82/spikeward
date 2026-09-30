# Spikeward — Project Plan

Open-source bot-spike mitigation on Cloudflare Workers, powered by Jev

Sep 29, 2026 · @John Garland

## Overview

Spikeward is an open-source Worker that watches a zone's traffic, asks Jev to judge suspicious clusters, and writes short-lived WAF blocks or challenges. It deploys from one button into the user's own Cloudflare account and is configured entirely from its own web app.

The core design rule: Jev never sits in the request path. Cloudflare's edge keeps doing per-request work; Spikeward runs beside it on a cron, so Jev calls scale with the number of suspicious clusters (tens per spike), not with the number of requests (millions).

**Goals**

- One-click deploy to any Cloudflare account, with no CLI and no local setup.
- Full configuration from the app: zones, thresholds, Jev questions, allowlists, actions, and TTLs.
- Zero added latency for real users.
- Every action is reversible and auditable, and expires on its own.
- Works on Free and Pro plans, with better signals unlocked on Business and Enterprise.

**Non-goals (v1)**

- Replacing Cloudflare Bot Management or Super Bot Fight Mode. Spikeward layers on top.
- Per-request inline scoring.
- Multi-tenant SaaS hosting. Each install serves one account.

## One-click deploy

The README carries a standard [Deploy to Cloudflare button](https://developers.cloudflare.com/workers/platform/deploy-buttons/) pointing at the public repo. The deploy form asks for one secret; everything else is set in the app afterward.

**What the button does for us**

- Forks the repo into the user's GitHub and builds it with Workers Builds, so later pushes (or syncing upstream releases) redeploy automatically.
- Auto-provisions every binding declared in `wrangler.jsonc` without IDs: one D1 database and one KV namespace. Supported types include KV, D1, R2, Durable Objects, Queues and Secrets Store secrets.
- Prompts for secrets listed in `.dev.vars.example`. We list exactly one: `SPIKEWARD_SECRET`, a long random string.
- Sets the cron trigger (every minute) from the config.

**Repo rules that keep the button working**

- `wrangler.jsonc` ships with binding names and default resource names but no resource IDs.
- Only one KV namespace. A known pitfall is two KV bindings pre-filled with the same default name, which fails provisioning.
- No Durable Objects in v1. D1 plus KV covers the state, which keeps the stack to tools you already run in production.
- The Worker applies D1 migrations itself on first request (SQL bundled as text, a `schema_version` row). No `wrangler d1 migrations apply` step is needed in the build.

**First-run wizard (in the app)**

1. **Claim.** The first visitor enters `SPIKEWARD_SECRET`, then creates an admin passkey or password. The claim endpoint locks after that.
2. **Cloudflare API token.** A link opens the dashboard's token page with the needed permissions listed (see Security). The user pastes the token; the app verifies it and lists the zones it can see.
3. **Jev key.** The user pastes a TypeSafe key, or picks OpenRouter or Vercel AI Gateway as the provider. The app runs one test call.
4. **Zones.** The user picks zones. The app detects each zone's plan and shows which features are available (see Plan compatibility).
5. **Provision.** The app creates its IP list and its WAF rules on each zone, disabled, in shadow mode.
6. **Shadow period.** Spikeward runs for 24 hours logging what it *would* do. The user reviews, then flips to enforce.

The Cloudflare token and Jev key are stored in D1, encrypted with AES-GCM using a key derived from `SPIKEWARD_SECRET`. They never appear in the fork, the build logs, or the Worker's env vars.

## Configuration app

The same Worker serves the app as static assets plus a JSON API under `/api`. Every setting lives in D1 and takes effect on the next cron tick, with no redeploy.

| Screen | What the user sees and controls |
| --- | --- |
| Live | Requests per minute per zone, the current baseline, active spikes, and clusters being judged right now |
| Decisions | Every Jev verdict: cluster, features sent, probabilities returned, action taken, expiry. One-click undo and "always allow" |
| Actions | Active blocks and challenges with time left; extend, shorten, or remove |
| Zones | Per zone: mode (off, shadow, enforce), plan tier detected, features available |
| Detection | Spike trigger (multiple of baseline, absolute floor), cluster keys (IP, /24, ASN, JA4, UA), minimum cluster size, poll interval |
| Policy | Probability thresholds per action, TTL per action, max new blocks per hour, never-block list (IPs, ASNs, UAs, paths) |
| Jev | Provider (TypeSafe, OpenRouter, Vercel Gateway), model alias, question schema editor with a "test against last spike" button, daily call and spend caps |
| Alerts | Slack or email webhook for spikes and grey-zone verdicts, with approve and reject links |
| Settings | Credentials (rotate, re-verify), admin users, export config as JSON, import, reset |

Sensible defaults ship out of the box, so a user who only completes the wizard gets working protection. The question schema editor is the power-user feature: users can add their own questions (say, "is this a partner integration?") and map answers to actions.

## Detection pipeline

A cron runs every minute per zone. It reads traffic from the GraphQL Analytics API, detects a spike, groups the spike into clusters, and sends only the clusters worth judging to Jev.

**Data source.** `httpRequestsAdaptiveGroups` [works on the Free plan](https://github.com/luberan/cloudflare-waf-log) and gives per-group counts by client IP, ASN, country, user agent, path, method, and status. Free-plan adaptive datasets keep roughly 24 hours, which is plenty for a one-minute loop. No Logpush, no route on the zone, and zero cost per real request. Adaptive data is sampled at high volume, which is fine for clustering but means counts are estimates.

1. **Poll.** Query the last two minutes per zone, grouped by the configured cluster keys. Also pull `firewallEventsAdaptive` so we see what Cloudflare already blocked.
2. **Baseline.** Keep an exponentially weighted requests-per-minute baseline per zone and per hour of week in KV. A spike starts when traffic exceeds the configured multiple (default 3x) and an absolute floor (default 500 rpm).
3. **Cluster.** Group spike traffic by IP, /24, ASN, user agent, and (Enterprise) JA4. Compute features per cluster: rpm, share of the spike, distinct paths, top five paths, 4xx and 403 rate, asset-to-page ratio, method mix, country mix, and whether the ASN is a hosting provider.
4. **Pre-filter.** Drop anything on the never-block list, verified bots, clusters below the minimum size, and clusters already actioned. Most spikes end up with 5 to 30 clusters.
5. **Sanitize.** Replace raw paths and query strings that contain attack patterns with flags such as `has_sqli_pattern: true` and `has_traversal_pattern: true`. Raw probes in the state [trip the WAF in front of the Jev API](https://github.com/tamaratran/fast-jev-compaction/issues/97) and the call fails with a 403.
6. **Judge.** One Jev call per cluster, capped per tick and per day. Results are cached in KV by cluster fingerprint for the action's TTL.
7. **Decide.** Apply the policy thresholds and hand the result to enforcement.

**Jev call.** TypeSafe's API is a single endpoint, `POST /v1/systemone`, taking a state, a model alias, and a map of named questions ([you.com overview](https://you.com/resources/what-is-jev)). Field names below are illustrative and get pinned to TypeSafe's docs in milestone 1.

```json
{
  "model": "jev-latest",
  "state": {
    "zone_type": "content site with member login",
    "cluster_key": "asn:14061",
    "rpm": 4200, "baseline_rpm": 350, "share_of_spike": 0.62,
    "distinct_ips": 180, "distinct_paths": 2900,
    "top_paths": ["/lectures/*", "/search?q=*"],
    "status_mix": {"200": 0.71, "404": 0.22, "403": 0.07},
    "asset_to_page_ratio": 0.02,
    "user_agents": ["Mozilla/5.0 ... Chrome/128"],
    "hosting_asn": true,
    "flags": {"has_sqli_pattern": false, "hits_login": false}
  },
  "questions": {
    "is_automated": {"type": "yes_no"},
    "intent": {"type": "choice", "options": ["search_crawler", "ai_crawler", "scraper", "credential_stuffing", "vuln_scanner", "monitor_or_load_test", "partner_integration", "human_burst"]},
    "harm": {"type": "score"},
    "action": {"type": "choice", "options": ["allow", "observe", "managed_challenge", "rate_limit", "block"]}
  }
}
```

The `action` answer is advisory. Policy thresholds on `is_automated` and `harm` decide the final action, so a user can tune behavior without rewriting questions.

## Enforcement

Spikeward acts only through objects it created and tagged `spikeward:`. It never edits the user's own rules. Every action has an expiry, and D1 tracks it, because Cloudflare list items have no native TTL.

**Mechanisms, narrowest first**

| Cluster key | Default action | How it is applied |
| --- | --- | --- |
| Single IP | Block at high confidence, else challenge | Item in the Spikeward IP list, referenced by a block rule |
| /24 or small CIDR set | Managed challenge | Inline set in the challenge rule's expression |
| ASN | Managed challenge, never block | `ip.geoip.asnum in {…}` in the challenge rule |
| User agent | Managed challenge | Exact-match UA clause in the challenge rule |
| JA4 (Enterprise) | Rate limit keyed on JA4 | Spikeward-owned rate limiting rule |

Broad keys (ASN, user agent) only ever challenge, because they catch real users. Hard blocks are reserved for single IPs above the block threshold.

**Safety rails**

- Shadow mode per zone: log the decision, apply nothing.
- Never-block list, and verified bots are always excluded.
- Cap on new actions per hour per zone (default 50); hitting it pauses enforcement and alerts.
- Grey zone (default probability 0.70 to 0.95): challenge only, plus an alert with approve and reject links.
- Escalation on repeat offenders: a second offense within 24 hours doubles the TTL, up to 7 days.
- Kill switch: one button disables every Spikeward rule on every zone.
- Janitor: each tick removes expired items and reconciles D1 against what exists in Cloudflare, so a failed call never leaves an orphan block.

**Default TTLs:** challenge 1 hour, rate limit 1 hour, block 6 hours. All editable in Policy.

## Data model

D1 holds configuration and history; KV holds hot, short-lived state the cron reads every minute.

**D1 tables**

| Table | Key columns | Purpose |
| --- | --- | --- |
| `meta` | key, value | Schema version, install id, claim state |
| `credentials` | kind, ciphertext, iv, verified\_at | Encrypted Cloudflare token and Jev key |
| `users` | id, name, passkey or password hash, role | Admin logins |
| `zones` | zone\_id, name, plan, mode, list\_id, rule\_ids (JSON) | Managed zones and the Cloudflare objects Spikeward owns |
| `settings` | zone\_id (null = global), key, value (JSON) | Detection, policy, Jev, and alert settings |
| `allowlist` | zone\_id, kind (ip, asn, ua, path), value, note | Never-block entries |
| `spikes` | id, zone\_id, started\_at, ended\_at, peak\_rpm, baseline\_rpm | One row per spike |
| `decisions` | id, spike\_id, cluster\_key, features (JSON), jev\_answers (JSON), action, reason | Every Jev verdict and its policy outcome |
| `actions` | id, decision\_id, zone\_id, mechanism, target, applied\_at, expires\_at, removed\_at, removed\_by | Everything applied, for the janitor and undo |
| `usage` | day, jev\_calls, jev\_input\_tokens, est\_cost | Enforces the daily caps |

**KV keys:** `baseline:{zone}:{hourOfWeek}` (EWMA), `verdict:{zone}:{clusterFingerprint}` (cached answer, TTL = action TTL), and `rpm:{zone}` (last value for the Live screen). The per-zone tick lock lives in D1 as a conditional update on `zones.locked_until`, because KV is eventually consistent and can't guarantee a single runner.

Retention: decisions and actions pruned after 90 days by default, configurable.

## Plan compatibility

The core loop works on every plan, including Free. Higher plans add sharper signals and more room for rules. The app reads each zone's plan at setup and hides what isn't available.

| Capability | Free | Pro | Business | Enterprise + Bot Mgmt |
| --- | --- | --- | --- | --- |
| Traffic polling (`httpRequestsAdaptiveGroups`) | Yes | Yes | Yes | Yes |
| Custom IP lists (account-wide) | 1 | 10 | 10 | 1,000 |
| List items (account-wide) | 10,000 | 10,000 | 10,000 | 500,000 |
| ASN and hostname lists | No | No | No | Yes |
| Bot score and JA4 as cluster features | No | No | No | Yes |
| Rate limit keyed on JA4 | No | No | No | Yes |

List figures are from Cloudflare's [lists availability table](https://developers.cloudflare.com/waf/tools/lists). The list quota follows the highest plan in the account, so one paid zone lifts every zone.

Free accounts get a single IP list, which Spikeward uses for blocks; challenges go into inline rule expressions instead. The custom-rule and rate-limiting-rule counts per plan need checking against current docs before milestone 2, because Spikeward needs at least two custom rules per zone.

## Security

Spikeward holds a token that can change a zone's firewall, so the app is locked down harder than a typical dashboard.

**Cloudflare API token (least privilege).** Scoped to the chosen account and zones only:

- Zone: Zone Read, Analytics Read, WAF Edit (custom rules and rate limiting rulesets)
- Account: Account Filter Lists Edit (the IP list)

Exact permission names get confirmed against the token UI in milestone 1. The wizard verifies the token and refuses tokens with broader scopes such as Account Settings Edit or DNS Edit.

**Secrets at rest.** `SPIKEWARD_SECRET` is a Worker secret. The Cloudflare token and Jev key sit in D1 encrypted with AES-GCM, using a key derived from that secret via HKDF. Rotating the secret re-encrypts both.

**App access.** The README recommends putting Cloudflare Access in front of the Worker hostname. Without it, the app uses its own login: passkeys preferred, passwords hashed with PBKDF2 (Workers-native), sessions in signed HttpOnly cookies, login rate-limited, CSRF tokens on every write.

**Data sent to Jev.** Only cluster features: ASN, country, user-agent strings, path patterns, and rates. No raw client IPs, no cookies, no query-string values. Clusters are named with a salted hash, so Jev never sees who the visitors were.

**Supply chain.** Few dependencies, a lockfile, signed releases, and Dependabot. Users update by syncing their fork with upstream tags, and the app shows when a new release exists.

## Costs

A typical install costs about $5 a month plus cents of Jev usage, because nothing runs per real request.

| Item | Driver | Estimate |
| --- | --- | --- |
| Workers | 43,200 cron runs/month plus app traffic | Fits the free tier on paper; Workers Paid ($5/month) recommended for CPU headroom during clustering |
| D1 | A few hundred writes per spike, reads per tick | Well inside free limits |
| KV | Baseline and verdict cache, a few writes per minute | Well inside free limits |
| Jev, typical spike | \~100 cluster judgments × \~600 input tokens | \~$0.03 per spike |
| Jev, bad day | 10,000 judgments × \~600 tokens | \~$2.50 per day |

Jev pricing used: [$0.25 to $0.42 per million input tokens, output free](https://jevtypesafeai.com/). Token counts per call are estimates until milestone 1 measures real ones.

The daily call cap and spend cap in the Jev screen bound the worst case. When a cap is hit, Spikeward falls back to rules-only decisions (rate and ratio thresholds) and alerts.

## Repo layout and stack

One repo, one Worker, TypeScript throughout. The Worker serves the app through Workers static assets and handles `fetch` (app and API) and `scheduled` (the loop).

**Stack:** Hono for routing, Drizzle for D1 with SQL migrations bundled as text, Zod for config and Jev response validation, Preact with Vite for the app, Vitest with `@cloudflare/vitest-pool-workers` for tests. Apache-2.0 license.

```text
spikeward/
├── wrangler.jsonc          # D1 + KV bindings with no IDs, cron "* * * * *", assets dir
├── .dev.vars.example       # SPIKEWARD_SECRET= (drives the deploy form prompt)
├── src/
│   ├── index.ts            # fetch + scheduled entry points
│   ├── api/                # Hono routes: setup, zones, settings, decisions, actions
│   ├── loop/
│   │   ├── poll.ts         # GraphQL Analytics queries per zone
│   │   ├── baseline.ts     # EWMA + spike detection
│   │   ├── cluster.ts      # grouping + feature extraction
│   │   ├── sanitize.ts     # attack-pattern flags
│   │   ├── judge.ts        # Jev client, provider adapters, caching, caps
│   │   ├── policy.ts       # thresholds -> action
│   │   └── enforce.ts      # lists, rules, janitor, reconcile
│   ├── cf/                 # typed Cloudflare API client (lists, rulesets, zones)
│   ├── jev/                # providers: typesafe.ts, openrouter.ts, vercel.ts
│   ├── db/                 # schema, migrations/*.sql, self-migrate on boot
│   └── crypto.ts           # HKDF + AES-GCM for stored credentials
├── app/                    # Preact UI, built into ./dist/assets
├── test/
│   ├── fixtures/spikes/    # recorded GraphQL responses from real spikes
│   └── replay.test.ts      # replays fixtures through the loop with a fake Jev
└── docs/                   # setup, token permissions, tuning guide, FAQ
```

The replay harness matters most: recorded spikes run through the whole pipeline in CI, so a threshold or question change shows exactly which clusters would flip.

## Risks and open questions

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Jev is new; it [launched in early access on September 15, 2026](https://www.truefoundry.com/blog/typesafe-ai-jev) | API or pricing changes, outages | Provider adapters (TypeSafe, OpenRouter, Vercel), rules-only fallback, verdict caching |
| False positives block real users | Lost traffic, support load | Shadow mode first, challenge-before-block, broad keys never block, undo, TTLs |
| One-minute polling is too slow for sharp spikes | First 1 to 2 minutes pass unmitigated | Document it; pair with a static rate limiting rule; optional sensor Worker in v2 |
| Sampled analytics undercount small clusters | Missed low-volume bots | Out of scope by design; Spikeward targets spikes |
| Token with WAF Edit is a high-value secret | Account compromise | Least-privilege token, encryption at rest, Access in front, audit log |
| Plan rule limits leave no room | Setup fails on crowded zones | Detect at setup, reuse one rule per action, clear error |

**Open questions**

- [ ] Exact Jev request and response field names, and measured tokens per call
- [ ] Custom rule and rate limiting rule counts per plan in 2026
- [ ] Exact API token permission names for WAF rulesets and lists
- [ ] Whether the token page supports a pre-filled permissions link for the wizard
- [ ] Name check: "Spikeward" availability on GitHub and npm
- [ ] Does TypeSafe's terms allow this use and redistribution of the question schema?
