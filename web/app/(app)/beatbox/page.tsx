// Beatbox -> MIDI (BUILD_PACKET section 15): enrollment and transcription,
// inside the workspace so the library and chat stay in reach.

import type { Metadata } from "next";
import { BeatboxPage } from "@/components/beatbox/BeatboxPage";

export const metadata: Metadata = { title: "Beatbox" };

export default function Page() {
  return <BeatboxPage />;
}
