import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { EVENT_NONE, GameSession, PACES, STAKES, STATUS_ALIVE, STATUS_RUGGED, STATUS_SETTLED } from "../game/session.ts";
import type { FeedItem, LiveCoin, Verification } from "../game/session.ts";
import { chip, clock, mult, signedUsdk, usdk } from "../game/format.ts";
import { S } from "../strings.ts";
import { Chart } from "./Chart.tsx";

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

function store(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Private mode: the tip simply shows again next time.
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

function Avatar({ coin, size }: { coin: LiveCoin; size: number }) {
  const { hue, emoji } = coin.meta;
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.56, background: `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 60) % 360} 70% 30%))` }}
      aria-hidden="true"
    >
      {emoji}
    </span>
  );
}

function CoinCard({ session, coin, focused, onFocus }: { session: GameSession; coin: LiveCoin; focused: boolean; onFocus: () => void }) {
  const c = coin.state;
  const rugged = c.status === STATUS_RUGGED;
  const bag = session.holding(coin.index);
  const open = bag.positions.some((p) => p.open);
  const result = bag.value + bag.paid - bag.stake;
  return (
    <div className={`card ${focused ? "card-focus" : ""} ${rugged ? "card-rugged" : ""} ${c.graduated ? "card-grad" : ""}`} onClick={onFocus} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onFocus()}>
      <div className="card-head">
        <Avatar coin={coin} size={30} />
        <div className="card-id">
          <div className="ticker">${coin.meta.ticker}</div>
          <span className={`badge badge-p${c.profile}`}>
            <Term k={PROFILE_TERMS[c.profile]!}>{S.profiles[c.profile]}</Term>
          </span>
        </div>
      </div>
      <div className={`card-mult ${rugged ? "down" : c.price >= 1_000_000_000n ? "up" : "down"}`}>{rugged ? S.rugged : mult(c.price)}</div>
      <Chart history={coin.history} rugged={rugged} version={session.version} compact />
      <div className="card-foot">
        {c.status === STATUS_ALIVE && c.event !== EVENT_NONE ? (
          <span className={`badge badge-e${c.event}`}>{S.events[c.event]}</span>
        ) : c.graduated && c.status === STATUS_ALIVE ? (
          <span className="badge badge-grad">{S.graduated}</span>
        ) : (
          <span className="badge badge-quiet">{c.status === STATUS_ALIVE ? S.live : c.status === STATUS_SETTLED ? "sold" : "gone"}</span>
        )}
        {bag.stake > 0n && <span className={`card-pnl ${result >= 0n ? "up" : "down"}`}>{open ? usdk(bag.value) : signedUsdk(result)}</span>}
      </div>
    </div>
  );
}

