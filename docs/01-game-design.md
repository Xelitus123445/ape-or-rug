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

## 3. Round structure

A round is shared by everyone in the room and lasts a few minutes.

1. **Launch.** Three coins start at price 1.00x. Each has a generated ticker,
   name and avatar, and one of three risk profiles shown on its card:
   - `degen` — wild candles, short life
   - `mid` — balanced
   - `runner` — calmer, lives longer
2. **Buy.** A player can buy any coin at any time while it is alive, and can
   hold several coins at once. Buying has an entry fee (see math spec).
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
   lost. Other coins keep running.
7. **End.** The round ends when all three coins have rugged or settled. A short
   summary shows each player's result, then the next round starts after a
   countdown.

Rare case: a coin that survives to the maximum round length is settled, and
all open positions are sold at the current price.

## 4. Screen layout (mobile first)

- **Top:** balance (play money), "Demo — play money" label, round timer.
- **Middle:** three coin cards side by side or in a swipeable row. Each card
  shows ticker, avatar, profile badge, live chart, current multiplier, active
  event, and the player's position with unrealised result.
- **Bottom:** stake selector, Buy button for the focused coin, and for open
  positions: Sell all, Sell %, Take initials.
- **Feed:** real players' buys and sells in this round, and events.
- **After the round:** result card with the best and worst moment
  ("sold $GIGACAT at 31x", "rugged on $BONKFATHER at 4x").

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
