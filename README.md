# Spikeward

Open-source bot-spike mitigation on Cloudflare Workers, powered by Jev.

Spikeward watches your zone's traffic once a minute, asks [Jev](https://docs.typesafe.ai) to judge
the suspicious clusters in a spike, and writes short-lived WAF challenges or blocks. Jev never
sits in the request path, so real visitors see zero added latency, and Jev calls scale with the
number of suspicious clusters (tens per spike), not with your traffic.

Website: https://spikeward.habitnetworks.com · Design: [docs/PLAN.md](docs/PLAN.md)

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Biomimic-io/spikeward/tree/main/spikeward)

The button forks this folder into your GitHub, creates a D1 database and a KV namespace, and
asks for one secret, `SPIKEWARD_SECRET` (generate it with `openssl rand -hex 32` and keep a
copy). Then open your Worker's URL and follow the setup screen:

1. **Claim** the install with `SPIKEWARD_SECRET` and create an admin login.
2. **Connect Cloudflare** with an API token (permissions below).
3. **Connect Jev** with a TypeSafe API key.
4. **Pick zones.** Each starts in shadow mode: Spikeward logs what it would do and applies nothing.
5. After a day of shadow decisions, review the Decisions screen and switch the zone to enforce.

We recommend putting [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/)
in front of the Worker's hostname as well as Spikeward's own login.

### API token permissions

Create a custom token at **My Profile → API Tokens**, scoped to one account and only the zones
Spikeward should manage:

| Scope | Permission | Used for |
| --- | --- | --- |
| Zone | Zone: Read | Listing zones and detecting their plan |
| Zone | Analytics: Read | Reading traffic from the GraphQL Analytics API |
| Zone | Zone WAF: Edit | Creating and updating Spikeward's custom and rate limiting rules |
| Account | Account Filter Lists: Edit | The `spikeward_blocks` IP list |

Don't grant more. Spikeward doesn't need DNS, settings, or Workers permissions.

## How it works

Every minute, for each zone not set to off:

1. **Poll** the last complete two minutes from `httpRequestsAdaptiveGroups`. Spikeward first asks
   Cloudflare which fields the zone's plan may read and queries only those. Free zones can't read
   ASN, query strings, JA4, or bot score, so on Free, clusters come from IPs, /24 ranges, and user
   agents, and a bot spread thinly across many networks is caught by its user agent (challenged,
   never blocked).
2. **Baseline.** Compare requests per minute with an EWMA baseline for this hour of the week (a
   zone-wide baseline covers the first week). A spike starts at 3x baseline and 500 rpm. Only calm
   traffic updates the baseline, so an attack can't raise its own threshold.
3. **Cluster** spike traffic by IP, /24 range, JA4 (Enterprise), ASN, and user agent, narrowest
   first. A broader cluster is only judged when most of its traffic isn't explained by a narrower one.
4. **Filter** verified bots, traffic Cloudflare already blocked, the never-block list, and targets
   already actioned.
5. **Sanitize** paths and queries: IDs become `*`, query values are dropped, attack strings become
   flags such as `has_sqli_pattern`. IPs are named by a salted hash.
6. **Judge** each cluster with one Jev call asking: is it automated, is it a service you'd want,
   what's its intent, how harmful is it, and what would you do. Verdicts are cached per cluster.
7. **Decide** with your thresholds. Jev's suggested action is advisory. Single IPs can be blocked;
   ranges, networks, and user agents are only ever challenged.
8. **Enforce and reconcile.** Spikeward owns one account IP list (`spikeward_blocks`) and, per zone,
   one block rule and one managed-challenge rule (plus a JA4 rate limit rule on Enterprise). Each
   tick it makes Cloudflare match its records: expired actions come out, hand edits to its rules
   are put back, and your own rules are never touched.

Safety rails: shadow mode, TTLs on everything (challenge 1 h, rate limit 1 h, block 6 h; repeat
offenders double up to 7 days), grey-zone verdicts (0.70 to 0.95) only challenge and send review
links, a 50-actions-per-hour cap that pauses enforcement, daily Jev call and spend caps with a
rules-only fallback that never blocks, and a kill switch that disables every Spikeward rule.

## Cost

About $5 a month for Workers Paid (recommended for CPU headroom) plus Jev usage. Jev 1.13 is
$0.042 per million input tokens with free output, so a typical spike (about 100 judgments of about
600 tokens) costs well under a cent, and 10,000 judgments on a very bad day costs about $0.25.
D1 and KV stay inside free limits.

## Develop

```sh
npm install            # npm 11 recommended; npm 10 can hit an arborist bug on a fresh install
cp .dev.vars.example .dev.vars   # set SPIKEWARD_SECRET
npm run dev            # builds the app, runs the Worker locally on :8787
npm run dev:app        # optional: Vite dev server for the app, proxying /api to :8787
npm test               # unit tests and the spike replay suite, in workerd
npm run typecheck
```

Layout: `src/` is the Worker (Hono API in `src/api`, the minute loop in `src/loop`, the Cloudflare
client in `src/cf`, the Jev client in `src/jev`, schema and self-migration in `src/db`). `app/` is
the Preact admin app, built into `dist/` and served as static assets. See
[docs/testing.md](docs/testing.md) for the replay harness and recording real spikes.

## Differences from the plan (v0.1)

- **Logins** use passwords (PBKDF2); passkeys aren't built yet.
- **Alerts** go to a Slack- or Discord-compatible webhook. Email isn't built.
- **Jev provider:** TypeSafe's API directly. The base URL is configurable for a compatible gateway,
  but OpenRouter and Vercel AI Gateway adapters aren't built.
- **Token scope** isn't checked automatically: reading a token's permissions needs a permission
  Spikeward shouldn't have. The setup screen lists exactly what to grant.
- **Already-blocked traffic** is read from the `securityAction` field of the same analytics query
  instead of a second `firewallEventsAdaptive` query.
- **The IP list is account-wide**, so in enforce mode an IP blocked because of one zone is blocked
  on every Spikeward zone in that account.
- **D1 access** uses plain SQL instead of Drizzle, to keep dependencies to Hono and Zod.

## License

Apache-2.0. Not affiliated with Cloudflare or TypeSafe.
