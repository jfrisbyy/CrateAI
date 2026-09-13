// Hand-written row types mirroring supabase/migrations/20260913000000_init.sql.
// Keep column names, nullability and check-constraint unions exactly in step
// with the migration; the typed Supabase client is built on `Database` below.

import type { AnalysisReport } from "./report";

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type FileKind = "original" | "stem" | "chop" | "loop_render" | "layer_render" | "revoice_render";
export type FileStatus = "uploading" | "queued" | "analyzing" | "ready" | "failed";
export type JobKind =
  | "analyze"
  | "stems"
  | "chop"
  | "midi"
  | "embed"
  | "render_loop"
  | "layer"
  | "revoice"
  | "breakdown"
  | "compare"
  | "beatbox_train"
  | "beatbox_transcribe";
export type JobStatus = "queued" | "running" | "done" | "failed";
export type LoopOrigin = "finder" | "user" | "chat";
export type MidiKind = "melody" | "drums" | "chords" | "beatbox" | "groove";
export type MessageRole = "user" | "assistant" | "tool";
export type TagSource = "model" | "user";

export const FILE_KINDS: readonly FileKind[] = ["original", "stem", "chop", "loop_render", "layer_render", "revoice_render"];
export const JOB_KINDS: readonly JobKind[] = [
  "analyze", "stems", "chop", "midi", "embed", "render_loop", "layer", "revoice", "breakdown", "compare",
  "beatbox_train", "beatbox_transcribe",
];

