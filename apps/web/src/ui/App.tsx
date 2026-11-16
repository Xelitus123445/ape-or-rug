import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { BREAKS, EVENT_NONE, GameSession, PACES, STAKES, START_BALANCE, STATUS_ALIVE, STATUS_RUGGED, STATUS_SETTLED } from "../game/session.ts";
import type { FeedItem, FinishedCoin, Lane, LiveCoin } from "../game/session.ts";
import { chip, clock, mult, signedUsdk, usdk } from "../game/format.ts";
import { S } from "../strings.ts";
import { Chart } from "./Chart.tsx";
import { play } from "./sound.ts";

function randomSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

function remember(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function store(key: string, on = true): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Private mode: the choice simply does not stick.
  }
}

/** A slang word with its plain-language meaning on tap. */
function Term({ k, children }: { k: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [title, text] = S.terms[k]!;
  return (
    <span className="term-wrap">
      <button type="button" className="term" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open); }} onBlur={() => setOpen(false)}>
        {children ?? title}
      </button>
      {open && (
        <span className="term-pop" role="tooltip">
          <b>{title}</b> — {text}
        </span>
      )}
    </span>
  );
}

const PROFILE_TERMS = ["degen", "mid", "runner"];
const EVENT_TERMS = ["", "devSold", "whale", "kol"];
// Mean coin life in ticks per profile, measured over 3.84M rounds (docs/reports/m1-rtp.md).
const MEAN_LIFE_TICKS = [164, 360, 664];

/** Risk meter: three bars, more lit for riskier coins. */
function Risk({ profile }: { profile: number }) {
  return (
    <span className="risk" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className={i < 3 - profile ? "risk-bar on" : "risk-bar"} />
      ))}
    </span>
  );
}

function Avatar({ coin, size }: { coin: { meta: LiveCoin["meta"] }; size: number }) {
  const { hue, emoji } = coin.meta;
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.56, background: `linear-gradient(135deg, hsl(${hue} 55% 46%), hsl(${(hue + 60) % 360} 55% 28%))` }}
      aria-hidden="true"
    >
      {emoji}
    </span>
  );
}

/** Multiplier that pulses on every tick. */
function LiveMult({ coin, className }: { coin: LiveCoin; className: string }) {
  const c = coin.state;
  const h = coin.history;
  if (c.status === STATUS_RUGGED) return <div className={`${className} down`}>{S.rugged}</div>;
  const dir = h.length < 2 ? "" : h[h.length - 1]! >= h[h.length - 2]! ? "tick-up" : "tick-down";
  return (
    <div key={c.tick} className={`${className} ${c.price >= 1_000_000_000n ? "up" : "down"} ${c.status === STATUS_ALIVE ? dir : ""}`}>
      {mult(c.price)}
    </div>
  );
}

function LaneCard({ session, lane, focused, onFocus }: { session: GameSession; lane: Lane; focused: boolean; onFocus: () => void }) {
  const coin = lane.coin;
  const c = coin.state;
  const rugged = c.status === STATUS_RUGGED;
  const bag = session.holding(lane.index);
  const open = bag.positions.some((p) => p.open);
  const result = bag.value + bag.paid - bag.stake;
  const wait = session.waitSeconds(lane.index);
  return (
    <div
      className={`card p${lane.profile} ${focused ? "card-focus" : ""} ${rugged ? "card-rugged" : ""} ${c.graduated && !rugged ? "card-grad" : ""}`}
      onClick={onFocus}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onFocus()}
    >
      <div className="card-class">
        <Risk profile={lane.profile} />
        <span>{S.profiles[lane.profile]}</span>
      </div>
      <div className="card-head">
        <Avatar coin={coin} size={28} />
        <div className="ticker">${coin.meta.ticker}</div>
      </div>
      <LiveMult coin={coin} className="card-mult" />
      <Chart history={coin.history} rugged={rugged} version={session.version} compact />
      <div className="card-foot">
        {lane.phase === "prelaunch" ? (
          <span className="badge badge-wait">{S.launchIn(wait)}</span>
        ) : lane.phase === "cooldown" ? (
          <span className="badge badge-quiet">{S.nextCoinIn(wait + Math.max(0, session.breakSeconds - 3))}</span>
        ) : c.event !== EVENT_NONE ? (
          <span className={`badge badge-e${c.event}`}>{S.eventIcons[c.event]} {S.events[c.event]}</span>
        ) : c.graduated ? (
          <span className="badge badge-grad">★ {S.graduated}</span>
        ) : (
          <span className="badge badge-quiet">{S.profileRisk[lane.profile]}</span>
        )}
        {bag.stake > 0n && <span className={`card-bag ${result >= 0n ? "up" : "down"}`}>{open ? usdk(bag.value) : signedUsdk(result)}</span>}
      </div>
    </div>
  );
}

