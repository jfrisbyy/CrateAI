# HANDOFF_launch_readiness.md

Making the launch financially safe, and making the cost visible instead of a
surprise. Written 2026-09-13 against branch `agent/launch`. Nothing here is
committed, nothing is deployed, and no migration was applied — because none
was needed.

---

## The headline

**A free account that uses every last allowance went from about $172 a month
of our money to about $2.05.** Twenty enthusiastic free users went from about
$3,450 a month to about $41.

Counted the way the cost analysis counted it — one model call per turn, no
tool rounds, which is the optimistic reading — it is $112.50 a month before and
$0.89 after. Both readings are in the arithmetic below; the $172 / $2.05 pair
is the honest one, because a turn that uses tools makes more than one call.

Three things did it, in order of how much they mattered:

| Change | Effect on a metered chat turn |
|---|---|
| The free tier gained a **monthly** ceiling under its daily cap | 1,500 turns/month possible → 40 |
| Chat routed to **Sonnet 5** instead of Opus 5 | $0.1125 → $0.045 a turn |
| The system prompt and tool schemas **cached and verified** | $0.045 → $0.0333 a turn |

The first is the one that mattered most and it is not a price change at all.
A daily cap cannot bound a monthly bill: 50 turns a day is 1,500 turns a month,
and at any per-turn price that is a number nobody chose. Every
conversation-shaped limit now has both.

---

## 1. The tiers, and the arithmetic behind them

Every cap is now a named constant in **`web/lib/billing/limits.ts`**, which is
the only place in the product a quota is written down. `web/lib/chat/limits.ts`
is an alias of it, not a second copy, and a test asserts that
(`FREE_TIER === PLAN_LIMITS.free`). The prices and the per-turn arithmetic are
in **`web/lib/billing/cost.ts`**, and the numbers in this document are
recomputed by `web/lib/billing/cost.test.ts` — if a price moves, a test fails.

### What one chat turn costs

Measured from this repository rather than assumed. `JSON.stringify(CHAT_TOOLS)`
is 16,901 characters over 19 tools and `SYSTEM_PROMPT` is 5,010, which at the
usual ratios is about 6,640 tokens; the constant is rounded to **7,000** with
`web/lib/billing/promptBudget.test.ts` failing if the real thing outgrows it.
The volatile tail — the per-request context block, the replayed history, the
question — is about **3,000**, and a full answer is about **1,000** output.
That is the cost analysis's "10,000 input and 1,000 output", split into the
part that can be cached and the part that cannot.

Two working assumptions, both named in the code so they can be argued with:

- **1.5 model calls per metered turn.** One user message is one metered turn,
  but a turn that uses tools makes one model call per round and the loop allows
  twelve. Most turns are one call; "find the drums in this, separate them, chop
  them" is four.
- **70% cache hit rate.** The 5-minute entry survives inside a session and
  between turns a producer sends back to back; the first call of a session pays
  the write.

| Path | Per model call | Per metered turn |
|---|---:|---:|
| Opus 5, nothing cached — what the free tier was priced against | $0.0750 | **$0.1125** |
| Opus 5, prefix cached (what the code did before this pass) | $0.0556 | $0.0834 |
| Sonnet 5, nothing cached | $0.0300 | $0.0450 |
| **Sonnet 5, prefix cached — the launch path** | **$0.0222** | **$0.0333** |

A warm Sonnet 5 call is $0.0174 and a cold one $0.0335; the blend above is the
70/30 of those.

### The free tier

| Limit | Was | Now | Why |
|---|---:|---:|---|
| Chat turns / day | 50 | **8** | bounds one day's burst at $0.27 |
| Chat turns / month | — | **40** | the real ceiling: 40 × $0.0333 = **$1.33** |
| Web searches / day | 20 | **5** | |
| Web searches / month | — | **25** | 25 × $0.005 = **$0.13** |
| Storage | 2 GB | **2 GB** | 2 × $0.021 = **$0.04** |
| Stem jobs / month | 5 | **5** | inside the GPU cap; 3–5 cents each, once, idempotent |
| GPU minutes / month | 30 | **30** | 1,800 s × $0.000306 = **$0.55** |

**Worst case, everything used: $2.05 a month.** Before: $168.75 of chat +
$3.00 of search + $0.55 of GPU + $0.04 of storage = **$172.34**.

