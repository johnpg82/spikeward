export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
  SPIKEWARD_SECRET: string;
}

export const VERSION = "0.1.0";
export const REPO = "Biomimic-io/spikeward";
