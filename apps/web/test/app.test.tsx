// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/ui/App.tsx";
import { S } from "../src/strings.ts";
import { loopback } from "./loopback.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function button(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((b) => b.textContent!.includes(text));
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("app smoke test", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Node's own experimental localStorage shadows jsdom's; use a plain in-memory one.
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    });
    history.replaceState(null, "", "/");
    // jsdom has no canvas; the chart must cope with a missing context.
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    vi.spyOn(console, "error").mockImplementation((...args) => {
      throw new Error(`console.error: ${args.join(" ")}`);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks for a nickname, opens a room, plays coins, buys, sells and verifies without errors", async () => {
    const loop = loopback(3);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<App dial={loop.dial} />));

    // Lobby first.
    expect(host.textContent).toContain(S.lobbyIntro);
    const input = host.querySelector<HTMLInputElement>("#nick")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Ana");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(host, S.createRoom)!.click());
    await settle(50);

    expect(location.search).toBe("?room=loop42");
    expect(host.textContent).toContain(S.demoLabel);
    expect(host.textContent).toContain(S.adultNotice);
    expect(host.textContent).toContain("100,000.00 USDK");
    expect(host.textContent).toContain("Ana");
    expect(host.querySelectorAll(".card").length).toBe(3);
    expect(host.textContent).toContain(S.tutorial[0]!.title);

    await act(async () => button(host, S.buyCta)!.click());
    await settle(10);
    expect(host.textContent).toContain("99,000.00 USDK");
    expect(host.textContent).toContain(S.tutorial[1]!.title);
    expect(host.textContent).toContain(S.feed.buy("", "", "").slice(0, 8));

    // Countdown, then a few live ticks.
    await settle(7000);
    const sell = button(host, S.sellAll);
    if (sell !== undefined) {
      await act(async () => sell.click());
      await settle(10);
    }

    await act(async () => button(host, "?")!.click());
    expect(host.textContent).toContain(S.glossaryTitle);
    await act(async () => button(host, S.close)!.click());

    // The first player is the host and can change the room's pace and break.
    await act(async () => button(host, S.paceNames.turbo!)!.click());
    await act(async () => button(host, "5s")!.click());
    await settle(10);
    expect(loop.room()!.pace.id).toBe("turbo");
    expect(loop.room()!.breakSeconds).toBe(5);

    let verified = 0;
    for (let i = 0; i < 300; i++) {
      await settle(5000);
      const buy = button(host, S.buyCta) ?? button(host, S.buyMore);
      if (i % 7 === 0 && buy !== undefined && !buy.disabled) await act(async () => buy.click());
      const verify = button(host, S.verifyShort);
      if (verify !== undefined && verified < 3) {
        verified++;
        await act(async () => verify.click());
        expect(host.textContent).toContain(S.verifyCommitOk);
        expect(host.textContent).toContain(S.verifyRoundOk);
        await act(async () => button(host, S.close)!.click());
      }
    }
    expect(verified).toBe(3);
    expect(host.querySelectorAll(".history li").length).toBeGreaterThan(3);
    expect(host.querySelectorAll(".card").length).toBe(3);
    await act(async () => root.unmount());
  });

  it("goes straight into the room from an invite link with a saved nickname, and shows a full room", async () => {
    const loop = loopback(4);
    localStorage.setItem("aor.nick", "Bo");
    history.replaceState(null, "", "/?room=abcdef");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<App dial={loop.dial} />));
    await settle(50);
    expect(loop.room()!.code).toBe("abcdef");
    expect(host.querySelectorAll(".card").length).toBe(3);
    // Fill the room from outside, then a new tab gets the full-room message.
    for (const nick of ["Cy", "Dee", "Eli", "Fay"]) expect(loop.room()!.join(nick, null).ok).toBe(true);
    await act(async () => root.unmount());
    sessionStorage.removeItem("aor.seat.abcdef");
    const second = createRoot(host);
    await act(async () => second.render(<App dial={loop.dial} />));
    await settle(50);
    // Bo's seat is held, so the room is still full for a stranger.
    expect(host.textContent).toContain(S.fatal.room_full);
    expect(button(host, S.newRoom)).toBeDefined();
    await act(async () => second.unmount());
  });
});
