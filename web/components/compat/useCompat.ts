"use client";

// The Fits-with panel's state: the caller's search settings, the matches for the
// open file, and the one-click "make this a layer lane".

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/api/client";
import { layersApi } from "@/lib/api/layers";
import { compatApi, type CompatResponse } from "@/lib/compat/client";
import { CHARACTER_SHIFT, MAX_SHIFT, TRANSPARENT_MAX, USABLE_MAX } from "@/lib/compat/theory";

/** The two dials a producer actually turns: how far to stretch, how far to pitch. */
export const STRETCH_CHOICES = [
  { id: "transparent", label: "Transparent", tolerance: TRANSPARENT_MAX, title: "Only stretches inside 6 %, which nobody hears" },
  { id: "usable", label: "Usable", tolerance: USABLE_MAX, title: "Out to 14 %, where a stretch starts to show on transients" },
] as const;

export const SHIFT_CHOICES = [
  { id: "none", label: "None", semitones: 0, title: "Only keys that already work together" },
  { id: "in-character", label: "Up to 2", semitones: CHARACTER_SHIFT, title: "Pitch a file up to 2 semitones, which keeps its character" },
  { id: "any", label: "Any", semitones: MAX_SHIFT, title: "Any pitch shift that reaches a relationship; past 2 semitones is flagged" },
] as const;

export type StretchChoice = (typeof STRETCH_CHOICES)[number]["id"];
export type ShiftChoice = (typeof SHIFT_CHOICES)[number]["id"];

export interface CompatSettings {
  stretch: StretchChoice;
  shift: ShiftChoice;
  includeKeyless: boolean;
}

export const DEFAULT_SETTINGS: CompatSettings = { stretch: "usable", shift: "in-character", includeKeyless: true };

export function toleranceOf(settings: CompatSettings): number {
  return (STRETCH_CHOICES.find((c) => c.id === settings.stretch) ?? STRETCH_CHOICES[1]).tolerance;
}

export function semitonesOf(settings: CompatSettings): number {
  return (SHIFT_CHOICES.find((c) => c.id === settings.shift) ?? SHIFT_CHOICES[1]).semitones;
}

export interface CompatState {
  settings: CompatSettings;
  setSettings: (next: CompatSettings) => void;
  data: CompatResponse | null;
  loading: boolean;
  error: string | null;
  actionError: string | null;
  clearActionError: () => void;
  /** the file id whose layer is being created, for the button's pending state */
  layering: string | null;
  reload: () => Promise<void>;
  layerWith: (fileId: string) => Promise<void>;
}

export function useCompat(fileId: string, ready: boolean, onLayered: () => void): CompatState {
  const [settings, setSettings] = useState<CompatSettings>(DEFAULT_SETTINGS);
  const [data, setData] = useState<CompatResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [layering, setLayering] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    if (!ready) {
      setData(null);
      return;
    }
    const ticket = ++request.current;
    setLoading(true);
    try {
      const res = await compatApi.find({
        file_id: fileId,
        stretch_tolerance: toleranceOf(settings),
        max_semitones: semitonesOf(settings),
        include_keyless: settings.includeKeyless,
        limit: 30,
      });
      if (ticket !== request.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (ticket !== request.current) return;
      setError(errorMessage(err));
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }, [fileId, ready, settings]);

  useEffect(() => {
    void load();
  }, [load]);

  const layerWith = useCallback(
    async (otherId: string) => {
      setLayering(otherId);
      try {
        await layersApi.create({ file_ids: [fileId, otherId] });
        setActionError(null);
        onLayered();
      } catch (err) {
        setActionError(errorMessage(err));
      } finally {
        setLayering(null);
      }
    },
    [fileId, onLayered],
  );

  return {
    settings,
    setSettings,
    data,
    loading,
    error,
    actionError,
    clearActionError: () => setActionError(null),
    layering,
    reload: load,
    layerWith,
  };
}
