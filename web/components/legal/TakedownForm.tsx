"use client";

import { useState, type FormEvent } from "react";
import { cx } from "@/components/ui";

const field = "w-full bg-slate border border-rule px-3 py-2 text-sm text-chalk focus:outline-none focus:border-pad";

export function TakedownForm() {
  const [state, setState] = useState<{ status: "idle" | "sending" | "sent" | "error"; message?: string; id?: string }>({ status: "idle" });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const body: Record<string, unknown> = {};
    for (const [k, v] of data.entries()) body[k] = v;
    body.good_faith = data.get("good_faith") === "on";
    body.accuracy_sworn = data.get("accuracy_sworn") === "on";
    if (!body.file_id) delete body.file_id;
    if (!body.claimant_address) delete body.claimant_address;
    setState({ status: "sending" });
    const res = await fetch("/api/takedown", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { error?: string; id?: string };
    if (!res.ok) {
      setState({ status: "error", message: json.error ?? `Could not send the notice (${res.status}).` });
      return;
    }
    setState({ status: "sent", id: json.id });
    form.reset();
  }

  if (state.status === "sent") {
    return (
      <p className="border-l-2 border-pad pl-3 text-sm">
        Notice received. Reference <span className="font-mono">{state.id}</span>. We reply to the email you gave within 2 business days.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <label className="block text-sm">Your name<input name="claimant_name" required minLength={2} className={field} /></label>
      <label className="block text-sm">Email<input name="claimant_email" type="email" required className={field} /></label>
      <label className="block text-sm">Postal address (optional)<input name="claimant_address" className={field} /></label>
      <label className="block text-sm">The work you own<textarea name="work_description" required minLength={10} rows={3} className={field} placeholder="Title, artist, and where it was released" /></label>
      <label className="block text-sm">What infringes and how you found it<textarea name="infringing_description" required minLength={10} rows={3} className={field} placeholder="Describe the material. If you have a CrateAI file id, add it below." /></label>
      <label className="block text-sm">CrateAI file id (optional)<input name="file_id" className={cx(field, "font-mono")} /></label>
      <input name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
      <label className="flex gap-2 text-sm"><input name="good_faith" type="checkbox" required /> I have a good-faith belief that the use is not authorized by the owner, its agent, or the law.</label>
      <label className="flex gap-2 text-sm"><input name="accuracy_sworn" type="checkbox" required /> The information here is accurate, and under penalty of perjury I am the owner or authorized to act for the owner.</label>
      <label className="block text-sm">Signature (type your full name)<input name="signature" required minLength={2} className={field} /></label>
      {state.status === "error" && <p className="text-sm text-pad">{state.message}</p>}
      <button type="submit" disabled={state.status === "sending"} className="border border-pad px-3 py-1.5 text-sm text-pad hover:bg-pad hover:text-graphite disabled:opacity-50">
        {state.status === "sending" ? "Sending" : "Send notice"}
      </button>
    </form>
  );
}
