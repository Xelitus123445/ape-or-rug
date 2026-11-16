# Ape or Rug

Play-money prototype of a memecoin-trenches game. See `CLAUDE.md` for the
project rules and `docs/` for the design, the math spec and the plan.

**Demo — play money. 18+.** Nothing here can be bought, sold or cashed out.

## Layout

- `packages/engine` — price engine, random stream, growth tables, position
  accounting. Pure, deterministic, integer-only.
- `packages/sim` — strategy simulator that produces the RTP report.
- `packages/game` — shared room logic: three lanes, one ledger per player, the wire protocol, and the client's mirror of a room.
- `apps/server` — WebSocket room server (Node + `ws`, in memory). Authoritative: plays the ticks and executes every order at the price of the tick it is on.
- `apps/web` — React client. Renders what the server sends; replays ended coins locally to verify them.
- `docs/proofs/fairness.md` — why no strategy beats the entry fee.
- `docs/reports/m1-rtp.md` — simulator output for milestone M1.

## Commands

Requires Node 24 or newer and pnpm.

| Command | What it does |
| --- | --- |
| `pnpm install` | Install dependencies |
| `pnpm dev` | Start the room server (port 8787) and the web app at http://127.0.0.1:5173. Open the page, pick a nickname, create a room, send the `?room=` link to friends (up to 5) |
| `pnpm build` then `pnpm start` | One process: the server also serves the built app at http://127.0.0.1:8787 (`PORT`, `HOST` from the environment) |
| `pnpm test` | Unit, property and exact tests (about 10 s) |
| `pnpm typecheck` | TypeScript strict check |
| `pnpm sim --bets 5000000 --report docs/reports/m1-rtp.md` | Full strategy simulation (about 20 min on 10 threads) |
| `pnpm sim --bets 100000 --max-waves 1` | Quick simulator smoke run (under a minute). Too few bets to converge, so it prints the table and ends with FAIL by design |
| `pnpm test:stream` | Uniformity test of the random stream on 10^8 draws (a few minutes) |
| `pnpm test:browser` | Recompute the golden rounds in headless Edge/Chrome and compare with Node. Add `-- --manual` to open the printed address in any browser instead |
| `pnpm gen:tables` | Regenerate growth tables after a config change |

## Changing the math

Every tunable number is in `packages/engine/src/config.ts`. After changing a
hazard, a volatility or an event multiplier, run `pnpm gen:tables`: the engine
refuses to start with tables built for other numbers. Then run `pnpm test`
and the full `pnpm sim`. A changed golden hash in
`packages/engine/test/golden.ts` means rounds are no longer the same as
before; regenerate it (`node packages/engine/tools/gen-golden.ts`) only when
that was the intent.
