// Browser-side API client. Every function maps to one route in app/api.

import type {
  ChatRequest,
  CompleteRequest,
  CompleteResponse,
  ConversationCreateRequest,
  ConversationResponse,
  ConversationsListResponse,
  EditField,
  EditResponse,
  FileResponse,
  FilesListResponse,
  JobCreateRequest,
  JobResponse,
  LoopCreateRequest,
  LoopPatchRequest,
  LoopResponse,
  LoopsFindRequest,
  LoopsListResponse,
  PrepareRequest,
  PrepareResponse,
  SearchRequest,
  SearchResponse,
  SignedUrlResponse,
} from "./types";
import type { FileKind, Json } from "@/lib/types/db";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    credentials: "same-origin",
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const err = body as { error?: string; details?: unknown } | null;
    throw new ApiError(res.status, err?.error ?? `${res.status} ${res.statusText}`, err?.details);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => call<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const del = <T>(path: string) => call<T>(path, { method: "DELETE" });

export const api = {
  files: {
    prepare: (body: PrepareRequest) => post<PrepareResponse>("/api/files/prepare", body),
    complete: (body: CompleteRequest) => post<CompleteResponse>("/api/files/complete", body),
    list: (params: { kind?: FileKind; parent?: string } = {}) => {
      const q = new URLSearchParams();
      if (params.kind) q.set("kind", params.kind);
      if (params.parent) q.set("parent", params.parent);
      const qs = q.toString();
      return call<FilesListResponse>(`/api/files${qs ? `?${qs}` : ""}`);
    },
    get: (id: string) => call<FileResponse>(`/api/files/${id}`),
    update: (id: string, body: { title?: string | null; artist?: string | null }) =>
      patch<FileResponse>(`/api/files/${id}`, body),
    remove: (id: string) => del<{ ok: true }>(`/api/files/${id}`),
    url: (id: string) => call<SignedUrlResponse>(`/api/files/${id}/url`),
    edit: (id: string, field: EditField, value: Json) => post<EditResponse>(`/api/files/${id}/edits`, { field, value }),
    reanalyze: (id: string, stages?: string[]) => post<JobResponse>(`/api/files/${id}/reanalyze`, stages ? { stages } : {}),
  },
  jobs: {
    create: (body: JobCreateRequest) => post<JobResponse>("/api/jobs", body),
    get: (id: string) => call<JobResponse>(`/api/jobs/${id}`),
    retry: (id: string) => post<JobResponse>(`/api/jobs/${id}/retry`),
  },
  loops: {
    list: (fileId: string) => call<LoopsListResponse>(`/api/loops?file_id=${encodeURIComponent(fileId)}`),
    create: (body: LoopCreateRequest) => post<LoopResponse>("/api/loops", body),
    update: (id: string, body: LoopPatchRequest) => patch<LoopResponse>(`/api/loops/${id}`, body),
    remove: (id: string) => del<{ ok: true }>(`/api/loops/${id}`),
    render: (id: string) => post<JobResponse>(`/api/loops/${id}/render`),
    find: (body: LoopsFindRequest) => post<JobResponse>("/api/loops/find", body),
  },
  search: (body: SearchRequest) => post<SearchResponse>("/api/search", body),
  conversations: {
    list: () => call<ConversationsListResponse>("/api/conversations"),
    create: (body: ConversationCreateRequest = {}) => post<{ conversation: ConversationResponse["conversation"] }>("/api/conversations", body),
    get: (id: string) => call<ConversationResponse>(`/api/conversations/${id}`),
    remove: (id: string) => del<{ ok: true }>(`/api/conversations/${id}`),
  },
  /** Returns the raw streaming response; read `body` as text chunks. */
  chat: (body: ChatRequest) =>
    fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
