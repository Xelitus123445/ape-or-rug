// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@ape/engine";
import { App } from "../src/ui/App.tsx";
import { S } from "../src/strings.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let n = 0;
const seedSource = (): Uint8Array => sha256(new Uint8Array([n++, 9, 9, 9]));

function button(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((b) => b.textContent!.includes(text));
}

describe("app smoke test", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom has no canvas; the chart must cope with a missing context.
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    vi.spyOn(console, "error").mockImplementation((...args) => {
      throw new Error(`console.error: ${args.join(" ")}`);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders, plays rounds, buys and sells without errors", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<App seedSource={seedSource} />));

    expect(host.textContent).toContain(S.demoLabel);
    expect(host.textContent).toContain(S.adultNotice);
    expect(host.textContent).toContain("100,000.00 USDK");
    expect(host.querySelectorAll(".card").length).toBe(3);
    expect(host.textContent).toContain(S.tutorial[0]!.title);

    expect(host.textContent).toContain(S.sameOdds);
    await act(async () => button(host, S.buyCta)!.click());
    expect(host.textContent).toContain("99,000.00 USDK");
    expect(host.textContent).toContain(S.tutorial[1]!.title);

    // Countdown, then a few live ticks.
    await act(async () => vi.advanceTimersByTime(7000));
    const sell = button(host, S.sellAll);
    if (sell !== undefined) await act(async () => sell.click());

    // Open the glossary and close it.
    await act(async () => button(host, "?")!.click());
    expect(host.textContent).toContain(S.glossaryTitle);
    await act(async () => button(host, S.close)!.click());

    // Switch speed and break while it runs.
    await act(async () => button(host, S.paceNames.turbo!)!.click());
    await act(async () => button(host, "5s")!.click());

    // Run long enough for many coins to end and relaunch on every lane.
    let verified = 0;
    for (let i = 0; i < 300; i++) {
      await act(async () => vi.advanceTimersByTime(5000));
      // Keep buying whenever the focused coin can be bought.
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
    expect(host.querySelectorAll(".history li").length).toBeGreaterThan(5);
    expect(host.querySelectorAll(".card").length).toBe(3);
    await act(async () => root.unmount());
  });
});
