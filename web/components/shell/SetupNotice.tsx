// Rendered instead of the workspace when the Supabase variables are missing,
// so a build or a first run without .env.local shows what to do rather than
// crashing.

export function SetupNotice() {
  return (
    <main className="min-h-full flex items-start justify-center px-4 py-[12vh]">
      <div className="max-w-[480px]">
        <h1 className="text-lg font-semibold">CrateAI needs its Supabase keys</h1>
        <ol className="mt-4 list-decimal pl-5 text-sm text-chalk-dim flex flex-col gap-2">
          <li>
            Copy <span className="font-mono text-chalk">web/.env.example</span> to{" "}
            <span className="font-mono text-chalk">web/.env.local</span>.
          </li>
          <li>
            Fill in <span className="font-mono text-chalk">NEXT_PUBLIC_SUPABASE_URL</span> and{" "}
            <span className="font-mono text-chalk">NEXT_PUBLIC_SUPABASE_ANON_KEY</span> from the Supabase dashboard.
          </li>
          <li>Restart the dev server.</li>
        </ol>
      </div>
    </main>
  );
}
