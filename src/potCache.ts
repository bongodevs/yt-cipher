import { InstrumentedLRU } from "./instrumentedCache.ts";

/** One mint's tokens. Always a matched set: a token is only valid against its own visitorData. */
export interface PotTokens {
  visitorDataToken: string;
  visitorData: string;
  videoIdToken?: string;
}

export interface PotCacheEntry extends PotTokens {
  mintedAt: number;
}

// key = the request the tokens were minted for, see cacheKey() in potPool.ts
const cacheSizeEnv = Deno.env.get("POT_CACHE_SIZE");
const maxCacheSize = cacheSizeEnv ? parseInt(cacheSizeEnv, 10) : 200;
export const potCache = new InstrumentedLRU<PotCacheEntry>("pot", maxCacheSize);
