# 02 — Math spec

All numbers here are starting values for the prototype. They live in one
config object and will be tuned. The fairness rule in §3 is not tunable.

## 1. Time and price

- A round advances in ticks. `TICKS_PER_SECOND = 4`.
- Each coin has a price multiplier `M_t`, with `M_0 = 1.00`.
- A coin is `alive`, `rugged` or `settled`.

## 2. One tick of a live coin

Let the coin's current regime give a rug hazard `h` (probability of rug in
this tick) and a volatility `s`.

1. Draw `u1`. If `u1 < h` the coin rugs: `M` becomes 0, state `rugged`.
2. Otherwise draw a growth factor `g` whose distribution is lognormal-shaped
   with

   ```
   g ~ exp(mu + s * z),   mu = -ln(1 - h) - s^2 / 2
   M_{t+1} = M_t * g
   ```

`mu` is not a free parameter. It is derived from `h` and `s`.

The formula above defines the shape. The engine does not evaluate `exp`,
`ln` or any floating-point math at run time. It uses precomputed integer
tables as specified in §10, which is the binding definition.

## 3. Fairness rule (invariant)

With `mu` as above, `E[g] = 1 / (1 - h)`, so

```
E[M_{t+1} | everything known at t] = (1 - h) * M_t * E[g] + h * 0 = M_t
```

The price is a martingale in every regime. Consequences:

- No exit rule based on the chart, the events, the timer or anything else
  observable can change the expected value of a position. Selling at peaks,
  trailing stops, reacting to `DEV_SOLD`, bots: all have the same expectation.
- Events may change `h` and `s` freely, because `mu` is recomputed from them.
  Information about the regime gives the player no edge.
- The house edge comes only from the entry fee (§5), so RTP is the same for
  every strategy: `RTP = 1 - ENTRY_FEE`, reduced slightly by the payout cap.

Anything that would break the identity above is a bug: a drift term chosen by
hand, a rug probability that depends on player positions, a forced rug at a
known time, a fee that depends on how long a position is held.

## 4. Regimes

Base profiles:

| Profile | h per tick | Mean life | s per tick |
| --- | --- | --- | --- |
| degen | 1/160 | 40 s | 0.060 |
| mid | 1/360 | 90 s | 0.035 |
| runner | 1/720 | 180 s | 0.020 |

Events multiply the base values while active. A coin has at most one active
event. While no event is active, a new one starts with probability 1/120 per
tick, type chosen uniformly, duration uniform in 20–40 ticks.

| Event | h multiplier | s multiplier |
| --- | --- | --- |
| DEV_SOLD | 3.0 | 1.5 |
| WHALE_IN | 0.5 | 1.3 |
| KOL_TWEET | 1.0 | 2.0 |

Migration: the first time `M >= 10`, the coin is marked `graduated` for the
rest of its life: `h * 0.5`, `s * 0.7`, stacking with events.

Event timing and type are drawn from the round's RNG stream and never depend
on players.

Round limit: `MAX_TICKS = 2400` (10 minutes). A coin still alive then is
`settled`: open positions are sold at the current price. With the hazards
above this is rare. It is a settlement, not a rug, so §3 still holds.

## 5. Positions, fees, caps

- Buy with stake `S` at tick `t`: fee `S * ENTRY_FEE` goes to the house, the
  position holds `units = S * (1 - ENTRY_FEE) / M_t`.
- `ENTRY_FEE = 0.03` (target RTP 97%).
- Sell fraction `f` at tick `t'`: payout `f * units * M_t'`, no exit fee.
- Take initials: sell the fraction `f = S / (units * M_t')` if that is below 1,
  otherwise the button is disabled.
- Rug: remaining units are worth 0.
- Payout cap: if a position's value reaches `MAX_PAYOUT_MULT * S`
  (`MAX_PAYOUT_MULT = 200`) it is sold automatically at exactly the cap.
  Earlier partial sells count: the cap is on the total a position ever pays,
  so the trigger is `already paid + current value >= MAX_PAYOUT_MULT * S`
  and the automatic sale pays `MAX_PAYOUT_MULT * S - already paid`.
