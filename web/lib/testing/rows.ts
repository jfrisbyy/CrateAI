// Seed helpers: one call puts a realistic row (and its storage object) in the
// database, owned by whoever you say. Every helper takes the owner first so a
// test reads as "user B's file" at a glance.

import { sampleContent } from "@/lib/narration/fixtures";
import { emptyReport } from "@/lib/report/effective";
import { libraryPath } from "@/lib/storage/paths";
import type {
  BeatboxProfileRow,
  BreakdownRow,
  ChopRow,
  ComparisonRow,
  ConversationRow,
  FileRow,
  JobRow,
  LayerItemRow,
  LayerRow,
  LoopRow,
  MessageRow,
  MidiRow,
  ProfileRow,
  RevoiceRow,
  StemRow,
  UsageEventRow,
} from "@/lib/types/db";
import type { AnalysisReport } from "@/lib/types/report";
import { testUuid, type TestDb } from "./db";
import { stemQualityColumns } from "@/lib/api/stems";
import { NOW } from "./schema";

/** A small report with a tempo, a key and a beat grid: enough for every route that needs one. */
export function sampleReport(partial: Partial<AnalysisReport> = {}): AnalysisReport {
  return emptyReport({
    analysis_version: 1,
    tempo: { bpm: 92, confidence: 0.9, method: "tempogram", alternates_bpm: [46, 184], notes: null },
    key: {
      tonic: "F",
      mode: "minor",
      confidence: 0.72,
      method: "harmonic-chroma",
      alternate: { tonic: "G#", mode: "major", correlation: 0.61 },
      notes: null,
    },
    beats: {
      times_s: Array.from({ length: 32 }, (_, i) => Number((i * (60 / 92)).toFixed(4))),
      confidence: 0.84,
      method: "beat_track",
      downbeats_s: Array.from({ length: 8 }, (_, i) => Number((i * 4 * (60 / 92)).toFixed(4))),
      downbeat_phase: 0,
      downbeat_confidence: 0.7,
      downbeat_method: "low-band",
      meter: "4/4",
      notes: null,
    },
    ...partial,
  });
}

export interface SeedFileOptions extends Partial<FileRow> {
  /** also put bytes at storage_path (default true) */
  withObject?: boolean;
  bytes?: Uint8Array | string;
}

export function seedFile(db: TestDb, userId: string, opts: SeedFileOptions = {}): FileRow {
  const { withObject = true, bytes, ...partial } = opts;
  const id = partial.id ?? testUuid(1);
  const sha256 = partial.sha256 ?? `${id.replace(/-/g, "")}`.padEnd(64, "0").slice(0, 64);
  const row: FileRow = {
    id,
    user_id: userId,
    sha256,
    original_filename: "break.wav",
    storage_path: libraryPath(userId, sha256, "wav"),
    size_bytes: 1024,
    duration_s: 120,
    sample_rate: 44100,
    channels: 2,
    format: "wav",
    kind: "original",
    parent_file_id: null,
    status: "ready",
    analysis_version: 1,
    report: sampleReport(),
    peaks: null,
    title: null,
    artist: null,
    created_at: NOW,
    updated_at: NOW,
    ...partial,
  };
  db.seed("files", row as unknown as Record<string, unknown>);
  if (withObject) db.putObject(row.storage_path, bytes ?? `audio:${row.id}`, "audio/wav");
  return row;
}

export function seedJob(db: TestDb, userId: string, partial: Partial<JobRow> = {}): JobRow {
  const row: JobRow = {
    id: partial.id ?? testUuid(2),
    user_id: userId,
    file_id: null,
    kind: "analyze",
    status: "queued",
    params: {},
    result: null,
    error: null,
    modal_call_id: null,
    progress: null,
    created_at: NOW,
    started_at: null,
    finished_at: null,
    ...partial,
  };
  db.seed("jobs", row as unknown as Record<string, unknown>);
  return row;
}

