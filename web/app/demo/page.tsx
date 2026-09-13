// The clickable prototype (docs/HANDOFF_prototype.md).
//
// Build order step 7 in docs/PRODUCT_DIRECTION.md: "the layout running end to
// end with real interaction, so the owner can feel it rather than read about
// it." It signs nobody in, holds no keys, touches no table and reaches no
// network, so it renders identically on a laptop and on a free Vercel tier
// with an empty environment.

import type { Metadata } from "next";
import { DemoBoot } from "./DemoBoot";

export const metadata: Metadata = {
  title: "Prototype",
  description: "Cratebox running end to end on synthesised audio: the chat, the candidate rack, the song timeline and one transport.",
};

export default function DemoPage() {
  return <DemoBoot />;
}
