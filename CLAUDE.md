# Ape or Rug — project rules for Claude Code

Ape or Rug is a casino-style game that recreates the feel of memecoin "trenches":
several synthetic coins launch each round, players buy in, hold, and sell before
the coin "rugs" (goes to zero). Outcomes come from a seeded RNG, never from real
markets.

**This repository is a play-money prototype.** Its purpose is to prove the math
and measure whether people enjoy the loop. It is not a real-money product.

Read these before writing code:

- `docs/01-game-design.md` — what the game is and how a round plays
- `docs/02-math-spec.md` — the price model, the fairness rule, simulation tests
- `docs/03-prototype-plan.md` — milestones, stack, acceptance criteria

## Hard rules

1. **Play money only.** No payments, deposits, withdrawals, wallets, tokens or
   anything convertible to value. Do not add them even behind a flag.
2. **No fake players.** Never generate bot trades, fake chat or fake winners
   presented as real people. The activity feed shows real participants only.
   If a demo needs bots, label every one of them visibly as a bot.
3. **No outcome steering.** A round's outcome depends only on its seed. Never
   read player positions, stakes or balances inside the price or rug logic.
4. **Events are truthful.** An in-game event ("dev sold", "whale in") must
   reflect an actual regime change in the engine. No decorative events.
5. **The engine is pure, deterministic and integer-only.** `packages/engine`
   has no I/O, no clock, no `Math.random` and no floating-point arithmetic:
   prices and money are `BigInt`, growth comes from checksummed integer
   tables (math spec §10). Same seed and config in, same round out, bit for
   bit, in Node and in the browser.
6. **The fairness rule in `docs/02-math-spec.md` §3 is an invariant.** Any change
   to price, rug, events, migration, fees or caps must keep the simulation
   suite green. Do not loosen test tolerances to make a change pass; fix the
   change or stop and report.
7. **Honest UI copy.** No promises of profit, no "beat the market" claims. The
   demo shows a visible "Demo — play money" label and an 18+ notice.

## Working conventions

- TypeScript, strict mode. Monorepo with pnpm workspaces.
- Engine logic gets unit tests and property tests before UI work builds on it.
- All tunable numbers live in one typed config object, not scattered constants.
- UI text in English, kept in one strings file so it can be translated later.
- Crypto slang in the UI always has a plain-language tooltip
  ("rug = the coin went to zero").
- Work milestone by milestone as listed in `docs/03-prototype-plan.md`. Finish a
  milestone's acceptance criteria before starting the next one.
- When a spec is ambiguous or seems wrong, say so and propose a change to the
  doc instead of silently deviating.

## Subagents

Four project subagents live in `.claude/agents/`:

- `math-reviewer` — required after any change to engine, RNG, fees, caps,
  events or migration. Do not mark such work done before it reports PASS.
- `bug-hunter` — required at the end of every milestone and before sharing
  any build. Money and fairness findings block the milestone.
- `ui-reviewer` — after UI changes and before sharing a build with testers.
- `playtest-analyst` — after a playtest, to produce the retention report.

Reviewers report; they do not edit code. Fix what they find, then run them
again.

## Services

GitHub (private repo), Railway (hosting), PostHog (telemetry, anonymous ids
only), Sentry (errors). Secrets live in environment variables; never commit
them. See `docs/03-prototype-plan.md` for details.
