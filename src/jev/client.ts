import { z } from "zod";

// TypeSafe System One API: POST /v1/systemone with a state and a map of typed questions.
// https://docs.typesafe.ai/api

export type Question =
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] };

const answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
]);

const response = z.object({
  model: z.string(),
  answers: z.record(z.string(), answer),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number().optional() }),
});

export type JevResponse = z.infer<typeof response>;
export type JevAnswer = z.infer<typeof answer>;

export class JevError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface JevConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export async function ask(
  cfg: JevConfig,
  state: unknown,
  questions: Record<string, Question>,
  fetcher: typeof fetch = fetch,
): Promise<JevResponse> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
  const body = JSON.stringify({ model: cfg.model, state, questions });
  for (let attempt = 0; ; attempt++) {
    const res = await fetcher(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body,
    });
    if ((res.status === 429 || res.status === 529) && attempt < 2) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 500 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      const hint =
        res.status === 401 ? "the Jev key was rejected" :
        res.status === 403 ? "a firewall in front of the Jev API refused the request" :
        res.status === 422 ? `the request was invalid: ${text.slice(0, 300)}` :
        `HTTP ${res.status}`;
      throw new JevError(`Jev call failed: ${hint}`, res.status);
    }
    const parsed = response.safeParse(JSON.parse(text));
    if (!parsed.success) throw new JevError("Jev returned an unexpected response shape", 502);
    return parsed.data;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
