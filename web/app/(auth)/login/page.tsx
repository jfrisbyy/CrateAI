import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";
import { hasPublicEnv } from "@/lib/env";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = params.next && params.next.startsWith("/") && !params.next.startsWith("//") ? params.next : "/";
  return <LoginForm initialError={params.error ?? null} next={next} configured={hasPublicEnv()} />;
}
