"use client";

// The rack's data: one ask, fetched from the routes that already answer it.
//
// `/api/compat` answers "what in my crate fits this" and `/api/loops` answers
// "what loops are in this file". Both already return everything a row needs —
// the measurement, its confidence, the file and its peaks — so the rack adds
// no backend of its own. It only turns rows into things you can play.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api/client";
import { compatApi } from "@/lib/compat/client";
import { rackFromCompat, rackFromLoops, rackFromSearch, vitalsOf, type Rack } from "@/lib/session/rack";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { TrackVitals } from "@/lib/compat/theory";
import { onRackRequest, type RackRequest } from "./rackEvents";

export interface RackState {
  rack: Rack | null;
  loading: boolean;
  error: string | null;
  request: RackRequest | null;
  open: (request: RackRequest) => Promise<void>;
  reload: () => Promise<void>;
  clear: () => void;
}

/** `sessionSource` is the file the session is built around, when the rack should fit to it. */
export function useRack(sessionSourceFileId: string | null): RackState {
  const lib = useLibrary();
  const [rack, setRack] = useState<Rack | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<RackRequest | null>(null);
  const ticket = useRef(0);
  const fileById = lib.fileById;

  const open = useCallback(
    async (next: RackRequest) => {
      const mine = ++ticket.current;
      setRequest(next);
      setLoading(true);
      setError(null);
      try {
        const session: TrackVitals | null = sessionSourceFileId ? (fileById(sessionSourceFileId) ? vitalsOf(fileById(sessionSourceFileId)!) : null) : null;
        if (next.source === "search") {
          const res = await api.search({ query: next.query, limit: 30 });
          if (mine !== ticket.current) return;
          setRack(rackFromSearch(next.query, res.results, res.note, res.mode, session));
        } else if (next.source === "compat") {
          const res = await compatApi.find({ file_id: next.fileId, limit: 30 });
          if (mine !== ticket.current) return;
          setRack(rackFromCompat(res));
        } else {
          const file = fileById(next.fileId);
          if (!file) throw new Error("That file is not in your library.");
          const res = await api.loops.list(next.fileId);
          if (mine !== ticket.current) return;
          setRack(rackFromLoops(file, res.loops, session));
        }
      } catch (err) {
        if (mine !== ticket.current) return;
        setError(errorMessage(err));
      } finally {
        if (mine === ticket.current) setLoading(false);
      }
    },
    [fileById, sessionSourceFileId],
  );

  const reload = useCallback(async () => {
    if (request) await open(request);
  }, [open, request]);

  const clear = useCallback(() => {
    ticket.current++;
    setRack(null);
    setRequest(null);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => onRackRequest((next) => void open(next)), [open]);

  return { rack, loading, error, request, open, reload, clear };
}
