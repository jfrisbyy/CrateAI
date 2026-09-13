// The workspace shell: one screen, three panes. Server-side: read the user,
// load the library once, hand it to the client store; Realtime keeps it live.

import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { SetupNotice } from "@/components/shell/SetupNotice";
import { Workspace } from "@/components/shell/Workspace";
import { hasPublicEnv } from "@/lib/env";
import { LibraryProvider } from "@/lib/state/LibraryProvider";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  if (!hasPublicEnv()) return <SetupNotice />;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [files, jobs] = await Promise.all([
    supabase.from("files").select("*").order("created_at", { ascending: false }).limit(1000),
    supabase.from("jobs").select("*").order("created_at", { ascending: false }).limit(300),
  ]);

  return (
    <LibraryProvider userId={user.id} userEmail={user.email ?? null} initialFiles={files.data ?? []} initialJobs={jobs.data ?? []}>
      <Workspace>{children}</Workspace>
    </LibraryProvider>
  );
}
