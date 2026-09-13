# RUNBOOK.md

How to run CrateAI end to end, from a fresh checkout to a deployed app.

## 1. Supabase

Project: `CrateAI` (`ufmpwtjtyzmfucjyuhqo`, us-east-2). Both migrations in
`supabase/migrations/` are applied. To apply future migrations:

- with the Supabase CLI: `supabase link --project-ref ufmpwtjtyzmfucjyuhqo && supabase db push`
- or paste the file into the SQL editor (they are plain SQL, in filename order).

Auth: enable Email (password + magic link) under Authentication → Providers.
Set the site URL and redirect URL to the web app's origin plus `/auth/callback`.

Keys (Project Settings → API): the publishable/anon key goes to the web
client; the service role key goes only to web server routes and to compute.

## 2. Web (Next.js)

```bash
cd web
pnpm install
cp .env.example .env.local   # fill in the values from docs/CONTRACTS.md section 1
pnpm dev                     # http://localhost:3000
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Vercel: project root `web/`, framework Next.js, the same env vars. Set
`COMPUTE_DISPATCH_URL` to the Modal URL from step 3 and share
`COMPUTE_DISPATCH_SECRET` with the Modal secret.

## 3. Compute

### Local runner (no Modal account needed)

```bash
cd analysis
uv sync --extra compute                      # the dev group (pytest, ruff) is installed by default
cp .env.example .env                         # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COMPUTE_DISPATCH_SECRET
uv run --extra compute lockedgroove-server   # http://127.0.0.1:8787  (set COMPUTE_DISPATCH_URL to this in web/.env.local)
```

`uv run` syncs the environment to exactly what it was asked for, so a plain
`uv run ...` removes the `compute` extra again; pass `--extra compute` to
every command that needs the server or Modal.

Development stand-ins when the models aren't installed:
`LOCKEDGROOVE_FAKE_STEMS=1` (band-split "separation"),
`LOCKEDGROOVE_FAKE_EMBEDDER=1` (hash embeddings). Rows written with them are
labeled so they can be re-run with the real models.

### Modal

```bash
cd analysis && uv sync --extra compute
uv run --extra compute modal token new
uv run --extra compute modal secret create lockedgroove \
    SUPABASE_URL=https://ufmpwtjtyzmfucjyuhqo.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=<service role key> \
    COMPUTE_DISPATCH_SECRET=<same value as the web env>
LOCKEDGROOVE_GPU_EXTRAS=1 uv run --extra compute modal deploy lockedgroove/modal_app.py
```

The deploy prints the dispatcher URL (`https://<workspace>--lockedgroove-web.modal.run`).
Check it with `curl $URL/health`. Logs: `uv run --extra compute modal app logs lockedgroove`.
Model weights are cached on the `lockedgroove-model-cache` volume.

## 4. Tests and the harness

```bash
cd analysis && uv run pytest -q                       # everything
uv run ruff check .
python scripts/gen_report_types.py --check            # schema and TS types in sync
python scripts/build_synthetic_dataset.py             # data/synthetic (gitignored)
python scripts/eval_accuracy.py --dataset synthetic   # gated by scripts/gates.json
python scripts/fetch_public_datasets.py --list        # then --dataset all
```

CI (`.github/workflows/ci.yml`) runs the Python suite, ruff, the web
typecheck/lint/test/build, the schema check, and the harness on the synthetic
set whenever `analysis/` or `scripts/` change.

If a test or a harness worker dies with `Segmentation fault` inside
`numba/np/ufunc/gufunc.py` (from `librosa.beat.beat_track`), the shared numba
cache is torn (several fresh processes compiled the same kernel at once).
Delete it and run once single-process:

```bash
find analysis/.venv -name '*.nbi' -delete -o -name '*.nbc' -delete
cd analysis && uv run python -c "import librosa, numpy as np; librosa.beat.beat_track(y=librosa.clicks(times=np.arange(0, 4, 0.5), sr=22050, length=88200), sr=22050)"
```

The harness warms this cache in the parent process before it starts workers,
and records an item as lost instead of hanging if a worker still dies.

## 5. Operations notes

- Backups: enable point-in-time recovery on the Supabase project (plan setting).
- Storage is a single private bucket `audio`; nothing in it is public.
- The compute dispatcher rejects any job whose params carry a URL; there is no
  code path from a URL to a library file.

## 6. Billing, quotas, and takedowns (Phase 10)

- Plan limits are constants in `web/lib/billing/limits.ts`, the only place any
  cap is written down, with the arithmetic that chose each one in that file's
  header and in `web/lib/billing/cost.ts`. Free: 2 GB, 5 stem jobs/month, 30 GPU
  minutes/month, **8 chat turns a day and 40 a month, 5 web searches a day and
  25 a month**. Every conversation-shaped cap is doubled on purpose — the daily
  cap bounds one day's burst, the monthly cap is the financial ceiling, and a
  daily cap on its own cannot bound a monthly bill. Full arithmetic and the Pro
  break-even price: `docs/HANDOFF_launch_readiness.md`.
