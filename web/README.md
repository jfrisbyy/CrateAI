# CrateAI web

The Next.js app: auth, the three-pane workspace (library, working surface,
chat), the upload flow, and the API routes in `docs/CONTRACTS.md` section 7.

## Setup

```sh
cd web
pnpm install
cp .env.example .env.local     # fill in the Supabase anon key (and the rest as you need them)
pnpm dev                        # http://localhost:3000
```

`NEXT_PUBLIC_SUPABASE_URL` is already set to the project in `.env.example`.
The anon key and the service-role key come from the Supabase dashboard
(Project settings, API). The schema is applied with the Supabase CLI from
`supabase/migrations/`.

Without `COMPUTE_DISPATCH_URL` everything works except analysis: uploads land
in the library with status `queued` and the UI says "compute not configured".

## Running compute locally

The local runner exposes the same `/dispatch` route as Modal
(`docs/CONTRACTS.md` section 9):

```sh
cd analysis
cp .env.example .env            # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COMPUTE_DISPATCH_SECRET
uv run lockedgroove-server      # http://127.0.0.1:8787
```

Then in `web/.env.local`:

```
COMPUTE_DISPATCH_URL=http://127.0.0.1:8787
COMPUTE_DISPATCH_SECRET=<the same secret as analysis/.env>
```

Jobs are dispatched by id; the runner reads the `jobs` row with the service
role, runs it, and writes results back. Realtime pushes the row changes to the
browser.

## Scripts

| Command          | Does                                                     |
| ---------------- | -------------------------------------------------------- |
| `pnpm dev`       | dev server                                               |
| `pnpm build`     | production build (works with no env; env is read lazily) |
| `pnpm start`     | serve the build                                          |
| `pnpm lint`      | ESLint (flat config, `eslint-config-next`)               |
| `pnpm typecheck` | `tsc --noEmit`                                           |
| `pnpm test`      | vitest: `lib/**/*.test.ts`, `components/**/*.test.tsx`   |

## Layout

```
app/
  (auth)/login            sign in, create account, magic link
  auth/callback, signout  session exchange and sign-out
  (app)/                  the workspace shell (server layout loads the library)
    page.tsx              nothing open
    f/[fileId]/page.tsx   the working surface for one file
  api/                    routes per CONTRACTS section 7
components/
  shell/    top bar, panes, keymap sheet, search state
  library/  upload zone and queue, grouped file list, search box
  surface/  header strip, waveform (wavesurfer + grid overlay + regions), tabs
  chat/     conversations, messages, composer
lib/
  supabase/  browser, server, admin (service role), middleware session refresh
  types/     db.ts (hand-written rows), report.ts (generated; do not edit)
  report/    effective() port, hedge bands, edit merge, grid snapping
  audio/     streaming SHA-256 (+ worker), decode, loop player, renderLoop
  upload/    folder traversal, tus upload queue
  search/    query parser (Phase 6 hybrid parser seam)
  compute/   job dispatch
  music/     key spelling
  keys/      keyboard map and command bus
  state/     LibraryProvider (files + jobs, Realtime, uploads)
```

## Keyboard

Space play/pause; `[` `]` loop start/end at the cursor; `L` new loop; `D` set
the first downbeat; `,` `.` nudge the selected loop a 16th; 1–8 and Q–I pads;
`?` shows the map.
