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
uv sync --extra compute --extra dev
cp .env.example .env         # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COMPUTE_DISPATCH_SECRET
uv run lockedgroove-server   # http://127.0.0.1:8787  (set COMPUTE_DISPATCH_URL to this in web/.env.local)
```

Development stand-ins when the models aren't installed:
`LOCKEDGROOVE_FAKE_STEMS=1` (band-split "separation"),
`LOCKEDGROOVE_FAKE_EMBEDDER=1` (hash embeddings). Rows written with them are
labeled so they can be re-run with the real models.

### Modal

```bash
cd analysis && uv sync --extra compute
uv run modal token new
uv run modal secret create lockedgroove \
    SUPABASE_URL=https://ufmpwtjtyzmfucjyuhqo.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=<service role key> \
    COMPUTE_DISPATCH_SECRET=<same value as the web env>
LOCKEDGROOVE_GPU_EXTRAS=1 uv run modal deploy lockedgroove/modal_app.py
```

The deploy prints the dispatcher URL (`https://<workspace>--lockedgroove-web.modal.run`).
Check it with `curl $URL/health`. Logs: `uv run modal app logs lockedgroove`.
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

## 5. Operations notes

- Backups: enable point-in-time recovery on the Supabase project (plan setting).
- Storage is a single private bucket `audio`; nothing in it is public.
- The compute dispatcher rejects any job whose params carry a URL; there is no
  code path from a URL to a library file.
