# Simulation reports

`m1-rtp.md` is the report of record for milestone M1. It was produced by
`pnpm sim --bets 5000000` with base seed `c3d2c3d2…0003` on the engine with
one coin of each profile per round. Result: PASS, every strategy and every
per-profile cell.

## Earlier runs

Two runs in `archive/` were made before the profile rule changed (each coin
then drew its profile independently). The price path of a coin with a given
profile is the same in both versions, so they remain evidence about the
price model, not about the current round layout.

| Run | Base seed | Result |
| --- | --- | --- |
| `archive/m1-rtp-run1-independent-profiles.md` | `a9e0a9e0…0001` | PASS |
| `archive/m1-rtp-run2-independent-profiles.md` | `b7c1b7c1…0002` | FAIL on one cell of 144 |
| `m1-rtp.md` | `c3d2c3d2…0003` | PASS |

The failing cell in run 2 was "mid-round entry: hold 200 ticks", degen
profile: 97.46% ± 0.15%, which is 3.07 SE above the 97% target against a
limit of 3. The same cell was 96.93% ± 0.15% in run 1 and 97.06% ± 0.15% in
run 3; the three together give 97.15% ± 0.09%, 1.7 SE above target. The
tolerance was not changed. Following math spec §7 the excess was treated as
a failure of that run and settled by an independent run, where it did not
come back.

Payouts of long-hold strategies are heavily right-skewed, so a cell beyond
3 SE turns up more often than a normal table predicts. With 144 cells per
run, an occasional one is expected; one that repeats under a new seed is not.
