import { BG } from "npm:bgutils-js@3.2.0";
import { potColdStartTokens } from "./metrics.ts";

const SESSION_BOUND_CLIENTS = new Set(["TV_SIMPLY"]);

/** Clients whose content bound token binds to visitorData instead of the videoId. */
export function isSessionBound(client?: string): boolean {
  if (!client) return false;
  const name = client.toUpperCase();
  return name.startsWith("IOS") || name.startsWith("ANDROID") ||
    name.startsWith("TVHTML5") || SESSION_BOUND_CLIENTS.has(name);
}

/**
 * Pull the bare visitor ID out of a visitorData blob. bgutils caps a binding at 118 bytes and a
 * full blob always exceeds that, so the cold start packet binds to field 1 of the protobuf.
 */
export function visitorIdFrom(visitorData: string): string | undefined {
  try {
    const b64 = decodeURIComponent(visitorData)
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));

    // Tag 0x0a = field 1, wire type 2 (length-delimited), then a single-byte length.
    if (bytes[0] !== 0x0a) return undefined;
    const length = bytes[1];
    if (!length || bytes.length < 2 + length) return undefined;
    return new TextDecoder().decode(bytes.subarray(2, 2 + length));
  } catch {
    return undefined;
  }
}

/**
 * Bootstrap token YouTube accepts only while a SABR session reports `StreamProtectionStatus=2`.
 * Minted per response because the packet embeds the current time.
 */
export function coldStartToken(visitorData: string): string | undefined {
  const visitorId = visitorIdFrom(visitorData);
  if (!visitorId) return undefined;

  try {
    const token = BG.PoToken.generateColdStartToken(visitorId);
    potColdStartTokens.labels({ result: "minted" }).inc();
    return token;
  } catch (e) {
    potColdStartTokens.labels({ result: "failed" }).inc();
    console.warn(
      "Failed to create cold start token:",
      e instanceof Error ? e.message : e,
    );
    return undefined;
  }
}
