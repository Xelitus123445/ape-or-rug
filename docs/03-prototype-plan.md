# 03 — Prototype plan

Build in milestones. Each one ends with acceptance criteria. Do not start the
next milestone until the current one passes.

**Lane mode (since M2).** The game no longer runs shared three-coin rounds;
it runs three lanes with one coin each (design doc §3). Wherever this plan
says "round", read it as "coin on a lane": M2's seed reveal and verify view
are per coin; M3's server runs three lane loops, sends no future ticks and
no seed of a coin before that coin ends, and its "20 consecutive rounds"
sync test becomes 20 consecutive coins on every lane.

**Order actually followed.** M2 work started before M1's two reviews were
finished, at the owner's request, to get a playable screen sooner. M1 is
not closed until `math-reviewer` reports PASS.

## Stack

- pnpm workspaces, TypeScript strict
- `packages/engine` — pure game engine and RNG (no I/O)
- `packages/sim` — strategy simulator and RTP report (Node CLI)
- `apps/server` — Node, WebSocket (`ws`), in-memory state
- `apps/web` — React + Vite, canvas chart, mobile-first
- Tests: Vitest. Property tests: fast-check. Browser checks: Playwright.
- No database in M1–M3.

## Tooling and services

- **GitHub** — private repository, `gh` CLI. Small commits per milestone step.
- **Railway** — hosting for the server and web build from M3 on (long-lived
  WebSocket connections). One service, one container.
- **PostHog** (free tier) — playtest telemetry in M4. Anonymous ids only, no
  personal data, session recording off.
- **Sentry** (free tier) — error tracking for the web app and server from the
  first shared build.
- **Coin art** — tickers and names are generated from word lists by the round
  seed; avatars are generated procedurally (shapes and colours from the seed)
  so the prototype needs no external image service. Generated meme images can
  replace them later.

Secrets go in environment variables and are never committed. Provide a
`.env.example`.

## Subagents

Defined in `.claude/agents/`:

- `math-reviewer` — run after any change to engine, RNG, fees, caps, events
  or migration. A milestone that touches these is not done until it passes.
- `bug-hunter` — run at the end of every milestone and before sharing any
  build. Money and fairness findings block the milestone.
- `ui-reviewer` — run after UI changes and before sharing a build.
- `playtest-analyst` — run on collected telemetry after a playtest.

## M1 — Engine and simulation

Build:

- Seeded RNG and commit-reveal as in math spec §6, integer-only engine and
  growth tables as in §10
- Round generator: given `(serverSeed, roundId, config)` produce the full tick
  series for three coins: price, regime, events, rug tick or settlement
- Position accounting: buy, partial sell, take initials, rug, settlement, cap
- Simulator CLI: `pnpm sim --bets 5000000` runs every strategy in math spec §7
  and prints a table with RTP, standard error and pass/fail

Acceptance:

- Same seed and config always produce an identical round (snapshot test)
- All strategies pass the tolerance in math spec §7
- Property test: for random configs within allowed ranges the one-step
  expectation identity in math spec §3 holds numerically
- A short `docs/reports/m1-rtp.md` with the simulator output
- Integer growth tables generated, checksummed and committed (math spec §10.3)
- All exact tests in math spec §10.5 pass, including bit-identical rounds in
  Node and in a browser build
- `docs/proofs/fairness.md` written (math spec §10.6)
- `math-reviewer` reports PASS and `bug-hunter` reports no money or fairness
  findings

M1 is the most important milestone. Do not start UI work until every item
above is met.

## M2 — Single-player web prototype

Build:

- Screen from design doc §4 with three live coin cards
- Round runs locally in the browser using the engine
- Buy, sell all, sell %, take initials
- Events and migration visible on the cards
- Guided first round and glossary tooltips
- Play-money balance in memory, reset button
- "Demo — play money" label and 18+ notice

Acceptance:

- Full rounds play end to end on a phone-sized viewport without layout breaks
- After each round the UI reveals the seed and a "verify" view recomputes the
  round from it
- Balance changes match engine accounting exactly (test)
- Manual check: a person who has never traded crypto can explain the game
  after one guided round

