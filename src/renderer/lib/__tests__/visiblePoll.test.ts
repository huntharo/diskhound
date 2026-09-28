import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWindowVisibility, startVisiblePoll, type VisibilityTarget } from "../visiblePoll";

class FakeDocument implements VisibilityTarget {
  hidden = false;
  private readonly listeners = new Set<() => void>();
  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.delete(listener);
  }
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

const MINUTE = 60_000;

describe("startVisiblePoll", () => {
  let doc: FakeDocument;
  let ticks: number;
  const tick = () => { ticks++; };

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new FakeDocument();
    ticks = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks on its interval while visible", () => {
    startVisiblePoll(tick, 10_000, { target: doc });
    vi.advanceTimersByTime(MINUTE);
    expect(ticks).toBe(6);
  });

  it("does not tick for 10 minutes hidden in the tray", () => {
    startVisiblePoll(tick, 3_000, { target: doc });
    doc.setHidden(true);
    vi.advanceTimersByTime(10 * MINUTE);
    expect(ticks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ticks at once when shown again, then resumes its interval", () => {
    startVisiblePoll(tick, 10_000, { target: doc });
    vi.advanceTimersByTime(9_000);
    doc.setHidden(true);
    vi.advanceTimersByTime(10 * MINUTE);
    doc.setHidden(false);
    expect(ticks).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(ticks).toBe(2);
  });

  it("waits to start when created hidden, even with immediate", () => {
    doc.hidden = true;
    startVisiblePoll(tick, 10_000, { target: doc, immediate: true });
    vi.advanceTimersByTime(MINUTE);
    expect(ticks).toBe(0);
    doc.setHidden(false);
    expect(ticks).toBe(1);
  });

  it("ticks at once with immediate when created visible", () => {
    startVisiblePoll(tick, 10_000, { target: doc, immediate: true });
    expect(ticks).toBe(1);
  });

  it("ignores a repeated visible event rather than doubling the timer", () => {
    startVisiblePoll(tick, 10_000, { target: doc });
    doc.setHidden(false);
    doc.setHidden(false);
    expect(ticks).toBe(0);
    vi.advanceTimersByTime(MINUTE);
    expect(ticks).toBe(6);
  });

  it("stops the timer and the listener", () => {
    const stop = startVisiblePoll(tick, 10_000, { target: doc });
    stop();
    doc.setHidden(true);
    doc.setHidden(false);
    vi.advanceTimersByTime(MINUTE);
    expect(ticks).toBe(0);
    expect(doc.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

class FakeMain {
  shown: boolean | null = true;
  private readonly listeners = new Set<(shown: boolean) => void>();
  isWindowShown = vi.fn(() => Promise.resolve(this.shown as boolean));
  onWindowShownChanged = (listener: (shown: boolean) => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  send(shown: boolean): void {
    this.shown = shown;
    for (const listener of this.listeners) listener(shown);
  }
}

// The main window hidden to the tray still reads document.visibilityState
// "visible" (main's background switches), so main reports it instead.
describe("createWindowVisibility", () => {
  let doc: FakeDocument;
  let main: FakeMain;
  let ticks: number;
  const tick = () => { ticks++; };

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new FakeDocument();
    main = new FakeMain();
    ticks = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauses polls while main says the window is hidden, though the page says visible", () => {
    const target = createWindowVisibility(main, doc);
    startVisiblePoll(tick, 10_000, { target });
    main.send(false);
    vi.advanceTimersByTime(10 * MINUTE);
    expect(doc.hidden).toBe(false);
    expect(ticks).toBe(0);
    main.send(true);
    expect(ticks).toBe(1);
  });

  it("pauses when the page itself is hidden", () => {
    const target = createWindowVisibility(main, doc);
    startVisiblePoll(tick, 10_000, { target });
    doc.setHidden(true);
    vi.advanceTimersByTime(MINUTE);
    expect(ticks).toBe(0);
  });

  it("asks main once, on first use, for a window that launched to the tray", async () => {
    main.shown = false;
    const target = createWindowVisibility(main, doc);
    expect(main.isWindowShown).not.toHaveBeenCalled();
    startVisiblePoll(tick, 10_000, { target });
    startVisiblePoll(tick, 3_000, { target });
    await Promise.resolve();
    vi.advanceTimersByTime(10 * MINUTE);
    expect(ticks).toBe(0);
    expect(main.isWindowShown).toHaveBeenCalledTimes(1);
  });

  it("stays shown when there is no bridge to ask", async () => {
    main.shown = null;
    const target = createWindowVisibility(main, doc);
    startVisiblePoll(tick, 10_000, { target });
    await Promise.resolve();
    vi.advanceTimersByTime(MINUTE);
    expect(ticks).toBe(6);
  });
});
