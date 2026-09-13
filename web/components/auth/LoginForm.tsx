"use client";

// Email + password sign in / account creation, and a magic-link option.
// One column, no marketing. Errors say what happened and what to do.

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { btn, btnPrimary, cx, input, label } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

type Mode = "signin" | "signup" | "magic";

export function LoginForm({ initialError, next, configured }: { initialError: string | null; next: string; configured: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);

  const redirectTo = () => `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const supabase = createClient();
      if (mode === "magic") {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: redirectTo() },
        });
        if (error) throw error;
        setNotice(`A sign-in link is on its way to ${email}. Open it on this device.`);
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: redirectTo() },
        });
        if (error) throw error;
        if (data.session) {
          router.push(next);
          router.refresh();
        } else {
          setNotice(`Check ${email} for a confirmation link, then sign in.`);
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push(next);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight">CrateAI</h1>
      <p className="mt-1 text-sm text-chalk-dim">Your sample library, and it knows what&apos;s in everything.</p>

      {!configured && (
        <p className="mt-6 text-sm border-l-2 border-pad pl-3 text-chalk-dim">
          This deployment has no Supabase keys. Copy <span className="font-mono">web/.env.example</span> to{" "}
          <span className="font-mono">web/.env.local</span> and fill in the URL and anon key.
        </p>
      )}

      <div className="mt-8 flex border-b border-rule text-sm">
        {(
          [
            ["signin", "Sign in"],
            ["signup", "Create account"],
            ["magic", "Email me a link"],
          ] as const
        ).map(([id, text]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setMode(id);
              setError(null);
              setNotice(null);
            }}
            className={cx(
              "h-8 px-3 -mb-px border-b-2",
              mode === id ? "border-pad text-chalk" : "border-transparent text-chalk-dim hover:text-chalk",
            )}
          >
            {text}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="email" className={label}>
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={cx(input, "w-full")}
          />
        </div>
        {mode !== "magic" && (
          <div className="flex flex-col gap-1">
            <label htmlFor="password" className={label}>
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={cx(input, "w-full")}
            />
          </div>
        )}
        <div className="mt-2 flex items-center gap-3">
          <button type="submit" disabled={busy || !configured} className={btnPrimary}>
            {mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send link"}
          </button>
          {mode === "signin" && (
            <button type="button" onClick={() => setMode("magic")} className={btn}>
              Forgot the password? Email a link
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm border-l-2 border-pad pl-3 text-chalk">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm text-chalk-dim">
            {notice}
          </p>
        )}
      </form>
    </div>
  );
}
