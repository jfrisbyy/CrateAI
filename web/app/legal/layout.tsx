import Link from "next/link";
import type { ReactNode } from "react";

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-graphite text-chalk">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <nav className="mb-10 flex items-center gap-6 text-sm text-chalk-dim">
          <Link href="/" className="text-chalk hover:text-pad">CrateAI</Link>
          <Link href="/legal/terms" className="hover:text-chalk">Terms</Link>
          <Link href="/legal/privacy" className="hover:text-chalk">Privacy</Link>
          <Link href="/legal/dmca" className="hover:text-chalk">Copyright</Link>
        </nav>
        <article className="prose-invert space-y-4 text-[15px] leading-7 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:mb-6 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-medium [&_li]:ml-5 [&_li]:list-disc">
          {children}
        </article>
      </div>
    </div>
  );
}
