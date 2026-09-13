// Request and response shapes shared by the route handlers and the browser
// client. Keep this the single place both sides import from.

import type { ChatSendBody } from "@/lib/api/chat";
import type { SearchMode } from "@/lib/search/hybrid";
import type { SearchHit } from "@/lib/search/merge";
import type { ParsedQuery } from "@/lib/search/parse";
import type { ConversationRow, FileKind, FileRow, JobKind, JobRow, Json, LoopRow, MessageRow, CorrectionRow } from "@/lib/types/db";

export type DispatchInfo = { ok: true; call_id: string } | { ok: false; reason: string };

export interface PrepareRequest {
  sha256: string;
  filename: string;
  size_bytes: number;
  content_type: string;
}
export type PrepareResponse = { status: "exists"; file: FileRow } | { status: "upload"; storage_path: string };

export interface CompleteRequest {
  sha256: string;
  storage_path: string;
  original_filename: string;
  size_bytes: number;
  content_type: string;
}
export interface CompleteResponse {
  file: FileRow;
  job: JobRow | null;
  dispatch: DispatchInfo | null;
}

export interface FilesListResponse {
  files: FileRow[];
}
export interface FileResponse {
  file: FileRow;
}
export interface SignedUrlResponse {
  url: string;
  expires_in: number;
}

export type EditField = "tempo_bpm" | "downbeat_phase" | "first_downbeat_s" | "key" | "meter" | "section_labels";
export interface EditRequest {
  field: EditField;
  value: Json;
}
export interface EditResponse {
  file: FileRow;
  correction: CorrectionRow;
}

export interface ReanalyzeRequest {
  stages?: string[];
}

export interface JobCreateRequest {
  kind: JobKind;
  file_id?: string | null;
  params?: Record<string, Json | undefined>;
}
export interface JobResponse {
  job: JobRow;
  dispatch?: DispatchInfo | null;
}

export interface LoopsListResponse {
  loops: LoopRow[];
}
export interface LoopCreateRequest {
  file_id: string;
  start_s: number;
  end_s: number;
  name?: string | null;
  bars?: number | null;
}
export interface LoopPatchRequest {
  start_s?: number;
  end_s?: number;
  name?: string | null;
  bars?: number | null;
}
export interface LoopResponse {
  loop: LoopRow;
}
export interface LoopsFindRequest {
  file_id: string;
  bars?: number[];
  top_k?: number;
}

export interface SearchRequest {
  query: string;
  limit?: number;
  kind?: FileKind;
}
export interface SearchResponse {
  /** ranked hits with the report fields that matched (BUILD_PACKET section 12) */
  results: SearchHit[];
  /** results[].file, for the shell's search state */
  files: FileRow[];
  parsed: ParsedQuery;
  /** "vector" when the text went through the CLAP embedding, "filters" when it fell back */
  mode: SearchMode;
  /** why a text query could not use vectors, or null */
  note: string | null;
}

export interface ConversationsListResponse {
  conversations: ConversationRow[];
}
export interface ConversationCreateRequest {
  title?: string | null;
  file_ids?: string[];
}
export interface ConversationResponse {
  conversation: ConversationRow;
  messages: MessageRow[];
}

/** POST /api/chat body; the route also accepts `content` as an alias of `message`. */
export type ChatRequest = ChatSendBody;
