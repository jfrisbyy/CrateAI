// The one thing a producer has to learn before they spend a minute here: it
// needs their audio, and it will not invent any. Stated early, plainly, and as
// the reason the measurements are worth anything rather than as an apology.
//
// It appears on the sign-in page and on the empty crate, which are the two
// screens somebody expecting a beat generator will see first.

export function NotAGenerator({ short = false }: { short?: boolean }) {
  return (
    <div className="border-l-2 border-rule pl-3">
      <p className="text-sm">It works on records you bring. There is no generator in here.</p>
      <p className="mt-1 text-sm text-chalk-dim">
        {short ? (
          <>
            A description of a beat gets you nothing; every result is cut, stretched, separated or re-voiced from a file
            you uploaded. That constraint is the reason the numbers can be trusted — they were measured off your audio.
          </>
        ) : (
          <>
            Type &quot;make me a boom-bap beat&quot; and nothing comes back, by design. Everything it hands you is cut,
            stretched, separated, layered or re-voiced from a file you brought. That constraint is also why the numbers
            are worth reading: each one was measured off your audio and carries the confidence it was measured with,
            rather than being a language model&apos;s guess at what a record probably is.
          </>
        )}
      </p>
    </div>
  );
}
