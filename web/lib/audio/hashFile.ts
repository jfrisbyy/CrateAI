// Main-thread API over sha256.worker.ts. One shared worker, requests keyed by
// id; falls back to hashing inline where Workers are unavailable.

import { sha256Blob } from "./sha256";
import type { HashRequest, HashResponse } from "./sha256.worker";

type Pending = {
  resolve: (hex: string) => void;
  reject: (err: Error) => void;
  onProgress?: (fraction: number) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./sha256.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  worker.onmessage = (event: MessageEvent<HashResponse>) => {
    const msg = event.data;
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === "progress") {
      p.onProgress?.(msg.total > 0 ? msg.done / msg.total : 1);
    } else if (msg.type === "done") {
      pending.delete(msg.id);
      p.resolve(msg.sha256);
    } else {
      pending.delete(msg.id);
      p.reject(new Error(msg.message));
    }
  };
  worker.onerror = (event) => {
    const err = new Error(event.message || "hash worker failed");
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Streaming SHA-256 of a File/Blob, off the main thread when possible. */
export function hashFile(blob: Blob, onProgress?: (fraction: number) => void): Promise<string> {
  const w = getWorker();
  if (!w) {
    return sha256Blob(blob, (done, total) => onProgress?.(total > 0 ? done / total : 1));
  }
  return new Promise<string>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    const request: HashRequest = { id, blob };
    w.postMessage(request);
  });
}
