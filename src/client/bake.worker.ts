// Runs the course bake off the main thread so a hole change never freezes the
// UI. The result's buffers move back without a copy.

import { bake, type BakeRequest } from "./bake.ts";

self.onmessage = (e: MessageEvent<{ id: number; req: BakeRequest }>) => {
  const { id, req } = e.data;
  const result = bake(req);
  self.postMessage({ id, result }, { transfer: [result.pixels.buffer, result.ground.buffer] });
};