function feedText(f: FeedItem): string {
  const t = f.ticker;
  const amount = f.amount !== undefined ? usdk(f.amount) : "";
  switch (f.kind) {
    case "buy": return S.feed.buy(t, amount, mult(f.price));
    case "sell": return S.feed.sell(t, amount, mult(f.price));
    case "initials": return S.feed.initials(t, amount, mult(f.price));
    case "rug": return S.feed.rug(t, mult(f.price));
    case "lost": return S.feed.lost(t, amount);
    case "graduated": return S.feed.graduated(t);
    case "cap": return S.feed.cap(t, amount);
    case "settled": return S.feed.settled(t, amount);
    case "event": return S.feed.event(t, `${S.events[f.event!]} (${S.eventEffects[f.event!]})`);
    case "launch": return S.feed.launch(t);
  }
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>{S.close}</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function endLine(coin: FinishedCoin): string {
  return coin.status === STATUS_RUGGED ? S.endedRug(mult(coin.endPrice)) : S.endedSettled(mult(coin.endPrice));
}

function VerifyView({ session, coin, onClose }: { session: GameSession; coin: FinishedCoin; onClose: () => void }) {
  const v = useMemo(() => session.verify(coin), [session, coin]);
  return (
    <Modal title={S.verifyTitle} onClose={onClose}>
      <p>
        <b>${coin.meta.ticker}</b> · {S.profiles[coin.profile]} · {endLine(coin)}
      </p>
      <p className="muted">{S.verifyIntro}</p>
      <div className="mono-label">{S.verifyRoundId}</div>
      <div className="mono">{coin.roundId}</div>
      <div className="mono-label">{S.verifyCommit}</div>
      <div className="mono">{coin.commit}</div>
      <div className="mono-label">{S.verifySeed}</div>
      <div className="mono">{coin.seed}</div>
      <p className={v.commitOk ? "check ok" : "check bad"}>{v.commitOk ? `✓ ${S.verifyCommitOk}` : `✗ ${S.verifyCommitBad}`}</p>
      <p className={v.roundOk ? "check ok" : "check bad"}>{v.roundOk ? `✓ ${S.verifyRoundOk}` : `✗ ${S.verifyRoundBad}`}</p>
      <div className="mono-label">{S.verifyHash}</div>
      <div className="mono">{v.recomputedHash}</div>
    </Modal>
  );
}

function swingPct(session: GameSession, profile: number): string {
  // Volatility per tick in ppm, shown as a percentage with one decimal.
  const tenths = Number(session.engine.config.profiles[profile]!.sigmaPpm / 1000n);
  return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1);
}

function lifeSeconds(session: GameSession, profile: number): number {
  return Math.round(MEAN_LIFE_TICKS[profile]! / session.pace.ticksPerSecond);
}

/** Side-by-side comparison of the three coin kinds. */
function Compare({ session }: { session: GameSession }) {
  return (
    <div className="compare">
      <div className="compare-grid">
        {[0, 1, 2].map((p) => (
          <div key={p} className={`compare-col p${p}`}>
            <div className="compare-name"><Risk profile={p} /> {S.profiles[p]}</div>
            <div className="compare-risk">{S.profileRisk[p]}</div>
            <dl>
              <dt>{S.compareSwing}</dt>
              <dd>±{swingPct(session, p)}%</dd>
              <dt>{S.compareLife}</dt>
              <dd>~{lifeSeconds(session, p)}s</dd>
              <dt>{S.compareRisk}</dt>
              <dd>{S.riskWords[p]}</dd>
            </dl>
          </div>
        ))}
      </div>
      <p className="same-odds">{S.sameOdds}</p>
    </div>
  );
}