/** docs/CONTRACTS.md section 6. Mono mixdown, exactly `points` entries each, values in [-1, 1]. */
export interface Peaks {
  version: 1;
  points: number;
  min: number[];
  max: number[];
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

export type FileRow = {
  id: string;
  user_id: string;
  sha256: string;
  original_filename: string;
  storage_path: string;
  size_bytes: number | null;
  duration_s: number | null;
  sample_rate: number | null;
  channels: number | null;
  format: string | null;
  kind: FileKind;
  parent_file_id: string | null;
  status: FileStatus;
  analysis_version: number;
  report: AnalysisReport | null;
  peaks: Peaks | null;
  title: string | null;
  artist: string | null;
  created_at: string;
  updated_at: string;
}

export type FileInsert = {
  id?: string;
  user_id: string;
  sha256: string;
  original_filename: string;
  storage_path: string;
  size_bytes?: number | null;
  duration_s?: number | null;
  sample_rate?: number | null;
  channels?: number | null;
  format?: string | null;
  kind?: FileKind;
  parent_file_id?: string | null;
  status?: FileStatus;
  analysis_version?: number;
  report?: AnalysisReport | null;
  peaks?: Peaks | null;
  title?: string | null;
  artist?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type FileUpdate = Partial<FileInsert>;

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

export type JobRow = {
  id: string;
  user_id: string;
  file_id: string | null;
  kind: JobKind;
  status: JobStatus;
  params: Json;
  result: Json | null;
  error: string | null;
  modal_call_id: string | null;
  progress: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type JobInsert = {
  id?: string;
  user_id: string;
  file_id?: string | null;
  kind: JobKind;
  status?: JobStatus;
  params?: Json;
  result?: Json | null;
  error?: string | null;
  modal_call_id?: string | null;
  progress?: number | null;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export type JobUpdate = Partial<JobInsert>;

// ---------------------------------------------------------------------------
// loops
// ---------------------------------------------------------------------------

export type LoopRow = {
  id: string;
  user_id: string;
  file_id: string;
  start_s: number;
  end_s: number;
  bars: number | null;
  score: number | null;
  origin: LoopOrigin;
  components: Json | null;
  name: string | null;
  render_file_id: string | null;
  created_at: string;
}

export type LoopInsert = {
  id?: string;
  user_id: string;
  file_id: string;
  start_s: number;
  end_s: number;
  bars?: number | null;
  score?: number | null;
  origin?: LoopOrigin;
  components?: Json | null;
  name?: string | null;
  render_file_id?: string | null;
  created_at?: string;
}

export type LoopUpdate = Partial<LoopInsert>;

// ---------------------------------------------------------------------------
// stems
// ---------------------------------------------------------------------------

export type StemRow = {
  id: string;
  user_id: string;
  file_id: string;
  stem: string;
  model: string;
  stem_file_id: string;
  created_at: string;
}

export type StemInsert = {
  id?: string;
  user_id: string;
  file_id: string;
  stem: string;
  model: string;
  stem_file_id: string;
  created_at?: string;
}

export type StemUpdate = Partial<StemInsert>;

// ---------------------------------------------------------------------------
// chops
// ---------------------------------------------------------------------------

export type ChopRow = {
  id: string;
  user_id: string;
  source_file_id: string;
  start_s: number;
  end_s: number;
  index: number;
  name: string | null;
  chop_file_id: string | null;
  created_at: string;
}

export type ChopInsert = {
  id?: string;
  user_id: string;
  source_file_id: string;
  start_s: number;
  end_s: number;
  index: number;
  name?: string | null;
  chop_file_id?: string | null;
  created_at?: string;
}

export type ChopUpdate = Partial<ChopInsert>;

// ---------------------------------------------------------------------------
// midi
// ---------------------------------------------------------------------------

export type MidiRow = {
  id: string;
  user_id: string;
  source_file_id: string | null;
  kind: MidiKind;
  storage_path: string;
  notes: Json | null;
  created_at: string;
}

export type MidiInsert = {
  id?: string;
  user_id: string;
  source_file_id?: string | null;
  kind: MidiKind;
  storage_path: string;
  notes?: Json | null;
  created_at?: string;
}

export type MidiUpdate = Partial<MidiInsert>;

// ---------------------------------------------------------------------------
// corrections (principle 7: the accuracy dataset; nothing else reads it)
// ---------------------------------------------------------------------------

export type CorrectionRow = {
  id: string;
  user_id: string;
  file_id: string;
  field: string;
  predicted: Json | null;
  corrected: Json | null;
  created_at: string;
}

export type CorrectionInsert = {
  id?: string;
  user_id: string;
  file_id: string;
  field: string;
  predicted?: Json | null;
  corrected?: Json | null;
  created_at?: string;
}

export type CorrectionUpdate = Partial<CorrectionInsert>;

// ---------------------------------------------------------------------------
// conversations, messages
// ---------------------------------------------------------------------------

export type ConversationRow = {
  id: string;
  user_id: string;
  title: string | null;
  file_ids: string[];
  created_at: string;
  updated_at: string;
}

export type ConversationInsert = {
  id?: string;
  user_id: string;
  title?: string | null;
  file_ids?: string[];
  created_at?: string;
  updated_at?: string;
}

export type ConversationUpdate = Partial<ConversationInsert>;

export type MessageRow = {
  id: string;
  user_id: string;
  conversation_id: string;
  role: MessageRole;
  content: Json;
  tool_calls: Json | null;
  citations: Json | null;
  created_at: string;
}

export type MessageInsert = {
  id?: string;
  user_id: string;
  conversation_id: string;
  role: MessageRole;
  content: Json;
  tool_calls?: Json | null;
  citations?: Json | null;
  created_at?: string;
}

export type MessageUpdate = Partial<MessageInsert>;

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

export type TagRow = {
  id: string;
  user_id: string;
  file_id: string;
  tag: string;
  source: TagSource;
  confidence: number;
  created_at: string;
}

export type TagInsert = {
  id?: string;
  user_id: string;
  file_id: string;
  tag: string;
  source?: TagSource;
  confidence?: number;
  created_at?: string;
}

export type TagUpdate = Partial<TagInsert>;

// ---------------------------------------------------------------------------
// Database: the generic the Supabase client is built on. Only the tables the
// web app touches are listed; add a table here when a route starts using it.
// ---------------------------------------------------------------------------

export type LibraryFilterArgs = {
  p_bpm_min?: number | null;
  p_bpm_max?: number | null;
  p_tonic?: string | null;
  p_mode?: string | null;
  p_kind?: string | null;
  p_limit?: number | null;
}

export type Database = {
  public: {
    Tables: {
      files: { Row: FileRow; Insert: FileInsert; Update: FileUpdate; Relationships: [] };
      jobs: { Row: JobRow; Insert: JobInsert; Update: JobUpdate; Relationships: [] };
      loops: { Row: LoopRow; Insert: LoopInsert; Update: LoopUpdate; Relationships: [] };
      stems: { Row: StemRow; Insert: StemInsert; Update: StemUpdate; Relationships: [] };
      chops: { Row: ChopRow; Insert: ChopInsert; Update: ChopUpdate; Relationships: [] };
      midi: { Row: MidiRow; Insert: MidiInsert; Update: MidiUpdate; Relationships: [] };
      corrections: { Row: CorrectionRow; Insert: CorrectionInsert; Update: CorrectionUpdate; Relationships: [] };
      conversations: {
        Row: ConversationRow;
        Insert: ConversationInsert;
        Update: ConversationUpdate;
        Relationships: [];
      };
      messages: { Row: MessageRow; Insert: MessageInsert; Update: MessageUpdate; Relationships: [] };
      tags: { Row: TagRow; Insert: TagInsert; Update: TagUpdate; Relationships: [] };
    };
    Views: Record<string, never>;
    Functions: {
      library_filter: {
        Args: LibraryFilterArgs;
        Returns: FileRow[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
