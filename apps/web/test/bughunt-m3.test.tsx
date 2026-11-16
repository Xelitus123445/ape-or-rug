// @vitest-environment jsdom
// Bug-hunter reproduction for M3 UI copy. Expected to fail until fixed.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/ui/App.tsx";
import type { Dial, SocketHandlers } from "../src/net/connection.ts";
import { S } from "../src/strings.ts";
import { loopback } from "./loopback.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("bughunt M3 U1: a seat closed by the server mid-game is not shown as 'reconnecting'", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    });
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("after 'replaced' (room opened in another tab) the page says so and offers a way out, instead of a banner that never resolves", async () => {
    const loop = loopback(5);
    let last: SocketHandlers | null = null;
    const dial: Dial = (h) => {
      last = h;
      return loop.dial(h);
    };
    localStorage.setItem("aor.nick", "Ana");
    history.replaceState(null, "", "/?room=abcdef");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<App dial={dial} />));
    await settle(50);
    expect(host.querySelectorAll(".card").length).toBe(3);
    // What server.ts sends to the older socket when the same seat connects from another tab.
    await act(async () => {
      last!.message(JSON.stringify([{ t: "error", error: "replaced" }]));
      last!.close();
    });
    await settle(30_000);
    expect(host.textContent).toContain(S.fatal.replaced);
    expect(host.textContent).not.toContain(S.reconnecting);
    await act(async () => root.unmount());
  });
});
