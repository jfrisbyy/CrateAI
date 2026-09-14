"use client";

// Every report section with its method and confidence (and hedge word).
// Nulls read "not measured yet" with a Run affordance that queues that stage.

import { useState, type ReactNode } from "react";
import { btn, btnQuiet, cx } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import { fmtBpm, fmtClock, fmtNumber, fmtSeconds } from "@/lib/format";
import { displayKey, otherSpelling } from "@/lib/music/keys";
import { limitsTheFlip, sourceFidelity } from "@/lib/report/bandwidth";
import { hedgeWord } from "@/lib/report/hedge";
import { useLibrary } from "@/lib/state/LibraryProvider";
import { REPORT_SECTIONS, type AnalysisReport, type ReportSection } from "@/lib/types/report";
import { ConfidenceDot } from "./ConfidenceDot";
import { useSurface } from "./surfaceState";

const TITLES: Record<ReportSection, string> = {
  tempo: "Tempo",
  beats: "Beats and downbeats",
  key: "Key",
  chords: "Chords",
  onsets: "Onsets",
  groove: "Groove",
  structure: "Structure",
  drums: "Drums",
  sample_use: "Sample use",
  instrumentation: "Instrumentation",
  loudness: "Loudness",
  spectral: "Spectral",
  effects_estimates: "Effects estimates",
};

