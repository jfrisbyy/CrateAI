"use client";

import { useState } from "react";
import { cx } from "@/components/ui";
import { formatUsd } from "@/lib/billing/cost";
import { formatBytes, formatMinutes, PLAN_LABELS } from "@/lib/billing/limits";
import type { UsageReport } from "@/lib/billing/usage";
import type { ProfileRow } from "@/lib/types/db";

function Bar({ label, used, limit, fraction }: { label: string; used: string; limit: string; fraction: number }) {
  const pct = Math.min(100, Math.round(fraction * 100));
  return (
    <div className="border-l-2 border-rule pl-3">
      <div className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className="font-mono text-chalk-dim">{used} / {limit}</span>
      </div>
      <div className="mt-1 h-1 w-full bg-slate">
        <div className={cx("h-1", fraction >= 1 ? "bg-chalk" : "bg-pad")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function CostLine({ label, amount, note }: { label: string; amount: number; note?: string }) {
  return (
    <div className="flex items-baseline justify-between border-l-2 border-rule pl-3 text-sm">
      <span>
        {label}
        {note ? <span className="text-chalk-dim"> {note}</span> : null}
      </span>
      <span className="font-mono text-chalk-dim">{formatUsd(amount)}</span>
    </div>
  );
}

export function AccountPanel({ profile, usage, billingConfigured }: { profile: ProfileRow; usage: UsageReport; billingConfigured: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [optIn, setOptIn] = useState(profile.corrections_opt_in);

  async function go(path: string) {
    setBusy(path);
    setError(null);
    const res = await fetch(path, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    setBusy(null);
    if (!res.ok || !body.url) {
      setError(body.error ?? "Something went wrong.");
      return;
    }
    window.location.assign(body.url);
  }

  async function toggleOptIn(next: boolean) {
    setOptIn(next);
    const res = await fetch("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ corrections_opt_in: next }) });
    if (!res.ok) setOptIn(!next);
  }

  const { limits, usage: u, fractions, cost } = usage;
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg">Plan</h2>
          <span className="font-mono text-sm">{PLAN_LABELS[usage.plan]}{usage.plan_status !== "active" ? ` (${usage.plan_status.replace("_", " ")})` : ""}</span>
        </div>
        <p className="text-sm text-chalk-dim">
          {usage.plan === "free"
            ? "Free is a taste: a small library, a few separations, and enough chat to see whether this is for you. Pro raises every cap."
            : "Pro. Manage the subscription, invoices, and the payment method in the billing portal."}
        </p>
        <div className="flex gap-3">
          {usage.plan === "free" ? (
            <button type="button" disabled={!billingConfigured || busy !== null} onClick={() => go("/api/billing/checkout")}
              className="border border-pad px-3 py-1.5 text-sm text-pad hover:bg-pad hover:text-graphite disabled:opacity-50">
              {billingConfigured ? "Upgrade to Pro" : "Upgrades open soon"}
            </button>
          ) : (
            <button type="button" disabled={!billingConfigured || busy !== null} onClick={() => go("/api/billing/portal")}
              className="border border-rule px-3 py-1.5 text-sm hover:border-pad disabled:opacity-50">
              Manage subscription
            </button>
          )}
        </div>
        {error && <p className="text-sm text-pad">{error}</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg">This month</h2>
        <Bar label="Chat turns" used={String(u.chat_turns_month)} limit={String(limits.chat_turns_per_month)} fraction={fractions.chat_turns_per_month} />
        <Bar label="Web searches" used={String(u.web_searches_month)} limit={String(limits.web_searches_per_month)} fraction={fractions.web_searches_per_month} />
        <Bar label="Stem separations" used={String(u.stem_jobs_month)} limit={String(limits.stem_jobs_per_month)} fraction={fractions.stem_jobs_per_month} />
        <Bar label="GPU time" used={formatMinutes(u.gpu_seconds_month)} limit={formatMinutes(limits.gpu_seconds_per_month)} fraction={fractions.gpu_seconds_per_month} />
        <Bar label="Storage" used={formatBytes(u.storage_bytes)} limit={formatBytes(limits.storage_bytes)} fraction={fractions.storage_bytes} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg">Today</h2>
        <p className="text-sm text-chalk-dim">
          Daily caps sit under the monthly ones so one heavy afternoon can&rsquo;t spend the month. Both reset on their own clock: the
          day at midnight UTC, the month on the first.
        </p>
        <Bar label="Chat turns" used={String(u.chat_turns_today)} limit={String(limits.chat_turns_per_day)} fraction={fractions.chat_turns_per_day} />
        <Bar label="Web searches" used={String(u.web_searches_today)} limit={String(limits.web_searches_per_day)} fraction={fractions.web_searches_per_day} />
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg">What this has cost</h2>
          <span className="font-mono text-sm">{formatUsd(cost.total_usd)}</span>
        </div>
        <CostLine label="Chat" amount={cost.chat_usd} note={`${u.chat_turns_month} turns at about ${formatUsd(usage.chat_turn_usd)} each`} />
        <CostLine label="Web searches" amount={cost.web_search_usd} note={`${u.web_searches_month} searches`} />
        <CostLine label="Compute" amount={cost.compute_usd} note={`${formatMinutes(u.gpu_seconds_month)} GPU, ${formatMinutes(u.cpu_seconds_month)} CPU`} />
        <CostLine label="Storage" amount={cost.storage_usd} note={formatBytes(u.storage_bytes)} />
        <p className="text-sm text-chalk-dim">
          Our cost of running this account this month, estimated from published list prices, not a bill and not what you pay. It is
          here so the numbers above mean something.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg">Corrections</h2>
        <label className="flex gap-3 text-sm">
          <input type="checkbox" checked={optIn} onChange={(e) => toggleOptIn(e.target.checked)} className="mt-1" />
          <span>Let my corrections count toward the accuracy set. The harness reads which values I corrected and, through a short-lived link, the audio, on the owner&rsquo;s machine only. Nothing else uses them, and I can turn this off any time.</span>
        </label>
      </section>

      <section className="space-y-2 text-sm text-chalk-dim">
        <p><a href="/legal/terms" className="hover:text-chalk">Terms</a> · <a href="/legal/privacy" className="hover:text-chalk">Privacy</a> · <a href="/legal/dmca" className="hover:text-chalk">Copyright</a></p>
        <p>Signed in as <span className="font-mono">{profile.email ?? "—"}</span>. <a href="/auth/signout" className="hover:text-chalk">Sign out</a></p>
      </section>
    </div>
  );
}