export function seedLoop(db: TestDb, userId: string, fileId: string, partial: Partial<LoopRow> = {}): LoopRow {
  const row: LoopRow = {
    id: partial.id ?? testUuid(3),
    user_id: userId,
    file_id: fileId,
    start_s: 0,
    end_s: 4,
    bars: 2,
    score: 0.8,
    origin: "finder",
    components: null,
    name: "break 2bar",
    render_file_id: null,
    created_at: NOW,
    ...partial,
  };
  db.seed("loops", row as unknown as Record<string, unknown>);
  return row;
}

export function seedStem(db: TestDb, userId: string, fileId: string, stemFileId: string, partial: Partial<StemRow> = {}): StemRow {
  const row: StemRow = {
    id: partial.id ?? testUuid(4),
    user_id: userId,
    file_id: fileId,
    stem: "drums",
    model: "htdemucs_ft",
    stem_file_id: stemFileId,
    // From the generated registry, so a seeded row cannot claim a tier the
    // model does not have. A test that wants a weak row names a weak model.
    ...stemQualityColumns(typeof partial.model === "string" ? partial.model : "htdemucs_ft"),
    created_at: NOW,
    ...partial,
  };
  db.seed("stems", row as unknown as Record<string, unknown>);
  return row;
}

export function seedChop(db: TestDb, userId: string, sourceFileId: string, partial: Partial<ChopRow> = {}): ChopRow {
  const row: ChopRow = {
    id: partial.id ?? testUuid(5),
    user_id: userId,
    source_file_id: sourceFileId,
    start_s: 0,
    end_s: 0.5,
    index: 0,
    name: null,
    chop_file_id: null,
    created_at: NOW,
    ...partial,
  };
  db.seed("chops", row as unknown as Record<string, unknown>);
  return row;
}

export function seedMidi(db: TestDb, userId: string, sourceFileId: string | null, partial: Partial<MidiRow> = {}): MidiRow {
  const id = partial.id ?? testUuid(6);
  const row: MidiRow = {
    id,
    user_id: userId,
    source_file_id: sourceFileId,
    kind: "drums",
    storage_path: `derived/${userId}/${sourceFileId ?? id}/midi/drums.mid`,
    notes: { notes: [], meta: { bpm: 92 } },
    created_at: NOW,
    ...partial,
  };
  db.seed("midi", row as unknown as Record<string, unknown>);
  db.putObject(row.storage_path, "MThd", "audio/midi");
  return row;
}

export function seedLayer(db: TestDb, userId: string, partial: Partial<LayerRow> = {}): LayerRow {
  const row: LayerRow = {
    id: partial.id ?? testUuid(7),
    user_id: userId,
    name: "a + b",
    tempo_bpm: null,
    key: null,
    render_file_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...partial,
  };
  db.seed("layers", row as unknown as Record<string, unknown>);
  return row;
}

export function seedLayerItem(db: TestDb, userId: string, layerId: string, fileId: string, partial: Partial<LayerItemRow> = {}): LayerItemRow {
  const row: LayerItemRow = {
    id: partial.id ?? testUuid(8),
    user_id: userId,
    layer_id: layerId,
    file_id: fileId,
    offset_s: 0,
    gain_db: 0,
    stretch_ratio: 1,
    pitch_semitones: 0,
    muted: false,
    stretch_mode: "transient",
    filter: null,
    position: 0,
    created_at: NOW,
    ...partial,
  };
  db.seed("layer_items", row as unknown as Record<string, unknown>);
  return row;
}

export function seedRevoice(db: TestDb, userId: string, sourceFileId: string, partial: Partial<RevoiceRow> = {}): RevoiceRow {
  const row: RevoiceRow = {
    id: partial.id ?? testUuid(9),
    user_id: userId,
    source_file_id: sourceFileId,
    instrument: "acoustic_guitar",
    path: "symbolic",
    midi_id: null,
    render_file_id: null,
    params: { instrument: "acoustic_guitar", path: "symbolic", keep_groove: false },
    created_at: NOW,
    ...partial,
  };
  db.seed("revoices", row as unknown as Record<string, unknown>);
  return row;
}

