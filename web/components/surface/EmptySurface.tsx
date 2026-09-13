// The panel with nothing on it. An invitation to act, not a mood.
//
// The first screen a new producer meets is not this one: at "/" the router
// renders nothing into the panel and the chat column holds the first run
// (components/onboarding/FirstRun.tsx). This is what the panel says once
// something has been on it and was closed.

export function EmptySurface() {
  return (
    <div className="flex-1 flex items-start justify-center pt-[14vh] px-6">
      <div className="max-w-[440px]">
        <h1 className="text-xl font-semibold tracking-tight leading-tight">Pick a file to open it here.</h1>
        <p className="mt-3 text-sm text-chalk-dim">
          The waveform, the beat grid, the vitals with their confidence, and the loops live on this surface. Drop audio
          in the library to add more; press <span className="font-mono text-chalk">?</span> for the keys.
        </p>
      </div>
    </div>
  );
}