- Take initials after partial sells brings the total paid up to `S`; it is
  disabled once the position has already paid `S` or more.
- `MIN_STAKE`, `MAX_STAKE` are config values (250.00 and 10,000.00 play
  coins in the prototype).
- Units are held with 18 decimal digits: `units = floor(net * 10^18 / M)`
  and `value = floor(units * M / 10^18)` with `M` as the integer price.
- Orders execute at the price of the tick in which the server receives them.
  Buys are not accepted for a coin that is not alive.
- Order of work inside a tick: price step (or rug, or settlement), then
  rugs, settlements and payout caps are applied to open positions, then the
  orders received during that tick execute at the new price.
- An event starts at the beginning of a tick and governs that tick's rug
  check and growth draw. Graduation takes effect from the tick after the
  price first reaches 10x.

  *(Cap with partial sells, unit precision and tick order were added in M1;
  the first draft left them open.)*

The engine's price path never reads positions. Caps and fees act on the
position only.

## 6. Randomness and verification

- Per round the server generates `serverSeed` (32 random bytes), fixes the
  `roundId`, and publishes both `roundId` and
  `commit = SHA-256(serverSeed || ":" || roundId)` before the round starts
  and before any bet is accepted. The commit covers the round id because the
  round id feeds every random draw: a commit to the seed alone would let
  whoever picks the id afterwards pick the round. *(Amended after the M1
  bug hunt; the first draft committed to the seed only.)*
- Random numbers come from `HMAC-SHA256(serverSeed, roundId:coinIndex:tick:n)`
  where `n` indexes the digest within the tick. Each draw takes the bits it
  needs from the digest as an unsigned integer. No conversion to floats.
  Bounded integers that are not a power of two use rejection sampling, never
  modulo.
- Fixed layout per tick, all in digest `n = 0` (eight 32-bit big-endian
  words): word 0 event start (32 bits), word 1 rug check (32 bits), word 2
  growth index (top 10 bits), word 3 event type (sixteen 2-bit chunks, first
  chunk below 3 wins), words 4–7 event duration (twenty-four 5-bit chunks,
  six per word, first chunk below the range size wins). Every draw owns its
  bits whether or not it is used, so the layout never depends on state.
- If every chunk of a rejection-sampled draw is rejected (probability about
  `2e-10` for the type, `3e-12` for the duration), sampling continues over
  all eight words of further digests: `n = 1, 3, 5, …` for the event type,
  `n = 2, 4, 6, …` for the duration.
- Tick 0 has no price move. Every round has exactly one degen, one mid and
  one runner coin, so a newcomer always sees the same three choices. Their
  order comes from the round digest `HMAC-SHA256(serverSeed, roundId:p:0:0)`:
  3-bit chunks, ten per word read from the top, first chunk below 6 picks
  one of the six orders `012, 021, 102, 120, 201, 210` (0 = degen, 1 = mid,
  2 = runner); overflow continues in `roundId:p:0:1, 2, …`. Coin `i` gets
  the `i`-th profile of that order.
- `roundId` is 1–48 characters of `[A-Za-z0-9_-]`; `serverSeed` is exactly
  32 bytes.

  *(Amended in M1. The first draft used one digest per draw. One digest per
  tick gives the same guarantees and makes the 5,000,000-bet simulation of §7
  five times cheaper.)*
- After the round the server reveals `serverSeed`. The client can recompute
  the whole round from `serverSeed` and `roundId` and check both against the
  commit. The seed must not appear in anything that leaves the server before
  then: state dumps, logs, error reports.

This is a prototype scheme. A production version needs a certified RNG and a
lab-reviewed design.

## 7. Simulation tests

The simulator runs each strategy for at least 5,000,000 bets and reports mean
payout per unit stake (RTP) and its standard error (SE).

Strategies:

1. Sell at a fixed target: 1.5x, 2x, 5x, 10x, 50x
2. Hold a fixed number of ticks: 10, 40, 200
3. Trailing stop: 10%, 20%, 40% below the running peak
4. Sell after 3 consecutive down ticks while in profit
5. Sell on `DEV_SOLD`; variant: buy only during `WHALE_IN`
6. Enter mid-round at a random tick, then each of the above
7. Take initials at 2x, hold the rest to rug or cap
8. Hold to cap or rug
9. Random exit
10. Per profile and mixed across profiles

Pass criteria:

- Every strategy: `|RTP - (1 - ENTRY_FEE)| <= 3 * SE`, or RTP below target for
  strategies that hit the cap often
- No strategy with `RTP - 3 * SE > 1 - ENTRY_FEE`
- Strategies with SE above 0.5% (hold to cap) are run with more bets until SE
  is below 0.5%. This applies to each strategy's row over all profiles. The
  per-profile cells are reported with whatever SE the run gives them (a
  third of the bets each) and judged by the same 3 SE rule.
- Payouts are heavily right-skewed (many small losses, rare large wins), so
  the mean of a long-hold strategy is not normally distributed even at
  millions of bets and a cell can land beyond 3 SE more often than a normal
  table says. A cell above target is still a failure of the run. It is
  resolved by an independent run with a new seed, never by widening the
  tolerance; a real edge shows up again, noise does not.

Also report for sizing house risk: distribution of round length, share of
coins that graduate, share that hit settlement, largest house loss over any
1,000 consecutive rounds at max stake.

## 8. Preliminary check

A quick Monte Carlo of this model (mid profile with events and migration,
600,000 rounds, 3% entry fee, cap 200x) gave:

| Strategy | RTP | SE |
| --- | --- | --- |
| Target 2x | 97.04% | 0.13% |
| Target 10x | 97.13% | 0.38% |
| Hold 40 ticks | 96.96% | 0.06% |
| Trailing stop 20% | 96.84% | 0.11% |
| Sell on DEV_SOLD | 97.03% | 0.37% |
| Mid-round entry, target 3x | 97.04% | 0.21% |
| 3 down ticks in profit | 97.06% | 0.06% |
| Hold to cap | 94.36% | 1.61% |

All are consistent with 97% within sampling error. Hold to cap is very noisy
at this sample size and sits slightly below target because the cap truncates
large wins. M1 must reproduce this with the real engine and the full list.

This check used the floating-point formula from §2, before the integer
tables of §10 existed. It supports the model, not the implementation.

## 9. Open questions

- Whether a fixed entry fee or a small per-tick fee feels better to players.
  A per-tick fee makes RTP depend on holding time, which complicates the
  "same RTP for every strategy" claim. Default: entry fee only.
- Tick rate and mean coin life are pacing choices to settle in playtests.
- House bankroll exposure at the 200x cap; may need a lower cap or stake
  limits per coin.

## 10. Exactness requirements

Monte Carlo can only show that RTP is close to target. The engine must be
built so that fairness can be checked exactly, with integer arithmetic, and
so that every machine computes the same round bit for bit.

### 10.1 No floating point in the engine

- Prices, units, stakes, balances and payouts are integers (`BigInt`).
  Price scale: `PRICE_SCALE = 10^9` (1.00x is `1_000_000_000`).
  Money is held in minor units (1/100 of a play coin).
- `Math.exp`, `Math.log`, `Math.random`, `Date` and any float arithmetic are
  forbidden inside `packages/engine/src`. A test enforces this by walking
  the TypeScript syntax tree with type information
  (`packages/engine/test/purity.test.ts`): non-integer literals, `/` and `**`
  on anything but `bigint`, float helpers, clocks, platform randomness, I/O
  globals and imports from outside the engine all fail it. Small integers
  (ticks, indexes, 32-bit draws) may be JavaScript numbers; they are only
  added, multiplied, compared and bit-shifted, which is exact. Floats are
  allowed only in rendering code and in the offline table generator.
  *(The first draft also asked for a lint rule; the type-aware test replaces
  it.)*

