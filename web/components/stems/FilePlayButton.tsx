"use client";

// Audition a library file (a stem) through an audio element on its signed
// URL. One file at a time: starting one stops the other.

import { useEffect, useRef, useState } from "react";
import { cx } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";

let current: { id: string; audio: HTMLAudioElement; stop: () => void } | null = null;

export function FilePlayButton({
  fileId,
  label,
  disabled,
  onStart,
  onError,
}: {
  fileId: string;
  label: string;
  disabled?: boolean;
  /** called before playback starts (pause the transport, stop a loop) */
  onStart?: () => void;
  onError?: (message: string) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      if (current?.id === fileId && current.audio === audioRef.current) current.stop();
    };
  }, [fileId]);

  const stop = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (current?.audio === audio) current = null;
    setPlaying(false);
  };

  const start = async () => {
    setLoading(true);
    try {
      const res = await api.files.url(fileId);
      current?.stop();
      onStart?.();
      const audio = new Audio(res.url);
      audio.preload = "auto";
      audioRef.current = audio;
      audio.onended = stop;
      audio.onerror = () => {
        onError?.("Could not play this file.");
        stop();
      };
      current = { id: fileId, audio, stop };
      await audio.play();
      setPlaying(true);
    } catch (err) {
      onError?.(errorMessage(err));
      stop();
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      className={cx("h-7 w-7 rounded-sm border flex items-center justify-center", playing ? "border-pad text-pad" : "border-rule text-chalk hover:border-rule-strong disabled:opacity-40")}
      disabled={disabled || loading}
      onClick={() => (playing ? stop() : void start())}
      aria-label={playing ? `Stop ${label}` : `Play ${label}`}
      title={playing ? "Stop" : loading ? "Fetching" : "Play"}
    >
      <span aria-hidden className="font-mono text-xs">
        {playing ? "■" : "▶"}
      </span>
    </button>
  );
}
