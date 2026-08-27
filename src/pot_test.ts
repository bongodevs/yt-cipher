import { assertEquals } from "jsr:@std/assert";
import { isSessionBound, visitorIdFrom } from "./potBinding.ts";
import { cacheKey, reuseMs } from "./potPool.ts";

/** A visitorData blob: field 1 (the visitor ID) followed by an unrelated field. */
function blob(visitorId: string): string {
  const bytes = [
    0x0a,
    visitorId.length,
    ...[...visitorId].map((c) => c.charCodeAt(0)),
    0x10,
    0x2a,
  ];
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

Deno.test("visitorIdFrom reads field 1", () => {
  assertEquals(visitorIdFrom(blob("AbCdEfGhIjK")), "AbCdEfGhIjK");
  assertEquals(visitorIdFrom("not base64 !!"), undefined);
  assertEquals(visitorIdFrom(btoa("\x12\x03abc")), undefined);
});

Deno.test("isSessionBound covers client families", () => {
  assertEquals(isSessionBound("IOS_MUSIC"), true);
  assertEquals(isSessionBound("android_vr"), true);
  assertEquals(isSessionBound("TVHTML5_SIMPLY_EMBEDDED_PLAYER"), true);
  assertEquals(isSessionBound("TV_SIMPLY"), true);
  assertEquals(isSessionBound("WEB"), false);
  assertEquals(isSessionBound(undefined), false);
});

Deno.test("cacheKey ignores videoId for session bound clients", () => {
  const a = cacheKey({ visitorData: "v", videoId: "one", client: "IOS" });
  const b = cacheKey({ visitorData: "v", videoId: "two", client: "IOS" });
  assertEquals(a, b);

  assertEquals(
    cacheKey({ visitorData: "v", videoId: "one", client: "WEB" }) ===
      cacheKey({ visitorData: "v", videoId: "two", client: "WEB" }),
    false,
  );

  // A request without a videoId must not share an entry with one that has it.
  assertEquals(
    cacheKey({ visitorData: "v" }) ===
      cacheKey({ visitorData: "v", videoId: "one", client: "IOS" }),
    false,
  );
});

Deno.test("reuseMs is short only for content bound video tokens", () => {
  const content = reuseMs({ videoId: "one", client: "WEB" });
  const session = reuseMs({ videoId: "one", client: "IOS" });
  assertEquals(content < session, true);
  assertEquals(reuseMs({ client: "WEB" }), session);
});