### 10.2 Rug check

- Hazard is an integer threshold: `h = H / 2^32`.
- Draw a 32-bit integer `r` from the round stream. Rug if `r < H`.

### 10.3 Growth tables

- For every regime (profile x event state x graduated or not) there is a
  table of `K = 1024` integers `g[0..1023]`, each a growth factor scaled by
  `PRICE_SCALE`, sorted ascending.
- A tick draws a 10-bit index `i` and sets
  `M = (M * g[i]) / PRICE_SCALE`, rounded down.
- Tables are generated offline by a script in `packages/engine/tools/` from
  the lognormal shape in §2 (quantiles at `(i + 0.5) / K`), then adjusted so
  that the fairness identity holds as tightly as integers allow and never
  favours the player:

  ```
  (2^32 - H) * sum(g)  <=  2^32 * K * PRICE_SCALE
  ```

  with the left side as large as possible. Equivalently the one-step drift

  ```
  d = (1 - h) * mean(g) - 1
  ```

  satisfies `-1e-9 <= d <= 0`. A reference construction reaches about
  `-1e-12` per tick for all regimes in §4.
- Tables are committed to the repository with a SHA-256 checksum. The engine
  refuses to start if a checksum does not match.

### 10.4 Rounding

- Every rounding step is defined and goes against the player: price updates
  round down, units bought round down, payouts round down to a minor unit,
  fees round up.
- Minimum stake is high enough that rounding loss per bet is below 0.01% of
  stake for one buy and one full sale (at most two minor units), so nobody
  is materially shorted and splitting a stake into many small bets cannot
  gain anything. Every further partial sale can cost up to one more minor
  unit.
- Price rounding is one price unit (`1e-9` of the launch price) per tick at
  most. Relative to the current price that is tiny near 1.00x and grows as
  the price falls: about `5e-8` per tick at 0.01x. It always goes against
  the player.

### 10.5 Exact tests (in addition to §7)

1. **Table identity.** For every table, compute the inequality in §10.3 with
   exact integers and assert it, and assert the drift bound.
2. **Table shape.** Sorted, all entries positive, mean and variance within
   0.1% of the lognormal they approximate.
3. **Index and rug draws are uniform.** Chi-square on at least 10^8 draws of
   the 10-bit index and of the 32-bit rug integer; serial correlation at
   lags 1–10. These test the stream construction, not the hash.
4. **Determinism.** A fixed set of seeds produces rounds with a known
   SHA-256 over the full tick series. The same test runs in Node and in a
   browser build and must match.
5. **Conservation.** Over any sequence of operations, total stakes in equals
   payouts plus fees plus rounding residue plus value lost to rugs, to the
   minor unit. Property test with random operation sequences.
6. **Cumulative rounding drift.** Over a maximum-length round the combined
   effect of table drift and price rounding is below `1e-5` and not positive.
7. **Bounded strategies, exact.** For the strategy "sell after exactly n
   ticks" compute expected payout exactly from the tables for n = 1..50 in
   one fixed regime and compare with simulation.

### 10.6 Proof note

`docs/proofs/fairness.md` must contain a short written argument that:

- the discrete price process is a supermartingale with drift in `[-1e-9, 0]`
  per tick in every regime;
- regime changes are functions of the round stream only, so they are
  predictable with respect to the player's information and do not break it;
- every exit rule is a stopping time bounded by `MAX_TICKS`, and the payout
  cap makes payouts bounded, so by optional stopping no strategy has
  expected payout above `stake * (1 - ENTRY_FEE)`;
- partial sells and multiple positions are sums of such strategies.

### 10.7 What this does not cover

- **House variance.** A fair-on-average game can still lose a lot in a short
  period. Report risk of ruin for a given bankroll and stake limits.
- **Operational exploits.** Latency, replayed or duplicated orders, reconnect
  races, and seed leakage are outside the math and are tested separately
  (see the `bug-hunter` agent and M3 acceptance).
- **Certification.** None of this replaces review by an accredited test lab,
  which is required before any real-money use.