The packet's other free-tier numbers survived unchanged, because the arithmetic
says they were never the problem: storage is four cents and the whole GPU
allowance is fifty-five. The cost analysis was right that the danger is
conversation.

Is 8 a day and 40 a month enough to be a useful free tier? It is a taste, not a
workspace, and that is deliberate: roughly two turns a day, or three real
sessions a month. It is enough to upload a record, hear the loops, run one
separation and decide. It is not enough to work in. That is the trade a
bootstrapped launch has to make, and the number to revisit first when there is
conversion data — every extra free turn per account per month is 3.3 cents of
real money, so going back to 50 a day would cost about $50 a month per
enthusiastic free user.

### The Pro tier

The Pro caps were placeholders that nobody had costed; at 1,000 chat turns a
day they implied about $3,375 a month of our cost per subscriber.

| Limit | Was | Now | Cost at full use |
|---|---:|---:|---:|
| Chat turns / day | 1,000 | **50** | |
| Chat turns / month | — | **400** | $13.34 |
| Web searches / day | 300 | **100** | |
| Web searches / month | — | **600** | $3.00 |
| Storage | 50 GB | **50 GB** | $1.05 |
| Stem jobs / month | 200 | **100** | inside the GPU cap |
| GPU hours / month | 10 | **5** | $5.51 |

**A fully used Pro account costs about $22.90 a month.** So Pro has to be
priced above roughly $23 to be safe even against a subscriber who uses every
allowance, or around $19 at the 40–50% utilisation a subscription business
normally sees. The price itself is still `TODO(owner)` (OPEN_QUESTIONS J.31) —
these caps are what it has to clear. `planCeilingUsd()` in
`web/lib/billing/limits.ts` computes that ceiling from the constants, and its
test fails if the caps drift above what the intended price can carry.

---

## 2. Model routing

`web/lib/anthropic/models.ts` is now the decision, with the per-turn cost of
each path written beside it, not three bare constants.

| Path | Model | Cost | Reason |
|---|---|---:|---|
| Breakdown narration | `claude-opus-5` | ~$0.04 per breakdown | The highest-stakes prose in the product: a full account of how a record was made, which the producer reads *instead of* the numbers. Runs once per breakdown, not once per turn, so it is a rounding error on the bill. Stays. |
| Chat turns | `claude-sonnet-5` | $0.0333 per turn | Routine work: read the report, call the right tool, answer in a paragraph. Every musical claim is already constrained by the grounding contract and by strict tool schemas, so the model is not being trusted to know things, only to route and to phrase. |
| Search query parser | `claude-sonnet-5` | <$0.001 per parse | Structured output against a fixed zod schema, run only when the rules parser left free text behind, and discarded when it does not validate. The schema is the quality gate; there is nothing for an Opus-class model to add. |

The rule, stated once so the next routing decision is easy: **pay Opus-class
rates where the prose is the product, and Sonnet rates where the model's output
is checked by something other than taste.**

What to watch: narration quality is unchanged by definition. Chat quality is
the thing to listen for — specifically whether hedging still tracks confidence
bands and whether multi-step sentences still run end to end without a nudge.
Moving chat back is one line, and it roughly triples the per-turn cost, so the
free tier's monthly cap has to come down with it. That relationship is written
into the comment at the top of `models.ts` so it cannot be done by accident.

Caches are per model, so chat's cached prefix and the narrator's are separate
entries. That costs nothing: they share no bytes.

---

## 3. Prompt caching

### How it is arranged

The cache is a prefix match, and the render order is **tools → system →
messages**. So one breakpoint on the last of the frozen system blocks covers
both the tool schemas and the system prompt: about 7,000 tokens, two thirds of
a turn's input, that never change between requests.

```
tools           CHAT_TOOLS, a static array, deterministic order   ─┐
system[0]       SYSTEM_PROMPT, a frozen template literal          ─┤ cached
                └── cache_control: ephemeral  ←── the breakpoint  ─┘
system[1]       the context block: today's date, the attached      ─┐
                files, the open file's compact report              │ volatile
messages        the replayed history, the producer's question,     │
                the tool results                                   ─┘
```

Everything volatile is already after the breakpoint, and the route now says so
in a comment that names the rule, because the failure mode here is somebody
later interpolating a date or a user id into `SYSTEM_PROMPT` and quietly paying
full price on every request forever.