- Model routing is `web/lib/anthropic/models.ts`: chat turns and the search
  query parser on Sonnet 5, breakdown narration on Opus 5, each with the cost
  of that path written next to it. The chat's system prompt and tool schemas
  are cached (one breakpoint on the last system block, one rolling through the
  tool loop); `web/lib/chat/caching.test.ts` is the standing check.
- Quotas are enforced once, at the dispatch step (`web/lib/compute/dispatch.ts`)
  and at upload prepare; an over-quota job is marked failed with the reason.
  Chat and web search check at the route, before the model is called.
- Usage: `usage_events` is the one table that answers "what has this account
  cost me". Compute writes a row per finished job (CPU or GPU seconds, plus
  `stem_job`); the web app writes one per chat turn and one per batch of web
  searches (`web/lib/billing/meter.ts`, service role). Storage is summed from
  `files.size_bytes`. `/account` shows usage against the limits and an estimate
  of what the account has cost, from the list prices in `web/lib/billing/cost.ts`.
- If `SUPABASE_SERVICE_ROLE_KEY` is missing, metering stops (one warning per
  process in the server log) and the chat-turn cap falls back to counting
  `messages`. The preflight in section 7 fails on a missing key for this reason.
- Stripe: create a recurring price for Pro, set `STRIPE_SECRET_KEY`,
  `STRIPE_PRICE_ID`, `NEXT_PUBLIC_APP_URL`, and a webhook endpoint at
  `POST {app}/api/billing/webhook` for `checkout.session.completed`,
  `customer.subscription.created|updated|deleted`; put its signing secret in
  `STRIPE_WEBHOOK_SECRET`. Profiles carry the plan; the webhook updates them.
- Takedowns: `/legal/dmca` posts to `POST /api/takedown` (rate limited, service
  role). Review rows in the `takedowns` table (SQL editor or the Supabase
  dashboard); set `status` as you act (`reviewing`, `removed`, `counter_noticed`,
  `restored`, `rejected`). Removal is manual: delete the file through the app
  as the owner, or with the service role, and email both parties. Register the
  agent at dmca.copyright.gov and fill the `TODO(owner)` lines in
  `web/app/legal/*`.
- Health: `GET /api/health` reports the database, compute, and whether the
  Anthropic key is set.
- Rate limits: `web/lib/ratelimit.ts` is a per-instance token bucket for public
  routes; durable limits are the quotas above.

## 7. Before you open signups

Run the preflight. It is the last step, after everything above is deployed and
before the first stranger can create an account.

```bash
node scripts/preflight.mjs              # the full check, against the real services
node scripts/preflight.mjs --offline    # shapes and files only, no network
node scripts/preflight.mjs --json       # the same result, machine readable
```

It reads `web/.env.local` (then `.env.production.local`, then `.env`), with the
process environment winning, so in CI or on the server just export the
variables. Run it from the repository root; Node 22 is the only requirement.

What it checks, in order:

| Group | What has to be true |
|---|---|
| environment | Every variable set and shaped right: the two Supabase keys are different keys, `ANTHROPIC_API_KEY` looks like one, `COMPUTE_DISPATCH_SECRET` is not still `change-me`, `STRIPE_PRICE_ID` is a price and not a product, the search provider's own key is present. |
| legal | `web/app/legal/{terms,privacy,dmca}` all exist and no `TODO(owner)` is left in any of them. |
| supabase | The project answers, every table and every callable function the migrations in `supabase/migrations/` create is present (the list is read out of the SQL, so it maintains itself), and the `audio` bucket exists and is **private**. |
| compute | The dispatcher's `/health` answers, and it is not a fake or local runner. |
| anthropic | The key is accepted, and every model id in `web/lib/anthropic/{models,narrate}.ts` is visible to this workspace. |
| stripe | The key is accepted and `STRIPE_PRICE_ID` is an active recurring price. |

Three properties it keeps, so it can be run without thinking about it:

- **It never prints a secret.** Only the variable's name and a verdict; never
  a value, not even a prefix.
- **It only reads.** No writes, no charges, no tokens spent. Run it against
  production as often as you like.
- **A FAIL is something that breaks a real user's first session**; a WARN is
  something you can launch with but should know about (a test-mode Stripe key,
  a localhost app URL, a local compute runner). Only a FAIL sets the exit code,
  so `node scripts/preflight.mjs && echo ready` is a safe gate.

Fix every FAIL, read every WARN, then open signups.
