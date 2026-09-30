# Tuning

Every setting lives in the app (Settings) and applies on the next minute's tick. Any setting
can be overridden per zone.

**Too many spikes on normal traffic?** Raise the spike multiple (default 3x) or the floor
(default 500 rpm). Sites with sharp daily peaks do better with a higher multiple; the
hour-of-week baseline needs about a week to learn the shape of your traffic.

**Missing small bots?** Lower the minimum cluster size (60 rpm) or share (2% of traffic). Very
low-volume bots are out of scope by design: sampled analytics undercount them, and Cloudflare's
own bot tools handle them better.

**Challenging real people?** Look at the Decisions screen for the verdicts that did it. Raise the
grey-zone floor (0.70), describe your site better in Jev settings (the model reads it), add the
source to the never-block list, or add a custom question such as "Is this a partner integration
we rely on?" mapped to allow.

**Blocking too little?** Blocks need a single IP judged automated above 0.95 with harm above
0.60. Lower the block harm threshold, or the grey-zone ceiling. Ranges, networks, and user agents
are never blocked, only challenged, because they include real people.

**Costs.** Each judgment is one Jev call of roughly 600 input tokens. The per-minute call cap
(30), daily call cap (5,000), and daily spend cap ($1) bound the worst case. When a cap is hit,
Spikeward falls back to rules-only decisions (challenge a single IP above 600 rpm, nothing else)
and keeps going.