export function ReportTab() {
  const { file, report } = useSurface();
  const lib = useLibrary();
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (stages?: string[]) => {
    setRunning(stages?.[0] ?? "all");
    setError(null);
    try {
      const res = await api.files.reanalyze(file.id, stages);
      lib.upsertJob(res.job);
      if (res.dispatch && !res.dispatch.ok) setError(`Queued, but ${res.dispatch.reason}.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(null);
    }
  };

  const raw = file.report;

  return (
    <div className="px-4 py-3 max-w-[760px]">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-xs text-chalk-dim">
          {raw ? (
            <>
              Analysis version <span className="font-mono text-chalk">{raw.analysis_version}</span>, schema{" "}
              <span className="font-mono text-chalk">{raw.schema_version}</span>
              {raw.user_edits.edited_at && (
                <>
                  , edited <span className="font-mono text-chalk">{raw.user_edits.edited_at.slice(0, 19).replace("T", " ")}</span>
                </>
              )}
            </>
          ) : (
            "No report yet."
          )}
        </p>
        <button type="button" className={btn} disabled={running !== null} onClick={() => void run()}>
          Run everything again
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs border-l-2 border-pad pl-2">
          {error}
        </p>
      )}

      {report && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-0.5 text-xs">
          <Row k="File">
            {report.file.original_filename ?? file.original_filename}
          </Row>
          <Row k="Duration">{fmtClock(report.file.duration_s || file.duration_s || 0)}</Row>
          <Row k="Sample rate">{report.file.sample_rate || file.sample_rate || "—"} Hz</Row>
          <Row k="Channels">{report.file.channels || file.channels || "—"}</Row>
          <Row k="Format">{report.file.format ?? file.format ?? "—"}</Row>
          {report.tags.length > 0 && <Row k="Tags">{report.tags.map((t) => `${t.tag} ${t.confidence.toFixed(2)}`).join(", ")}</Row>}
        </dl>
      )}

      <div className="mt-4">
        {REPORT_SECTIONS.map((section) => (
          <SectionBlock key={section} id={section} report={report} running={running === section} onRun={() => void run([section])} />
        ))}
      </div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-chalk-dim">{k}</dt>
      <dd className="font-mono text-chalk">{children}</dd>
    </>
  );
}

function confidenceOf(section: ReportSection, report: AnalysisReport): number | null {
  switch (section) {
    case "tempo":
      return report.tempo?.confidence ?? null;
    case "beats":
      return report.beats?.confidence ?? null;
    case "key":
      return report.key?.confidence ?? null;
    case "groove":
      return report.groove?.confidence ?? null;
    case "structure":
      return report.structure?.loop_period_confidence ?? null;
    case "drums":
      return report.drums?.source_confidence ?? null;
    case "sample_use":
      return report.sample_use?.confidence ?? null;
    case "instrumentation":
      return report.instrumentation?.confidence ?? null;
    default:
      return null;
  }
}

function methodOf(section: ReportSection, report: AnalysisReport): string | null {
  const value = report[section] as { method?: string } | null;
  if (value && typeof value === "object" && "method" in value && typeof value.method === "string") return value.method;
  if (section === "effects_estimates" && report.effects_estimates) return report.effects_estimates.reverb_tail_s.method;
  return null;
}

function SectionBlock({ id, report, running, onRun }: { id: ReportSection; report: AnalysisReport | null; running: boolean; onRun: () => void }) {
  const value = report ? report[id] : null;
  const conf = report ? confidenceOf(id, report) : null;
  const method = report ? methodOf(id, report) : null;
  const hedge = conf === null ? null : hedgeWord(conf);
  return (
    <section className="border-t border-rule py-2.5" aria-label={TITLES[id]}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium flex items-center gap-2">
          {TITLES[id]}
          {value && conf !== null && <ConfidenceDot confidence={conf} />}
          {value && hedge && <span className="text-xs font-normal text-chalk-dim">{hedge}</span>}
        </h2>
        <div className="flex items-center gap-3 text-xs text-chalk-dim">
          {method && (
            <span>
              method <span className="font-mono text-chalk">{method}</span>
            </span>
          )}
          {conf !== null && (
            <span>
              confidence <span className="font-mono text-chalk">{conf.toFixed(2)}</span>
            </span>
          )}
          <button type="button" className={btnQuiet} disabled={running} onClick={onRun} title={value ? "Run this stage again" : "Run this stage"}>
            {running ? "queueing" : value ? "Run again" : "Run"}
          </button>
        </div>
      </div>
      {value && report ? <SectionBody id={id} report={report} /> : <p className="mt-1 text-xs text-chalk-dim">not measured yet</p>}
    </section>
  );
}

function SectionBody({ id, report }: { id: ReportSection; report: AnalysisReport }) {
  const dl = "mt-1.5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-0.5 text-xs";
  switch (id) {
    case "tempo": {
      const t = report.tempo!;
      return (
        <dl className={dl}>
          <Row k="BPM">{fmtBpm(t.bpm)}</Row>
          <Row k="Alternates">{t.alternates_bpm.map((b) => fmtBpm(b)).join(" / ") || "—"}</Row>
          {t.notes && <Row k="Notes">{t.notes}</Row>}
        </dl>
      );
    }
    case "beats": {
      const b = report.beats!;
      return (
        <dl className={dl}>
          <Row k="Beats">{b.times_s.length}</Row>
          <Row k="Meter">{b.meter}</Row>
          <Row k="Downbeats">
            {b.downbeats_s.length}, phase {b.downbeat_phase}, first {fmtSeconds(b.downbeats_s[0] ?? null)}
          </Row>
          <Row k="Downbeat confidence">
            {b.downbeat_confidence.toFixed(2)} ({hedgeWord(b.downbeat_confidence) || "stated"}), method {b.downbeat_method || "—"}
          </Row>
          {b.notes && <Row k="Notes">{b.notes}</Row>}
        </dl>
      );
    }
    case "key": {
      const k = report.key!;
      const other = otherSpelling(k.tonic, k.mode);
      return (
        <dl className={dl}>
          <Row k="Key">
            {displayKey(k.tonic, k.mode)}
            {other ? ` (also written ${other})` : ""}
          </Row>
          <Row k="Alternate">{k.alternate ? `${displayKey(k.alternate.tonic, k.alternate.mode)}, correlation ${fmtNumber(k.alternate.correlation)}` : "—"}</Row>
          {k.notes && <Row k="Notes">{k.notes}</Row>}
        </dl>
      );
    }
    case "chords": {
      const c = report.chords!;
      return (
        <dl className={dl}>
          <Row k="Segments">{c.segments.length}</Row>
          <Row k="Progression">{c.segments.slice(0, 16).map((s) => s.label).join(" ") || "—"}</Row>
          {c.notes && <Row k="Notes">{c.notes}</Row>}
        </dl>
      );
    }
    case "onsets": {
      const o = report.onsets!;
      return (
        <dl className={dl}>
          <Row k="Count">{o.count}</Row>
        </dl>
      );
    }
    case "groove": {
      const g = report.groove!;
      return (
        <dl className={dl}>
          <Row k="Feel">{g.feel}</Row>
          <Row k="Swing">{fmtNumber(g.swing_pct, 1)}%</Row>
          <Row k="Timing deviation">
            mean {fmtNumber(g.timing_deviation_ms.mean, 1)} ms, std {fmtNumber(g.timing_deviation_ms.std, 1)} ms
          </Row>
        </dl>
      );
    }
    case "structure": {
      const st = report.structure!;
      return (
        <div className="mt-1.5 text-xs">
          <dl className={cx(dl, "mt-0")}>
            <Row k="Loop period">{st.loop_period_bars !== null ? `${st.loop_period_bars} bars` : "—"}</Row>
            {st.notes && <Row k="Notes">{st.notes}</Row>}
          </dl>
          <table className="mt-1.5 w-full font-mono">
            <thead className="text-chalk-dim">
              <tr>
                <th className="text-left font-normal">label</th>
                <th className="text-right font-normal">bar</th>
                <th className="text-right font-normal">bars</th>
                <th className="text-right font-normal">start</th>
                <th className="text-right font-normal">end</th>
                <th className="text-right font-normal">energy</th>
                <th className="text-right font-normal">confidence</th>
              </tr>
            </thead>
            <tbody>
              {st.sections.map((sec, i) => (
                <tr key={i} className="border-t border-rule">
                  <td className="py-0.5">{sec.label}</td>
                  <td className="text-right">{sec.start_bar}</td>
                  <td className="text-right">{sec.bars}</td>
                  <td className="text-right">{fmtClock(sec.start_s)}</td>
                  <td className="text-right">{fmtClock(sec.end_s)}</td>
                  <td className="text-right">{fmtNumber(sec.energy)}</td>
                  <td className="text-right">{fmtNumber(sec.confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "drums": {
      const d = report.drums!;
      return (
        <dl className={dl}>
          <Row k="Source">
            {d.source_estimate.replace("_", " ")} ({hedgeWord(d.source_confidence) || "stated"})
          </Row>
          <Row k="Patterns">{d.patterns.length} section{d.patterns.length === 1 ? "" : "s"}</Row>
          <Row k="Layered kick">{d.layered_kick === null ? "not measured yet" : d.layered_kick ? "yes" : "no"}</Row>
          {d.notes && <Row k="Notes">{d.notes}</Row>}
        </dl>
      );
    }
    case "sample_use": {
      const su = report.sample_use!;
      const yn = (v: boolean | null) => (v === null ? "not measured yet" : v ? "yes" : "no");
      return (
        <dl className={dl}>
          <Row k="Loop based">{yn(su.is_loop_based)}</Row>
          <Row k="Chops">{su.chop_count_estimate ?? "not measured yet"}</Row>
          <Row k="Reordered">{yn(su.chop_reordering_detected)}</Row>
          <Row k="Pitch shift">{su.pitch_shift_semitones_estimate !== null ? `${fmtNumber(su.pitch_shift_semitones_estimate, 1)} st` : "not measured yet"}</Row>
          <Row k="Sample bars">{su.sample_bars.length > 0 ? su.sample_bars.join(" ") : "—"}</Row>
          {su.notes && <Row k="Notes">{su.notes}</Row>}
        </dl>
      );
    }
    case "instrumentation": {
      const inst = report.instrumentation!;
      return (
        <dl className={dl}>
          {inst.per_section.map((ps) => (
            <Row key={ps.section_index} k={`Section ${ps.section_index}`}>
              {ps.present.join(", ") || "nothing detected"}
              {ps.entries.length > 0 && `; enters ${ps.entries.map((e) => `${e.instrument}@${e.bar}`).join(" ")}`}
              {ps.exits.length > 0 && `; exits ${ps.exits.map((e) => `${e.instrument}@${e.bar}`).join(" ")}`}
            </Row>
          ))}
        </dl>
      );
    }
    case "loudness": {
      const l = report.loudness!;
      return (
        <dl className={dl}>
          <Row k="Integrated">{fmtNumber(l.integrated_lufs, 1)} LUFS</Row>
          <Row k="True peak">{fmtNumber(l.true_peak_dbtp, 1)} dBTP</Row>
          <Row k="Range">{fmtNumber(l.loudness_range_lu, 1)} LU</Row>
        </dl>
      );
    }
    case "spectral": {
      const sp = report.spectral!;
      // Bandwidth leads: it is the one number here a producer can act on, and
      // the reason a flip off a 128 kbps rip sounds dull however it is
      // separated. The processing chain has guarded against it since it was
      // measured; nobody was told.
      const fidelity = sourceFidelity(sp.bandwidth);
      return (
        <>
          <dl className={dl}>
            <Row k="Bandwidth">
              {fidelity ? (
                <>
                  {fidelity.khz} kHz <ConfidenceDot confidence={fidelity.confidence} />
                </>
              ) : (
                "not measured"
              )}
            </Row>
            <Row k="Centroid">{fmtNumber(sp.centroid_hz_mean, 0)} Hz</Row>
            <Row k="Stereo width">{fmtNumber(sp.stereo_width)}</Row>
            <Row k="Low / high">{fmtNumber(sp.low_high_ratio_db, 1)} dB</Row>
          </dl>
          {fidelity && (
            <p className={cx("mt-2 text-xs max-w-[560px]", limitsTheFlip(fidelity) ? "text-pad" : "text-chalk-dim")}>
              {fidelity.verdict}
              {fidelity.note && <span className="block text-chalk-dim">{fidelity.note}</span>}
            </p>
          )}
        </>
      );
    }
    case "effects_estimates": {
      const fx = report.effects_estimates!;
      const est = (v: number | null, unit: string, conf: number) =>
        v === null ? "not measured yet" : `${hedgeWord(conf) ? `${hedgeWord(conf)} ` : ""}${fmtNumber(v, 2)} ${unit} (confidence ${conf.toFixed(2)})`;
      return (
        <dl className={dl}>
          <Row k="Reverb tail">{est(fx.reverb_tail_s.value, "s", fx.reverb_tail_s.confidence)}</Row>
          <Row k="Sidechain">
            {fx.sidechain_ducking.detected ? `detected, ${fx.sidechain_ducking.depth_db !== null ? `${fmtNumber(fx.sidechain_ducking.depth_db, 1)} dB` : "depth not measured"}` : "not detected"}{" "}
            (confidence {fx.sidechain_ducking.confidence.toFixed(2)})
          </Row>
          <Row k="Saturation above">{est(fx.saturation_above_hz.value, "Hz", fx.saturation_above_hz.confidence)}</Row>
        </dl>
      );
    }
  }
}
