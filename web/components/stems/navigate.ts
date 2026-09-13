// Open a library file on the surface and, once its surface has mounted,
// switch it to a tab. The tab switch is the `crateai:tab` window event
// SurfaceTabs listens for (TAB_EVENT there; spelled out here so this module
// does not import the tab registry and create a cycle).

const TAB_EVENT = "crateai:tab";
const SETTLE_MS = 60;
const GIVE_UP_MS = 4000;

export type SurfaceTab = "loops" | "stems" | "chops" | "layers" | "revoice" | "breakdown" | "compare" | "report";

export function openFile(router: { push: (href: string) => void }, fileId: string, tab: SurfaceTab | null = null): void {
  const href = `/f/${fileId}`;
  router.push(href);
  if (!tab) return;
  const started = performance.now();
  const poll = () => {
    if (window.location.pathname === href) {
      // the new surface's tab listener registers in an effect after commit
      window.setTimeout(() => window.dispatchEvent(new CustomEvent<SurfaceTab>(TAB_EVENT, { detail: tab })), SETTLE_MS);
      return;
    }
    if (performance.now() - started < GIVE_UP_MS) requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}
