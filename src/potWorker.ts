import { potManager } from "./pot.ts";

interface MintRequest {
  id: number;
  visitorData?: string;
  videoId?: string;
  client?: string;
}

self.onmessage = async (e: MessageEvent<MintRequest>) => {
  const { id, visitorData, videoId, client } = e.data;

  try {
    self.postMessage({
      id,
      type: "success",
      data: await potManager.generatePoToken(visitorData, videoId, client),
    });
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      data: { message: error instanceof Error ? error.message : String(error) },
    });
  }
};