There is a second, **rolling** breakpoint inside the tool loop
(`web/lib/chat/loop.ts`): the last tool result of each round is marked, and the
previous round's marker is removed. A turn that calls tools re-sends the whole
conversation on every round, so round three reads back what round two wrote
instead of paying full input price for it. It rolls rather than accumulating
because a request may carry at most four breakpoints and a turn may run twelve
rounds; moving a marker invalidates nothing, because the markers are not part
of the cache key.

### How it is verified here

`web/lib/chat/caching.test.ts` drives the real `runToolLoop` against a fake
model that implements the prefix rule — whole blocks, not raw bytes, and a read
lands on any position a previous request wrote. Six assertions:

- a second identical request reports **non-zero `cache_read_input_tokens`**,
  and it is the whole tools-plus-system prefix, not a scrap;
- a request that changes only the volatile block still hits (the property the
  ordering exists for);
- appending one sentence to the system prompt **misses** — so the test can
  actually fail;
- reordering the tool list misses, because tools render first;
- a three-round tool loop's reads grow round over round;
- a twelve-round turn never sends more than four breakpoints (it sends two).

### How to confirm it live

The fake proves the request is shaped right. It cannot prove the API agrees.
On the first real session:

1. Send two turns in the same conversation, less than five minutes apart, with
   no code deploy in between (a deploy that changes `SYSTEM_PROMPT` or
   `CHAT_TOOLS` starts a new prefix).
2. Log `message.usage` from `stream.finalMessage()` in
   `web/app/api/chat/route.ts` — `cache_creation_input_tokens`,
   `cache_read_input_tokens` and `input_tokens`.
3. The healthy shape is: **first turn** writes ~7,000 and reads 0; **second
   turn** reads ~7,000 and writes only the delta; `input_tokens` is just the
   tail after the last breakpoint, in the low thousands.
4. If the second turn reads 0, something in the prefix moved. Diff the two
   request bodies with the `cache_control` markers stripped; the first
   difference inside the overlapping region is the invalidator. The usual
   suspects are a date or an id interpolated into the system prompt, and a tool
   list that stopped being deterministic.

Two things worth knowing when reading those numbers: `input_tokens` is the
uncached remainder only, so the real prompt size is the sum of all three; and
caches are per workspace and per model, so traffic split across workspaces
writes and reads separate entries.

**This is worth a standing check, not a one-time look.** The expensive failure
is silent: requests keep succeeding, the bill is just higher. The unit test
guards the request shape; the `usage` numbers are the only ground truth that
the cache is actually being read.

---

## 4. What the usage page shows now

`usage_events` is now the one table that answers "what has this account cost
me". Compute already metered every finished job into it; the gap recorded in
BACKLOG was the chat side, which counted by re-reading `messages` and the tool
calls recorded on assistant rows. That meant a direct `POST /api/web/search`
cost nothing, and a turn that spent four searches inside one `identify_context`
call was invisible until it was written down.

Closed:

- `web/lib/billing/meter.ts` writes `usage_events` rows with the service role,
  best effort — it never fails the request it is attached to, and it says so
  once per process in the server log when it cannot write.
- `/api/chat` meters one `chat_turn` the moment a turn is accepted, before the
  model is called, so a turn that dies mid-stream still counts. It meters the
  searches the turn actually ran when the turn finishes, read back off the
  recorded tool calls so fanned-out searches are counted correctly.
- `/api/web/search` meters every search it serves.
- Both caps are read back through `usage_summary(p_since)` — the same function
  compute's metering has always fed — called twice, once since the start of the
  month and once since the start of the day.
- `messages` survives as a **floor** under the metered chat-turn count, so if
  the service role is missing the cap still bites and the number shown can
  never be lower than the conversation itself proves.

**No migration was needed.** `usage_events.kind` already allowed `chat_turn`
and `web_search`, the index on `(user_id, kind, created_at desc)` already
exists, and `usage_summary` already takes the window as an argument, so the
daily counts are the same function with a different `p_since`. There is no new
`.sql` file in this branch.

`/api/usage` and `/account` now show:

- **This month** — chat turns, web searches, stem separations, GPU time and
  storage, each against its cap.
- **Today** — chat turns and web searches against the daily burst caps, with a
  line saying why both exist.