function Glossary({ session, onClose }: { session: GameSession; onClose: () => void }) {
  return (
    <Modal title={S.glossaryTitle} onClose={onClose}>
      <h3 className="modal-sub">{S.compareTitle}</h3>
      <Compare session={session} />
      <dl className="glossary">
        {Object.entries(S.terms).map(([k, [title, text]]) => (
          <div key={k}>
            <dt>{title}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
      <p className="muted">{S.demoNote}</p>
    </Modal>
  );
}

interface Pop {
  id: number;
  text: string;
  tone: "up" | "down" | "gold";
}

export function App({ seedSource = randomSeed }: { seedSource?: () => Uint8Array }) {
  const session = useMemo(() => new GameSession(seedSource), [seedSource]);
  useSyncExternalStore(session.subscribe, session.getVersion);
  const [focus, setFocus] = useState(0);
  const [stake, setStake] = useState(STAKES[2]!);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<FinishedCoin | null>(null);
  const [showGlossary, setShowGlossary] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [tipStep, setTipStep] = useState(() => (remember("aor.tips") ? -1 : 0));
  const [rugTip, setRugTip] = useState(() => !remember("aor.rug"));
  const [muted, setMuted] = useState(() => remember("aor.muted"));
  const [pops, setPops] = useState<Pop[]>([]);
  const [shake, setShake] = useState(-1);
  const lastFeed = useRef(0);

  const tps = session.pace.ticksPerSecond;
  useEffect(() => {
    const id = setInterval(() => session.clock(), 1000 / tps);
    return () => clearInterval(id);
  }, [session, tps]);

  useEffect(() => {
    if (error === null) return;
    const id = setTimeout(() => setError(null), 2500);
    return () => clearTimeout(id);
  }, [error]);

  // Turn new feed lines into sound and floating numbers.
  const newest = session.feed[0]?.id ?? 0;
  useEffect(() => {
    const fresh = session.feed.filter((f) => f.id > lastFeed.current).reverse();
    lastFeed.current = newest;
    const added: Pop[] = [];
    for (const f of fresh) {
      if (f.kind === "buy") play("buy", muted);
      else if (f.kind === "sell" || f.kind === "initials" || f.kind === "cap" || f.kind === "settled") {
        play(f.won ? "win" : "loss", muted);
        added.push({ id: f.id, text: `+${usdk(f.amount ?? 0n)}`, tone: f.won ? "gold" : "up" });
      } else if (f.kind === "rug") {
        play("rug", muted);
        setShake(f.lane);
        setTimeout(() => setShake(-1), 700);
      } else if (f.kind === "lost") {
        added.push({ id: f.id, text: `$${f.ticker} −${usdk(f.amount ?? 0n)}`, tone: "down" });
      } else if (f.kind === "graduated") play("graduate", muted);
      else if (f.kind === "event" && f.lane === focus) play("event", muted);
      else if (f.kind === "launch" && f.lane === focus) play("go", muted);
    }
    if (added.length > 0) {
      setPops((p) => [...p, ...added].slice(-3));
      const ids = new Set(added.map((a) => a.id));
      setTimeout(() => setPops((p) => p.filter((x) => !ids.has(x.id))), 1800);
    }
  }, [newest, session, muted, focus]);

  const lane = session.lanes[focus]!;
  const coin = lane.coin;
  const c = coin.state;
  const bag = session.holding(focus);
  const hasOpen = bag.positions.some((p) => p.open);
  const alive = c.status === STATUS_ALIVE;
  const result = bag.value + bag.paid - bag.stake;
  // Open bags count at their current value, so buying does not look like a loss.
  const sessionNet = session.equity - START_BALANCE;
  const wait = session.waitSeconds(focus);

  const act = (r: { ok: true } | { ok: false; error: string }): void => {
    if (!r.ok) setError(S.errors[r.error] ?? r.error);
  };
  const endTips = (): void => {
    setTipStep(-1);
    store("aor.tips");
  };
  const onBuy = (): void => {
    const r = session.buy(focus, stake);
    act(r);
    if (r.ok && tipStep === 0) setTipStep(1);
  };
  const onSell = (r: { ok: true } | { ok: false; error: string }): void => {
    act(r);
    if (r.ok && tipStep >= 0) endTips();
  };
  const toggleSound = (): void => {
    store("aor.muted", !muted);
    setMuted(!muted);
  };

  const maxTicks = session.engine.config.maxTicks;
  const secondsLeft = (maxTicks - c.tick) / tps;
  const tip = tipStep >= 0 ? S.tutorial[tipStep]! : null;
  // Launches happen all the time on three lanes; they would drown the rest of the feed.
  const feedLines = session.feed.filter((f) => f.kind !== "launch").slice(0, 12);
  const ended = lane.ended;
  const endedNet = ended !== null ? ended.paid - ended.staked : 0n;

  return (
    <div className="app">
      <header className="top">
        <div className="top-row">
          <div className="brand">
            <span className="logo">
              <span className="logo-a">{S.brandA}</span> <span className="logo-or">{S.brandOr}</span> <span className="logo-b">{S.brandB}</span>
            </span>
            <span className="pills">
              <span className="pill pill-demo">{S.demoLabel}</span>
              <span className="pill">{S.adultNotice}</span>
            </span>
          </div>
          <div className="top-actions">
            <button type="button" className="icon-btn" onClick={toggleSound} aria-label={muted ? S.soundOff : S.soundOn} title={muted ? S.soundOff : S.soundOn}>{muted ? "🔇" : "🔊"}</button>
            <button type="button" className="icon-btn" onClick={() => setShowGlossary(true)} aria-label={S.glossary} title={S.glossary}>?</button>
            <button type="button" className={`icon-btn gear ${showSettings ? "gear-on" : ""}`} onClick={() => setShowSettings(!showSettings)} aria-label={S.settings} aria-expanded={showSettings} title={S.settings}>⚙</button>
          </div>
        </div>
        <div className="wallet">
          <div>
            <div className="label">{S.balance}</div>
            <div className="balance">{usdk(session.balance)}</div>
          </div>
          <div className="wallet-right">
            <div className="label">{S.session}<span className="wide-only"> · {S.coinsPlayed(session.coinsPlayed)}</span></div>
            <div className={`session-net ${sessionNet >= 0n ? "up" : "down"}`}>{signedUsdk(sessionNet)}</div>
          </div>
        </div>
        <div className={`settings ${showSettings ? "open" : ""}`}>
          <div className="setting" role="group" aria-label={S.speed} title={S.paceHint(tps)}>
            <span className="label">{S.speed}</span>
            {PACES.map((p) => (
              <button key={p.id} type="button" className={`seg ${p === session.pace ? "seg-on" : ""}`} onClick={() => session.setPace(p.id)}>
                {S.paceNames[p.id]}
              </button>
            ))}
          </div>
          <div className="setting" role="group" aria-label={S.breakLabel} title={S.breakHint}>
            <span className="label">{S.breakLabel}</span>
            {BREAKS.map((b) => (
              <button key={b} type="button" className={`seg ${b === session.breakSeconds ? "seg-on" : ""}`} onClick={() => session.setBreak(b)}>
                {b}s
              </button>
            ))}
          </div>
          <button type="button" className="seg" onClick={() => { if (window.confirm(S.resetConfirm)) session.reset(); }}>{S.reset}</button>
        </div>
      </header>

      <div className="layout">
      <main className="col-main">
        <section className="cards">
          {session.lanes.map((l) => (
            <div key={l.index} className={shake === l.index ? "shake" : ""}>
              <LaneCard session={session} lane={l} focused={l.index === focus} onFocus={() => setFocus(l.index)} />
            </div>
          ))}
        </section>

        <section className={`stage p${lane.profile} ${c.status === STATUS_RUGGED ? "stage-rugged" : ""} ${c.graduated && alive ? "stage-grad" : ""} ${shake === focus ? "shake" : ""}`}>
          <div className="stage-head">
            <Avatar coin={coin} size={44} />
            <div className="stage-id">
              <div className="stage-name">
                {coin.meta.name} <span className="muted">${coin.meta.ticker}</span>
              </div>
              <div className="muted lore">{coin.meta.lore}</div>
            </div>
            <LiveMult coin={coin} className="stage-mult" />
          </div>

          <div className="stage-line">
            {lane.phase === "prelaunch" && (
              <>
                <span key={wait} className="count">{wait}</span>
                <span><b>{S.launchIn(wait)}</b> · {S.launchHint}</span>
              </>
            )}
            {lane.phase === "live" && c.event !== EVENT_NONE && (
              <span className={`event-strip e${c.event}`}>
                <span className="event-icon">{S.eventIcons[c.event]}</span>
                <span>
                  <b><Term k={EVENT_TERMS[c.event]!}>{S.events[c.event]}</Term></b> — {S.eventEffects[c.event]}
                </span>
                <span className="event-left">{Math.ceil(c.eventLeft / tps)}s</span>
              </span>
            )}
            {lane.phase === "live" && c.event === EVENT_NONE && c.graduated && (
              <span className="event-strip grad">
                <span className="event-icon">★</span>
                <span><b><Term k="graduated">{S.graduated}</Term></b> — {S.graduatedEffect}</span>
              </span>
            )}
            {lane.phase === "live" && c.event === EVENT_NONE && !c.graduated && (
              <>
                <span className="live-dot" /> <span className="muted">{S.timeLeft}</span> <b>{clock(secondsLeft)}</b>
                <span className="bar"><span style={{ width: `${100 - (100 * c.tick) / maxTicks}%` }} /></span>
              </>
            )}
            {lane.phase === "cooldown" && ended !== null && (
              <>
                <span><b>{endLine(ended)}</b> · {S.nextCoinIn(wait + Math.max(0, session.breakSeconds - 3))}</span>
                <button type="button" className="link" onClick={() => setVerifying(ended)}>{S.verifyOpen}</button>
              </>
            )}
          </div>

          <div className="chart-wrap">
            <Chart history={coin.history} marks={coin.marks} rugged={c.status === STATUS_RUGGED} version={session.version} />
            {c.status === STATUS_RUGGED && <div className="rug-stamp">{S.rugged}</div>}
            {c.status === STATUS_SETTLED && <div className="settle-note">{S.settled}</div>}
            {lane.phase === "cooldown" && ended !== null && ended.staked > 0n && (
              <div className={`coin-result ${endedNet >= 0n ? "up" : "down"}`}>
                <span className="label">{S.coinNet}</span>
                {signedUsdk(endedNet)}
              </div>
            )}
          </div>

          <div className="class-box">
            <div className="class-title">
              <Risk profile={lane.profile} />
              <Term k={PROFILE_TERMS[lane.profile]!}>{S.profiles[lane.profile]}</Term>
              <span className="class-risk">{S.profileRisk[lane.profile]}</span>
            </div>
            <div className="class-facts">
              <span>{S.profileSwing(swingPct(session, lane.profile))}</span>
              <span>{S.profileLife(lifeSeconds(session, lane.profile))}</span>
            </div>
          </div>

          <div className="bag">
            {bag.stake === 0n ? (
              <span className="muted">{S.noBag}</span>
            ) : (
              <>
                <div><span className="label">{S.staked}</span>{usdk(bag.stake)}</div>
                <div><span className="label">{S.takenOut}</span>{usdk(bag.paid)}</div>
                <div><span className="label">{S.worthNow}</span>{usdk(bag.value)}</div>
                <div className={result >= 0n ? "up" : "down"}><span className="label">{S.resultNow}</span>{signedUsdk(result)}</div>
              </>
            )}
          </div>
        </section>

        {rugTip && session.firstRugSeen && (
          <div className="tip tip-rug">
            <p>{S.rugExplainer}</p>
            <button type="button" className="btn btn-ghost" onClick={() => { setRugTip(false); store("aor.rug"); }}>{S.tutorialNext}</button>
          </div>
        )}
        {tip !== null && (
          <div className="tip">
            <b>{tip.title}</b>
            <p>{tip.text}</p>
            <div className="tip-actions">
              {tipStep > 0 && <button type="button" className="btn btn-ghost" onClick={() => (tipStep >= S.tutorial.length - 1 ? endTips() : setTipStep(tipStep + 1))}>{S.tutorialNext}</button>}
              <button type="button" className="btn btn-ghost" onClick={endTips}>{S.tutorialSkip}</button>
            </div>
          </div>
        )}

      </main>

      <aside className="col-side">
        <section className="panel">
          <h3>{S.compareTitle}</h3>
          <Compare session={session} />
        </section>

        <section className="panel">
          <h3>{S.historyTitle}</h3>
          {session.history.length === 0 ? <p className="muted">{S.historyEmpty}</p> : (
            <ul className="history">
              {session.history.map((f) => (
                <li key={f.id} className={`p${f.profile}`}>
                  <Avatar coin={f} size={24} />
                  <span className="history-main">
                    <b>${f.meta.ticker}</b> <span className="history-class">{S.profiles[f.profile]}</span>
                    <span className="muted"> · {endLine(f)} · {S.peak(mult(f.peak))} · {S.life(Math.round(f.ticks / tps))}</span>
                  </span>
                  <span className={`history-net ${f.staked === 0n ? "muted" : f.paid >= f.staked ? "up" : "down"}`}>{f.staked === 0n ? S.noStake : signedUsdk(f.paid - f.staked)}</span>
                  <button type="button" className="link" onClick={() => setVerifying(f)}>{S.verifyShort}</button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel feed">
          <h3>{S.feedTitle}</h3>
          {feedLines.length === 0 ? <p className="muted">{S.feedEmpty}</p> : (
            <ul>
              {feedLines.map((f) => (
                <li key={f.id} className={`feed-${f.kind}`}>{feedText(f)}</li>
              ))}
            </ul>
          )}
        </section>
        <p className="muted footnote">
          <Term k="seed">{S.commitLabel}</Term> ${coin.meta.ticker}: <code title={lane.commit}>{lane.commit.slice(0, 16)}…</code>
          <br />
          {S.demoNote}
        </p>
      </aside>

      <footer className="controls">
        <div className="pops" aria-live="polite">
          {pops.map((p) => (
            <div key={p.id} className={`pop pop-${p.tone}`}>{p.text}</div>
          ))}
        </div>
        {error !== null && <div className="toast" role="alert">{error}</div>}
        {hasOpen && alive && (
          <div className="row">
            <button type="button" className={`btn btn-cash ${result >= 0n ? "cash-up" : "cash-down"}`} onClick={() => onSell(session.sellAll(focus))}>
              <span className="btn-main">{S.sellAll} {usdk(bag.value)}</span>
              <span className="btn-sub">{signedUsdk(result)} · ${coin.meta.ticker} at {mult(c.price)}</span>
            </button>
            <button type="button" className="btn btn-side" onClick={() => onSell(session.sell(focus, 5000n))}>{S.sellHalf}</button>
            <button type="button" className="btn btn-side" disabled={!bag.canInitials} title={S.takeInitialsHint} onClick={() => onSell(session.takeInitials(focus))}>{S.takeInitials}</button>
          </div>
        )}
        <div className="stakes" role="group" aria-label={S.stake}>
          {STAKES.map((s) => (
            <button key={String(s)} type="button" className={`chip ${s === stake ? "chip-on" : ""}`} onClick={() => setStake(s)}>{chip(s)}</button>
          ))}
        </div>
        <div className="row">
          <button type="button" className={`btn btn-buy ${hasOpen && alive ? "btn-buy-more" : ""}`} disabled={!alive} onClick={onBuy}>
            <span className="btn-main">{alive ? (hasOpen ? S.buyMore : S.buyCta) : S.buyClosed}</span>
            <span className="btn-sub">{alive ? S.buySub(coin.meta.ticker, usdk(stake), mult(c.price)) : S.nextCoinIn(wait + Math.max(0, session.breakSeconds - 3))}</span>
          </button>
          {lane.phase === "prelaunch" && <button type="button" className="btn btn-side" onClick={() => session.skipWait(focus)}>{S.startNow}</button>}
        </div>
        <div className="muted fee">
          <Term k="fee">{S.fee}</Term> · <Term k="odds" /> · <Term k="initials" />
        </div>
      </footer>
      </div>

      {verifying !== null && <VerifyView session={session} coin={verifying} onClose={() => setVerifying(null)} />}
      {showGlossary && <Glossary session={session} onClose={() => setShowGlossary(false)} />}
    </div>
  );
}
