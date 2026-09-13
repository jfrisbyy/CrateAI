"use client";

// Building the crate.
//
// The material is a few hundred milliseconds of arithmetic, which is nothing
// to wait for and quite a lot to freeze a tab for, so the records are rendered
// one at a time with a yield between them and the page says how far it has
// got. Nothing here runs on the server: the effect is the only place the
// synthesis is called from, so the prerendered HTML is the line below and the
// work starts after the first paint.

import { useEffect, useState } from "react";
import { DEMO_SAMPLE_RATE } from "@/lib/demo/audio";
import { assembleDemoLibrary, DEMO_RECORD_COUNT, renderDemoRecord, type DemoLibrary, type RenderedRecord } from "@/lib/demo/material";
import { DemoShell } from "./DemoShell";

export function DemoBoot() {
  const [rendered, setRendered] = useState<RenderedRecord[]>([]);
  const [library, setLibrary] = useState<DemoLibrary | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (library !== null || failed !== null) return;
    if (rendered.length >= DEMO_RECORD_COUNT) {
      setLibrary(assembleDemoLibrary(rendered));
      return;
    }
    const next = rendered.length;
    const timer = window.setTimeout(() => {
      try {
        const record = renderDemoRecord(next, DEMO_SAMPLE_RATE);
        // Guarded rather than computed inside the updater: React is free to
        // call an updater twice, and rendering a record twice would put it in
        // the crate twice.
        setRendered((prev) => (prev.length === next ? [...prev, record] : prev));
      } catch (err) {
        setFailed(err instanceof Error ? err.message : String(err));
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [rendered, library, failed]);

  if (failed !== null) {
    return (
      <main className="min-h-full flex items-start justify-center px-4 py-[12vh]">
        <div className="max-w-[520px]">
          <h1 className="text-lg font-semibold">The demo material could not be built</h1>
          <p className="mt-3 text-sm text-chalk-dim">{failed}</p>
          <p className="mt-3 text-sm text-chalk-dim">Reloading the page starts it again. Nothing was uploaded and nothing was stored.</p>
        </div>
      </main>
    );
  }

  if (library === null) {
    return (
      <main className="min-h-full flex items-start justify-center px-4 py-[12vh]">
        <div className="max-w-[520px]">
          <h1 className="text-lg font-semibold">Cratebox — prototype</h1>
          <p className="mt-3 text-sm text-chalk-dim">
            Synthesising the demo material: a Rhodes bed and five drum breaks, built in your browser out of oscillators and noise. Nothing is
            downloaded and nothing is uploaded.
          </p>
          <p className="mt-3 font-mono text-sm text-chalk">
            {rendered.length} of {DEMO_RECORD_COUNT}
          </p>
          <div className="mt-2 h-1 w-full bg-slate rounded-sm overflow-hidden" role="progressbar" aria-valuenow={rendered.length} aria-valuemin={0} aria-valuemax={DEMO_RECORD_COUNT}>
            <div className="h-full bg-pad" style={{ width: `${(rendered.length / DEMO_RECORD_COUNT) * 100}%` }} />
          </div>
        </div>
      </main>
    );
  }

  return <DemoShell library={library} />;
}
