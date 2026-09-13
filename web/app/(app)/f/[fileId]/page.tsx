// The working surface for one file. Selection lives in the URL so a file
// can be linked, reloaded, and opened from the chat later.

import { Surface } from "@/components/surface/Surface";

export default async function FilePage({ params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  return <Surface fileId={fileId} />;
}