## M3 — Shared rounds and rooms

Build:

- Server runs the round loop and broadcasts ticks; clients render only
- Server is authoritative: a sell executes at the price of the tick in which
  the server received it, not the price the client displayed
- Rooms by link, nickname entry, up to 5 players per room for now
- Feed of real buys and sells, per-room leaderboard
- Reconnect restores the player's positions

Acceptance:

- 5 clients in one room stay in sync for 20 consecutive rounds
- A late or replayed sell message cannot execute at a stale price (test)
- The server never sends future ticks or the seed before the round ends
  (test that inspects every outbound message)
- No bot or synthetic player activity anywhere in the feed

Status (built): `packages/game` (room, protocol, client mirror),
`apps/server`, lobby and room UI in `apps/web`. Decisions made while
building, not in the original text:

- The first player in a room is the host and sets pace and break for the
  room, and can launch a waiting coin early; the host passes on if they drop.
- No free reset in a room: a player can refill to the starting balance only
  when they cannot afford the smallest stake and hold nothing, and refills
  show on the leaderboard (result = equity minus every balance handed out).
- A dropped player keeps their seat and open bags for 10 minutes; a reload
  in the same tab returns to the same seat; a new tab is a new player.
- Every order carries a rising number and the coin's round id: replayed,
  duplicated or out-of-date orders are refused, and the order has no price
  field at all.

Bug-hunter: PASS after three rounds (commit 665543e and follow-up).

Carried into M4 deploy: the per-address room limit reads the player's
address from X-Forwarded-For only when the socket comes from a private
address. After the first deploy, log one resolved address to confirm the
host's proxy is private and appends to the header; if not, add a
`TRUST_PROXY` setting.

Acceptance tests: `packages/game/test/room.test.ts` (5 clients in sync for
20 coins on every lane; late, replayed and forged orders; every outbound
frame inspected for future ticks and unrevealed seeds; every trade in the
feed traced to a real order) and `apps/server/test/server.test.ts` (the same
over real sockets).

## M4 — Telemetry and playtest build

Build:

- Anonymous player id stored locally, no personal data
- Events: `session_start`, `round_join`, `buy`, `sell`, `rugged`,
  `round_end`, `tutorial_step`, `session_end`
- Events sent to PostHog; the server also appends them to a local JSONL file
  as a backup
- A report script (used by `playtest-analyst`) that outputs:
  - rounds per first session (median, distribution)
  - share of players who return the next day
  - share who finish the guided round
  - split by a `source` tag in the invite link (e.g. `crypto`, `general`)
- A deployable build (single container) on Railway for sharing a link with
  testers, with Sentry enabled

Acceptance:

- Report runs on recorded data and matches a hand count on a small sample
- Invite links with different `source` tags are separated in the report

Status (built, not yet deployed):

- Events are recorded by the server, not the browser: the client sends a
  random id (local storage), a random id per tab visit (session storage)
  and the link's `src` tag with hello, and only tutorial steps on its own.
  Game events come from the room, so they cannot be faked or blocked.
- A round = a coin the player bought into, keyed by the coin's commit.
  Definitions of every report number are at the top of
  `apps/server/src/report.ts`.
- The JSONL file is the record the report reads; PostHog gets a copy.
- `src=dev` marks the developers' own play; the report leaves it out.
- Acceptance tests: `apps/server/test/report.test.ts` (hand-counted sample,
  groups kept apart), `apps/server/test/telemetry.test.ts`,
  `packages/game/test/telemetry.test.ts`.
- Left for the deploy (needs the owner's accounts): GitHub repo, Railway
  service with a `/data` volume, PostHog key, Sentry DSN, the proxy check
  from M3, and `pnpm smoke` against the public address.

## Decision point after M4

Run the playtest with two groups (crypto audience, general players).

- Median of 10+ rounds in the first session and a meaningful next-day return:
  continue to clips, polish and the pitch package.
- Below that: change pacing, round length and events, then re-test. Do not add
  features to compensate.

## Not in this plan

Real-money play, payments, operator integration, certification and licensing
are separate later work that needs legal advice first.
