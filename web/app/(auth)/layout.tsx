import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-full flex items-start justify-center px-4 py-[12vh]">
      <div className="w-full max-w-[360px]">{children}</div>
    </main>
  );
}
