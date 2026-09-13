// The upload queue (docs/CONTRACTS.md section 3):
//   hash (worker) -> POST /api/files/prepare (dedupe) -> tus upload ->
//   POST /api/files/complete (files row + analyze job + dispatch).
//
// Hashing is serialized (CPU bound); uploads run two at a time. Items are
// plain objects; subscribers get a fresh array on every change.

import * as tus from "tus-js-client";
import { api, errorMessage } from "@/lib/api/client";
import { hashFile } from "@/lib/audio/hashFile";
import { publicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";
import type { FileRow, JobRow } from "@/lib/types/db";
import { contentTypeFor, type PickedFile } from "./fs";

export type UploadState =
  | "waiting"
  | "hashing"
  | "checking"
  | "uploading"
  | "completing"
  | "exists"
  | "done"
  | "failed";

export interface UploadItem {
  id: string;
  file: File;
  name: string;
  relativePath: string;
  size: number;
  state: UploadState;
  /** 0..1 within the current step */
  progress: number;
  error: string | null;
  sha256: string | null;
  storagePath: string | null;
  fileRow: FileRow | null;
  job: JobRow | null;
  /** "compute not configured" etc., when the analyze job could not be dispatched */
  dispatchNote: string | null;
}

type Listener = (items: UploadItem[]) => void;

const CHUNK_SIZE = 6 * 1024 * 1024; // Supabase requires exactly 6 MiB
const UPLOAD_CONCURRENCY = 2;
const RETRY_DELAYS = [0, 1000, 3000, 5000, 10_000];

export class UploadManager {
  private items: UploadItem[] = [];
  private listeners = new Set<Listener>();
  private hashChain: Promise<void> = Promise.resolve();
  private activeUploads = 0;
  private uploadQueue: UploadItem[] = [];
  private tusUploads = new Map<string, tus.Upload>();
  private counter = 0;
  /** called with the file row when an item finishes so the library can show it at once */
  onFileRow: ((file: FileRow, job: JobRow | null) => void) | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.items);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getItems(): UploadItem[] {
    return this.items;
  }

  add(picked: PickedFile[]): UploadItem[] {
    const added: UploadItem[] = [];
    for (const p of picked) {
      const item: UploadItem = {
        id: `u${++this.counter}-${Date.now()}`,
        file: p.file,
        name: p.file.name,
        relativePath: p.relativePath,
        size: p.file.size,
        state: "waiting",
        progress: 0,
        error: null,
        sha256: null,
        storagePath: null,
        fileRow: null,
        job: null,
        dispatchNote: null,
      };
      this.items = [...this.items, item];
      added.push(item);
    }
    this.emit();
    for (const item of added) this.enqueueHash(item);
    return added;
  }

  retry(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.state !== "failed") return;
    this.patch(id, { state: "waiting", progress: 0, error: null });
    if (item.sha256 && item.storagePath) {
      this.enqueueUpload(item);
    } else if (item.sha256) {
      void this.prepare(item);
    } else {
      this.enqueueHash(item);
    }
  }

  remove(id: string): void {
    const upload = this.tusUploads.get(id);
    if (upload) {
      void upload.abort(true).catch(() => undefined);
      this.tusUploads.delete(id);
    }
    this.uploadQueue = this.uploadQueue.filter((i) => i.id !== id);
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
  }

  /** Drop finished and duplicate rows from the queue view. */
  clearFinished(): void {
    this.items = this.items.filter((i) => i.state !== "done" && i.state !== "exists");
    this.emit();
  }

  // ---- pipeline ----------------------------------------------------------

  private enqueueHash(item: UploadItem): void {
    this.hashChain = this.hashChain.then(() => this.hash(item)).catch(() => undefined);
  }

  private async hash(item: UploadItem): Promise<void> {
    if (!this.has(item.id)) return;
    this.patch(item.id, { state: "hashing", progress: 0 });
    try {
      const sha256 = await hashFile(item.file, (fraction) => this.patch(item.id, { progress: fraction }));
      this.patch(item.id, { sha256, progress: 1 });
      await this.prepare(this.get(item.id) ?? { ...item, sha256 });
    } catch (err) {
      this.fail(item.id, `Could not read the file: ${errorMessage(err)}`);
    }
  }

  private async prepare(item: UploadItem): Promise<void> {
    if (!this.has(item.id) || !item.sha256) return;
    this.patch(item.id, { state: "checking", progress: 0 });
    try {
      const res = await api.files.prepare({
        sha256: item.sha256,
        filename: item.name,
        size_bytes: item.size,
        content_type: contentTypeFor(item.file),
      });
      if (res.status === "exists") {
        this.patch(item.id, { state: "exists", progress: 1, fileRow: res.file });
        this.onFileRow?.(res.file, null);
        return;
      }
      this.patch(item.id, { storagePath: res.storage_path });
      this.enqueueUpload(this.get(item.id) ?? { ...item, storagePath: res.storage_path });
    } catch (err) {
      this.fail(item.id, errorMessage(err));
    }
  }

  private enqueueUpload(item: UploadItem): void {
    this.uploadQueue.push(item);
    this.pumpUploads();
  }

  private pumpUploads(): void {
    while (this.activeUploads < UPLOAD_CONCURRENCY && this.uploadQueue.length > 0) {
      const next = this.uploadQueue.shift();
      if (!next || !this.has(next.id)) continue;
      this.activeUploads++;
      void this.upload(next).finally(() => {
        this.activeUploads--;
        this.pumpUploads();
      });
    }
  }

  private async upload(item: UploadItem): Promise<void> {
    const current = this.get(item.id);
    if (!current || !current.sha256 || !current.storagePath) return;
    const { sha256, storagePath } = current;
    this.patch(item.id, { state: "uploading", progress: 0 });

    let token: string;
    let supabaseUrl: string;
    try {
      supabaseUrl = publicEnv().url;
      const { data } = await createClient().auth.getSession();
      if (!data.session) throw new Error("Your session expired. Sign in again.");
      token = data.session.access_token;
    } catch (err) {
      this.fail(item.id, errorMessage(err));
      return;
    }

    const contentType = contentTypeFor(item.file);
    const uploaded = await new Promise<boolean>((resolve) => {
      const upload = new tus.Upload(item.file, {
        endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
        retryDelays: RETRY_DELAYS,
        headers: { authorization: `Bearer ${token}`, "x-upsert": "false" },
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        metadata: { bucketName: "audio", objectName: storagePath, contentType, cacheControl: "3600" },
        chunkSize: CHUNK_SIZE,
        onError: (error) => {
          this.tusUploads.delete(item.id);
          const status = statusOf(error);
          // The object is already there (an earlier upload finished but
          // /complete never ran): proceed to complete against it.
          if (status === 409 || /already exists|duplicate/i.test(error.message)) {
            resolve(true);
            return;
          }
          this.fail(item.id, `Upload failed${status ? ` (${status})` : ""}: ${error.message}`);
          resolve(false);
        },
        onProgress: (sent, total) => this.patch(item.id, { progress: total > 0 ? sent / total : 0 }),
        onSuccess: () => {
          this.tusUploads.delete(item.id);
          resolve(true);
        },
      });
      this.tusUploads.set(item.id, upload);
      upload
        .findPreviousUploads()
        .then((previous) => {
          const prev = previous[0];
          if (prev) upload.resumeFromPreviousUpload(prev);
          upload.start();
        })
        .catch(() => upload.start());
    });
    if (!uploaded || !this.has(item.id)) return;

    this.patch(item.id, { state: "completing", progress: 1 });
    try {
      const res = await api.files.complete({
        sha256,
        storage_path: storagePath,
        original_filename: item.name,
        size_bytes: item.size,
        content_type: contentType,
      });
      this.patch(item.id, {
        state: "done",
        fileRow: res.file,
        job: res.job,
        dispatchNote: res.dispatch && !res.dispatch.ok ? res.dispatch.reason : null,
      });
      this.onFileRow?.(res.file, res.job);
    } catch (err) {
      this.fail(item.id, errorMessage(err));
    }
  }

  // ---- state -------------------------------------------------------------

  private has(id: string): boolean {
    return this.items.some((i) => i.id === id);
  }

  private get(id: string): UploadItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  private patch(id: string, changes: Partial<UploadItem>): void {
    let changed = false;
    this.items = this.items.map((i) => {
      if (i.id !== id) return i;
      changed = true;
      return { ...i, ...changes };
    });
    if (changed) this.emit();
  }

  private fail(id: string, error: string): void {
    this.patch(id, { state: "failed", error });
  }

  private emit(): void {
    for (const l of this.listeners) l(this.items);
  }
}

function statusOf(error: Error): number | null {
  const detailed = error as Error & { originalResponse?: { getStatus?: () => number } | null };
  const status = detailed.originalResponse?.getStatus?.();
  return typeof status === "number" ? status : null;
}
