import { generatePotoken, PotError } from "../potPool.ts";
import { coldStartToken } from "../potBinding.ts";
import type {
  PoTokenRequest,
  PoTokenResponse,
  RequestContext,
} from "../types.ts";

const STATUS: Record<PotError["code"], number> = {
  QUEUE_FULL: 503,
  TIMEOUT: 504,
  GENERATION_FAILED: 500,
};

export async function handleGeneratePotoken(
  ctx: RequestContext,
): Promise<Response> {
  try {
    const potData = await generatePotoken(ctx.body as PoTokenRequest);

    const response: PoTokenResponse = {
      visitorDataToken: potData.visitorDataToken,
      visitorData: potData.visitorData,
      videoIdToken: potData.videoIdToken,
      // Not cached: the packet embeds the current time.
      coldStartToken: coldStartToken(potData.visitorData),
      expiresAt: potData.expiresAt.toISOString(),
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Error generating PoToken:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      {
        status: e instanceof PotError ? STATUS[e.code] : 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
