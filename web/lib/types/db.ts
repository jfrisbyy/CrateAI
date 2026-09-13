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


// ---------------------------------------------------------------------------
// layers, layer_items (combine)
// ---------------------------------------------------------------------------

export type LayerRow = {
  id: string;
  user_id: string;
  name: string | null;
  tempo_bpm: number | null;
  key: { tonic: string; mode: "major" | "minor" } | null;
  render_file_id: string | null;
  created_at: string;
  updated_at: string;
};

export type LayerInsert = {
  id?: string;
  user_id: string;
  name?: string | null;
  tempo_bpm?: number | null;
  key?: { tonic: string; mode: "major" | "minor" } | null;
  render_file_id?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type LayerUpdate = Partial<LayerInsert>;

export type LayerItemRow = {
  id: string;
  user_id: string;
  layer_id: string;
  file_id: string;
  offset_s: number;
  gain_db: number;
  stretch_ratio: number;
  pitch_semitones: number;
  muted: boolean;
  stretch_mode: "transient" | "smooth";
  filter: { highpass_hz?: number | null; lowpass_hz?: number | null } | null;
  position: number;
  created_at: string;
};

export type LayerItemInsert = {
  id?: string;
  user_id: string;
  layer_id: string;
  file_id: string;
  offset_s?: number;
  gain_db?: number;
  stretch_ratio?: number;
  pitch_semitones?: number;
  muted?: boolean;
  stretch_mode?: "transient" | "smooth";
  filter?: { highpass_hz?: number | null; lowpass_hz?: number | null } | null;
  position?: number;
  created_at?: string;
};

export type LayerItemUpdate = Partial<LayerItemInsert>;

// ---------------------------------------------------------------------------
// revoices
// ---------------------------------------------------------------------------

export type RevoicePath = "symbolic" | "neural";

export type RevoiceRow = {
  id: string;
  user_id: string;
  source_file_id: string;
  instrument: string;
  path: RevoicePath;
  midi_id: string | null;
  render_file_id: string | null;
  params: Json | null;
  created_at: string;
};

export type RevoiceInsert = {
  id?: string;
  user_id: string;
  source_file_id: string;
  instrument: string;
  path: RevoicePath;
  midi_id?: string | null;
  render_file_id?: string | null;
  params?: Json | null;
  created_at?: string;
};

export type RevoiceUpdate = Partial<RevoiceInsert>;

// ---------------------------------------------------------------------------
// breakdowns, comparisons
// ---------------------------------------------------------------------------

/** analysis/lockedgroove/breakdown/compose.py: Fact */
export type BreakdownFact = {
  text: string;
  source: string;
  confidence: number | null;
  hedge: string;
  value: Json;
  time_s: number | null;
  end_s: number | null;
  bar: number | null;
  citation: { url: string; title?: string; [k: string]: Json | undefined } | null;
}

export type BreakdownMissing = {
  field: string;
  text: string;
  job: string | null;
}

export type BreakdownSectionKey =
  | "vitals" | "structure" | "sample" | "drums" | "bass" | "harmony" | "melodic" | "arrangement" | "mix"
  | "context" | "recipe";

export type BreakdownSection = {
  key: BreakdownSectionKey;
  title: string;
  facts: BreakdownFact[];
  missing: BreakdownMissing[];
}

export type BreakdownContent = {
  schema_version: "1.0";
  file_id: string | null;
  generated_at: string;
  analysis_version: number;
  identified: boolean;
  title: string | null;
  artist: string | null;
  sections: BreakdownSection[];
  requires: string[];
}

export type BreakdownRow = {
  id: string;
  user_id: string;
  file_id: string;
  version: number;
  content: BreakdownContent;
  web_context: Json | null;
  narration: string | null;
  created_at: string;
};

export type BreakdownInsert = {
  id?: string;
  user_id: string;
  file_id: string;
  version?: number;
  content: BreakdownContent;
  web_context?: Json | null;
  narration?: string | null;
  created_at?: string;
};

export type BreakdownUpdate = Partial<BreakdownInsert>;

/** analysis/lockedgroove/breakdown/compare.py: Delta */
export type ComparisonDelta = {
  section: "vitals" | "structure" | "sample" | "drums" | "bass" | "harmony" | "mix";
  metric: string;
  a: Json;
  b: Json;
  delta: number | null;
  unit: string;
  text: string;
  confidence: number | null;
  hedge: string;
  source: string;
}

export type ComparisonContent = {
  schema_version: "1.0";
  file_a_id: string | null;
  file_b_id: string | null;
  a_name: string;
  b_name: string;
  generated_at: string;
  deltas: ComparisonDelta[];
  missing: string[];
}

export type ComparisonRow = {
  id: string;
  user_id: string;
  file_a_id: string;
  file_b_id: string;
  content: ComparisonContent;
  created_at: string;
};

export type ComparisonInsert = {
  id?: string;
  user_id: string;
  file_a_id: string;
  file_b_id: string;
  content: ComparisonContent;
  created_at?: string;
};

export type ComparisonUpdate = Partial<ComparisonInsert>;

// ---------------------------------------------------------------------------
// embeddings, beatbox_profiles
// ---------------------------------------------------------------------------

export type EmbeddingRow = {
  id: string;
  user_id: string;
  file_id: string;
  model: string;
  vector: number[] | string;
  created_at: string;
};

export type EmbeddingInsert = {
  id?: string;
  user_id: string;
  file_id: string;
  model: string;
  vector: number[] | string;
  created_at?: string;
};

export type EmbeddingUpdate = Partial<EmbeddingInsert>;

export type BeatboxProfileRow = {
  id: string;
  user_id: string;
  model_path: string;
  classes: string[];
  sample_count: number;
  cv_accuracy: number | null;
  enabled: boolean;
  trained_at: string;
};

export type BeatboxProfileInsert = {
  id?: string;
  user_id: string;
  model_path: string;
  classes: string[];
  sample_count?: number;
  cv_accuracy?: number | null;
  enabled?: boolean;
  trained_at?: string;
};

export type BeatboxProfileUpdate = Partial<BeatboxProfileInsert>;

export type SearchEmbeddingsArgs = {
  p_query: number[] | string;
  p_model: string;
  p_limit?: number;
  p_kind?: FileKind | null;
  p_bpm_min?: number | null;
  p_bpm_max?: number | null;
  p_tonic?: string | null;
  p_mode?: "major" | "minor" | null;
  p_has_drums?: boolean | null;
  p_is_loop_based?: boolean | null;
  p_exclude_file_id?: string | null;
}

export type SimilarFilesArgs = {
  p_file_id: string;
  p_limit?: number;
}

export type VectorMatch = {
  file_id: string;
  similarity: number;
}


// ---------------------------------------------------------------------------
// profiles, usage_events, takedowns (Phase 10)
// ---------------------------------------------------------------------------

export type Plan = "free" | "pro";
export type PlanStatus = "active" | "past_due" | "canceled" | "trialing";
export type UsageKind = "gpu_seconds" | "cpu_seconds" | "chat_turn" | "web_search" | "stem_job";
export type TakedownStatus = "received" | "reviewing" | "removed" | "counter_noticed" | "restored" | "rejected";

export type ProfileRow = {
  id: string;
  email: string | null;
  plan: Plan;
  plan_status: PlanStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  corrections_opt_in: boolean;
  created_at: string;
  updated_at: string;
};

export type ProfileInsert = {
  id: string;
  email?: string | null;
  plan?: Plan;
  plan_status?: PlanStatus;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  corrections_opt_in?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type ProfileUpdate = Partial<ProfileInsert>;

export type UsageEventRow = {
  id: string;
  user_id: string;
  kind: UsageKind;
  amount: number;
  job_id: string | null;
  created_at: string;
};

export type UsageEventInsert = {
  id?: string;
  user_id: string;
  kind: UsageKind;
  amount?: number;
  job_id?: string | null;
  created_at?: string;
};

export type UsageEventUpdate = Partial<UsageEventInsert>;

export type TakedownRow = {
  id: string;
  claimant_name: string;
  claimant_email: string;
  claimant_address: string | null;
  work_description: string;
  infringing_description: string;
  good_faith: boolean;
  accuracy_sworn: boolean;
  signature: string;
  file_id: string | null;
  user_id: string | null;
  status: TakedownStatus;
  notes: string | null;
  source_ip: string | null;
  created_at: string;
  updated_at: string;
};

export type TakedownInsert = {
  id?: string;
  claimant_name: string;
  claimant_email: string;
  claimant_address?: string | null;
  work_description: string;
  infringing_description: string;
  good_faith?: boolean;
  accuracy_sworn?: boolean;
  signature: string;
  file_id?: string | null;
  user_id?: string | null;
  status?: TakedownStatus;
  notes?: string | null;
  source_ip?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type TakedownUpdate = Partial<TakedownInsert>;

export type UsageSummaryArgs = { p_since?: string };
export type UsageSummaryRow = { kind: string; total: number };

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
      layers: { Row: LayerRow; Insert: LayerInsert; Update: LayerUpdate; Relationships: [] };
      layer_items: { Row: LayerItemRow; Insert: LayerItemInsert; Update: LayerItemUpdate; Relationships: [] };
      revoices: { Row: RevoiceRow; Insert: RevoiceInsert; Update: RevoiceUpdate; Relationships: [] };
      breakdowns: { Row: BreakdownRow; Insert: BreakdownInsert; Update: BreakdownUpdate; Relationships: [] };
      comparisons: { Row: ComparisonRow; Insert: ComparisonInsert; Update: ComparisonUpdate; Relationships: [] };
      embeddings: { Row: EmbeddingRow; Insert: EmbeddingInsert; Update: EmbeddingUpdate; Relationships: [] };
      beatbox_profiles: {
        Row: BeatboxProfileRow;
        Insert: BeatboxProfileInsert;
        Update: BeatboxProfileUpdate;
        Relationships: [];
      };
      profiles: { Row: ProfileRow; Insert: ProfileInsert; Update: ProfileUpdate; Relationships: [] };
      usage_events: { Row: UsageEventRow; Insert: UsageEventInsert; Update: UsageEventUpdate; Relationships: [] };
      takedowns: { Row: TakedownRow; Insert: TakedownInsert; Update: TakedownUpdate; Relationships: [] };
    };
    Views: Record<string, never>;
    Functions: {
      library_filter: {
        Args: LibraryFilterArgs;
        Returns: FileRow[];
      };
      search_embeddings: {
        Args: SearchEmbeddingsArgs;
        Returns: VectorMatch[];
      };
      similar_files: {
        Args: SimilarFilesArgs;
        Returns: VectorMatch[];
      };
      usage_summary: {
        Args: UsageSummaryArgs;
        Returns: UsageSummaryRow[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