- **What this has cost** — chat, web searches, compute and storage as dollars,
  with the per-turn price shown next to the turn count, and a total. It is
  labelled as our estimated cost from published list prices, not a bill and not
  what the user pays. Stem jobs are deliberately not a line: a separation's real
  cost is its GPU seconds, which are already counted, and counting both would
  double-count.

A quota check is now plan-aware, which fixes a real bug: `/api/chat` and
`/api/web/search` applied the free-tier constants to every caller, including
Pro subscribers.

---

## 5. The preflight

`scripts/preflight.mjs`, wired into `docs/RUNBOOK.md` as section 7, the step
before opening signups.

```bash
node scripts/preflight.mjs              # the full check
node scripts/preflight.mjs --offline    # shapes and files only
node scripts/preflight.mjs --json       # machine readable
```

Node 22, no dependencies, run from the repository root. It reads
`web/.env.local`, then `.env.production.local`, then `.env`, with the process
environment winning.

It checks environment variables for presence *and shape* (the two Supabase keys
are different keys; `COMPUTE_DISPATCH_SECRET` is not still `change-me`;
`STRIPE_PRICE_ID` is a price and not a product; the selected search provider's
own key is present), the legal pages for leftover `TODO(owner)`, the Supabase
project for every table and callable function the migrations create — the list
is read out of the SQL files, so it maintains itself — and that the `audio`
bucket exists and is **private**, the compute dispatcher's `/health`, the
Anthropic key plus whether this workspace can see every model id the app routes
to, and that `STRIPE_PRICE_ID` is an active recurring price.

Three properties it keeps:

- **It never prints a secret.** Only the variable's name and a verdict; never a
  value, not even a prefix.
- **It only reads.** No writes, no charges, no tokens. Safe against production,
  repeatedly.
- **FAIL means a real user's first session breaks; WARN means know about it.**
  Only FAIL sets the exit code, so `node scripts/preflight.mjs && echo ready`
  is a safe gate.

---

## 6. What the owner must do before opening signups

In order. Run the preflight after each one and watch the list shrink.

1. **Fill the legal placeholders.** `web/app/legal/terms`, `privacy` and `dmca`
   still contain four `TODO(owner)` markers between them: the legal entity name,
   the address, and the DMCA agent's contact. Register the agent at
   dmca.copyright.gov first — the registration gives you the contact details the
   pages need. The preflight fails until all four are gone.
2. **Set the Pro price.** The caps put a fully used Pro account at about $22.90
   a month of our cost. Price it at $19 if you accept that a maximal subscriber
   is break-even-to-slightly-negative and the average one is profitable; price
   it at $25 if you want it safe at 100% utilisation. Then create the recurring
   price in Stripe and set `STRIPE_PRICE_ID`.
3. **Set every environment variable in production** (Vercel and the Modal
   secret), including `SUPABASE_SERVICE_ROLE_KEY` — without it nothing meters
   and the cost page reads low.
4. **Deploy compute to Modal and point `COMPUTE_DISPATCH_URL` at it.** The
   preflight warns if the dispatcher reports itself as a fake or local runner,
   because the separation is the irreversible step and a band-split stand-in
   throws away the air that PRODUCT_DIRECTION says is the product.
5. **Turn on point-in-time recovery** on the Supabase project. It is a plan
   setting, not code, and the preflight cannot see it.
6. **Run `node scripts/preflight.mjs`.** Fix every FAIL. Read every WARN.
7. **Take one real session yourself, with the API key live, and read the
   `usage` numbers on the second turn** (section 3). This is the only way to
   know the cache is actually being read, and it is the difference between
   $0.033 and $0.045 a turn.
8. **Then open signups**, and watch `/account` for the first week. If a free
   account's monthly cost line is running above about $2, something in this
   arithmetic is wrong and the caps should come down before the caps are
   raised.

---

## 7. Where everything lives

