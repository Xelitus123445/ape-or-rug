# 01 — Game design

## 1. One-line pitch

All the adrenaline of memecoin trenches without the work they require: no
wallet, no research, no crypto knowledge. A coin is pumping right now; get out
before it rugs.

## 2. Players

- **Crypto degens** who already trade memecoins and want the same feeling
  without bots, gas and honeypots.
- **Regular casino players** who have heard of memecoins but will never set up
  a wallet. The game must be understandable to them within one round.

Design for the second group. If a first-time player needs an explanation
longer than one sentence, the screen is wrong.

## 3. Lanes and coins

*(Changed during M2 at the owner's request. The first draft had shared
rounds: three coins launched together and the next round waited for all of
them to end, which left players waiting minutes for the calm coin. The
engine can still generate such rounds; the game no longer uses them.)*

The room has three lanes that never stop. Each lane has a fixed risk profile
and runs one coin at a time:

- `degen` lane — wild candles, short life
- `mid` lane — balanced
- `runner` lane — calmer, lives longer

So a newcomer always sees the same three choices, and each lane moves at its
own pace: when a coin ends, only its lane takes a break, and the other two
keep going.

1. **Launch.** A lane shows its next coin at 1.00x with a generated ticker,
   name and avatar and a short countdown, then the coin goes live. Every coin
   has its own seed and its own published fingerprint (math spec §6).
2. **Buy.** A player can buy a coin while it waits to launch (at 1.00x) and
   at any time while it is alive, and can hold coins on several lanes at
   once. Buying has an entry fee (see math spec).
3. **Life.** The price moves every tick. Events appear on the coin card and in
   the feed:
   - `DEV_SOLD` — rug risk up, volatility up
   - `WHALE_IN` — rug risk down, volatility up
   - `KOL_TWEET` — volatility up
   Each event corresponds to a real regime change in the engine and lasts a
   limited number of ticks.
4. **Migration.** A coin that reaches 10x "graduates": the card changes look,
   rug risk and volatility drop for the rest of its life.
5. **Sell.** The player can sell 100%, sell a chosen percentage, or press
   **Take initials** (sell exactly enough to get the original stake back and
   keep the rest).
6. **Rug.** At a random tick the coin goes to zero. Open positions in it are
   lost. The other lanes keep running.
7. **Next coin.** The ended coin stays on screen for a moment with the
   player's result on it and its seed revealed, then the lane shows its next
   coin and counts down to launch. The break between coins is a pacing
   setting (5, 10 or 20 seconds in the prototype). Nothing carries over from
   one coin to the next on a lane.

Rare case: a coin that survives to the maximum length (2400 ticks) is
settled, and all open positions are sold at the current price.

Pacing has two settings that do not touch the odds: the tick rate (4, 6 or 8
price moves per second) and the break between coins. The math is defined per
tick, so every setting is the same game.

## 4. Screen layout (mobile first)

- **Top:** balance (play money), session result, "Demo — play money" label
  and 18+ notice. Speed and break settings sit behind a gear on a phone.
- **Lanes:** three coin cards side by side, colour-coded by profile. Each
  card shows the profile with a risk meter, ticker, avatar, a small live
  chart, the current multiplier, the active event or the countdown, and the
  value of the player's bag.
- **Stage:** the focused coin with a candlestick chart, the active event and
  what it does, the coin's time left, and plain facts about its profile
  (typical move per tick, average life).
- **Bottom (right-hand column on a desktop):** cash out with the live value,
  sell 50%, take initials, stake chips, and the buy button.
- **Reference panels:** the three profiles side by side with the reminder
  that all three pay back the same on average; ended coins, each with its
  result and its fairness check; and the feed of the player's own actions
  and the coins' events.

## 5. Social layer

- Everyone in a room sees the same coins and the same prices.
- The feed shows who bought and who sold at what multiplier.
- A per-room leaderboard ranks players by balance.
- Rooms are joined by link; a room holds a small group (target: up to 5 for
  friend tests, more later).

## 6. Onboarding

- The first round is a guided round: three short tooltips (buy, watch, sell)
  and a plain-language glossary on tap.
- Every slang term has a tooltip. "Rug" is explained the first time it happens.

## 7. Out of scope for the prototype

- Real money, payments, wallets, tokens
- Streamer coins, tournaments, seasons, battle pass
- Shareable video clips (planned after the retention test)
- Operator integration, certification, licensing

## 8. What the prototype must answer

1. Does every exit strategy land on the same RTP? (math)
2. Does a non-crypto person understand the game in one round? (clarity)
3. Do people play 10+ rounds in their first session and come back the next
   day? (retention)
