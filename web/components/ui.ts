// Shared class presets. Rules, not boxes: controls are flat, 2–3px radius,
// separated by rule-colored borders. The only filled control is the one
// primary action per view, in pad amber.

export const btn =
  "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm border border-rule text-sm text-chalk " +
  "hover:border-rule-strong hover:bg-slate disabled:opacity-40 disabled:hover:border-rule disabled:hover:bg-transparent " +
  "whitespace-nowrap select-none";

export const btnPrimary =
  "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm bg-pad text-slate font-medium text-sm " +
  "hover:bg-[#f5b654] disabled:opacity-40 disabled:hover:bg-pad whitespace-nowrap select-none";

export const btnQuiet =
  "inline-flex items-center gap-1 h-6 px-1.5 rounded-sm text-sm text-chalk-dim hover:text-chalk hover:bg-slate " +
  "disabled:opacity-40 whitespace-nowrap select-none";

export const input =
  "h-7 px-2 rounded-sm bg-slate border border-rule text-sm text-chalk placeholder:text-chalk-faint " +
  "focus:border-rule-strong focus:outline-none focus-visible:outline-2";

export const select =
  "h-7 pl-2 pr-6 rounded-sm bg-slate border border-rule text-sm text-chalk appearance-none " +
  "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22 viewBox=%220 0 10 10%22><path d=%22M2 3.5l3 3 3-3%22 fill=%22none%22 stroke=%22%239b988f%22 stroke-width=%221.2%22/></svg>')] " +
  "bg-no-repeat bg-[right_6px_center]";

export const mono = "font-mono tabular-nums";

export const label = "text-xs text-chalk-dim";

/** A segmented control: the active item carries the amber underline. */
export const segment = "inline-flex items-stretch border border-rule rounded-sm overflow-hidden";
export const segmentItem =
  "h-7 px-2 text-sm text-chalk-dim hover:text-chalk border-r border-rule last:border-r-0 " +
  "data-[active=true]:text-chalk data-[active=true]:bg-slate data-[active=true]:shadow-[inset_0_-2px_0_0_var(--color-pad)]";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
