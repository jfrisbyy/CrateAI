# BACKLOG.md

Deferred items and known gaps, by phase. Items move to the phase plan when
they're scheduled and out of here when they ship.

## Phase 0
- [ ] Google OAuth provider (needs dashboard setup; code is a one-line addition in `web/app/(auth)/login`).
- [ ] Folder upload on Safari (no `webkitdirectory` support for drag-drop; the picker works).
- [ ] Files longer than 20 minutes: vitals only, note in the header.

## Phase 1
- [ ] Loop preview with the tail crossfade when the loop ends at end of file (falls back to self-crossfade).

## Phase 2
- [ ] BeatNet weights are GPL-licensed; the interface is in place, the backend ships only if the license is acceptable for the hosted product (see OPEN_QUESTIONS H.27 for the same class of question).
- [ ] Meter detection (PROPOSALS).

## Phase 4
- [ ] Layered kick detection needs a second-spectrum clustering pass; currently reports `null`.

## Phase 5
- [ ] Web result cache eviction (24 h TTL is set; there is no size cap yet).

## Phase 7
- [ ] Neural re-voice evaluation write-up.

## Phase 10
- [ ] Backups: point-in-time recovery is a Supabase plan setting, not code; documented in the runbook.
