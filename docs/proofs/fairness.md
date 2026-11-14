# Fairness of the price process

This note argues that no way of playing Ape or Rug has an expected payout
above `stake * (1 - ENTRY_FEE)`. It refers to the engine as built in
`packages/engine` and to `docs/02-math-spec.md`.

## Setup

Fix a round seed. For one coin let `M_t` be the integer price after tick `t`
(`M_0 = 10^9`, meaning 1.00x), and let `F_t` be everything determined by the
coin's random stream up to and including tick `t`. A player sees less than
`F_t`: the prices, events and statuses so far, never the seed.

In tick `t + 1` the engine

1. decides whether an event starts, using word 0, word 3 and words 4–7 of
   the tick's digest;
2. looks up the regime `r` (profile, event, graduated flag), which gives a
   rug threshold `H_r` and a growth table `g_r[0..1023]`;
3. draws a 32-bit integer `R` from word 1 and rugs the coin if `R < H_r`;
4. otherwise draws a 10-bit index `I` from word 2 and sets
   `M_{t+1} = floor(M_t * g_r[I] / 10^9)`.

The words of an HMAC-SHA256 digest under an unknown key are modelled as
independent and uniform, and digests of different ticks as independent. This
is the standard pseudorandom-function assumption on HMAC; the uniformity and
serial-correlation tests of the spec (§10.5 #3) check the stream construction
against it.

## 1. One step is a supermartingale with drift in [-1e-9, 0]

The regime `r` of tick `t + 1` depends on `F_t` and on words 0, 3–7 of the
new digest. `R` and `I` come from words 1 and 2, which are independent of
those. So, given `F_t` and `r`, `R` is uniform on `[0, 2^32)` and `I` is
uniform on `[0, 1024)`, and

```
E[M_{t+1} | F_t, r] <= (1 - H_r / 2^32) * (1/1024) * sum_i (M_t * g_r[i] / 10^9)
                     = M_t * (2^32 - H_r) * sum(g_r) / (2^32 * 1024 * 10^9)
                     = M_t * (1 + d_r)
```

The inequality is the `floor`. Every table satisfies, as exact integers,

```
(2^32 - H_r) * sum(g_r) <= 2^32 * 1024 * 10^9
```

and misses equality by less than one unit of `sum(g_r)`, so
`-1e-9 <= d_r <= 0` (`packages/engine/test/tables.test.ts`, "satisfies the
fairness identity exactly"). The engine refuses to start if a table's
checksum is wrong or if the table was built for a different hazard than the
config asks for. Averaging over `r`:

```
E[M_{t+1} | F_t] <= M_t
```

A rugged or settled coin never moves again, so the bound holds for all `t`.
`M_t` is a non-negative supermartingale.

## 2. Regime changes do not break it

Event start, type and duration, and graduation are functions of the coin's
stream and of the price path, which is itself a function of the stream.
Nothing in `engine.ts` reads positions, stakes, balances or a clock
(`packages/engine/test/engine.test.ts`, "engine purity"). The regime that
governs tick `t + 1` is fixed before that tick's rug and growth draws are
looked at, and those draws use bits the regime decision never touches. That
is all step 1 needs: whatever the regime turns out to be, the conditional
expectation of the price does not exceed `M_t`. A player who knows the
regime, or reacts to an event, is conditioning on part of `F_t` and learns
nothing about `R` or `I`.

## 3. Every exit rule is a bounded stopping time

A position is opened at some tick `a` at price `M_a > 0` with stake `S`:
`fee = ceil(0.03 * S)`, `units = floor((S - fee) * 10^18 / M_a)`.
Its value at tick `t` is `V_t = floor(units * M_t / 10^18)`, so

```
V_a <= S - fee <= 0.97 * S        and        V_t <= units * M_t / 10^18
```

Whatever rule the player uses to sell everything — a price target, a
trailing stop, a reaction to `DEV_SOLD`, a timer, a coin flip, a bot — the
decision at tick `t` can only use what has happened up to `t`. The sale tick
`tau` is therefore a stopping time, and `a <= tau <= MAX_TICKS` because the
coin is settled at `MAX_TICKS` and a rug closes the position at value 0.
The choice of entry tick `a` is a stopping time for the same reason.

`units * M_t / 10^18` is a constant times a supermartingale, and `tau` is
bounded, so the optional stopping theorem applies without further
conditions:

```
E[payout | F_a] <= E[units * M_tau / 10^18 | F_a] <= units * M_a / 10^18 <= 0.97 * S
```

The payout cap only lowers this. If the value reaches `200 * S` the position
is sold for exactly `200 * S`, which is at most its value at that tick. The
cap also bounds every payout by `200 * S`, so all expectations are finite.

## 4. Partial sells and several positions

A position sold in pieces — including "take initials" — is a sum of
sub-positions, each with its own share of the units and its own stopping
time. Step 3 applies to each piece; rounding each piece down can only reduce
the total (`ledger.test.ts`, "gains nothing by splitting a stake or a
sale"). Several positions on one coin or on different coins are a sum of
positions, and expectation is linear, so the bound holds for the total no
matter how the coins' streams relate to each other.

Buying again with money from an earlier sale is a new position with a new
3% fee; it does not escape the bound.

## Result

For every strategy, the expected total payout is at most 97% of the total
staked. The shortfall below 97% has three sources, all against the player:
table drift (at most `1e-9` per tick, about `1e-12` for the committed
tables), integer rounding (at most one price unit per tick and two minor
units per bet), and the payout cap. Over a maximum-length round the first
two together stay below `1e-5` (`exact.test.ts`, "cumulative drift").

## What this does not show

- It is an argument about expectation. The house can still lose a lot over a
  short run; see the house-risk section of `docs/reports/m1-rtp.md`.
- It relies on HMAC-SHA256 behaving as a pseudorandom function and on the
  seed staying secret until the round ends. Seed handling, order timing and
  replay are operational questions for M3.
- It is not a certification. Real-money use needs review by an accredited
  test lab.
