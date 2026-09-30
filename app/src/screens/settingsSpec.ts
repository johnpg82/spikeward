// Field descriptions for every setting in src/settings.ts (except custom questions and retention).
export type Spec = {
  key: string;
  label: string;
  help: string;
  kind: "number" | "text" | "url" | "textarea" | "bool" | "kinds";
  unit?: string;
  /** Stored value = shown value x scale (for seconds shown as minutes, and so on). */
  scale?: number;
  int?: boolean;
  min?: number;
  max?: number;
  wide?: boolean;
};

export const CLUSTER_KINDS: { id: string; label: string }[] = [
  { id: "ip", label: "Single IP" },
  { id: "ip24", label: "IP range (/24)" },
  { id: "asn", label: "Network (ASN)" },
  { id: "ua", label: "User agent" },
  { id: "ja4", label: "TLS fingerprint (JA4)" },
];

export const SPECS: Record<"detection" | "policy" | "jev" | "alerts", { title: string; lede: string; save: string; fields: Spec[] }> = {
  detection: {
    title: "Detection",
    lede: "When a traffic spike starts, how traffic is grouped into clusters, and which clusters are worth asking Jev about.",
    save: "Save detection settings",
    fields: [
      { key: "spikeMultiple", label: "Spike trigger", kind: "number", unit: "× baseline", min: 1.2, max: 100, help: "A spike starts when requests per minute reach this multiple of the learned baseline. Range 1.2 to 100." },
      { key: "spikeFloorRpm", label: "Spike floor", kind: "number", unit: "rpm", min: 10, help: "Ignore spikes below this many requests per minute, however large the multiple. Minimum 10." },
      { key: "minClusterRpm", label: "Smallest cluster to judge", kind: "number", unit: "rpm", min: 1, help: "Clusters sending fewer requests per minute than this are skipped." },
      { key: "minClusterShare", label: "Smallest cluster share", kind: "number", unit: "% of traffic", scale: 0.01, min: 0, max: 1, help: "Clusters below this share of total traffic are skipped. Range 0 to 100." },
      { key: "maxClustersPerTick", label: "Clusters per check", kind: "number", unit: "clusters", int: true, min: 1, max: 100, help: "At most this many clusters are considered on each check. Range 1 to 100." },
      { key: "windowMinutes", label: "Analysis window", kind: "number", unit: "minutes", int: true, min: 1, max: 10, help: "How many minutes of recent traffic each check looks at. Range 1 to 10." },
      { key: "lagMinutes", label: "Analytics lag", kind: "number", unit: "minutes", int: true, min: 0, max: 5, help: "Skip the newest minutes, which Cloudflare analytics may not have finished counting. Range 0 to 5." },
      { key: "calmMinutesToEnd", label: "Calm time to end a spike", kind: "number", unit: "minutes", int: true, min: 1, max: 60, help: "A spike is over after traffic stays below the trigger for this long. Range 1 to 60." },
      { key: "clusterKinds", label: "Ways to group traffic", kind: "kinds", wide: true, help: "Traffic is grouped by each selected key. JA4 needs an Enterprise zone." },
    ],
  },
  policy: {
    title: "Policy",
    lede: "How Jev's probabilities become actions, how long actions last, and how many Spikeward may create. Probabilities run from 0 to 1.",
    save: "Save policy settings",
    fields: [
      { key: "legitAllow", label: "Allow when welcome at or above", kind: "number", unit: "probability", min: 0, max: 1, help: "If Jev thinks a cluster is a service you want (search engine, monitor) at least this strongly, allow it." },
      { key: "allowBelow", label: "Allow when automated below", kind: "number", unit: "probability", min: 0, max: 1, help: "Below this chance of being automated, treat the cluster as people and allow it." },
      { key: "greyLow", label: "Grey zone starts at", kind: "number", unit: "probability", min: 0, max: 1, help: "Between the allow line and here, the cluster is only logged." },
      { key: "greyHigh", label: "Grey zone ends at", kind: "number", unit: "probability", min: 0, max: 1, help: "From the grey zone start up to here, Spikeward only challenges and asks you to review." },
      { key: "blockHarm", label: "Block when harm at or above", kind: "number", unit: "score 0 to 1", min: 0, max: 1, help: "A single IP above the grey zone is blocked only if Jev's harm score reaches this. Otherwise it is challenged." },
      { key: "ttlChallenge", label: "Challenge lasts", kind: "number", unit: "minutes", scale: 60, int: true, min: 60, help: "How long a managed challenge stays in place. Minimum 1 minute." },
      { key: "ttlRateLimit", label: "Rate limit lasts", kind: "number", unit: "minutes", scale: 60, int: true, min: 60, help: "How long a rate limit stays in place. Minimum 1 minute." },
      { key: "ttlBlock", label: "Block lasts", kind: "number", unit: "hours", scale: 3600, int: true, min: 60, help: "How long an IP block stays in place." },
      { key: "maxTtl", label: "Longest any action lasts", kind: "number", unit: "days", scale: 86400, int: true, min: 60, help: "Repeat offenders get double the time each time, up to this cap." },
      { key: "maxActionsPerHour", label: "New actions per hour", kind: "number", unit: "actions", int: true, min: 1, help: "Spikeward pauses a zone after creating this many actions in an hour, and alerts you." },
      { key: "rateLimitPerMinute", label: "Rate limit ceiling", kind: "number", unit: "requests per minute", int: true, min: 1, help: "Requests per minute allowed from a rate-limited fingerprint." },
      { key: "fallbackIpRpm", label: "Fallback challenge threshold", kind: "number", unit: "rpm per IP", min: 1, help: "If Jev is unavailable or a cap is hit, challenge a single IP above this rate. Spikeward never blocks without Jev." },
    ],
  },
  jev: {
    title: "Jev",
    lede: "Jev, by TypeSafe, judges each traffic cluster. Set what it knows about your site and how much you're willing to spend on it.",
    save: "Save Jev settings",
    fields: [
      { key: "siteDescription", label: "Site description", kind: "textarea", wide: true, help: "One or two sentences on what your site is. Jev uses it to tell wanted traffic from unwanted. Up to 500 characters." },
      { key: "baseUrl", label: "Base URL", kind: "url", help: "The Jev API endpoint. Change only if you use a different gateway." },
      { key: "model", label: "Model alias", kind: "text", help: "For example jev-latest." },
      { key: "maxCallsPerTick", label: "Jev calls per check", kind: "number", unit: "calls", int: true, min: 0, max: 100, help: "At most this many clusters are sent to Jev per check. 0 turns Jev off and uses fallback rules." },
      { key: "dailyCallCap", label: "Daily call cap", kind: "number", unit: "calls per day", int: true, min: 0, help: "After this many calls in a day, Spikeward uses fallback rules until tomorrow." },
      { key: "dailySpendCap", label: "Daily spend cap", kind: "number", unit: "US dollars", min: 0, help: "Estimated spend at which Spikeward stops calling Jev for the day." },
      { key: "pricePerMillionTokens", label: "Price per million input tokens", kind: "number", unit: "US dollars", min: 0, help: "Used only to estimate cost in the usage table and for the spend cap." },
    ],
  },
  alerts: {
    title: "Alerts",
    lede: "Send a message to Slack, or any webhook, when something needs your attention. Grey-zone alerts include one-click approve and reject links.",
    save: "Save alert settings",
    fields: [
      { key: "webhookUrl", label: "Webhook URL", kind: "url", wide: true, help: "A Slack incoming webhook or any URL that accepts JSON. Leave empty to turn alerts off." },
      { key: "onSpike", label: "Alert when a spike starts", kind: "bool", help: "One message per spike, with the zone and peak rate." },
      { key: "onGrey", label: "Alert on grey-zone verdicts", kind: "bool", help: "Jev was unsure, so Spikeward challenged and wants your review." },
      { key: "onPause", label: "Alert when a zone pauses", kind: "bool", help: "A zone hit its new-actions-per-hour limit and stopped creating actions." },
    ],
  },
};