| File | What it is now |
|---|---|
| `web/lib/billing/limits.ts` | Every cap in the product, with the arithmetic that chose it in the header. `planCeilingUsd()` computes a plan's worst case from the constants. |
| `web/lib/billing/cost.ts` | Model prices, cache multipliers, the measured shape of a chat turn, and every cost function. One place to change when a price moves. |
| `web/lib/billing/meter.ts` | Writes `usage_events` with the service role. Best effort, warns once, never throws. |
| `web/lib/billing/usage.ts` | The plan-aware usage report: month and day totals from `usage_summary`, the `messages` floor, the cost estimate. |
| `web/lib/billing/quota.ts` | The decisions, day and month, plus `chatTurnsLeft` / `webSearchesLeft`. |
| `web/lib/chat/limits.ts` | The chat seam's view: an alias of the free tier, the quota sentences, and the two metering calls. No numbers of its own. |
| `web/lib/anthropic/models.ts` | The routing decision with per-turn costs. |
| `web/lib/chat/loop.ts` | The rolling message breakpoint, and the caching rules in the header. |
| `web/app/api/chat/route.ts` | Plan-aware quota check, metering, the system breakpoint with the rule written next to it. |
| `web/app/api/web/search/route.ts` | Plan-aware quota check, and it now meters. |
| `web/components/account/AccountPanel.tsx` | Month, day, and what it has cost. |
| `scripts/preflight.mjs` | The launch check. |
| `web/lib/chat/caching.test.ts` | The standing proof that caching is arranged right. |
| `web/lib/billing/promptBudget.test.ts` | Fails if the prompt outgrows the budget the tiers were priced from. |

---

## 8. Judgement calls

Made without asking, noted here so they can be reversed.

- **Two caps rather than one, and a new `chat_turns_per_month` /
  `web_searches_per_month` on `PlanLimits`.** A daily cap cannot bound a monthly
  bill. Everything else in this handoff follows from that.
- **8 a day / 40 a month for free chat.** Chosen to land the worst case near
  $2 a month, not from a view about what a producer needs. It is the number
  most likely to want revisiting, and the one with a clear price attached.
- **Pro caps cut hard** (1,000 turns/day → 50, 10 GPU hours → 5, 200 stem
  jobs → 100). They were placeholders with no costing; these are costed, and
  they let a price be chosen.
- **The 1.5-calls-per-turn and 70%-hit-rate assumptions.** Both are guesses in
  a model made of measurements. They are named constants so a week of real
  traffic can replace them, and everything downstream moves when they do.
- **Token counts estimated from character counts.** No tokenizer in the test
  environment, and `count_tokens` needs a key and the network. The estimate is
  conservative and `promptBudget.test.ts` keeps it honest; re-baseline against
  real `usage` numbers (BACKLOG, Phase 8).
- **A rolling breakpoint in the tool loop, unconditionally.** It wins on turns
  of three rounds or more and costs about a fifth of a cent on a two-round turn.
  Taken because the long turns are where the money is, and because it is the
  documented placement. Worth measuring; it is one condition to make it
  conditional.
- **`messages` kept as a floor under the metered chat count.** Belt and braces:
  a missing service role loosens the accounting but must never remove the cap.
- **No migration.** `usage_events` already had the kinds, the index and a
  windowed summary function. Adding one would have been ceremony.
- **`web/lib/chat/limits.ts` rewritten rather than extended.** Its
  `UsageSource` / `readUsage(source)` abstraction existed so a unit test could
  fake the database; with the counts coming from `usage_summary` the natural
  unit is the usage report, and the seam was buying nothing. Its test was
  rewritten to the new basis — every assertion it made is still made, against
  the real Supabase double instead of a hand-written fake, plus eight more.

### Existing tests that changed, and why

No test was weakened or skipped. Four assertions changed value because the
constant they assert *is* the product change, and two changed basis because the
counting source is what this pass replaced:

- `lib/chat/limits.test.ts` — rewritten to the new API; now exercises the real
  Supabase double rather than a fake source. 3 tests → 11.
- `lib/billing/quota.test.ts` — the web-search boundary moved from 19/20 to
  4/5, and the `report()` helper gained the two monthly fields. Three tests
  added for the monthly caps and for what is left.
- `app/api/web/search/route.test.ts` — `quota.per_day` now asserts the
  constant rather than the literal 20, and the two quota tests seed
  `usage_events` instead of assistant `tool_calls`, because that is the point of
  the change. Two tests added: that the route meters, and that the monthly
  ceiling bites.
- `app/api/chat/route.test.ts` — unchanged assertions; three tests added for
  metering and the monthly ceiling.

Suite: **779 → 817 passing, 0 failing.** 38 tests added, none removed, none
skipped. `pnpm typecheck`, `pnpm lint` and `pnpm build` are clean.
