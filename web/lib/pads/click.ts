// The count-in click: a short sine blip scheduled on the audio clock. The
// downbeat is higher and louder so the "one" is unmistakable.

export const CLICK_LENGTH_S = 0.04;

export function scheduleClick(ctx: AudioContext, at: number, accent: boolean, gainLevel = 0.5): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = accent ? 1200 : 800;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(accent ? gainLevel : gainLevel * 0.6, at + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + CLICK_LENGTH_S);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + CLICK_LENGTH_S + 0.01);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}