export function seedBreakdown(db: TestDb, userId: string, fileId: string, partial: Partial<BreakdownRow> = {}): BreakdownRow {
  const row: BreakdownRow = {
    id: partial.id ?? testUuid(1),
    user_id: userId,
    file_id: fileId,
    version: 1,
    content: sampleContent(),
    web_context: null,
    narration: null,
    created_at: NOW,
    ...partial,
  };
  db.seed("breakdowns", row as unknown as Record<string, unknown>);
  return row;
}

export function seedComparison(db: TestDb, userId: string, fileAId: string, fileBId: string, partial: Partial<ComparisonRow> = {}): ComparisonRow {
  const row: ComparisonRow = {
    id: partial.id ?? testUuid(2),
    user_id: userId,
    file_a_id: fileAId,
    file_b_id: fileBId,
    content: {
      schema_version: "1.0",
      file_a_id: fileAId,
      file_b_id: fileBId,
      a_name: "mine.wav",
      b_name: "reference.wav",
      generated_at: NOW,
      deltas: [],
      missing: [],
    },
    created_at: NOW,
    ...partial,
  };
  db.seed("comparisons", row as unknown as Record<string, unknown>);
  return row;
}

export function seedConversation(db: TestDb, userId: string, partial: Partial<ConversationRow> = {}): ConversationRow {
  const row: ConversationRow = {
    id: partial.id ?? testUuid(3),
    user_id: userId,
    title: "how was this made",
    file_ids: [],
    created_at: NOW,
    updated_at: NOW,
    ...partial,
  };
  db.seed("conversations", row as unknown as Record<string, unknown>);
  return row;
}

export function seedMessage(db: TestDb, userId: string, conversationId: string, partial: Partial<MessageRow> = {}): MessageRow {
  const row: MessageRow = {
    id: partial.id ?? testUuid(4),
    user_id: userId,
    conversation_id: conversationId,
    role: "user",
    content: [{ type: "text", text: "hello" }],
    tool_calls: null,
    citations: null,
    created_at: NOW,
    ...partial,
  };
  db.seed("messages", row as unknown as Record<string, unknown>);
  return row;
}

export function seedProfile(db: TestDb, userId: string, partial: Partial<ProfileRow> = {}): ProfileRow {
  const row: ProfileRow = {
    id: userId,
    email: `${userId}@example.test`,
    plan: "free",
    plan_status: "active",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    corrections_opt_in: false,
    loop_personalization: true,
    created_at: NOW,
    updated_at: NOW,
    ...partial,
  };
  db.seed("profiles", row as unknown as Record<string, unknown>);
  return row;
}

export function seedUsageEvent(db: TestDb, userId: string, partial: Partial<UsageEventRow> = {}): UsageEventRow {
  const row: UsageEventRow = {
    id: partial.id ?? testUuid(5),
    user_id: userId,
    kind: "stem_job",
    amount: 1,
    job_id: null,
    created_at: NOW,
    ...partial,
  };
  db.seed("usage_events", row as unknown as Record<string, unknown>);
  return row;
}

export function seedBeatboxProfile(db: TestDb, userId: string, partial: Partial<BeatboxProfileRow> = {}): BeatboxProfileRow {
  const row: BeatboxProfileRow = {
    id: partial.id ?? testUuid(6),
    user_id: userId,
    model_path: `derived/${userId}/beatbox/model.joblib`,
    classes: ["kick", "snare", "hat"],
    sample_count: 30,
    cv_accuracy: 0.91,
    enabled: true,
    trained_at: NOW,
    ...partial,
  };
  db.seed("beatbox_profiles", row as unknown as Record<string, unknown>);
  return row;
}
