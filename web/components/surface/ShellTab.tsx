export function ShellTab({ phase, sentence }: { phase: string; sentence: string }) {
  return (
    <p className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">
      <span className="text-chalk">{phase}.</span> {sentence}
    </p>
  );
}
