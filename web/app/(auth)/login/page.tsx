import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";
import { NotAGenerator } from "@/components/onboarding/NotAGenerator";
import { hasPublicEnv } from "@/lib/env";
import { planSentence, UNMETERED_NOTE } from "@/lib/onboarding/limits";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = params.next && params.next.startsWith("/") && !params.next.startsWith("//") ? params.next : "/";
  return (
    <>
      <LoginForm initialError={params.error ?? null} next={next} configured={hasPublicEnv()} />
      {/* The two things worth knowing before an account exists: what it will
          not do, and what the free tier is. A producer who wanted a generator
          should find out here, in thirty seconds, rather than after uploading
          a crate. */}
      <div className="mt-10 flex flex-col gap-3">
        <NotAGenerator short />
        <p className="text-xs text-chalk-dim">
          {planSentence("free")} {UNMETERED_NOTE}
        </p>
      </div>
    </>
  );
}
