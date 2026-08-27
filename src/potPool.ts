import { potCache, type PotCacheEntry, type PotTokens } from "./potCache.ts";
import { isSessionBound } from "./potBinding.ts";
import { potTokens } from "./metrics.ts";
import type { PoTokenRequest } from "./types.ts";

function num(name: string, fallback: number): number {
  const parsed = parseInt(Deno.env.get(name) || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const WORKER_COUNT = num("POT_WORKERS", 1);
const MAX_PENDING = num("POT_MAX_PENDING", 256);
const REQUEST_TIMEOUT = num("POT_REQUEST_TIMEOUT", 30_000);

/** How long a token is advertised as valid, and how long each binding may be reused for. */
const VISITOR_TTL_MS = 6 * 60 * 60 * 1000;
const VIDEO_REUSE_MS = 150_000;
const VISITOR_REUSE_MS = VISITOR_TTL_MS - 5 * 60 * 1000;

export interface PotResult extends PotTokens {
  expiresAt: Date;
}

export class PotError extends Error {
  constructor(
    message: string,
    readonly code: "QUEUE_FULL" | "TIMEOUT" | "GENERATION_FAILED",
  ) {
    super(message);
    this.name = "PotError";
  }
}

interface PotWorker {
  worker: Worker;
  inFlight: number;
}

interface PendingTask {
  owner: PotWorker;
  timer: ReturnType<typeof setTimeout>;
  resolve: (tokens: PotTokens) => void;
  reject: (error: Error) => void;
}

const workers: PotWorker[] = [];
const pending = new Map<number, PendingTask>();
const inFlightByKey = new Map<string, Promise<PotCacheEntry>>();
let nextId = 1;
let roundRobin = 0;

function settle(id: number, settleTask: (task: PendingTask) => void) {
  const task = pending.get(id);
  if (!task) return;

  pending.delete(id);
  clearTimeout(task.timer);
  task.owner.inFlight--;
  settleTask(task);
}

function spawn(): PotWorker {
  const entry: PotWorker = {
    worker: new Worker(new URL("./potWorker.ts", import.meta.url).href, {
      type: "module",
    }),
    inFlight: 0,
  };

  entry.worker.onmessage = (e: MessageEvent) => {
    const { id, type, data } = e.data;
    settle(
      id,
      (task) =>
        type === "success" ? task.resolve(data as PotTokens) : task.reject(
          new PotError(
            data?.message || "generation failed",
            "GENERATION_FAILED",
          ),
        ),
    );
  };

  entry.worker.onerror = (e: ErrorEvent) => {
    e.preventDefault();
    console.error("PoToken worker error:", e.message);

    const index = workers.indexOf(entry);
    if (index >= 0) workers.splice(index, 1);

    for (const [id, task] of pending) {
      if (task.owner === entry) {
        settle(
          id,
          (t) =>
            t.reject(
              new PotError(e.message || "worker died", "GENERATION_FAILED"),
            ),
        );
      }
    }

    entry.worker.terminate();
    workers.push(spawn());
  };

  return entry;
}

export function initializePotWorkers() {
  for (let i = 0; i < WORKER_COUNT; i++) {
    workers.push(spawn());
  }
  console.log(`Initialized ${WORKER_COUNT} PoToken worker(s)`);
}

function dispatch(req: PoTokenRequest): Promise<PotTokens> {
  if (pending.size >= MAX_PENDING) {
    return Promise.reject(new PotError("service overloaded", "QUEUE_FULL"));
  }

  if (workers.length === 0) {
    return Promise.reject(
      new PotError("no PoToken workers available", "GENERATION_FAILED"),
    );
  }

  const owner = workers.reduce(
    (a, b) => (b.inFlight < a.inFlight ? b : a),
    workers[roundRobin++ % workers.length],
  );
  const id = nextId++;

  return new Promise<PotTokens>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        settle(
          id,
          (task) =>
            task.reject(new PotError("generation timed out", "TIMEOUT")),
        ),
      REQUEST_TIMEOUT,
    );

    pending.set(id, { owner, timer, resolve, reject });
    owner.inFlight++;
    owner.worker.postMessage({ id, ...req });
  });
}

/**
 * Cache and dedupe key for one request. A session bound client's videoIdToken binds to visitorData,
 * so its videoId only decides whether one was asked for. An empty visitorData means the worker's
 * own session, which is stable for the worker's lifetime.
 */
export function cacheKey({ visitorData, videoId, client }: PoTokenRequest) {
  const video = !videoId ? "-" : isSessionBound(client) ? "session" : videoId;
  return `${visitorData ?? ""}|${video}`;
}

/** Content bound tokens go stale in minutes; session bound ones last as long as the visitorData. */
export function reuseMs({ videoId, client }: PoTokenRequest): number {
  return videoId && !isSessionBound(client) ? VIDEO_REUSE_MS : VISITOR_REUSE_MS;
}

export async function generatePotoken(req: PoTokenRequest): Promise<PotResult> {
  const key = cacheKey(req);

  const cached = potCache.get(key);
  if (cached && Date.now() - cached.mintedAt < reuseMs(req)) {
    return result(req, cached, "reused");
  }

  const existing = inFlightByKey.get(key);
  if (existing) return result(req, await existing, "reused");

  const minting = dispatch(req)
    .then((tokens) => {
      const entry: PotCacheEntry = { ...tokens, mintedAt: Date.now() };
      potCache.set(key, entry);
      return entry;
    })
    .finally(() => inFlightByKey.delete(key));

  inFlightByKey.set(key, minting);
  return result(req, await minting, "minted");
}

function result(
  req: PoTokenRequest,
  entry: PotCacheEntry,
  outcome: string,
): PotResult {
  potTokens.labels({ binding: "visitor", result: outcome }).inc();
  if (req.videoId) {
    potTokens.labels({ binding: "video", result: outcome }).inc();
  }

  return {
    visitorDataToken: entry.visitorDataToken,
    visitorData: entry.visitorData,
    videoIdToken: entry.videoIdToken,
    expiresAt: new Date(entry.mintedAt + VISITOR_TTL_MS),
  };
}
