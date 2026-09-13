// Web Worker: streams a Blob through the incremental SHA-256 so the main
// thread stays responsive while a folder of WAVs is hashed.

import { sha256Blob } from "./sha256";

export interface HashRequest {
  id: number;
  blob: Blob;
  sliceBytes?: number;
}

export type HashResponse =
  | { id: number; type: "progress"; done: number; total: number }
  | { id: number; type: "done"; sha256: string }
  | { id: number; type: "error"; message: string };

type WorkerScope = {
  onmessage: ((event: MessageEvent<HashRequest>) => void) | null;
  postMessage: (message: HashResponse) => void;
};

const scope = self as unknown as WorkerScope;

scope.onmessage = async (event) => {
  const { id, blob, sliceBytes } = event.data;
  try {
    const sha256 = await sha256Blob(
      blob,
      (done, total) => scope.postMessage({ id, type: "progress", done, total }),
      sliceBytes,
    );
    scope.postMessage({ id, type: "done", sha256 });
  } catch (err) {
    scope.postMessage({ id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