function feedText(session: GameSession, f: FeedItem): string {
  const t = session.coins[f.coin]!.meta.ticker;
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

function VerifyView({ session, onClose }: { session: GameSession; onClose: () => void }) {
  const v: Verification | null = useMemo(() => session.verify(), [session, session.roundNo, session.phase]);
  return (
    <Modal title={S.verifyTitle} onClose={onClose}>
      <p>{S.verifyIntro}</p>
      <div className="mono-label">{S.verifyCommit}</div>
      <div className="mono">{session.commit}</div>
      <div className="mono-label">{S.verifySeed}</div>
      <div className="mono">{session.revealedSeed ?? "—"}</div>
      {v !== null && (
        <>
          <p className={v.commitOk ? "check ok" : "check bad"}>{v.commitOk ? `✓ ${S.verifyCommitOk}` : `✗ ${S.verifyCommitBad}`}</p>
          <p className={v.roundOk ? "check ok" : "check bad"}>{v.roundOk ? `✓ ${S.verifyRoundOk}` : `✗ ${S.verifyRoundBad}`}</p>
          <div className="mono-label">{S.verifyHash}</div>
          <div className="mono">{v.recomputedHash}</div>
        </>
      )}
    </Modal>
  );
}

function Glossary({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={S.glossaryTitle} onClose={onClose}>
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

export function App({ seedSource = randomSeed }: { seedSource?: () => Uint8Array }) {
  const session = useMemo(() => new GameSession(seedSource), [seedSource]);
  useSyncExternalStore(session.subscribe, session.getVersion);
  const [focus, setFocus] = useState(0);
  const [stake, setStake] = useState(STAKES[2]!);
  const [error, setError] = useState<string | null>(null);
  const [showVerify, setShowVerify] = useState(false);
  const [showGlossary, setShowGlossary] = useState(false);
  const [tipStep, setTipStep] = useState(() => (remember("aor.tips") ? -1 : 0));
  const [rugTip, setRugTip] = useState(() => !remember("aor.rug"));

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

  // A new round closes the fairness view of the old one.
  useEffect(() => setShowVerify(false), [session.roundNo]);

  const coin = session.coins[focus]!;
  const c = coin.state;
  const bag = session.holding(focus);
  const hasOpen = bag.positions.some((p) => p.open);
  const alive = c.status === STATUS_ALIVE;
  const canBuy = alive && session.phase !== "ended";
  const result = bag.value + bag.paid - bag.stake;

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

  const secondsLeft = (session.engine.config.maxTicks - session.tick) / tps;
  const tip = tipStep >= 0 ? S.tutorial[tipStep]! : null;

  return (
    <div className="app">
      <header className="top">
        <div className="top-row">
          <div className="brand">
            {S.appName}
            <span className="pill pill-demo">{S.demoLabel}</span>
            <span className="pill">{S.adultNotice}</span>
          </div>
          <div className="top-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setShowGlossary(true)} aria-label={S.glossary}>?</button>
            <button type="button" className="btn btn-ghost" onClick={() => { if (window.confirm(S.resetConfirm)) session.reset(); }}>{S.reset}</button>
          </div>
        </div>
        <div className="top-row">
          <div>
            <div className="label">{S.balance}</div>
            <div className="balance">{usdk(session.balance)}</div>
          </div>
          <div className="top-right">
            <div className="label">{S.round(session.roundNo)}</div>
            <div className="timer">
              {session.phase === "countdown" ? S.startsIn(session.waitSeconds) : session.phase === "live" ? `${S.timeLeft} ${clock(secondsLeft)}` : S.nextRoundIn(session.waitSeconds)}
            </div>
          </div>
        </div>
        <div className="speed" role="group" aria-label={S.speed} title={S.paceHint(tps)}>
          <span className="label">{S.speed}</span>
          {PACES.map((p) => (
            <button key={p.id} type="button" className={`chip ${p === session.pace ? "chip-on" : ""}`} onClick={() => session.setPace(p.id)}>
              {S.paceNames[p.id]} · {p.ticksPerSecond}/s
            </button>
          ))}
        </div>
      </header>

      <main>
        <section className="cards">
          {session.coins.map((x) => (
            <CoinCard key={x.index} session={session} coin={x} focused={x.index === focus} onFocus={() => setFocus(x.index)} />
          ))}
        </section>

        <section className={`focus ${c.status === STATUS_RUGGED ? "focus-rugged" : ""}`}>
          <div className="focus-head">
            <Avatar coin={coin} size={44} />
            <div className="focus-id">
              <div className="focus-name">
                {coin.meta.name} <span className="muted">${coin.meta.ticker}</span>
              </div>
              <div className="muted lore">{coin.meta.lore}</div>
            </div>
            <div className={`focus-mult ${c.status === STATUS_RUGGED ? "down" : c.price >= 1_000_000_000n ? "up" : "down"}`}>{c.status === STATUS_RUGGED ? S.rugged : mult(c.price)}</div>
          </div>
          <Chart history={coin.history} marks={coin.marks} rugged={c.status === STATUS_RUGGED} version={session.version} />
          <div className="focus-status">
            <span className={`badge badge-p${c.profile}`}>
              <Term k={PROFILE_TERMS[c.profile]!}>{S.profiles[c.profile]}</Term>
            </span>
            <span className="muted">{S.profileHints[c.profile]}</span>
            {c.graduated && (
              <span className="badge badge-grad">
                <Term k="graduated">{S.graduated}</Term>
              </span>
            )}
            {alive && c.event !== EVENT_NONE && (
              <span className={`badge badge-e${c.event}`}>
                <Term k={EVENT_TERMS[c.event]!}>{S.events[c.event]}</Term> · {S.eventEffects[c.event]} · {Math.ceil(c.eventLeft / tps)}s
              </span>
            )}
            {c.status === STATUS_SETTLED && <span className="badge badge-quiet">{S.settled}</span>}
          </div>
          <div className="bag">
            {bag.stake === 0n ? (
              <span className="muted">{S.noBag}</span>
            ) : (
              <>
                <div><span className="label">{S.staked}</span>{usdk(bag.stake)}</div>
                <div><span className="label">{S.takenOut}</span>{usdk(bag.paid)}</div>
                <div><span className="label">{S.worthNow}</span>{usdk(bag.value)}</div>
                <div className={result >= 0n ? "up" : "down"}><span className="label">=</span>{signedUsdk(result)}</div>
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

        <section className="feed">
          <h3>{S.feedTitle}</h3>
          {session.feed.length === 0 ? <p className="muted">{S.feedEmpty}</p> : (
            <ul>
              {session.feed.slice(0, 14).map((f) => (
                <li key={f.id} className={`feed-${f.kind}`}>{feedText(session, f)}</li>
              ))}
            </ul>
          )}
        </section>
        <p className="muted footnote">{S.demoNote}</p>
      </main>

      <footer className="controls">
        {error !== null && <div className="toast" role="alert">{error}</div>}
        {session.phase === "ended" && session.summary !== null ? (
          <div className="summary">
            <div className="summary-head">
              <b>{S.summaryTitle}</b>
              <span className={session.summary.net >= 0n ? "up" : "down"}>{session.summary.staked === 0n ? S.summaryNoBets : `${S.summaryNet}: ${signedUsdk(session.summary.net)}`}</span>
            </div>
            {session.summary.best !== null && <div>{S.summaryBest(session.coins[session.summary.best.coin]!.meta.ticker, mult(session.summary.best.price))}</div>}
            {session.summary.worst !== null && <div>{S.summaryWorst(session.coins[session.summary.worst.coin]!.meta.ticker, mult(session.summary.worst.price))}</div>}
            <div className="muted">{S.summaryLength(Math.round(session.summary.ticks / tps))}</div>
            <div className="row">
              <button type="button" className="btn btn-buy" onClick={() => session.skipWait()}>{S.nextRound} · {session.waitSeconds}s</button>
              <button type="button" className="btn" onClick={() => setShowVerify(true)}>{S.verifyOpen}</button>
            </div>
          </div>
        ) : (
          <>
            <div className="stakes" role="group" aria-label={S.stake}>
              <span className="label">{S.stake}</span>
              {STAKES.map((s) => (
                <button key={String(s)} type="button" className={`chip ${s === stake ? "chip-on" : ""}`} onClick={() => setStake(s)}>{chip(s)}</button>
              ))}
            </div>
            <div className="row">
              <button type="button" className="btn btn-buy" disabled={!canBuy} onClick={onBuy}>
                {canBuy ? S.buy(coin.meta.ticker) : S.buyClosed}
              </button>
              {session.phase === "countdown" && <button type="button" className="btn" onClick={() => session.skipWait()}>{S.startNow}</button>}
            </div>
            {hasOpen && alive && (
              <div className="row">
                <button type="button" className="btn btn-sell" onClick={() => onSell(session.sellAll(focus))}>{S.sellAll} · {usdk(bag.value)}</button>
                <button type="button" className="btn" onClick={() => onSell(session.sell(focus, 5000n))}>{S.sellHalf}</button>
                <button type="button" className="btn" disabled={!bag.canInitials} onClick={() => onSell(session.takeInitials(focus))}>{S.takeInitials}</button>
              </div>
            )}
            <div className="muted fee">
              <Term k="fee">{S.fee}</Term> · <Term k="odds" /> · <Term k="initials" />
            </div>
          </>
        )}
      </footer>

      {showVerify && <VerifyView session={session} onClose={() => setShowVerify(false)} />}
      {showGlossary && <Glossary onClose={() => setShowGlossary(false)} />}
    </div>
  );
}
