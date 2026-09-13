"use client";

import { useEffect, useState } from "react";
import { cx } from "@/components/ui";
import { BreakdownTab } from "./BreakdownTab";
import { ChopsTab } from "./ChopsTab";
import { CompareTab } from "./CompareTab";
import { LayersTab } from "./LayersTab";
import { LoopsTab } from "./LoopsTab";
import { ReportTab } from "./ReportTab";
import { RevoiceTab } from "./RevoiceTab";
import { StemsTab } from "./StemsTab";

type TabId = "loops" | "stems" | "chops" | "layers" | "revoice" | "breakdown" | "compare" | "report";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "loops", label: "Loops" },
  { id: "stems", label: "Stems" },
  { id: "chops", label: "Chops" },
  { id: "layers", label: "Layers" },
  { id: "revoice", label: "Re-voice" },
  { id: "breakdown", label: "Breakdown" },
  { id: "compare", label: "Compare" },
  { id: "report", label: "Report" },
];

export type { TabId };

/** Other parts of the app open a tab by dispatching this event on window: `new CustomEvent("crateai:tab", { detail: "stems" })`. */
export const TAB_EVENT = "crateai:tab";

export function SurfaceTabs() {
  const [tab, setTab] = useState<TabId>("loops");
  useEffect(() => {
    const onTab = (e: Event) => {
      const id = (e as CustomEvent<TabId>).detail;
      if (TABS.some((t) => t.id === id)) setTab(id);
    };
    window.addEventListener(TAB_EVENT, onTab);
    return () => window.removeEventListener(TAB_EVENT, onTab);
  }, []);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div role="tablist" aria-label="Working surface" className="shrink-0 h-9 border-b border-rule px-2 flex items-stretch">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            id={`tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cx(
              "px-3 text-sm border-b-2 -mb-px transition-colors",
              tab === t.id ? "border-pad text-chalk" : "border-transparent text-chalk-dim hover:text-chalk",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="flex-1 min-h-0 overflow-y-auto">
        {tab === "loops" && <LoopsTab />}
        {tab === "report" && <ReportTab />}
        {tab === "stems" && <StemsTab />}
        {tab === "chops" && <ChopsTab />}
        {tab === "layers" && <LayersTab />}
        {tab === "revoice" && <RevoiceTab />}
        {tab === "breakdown" && <BreakdownTab />}
        {tab === "compare" && <CompareTab />}
      </div>
    </div>
  );
}
