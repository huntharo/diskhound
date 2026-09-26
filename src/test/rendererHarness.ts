import { type ComponentChild, render } from "preact";
import { act } from "preact/test-utils";

import { rendererIpcState } from "./mainProcessHarness";

/**
 * Mounts real renderer components on top of the real main process from
 * `mainProcessHarness.ts`, so a test can click through a view and
 * budget the disk I/O behind it.
 *
 * The real `src/preload.ts` is loaded. The fake electron's
 * `ipcRenderer` calls main's handlers in this process, and
 * `contextBridge` puts the API on `window.diskhound`, where
 * `renderer/nativeApi.ts` looks for it. So every `nativeApi` call a
 * component makes runs the handler the app ships, and `measureFsIo`
 * counts what it reads.
 *
 * ## Wiring a test file
 *
 * The file needs a DOM, and the electron and fs mocks of a main
 * harness test:
 *
 *     // @vitest-environment happy-dom
 *     vi.mock("electron", async () =>
 *       (await import("../test/mainProcessHarness")).fakeElectron());
 *
 * Boot main first, then `bootRenderer()`. Mount with `mount()`, drive
 * the DOM with `click()` and `type()`, and `settle()` before measuring
 * so the mount's own IPC is done.
 *
 * ## Layout stubs
 *
 * happy-dom has no layout and no canvas. `ResizeObserver` reports a
 * 1200x700 box once per observed element, and `getContext("2d")`
 * returns a context whose drawing calls do nothing. That is enough for
 * the treemap to lay out its rects and hit-test the mouse.
 */

export interface Renderer {
  /** Renders into a fresh container, replacing what was mounted before. */
  mount(vnode: ComponentChild): HTMLElement;
  /** Waits until the renderer's IPC is answered and the DOM has caught up. */
  settle(): Promise<void>;
  /** Channels the renderer invoked or sent since the last call, oldest first. */
  takeIpc(): string[];
  unmount(): void;
}

export const LAYOUT_WIDTH = 1200;
export const LAYOUT_HEIGHT = 700;
const SETTLE_TIMEOUT_MS = 30_000;

let renderer: Renderer | null = null;

export async function bootRenderer(): Promise<Renderer> {
  if (renderer) return renderer;
  installLayoutStubs();
  // Imported for its side effect: it exposes window.diskhound.
  await import("../preload");

  const ipc = rendererIpcState();
  let container: HTMLElement | null = null;
  const unmount = () => {
    if (!container) return;
    const old = container;
    act(() => render(null, old));
    old.remove();
    container = null;
  };
  renderer = {
    mount(vnode) {
      unmount();
      const next = document.createElement("div");
      document.body.appendChild(next);
      act(() => render(vnode, next));
      container = next;
      return next;
    },
    async settle() {
      const startedAt = Date.now();
      let quietRounds = 0;
      while (quietRounds < 3) {
        if (Date.now() - startedAt > SETTLE_TIMEOUT_MS) {
          throw new Error(`renderer IPC did not settle in ${SETTLE_TIMEOUT_MS} ms`);
        }
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
        });
        quietRounds = ipc.rendererInflight === 0 ? quietRounds + 1 : 0;
      }
    },
    takeIpc() {
      return ipc.rendererIpc.splice(0);
    },
    unmount,
  };
  return renderer;
}

/** Clicks an element the way a user would (a checkbox toggles), and lets the view re-render. */
export async function click(element: Element): Promise<void> {
  await act(() => {
    (element as HTMLElement).click();
  });
}

/** Types into an input: sets the value and fires `input`. */
export async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Fires a mouse event at a point relative to the element's origin. */
export async function mouse(element: Element, kind: "mousemove" | "mouseleave" | "click", x = 0, y = 0): Promise<void> {
  await act(() => {
    element.dispatchEvent(new MouseEvent(kind, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
}

/** The single element matching `selector`, or a failure naming it. */
export function one<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const matches = root.querySelectorAll<T>(selector);
  if (matches.length !== 1) throw new Error(`expected 1 match for ${selector}, found ${matches.length}`);
  return matches[0]!;
}

/** The one element matching `selector` whose text contains `text`. */
export function withText<T extends Element = HTMLElement>(root: ParentNode, selector: string, text: string): T {
  const matches = [...root.querySelectorAll<T>(selector)].filter((candidate) => candidate.textContent?.includes(text));
  if (matches.length !== 1) throw new Error(`expected 1 ${selector} containing "${text}", found ${matches.length}`);
  return matches[0]!;
}

/** The button under `root` whose text is `label`, trimmed. */
export function button(root: ParentNode, label: string): HTMLButtonElement {
  const matches = [...root.querySelectorAll<HTMLButtonElement>("button")]
    .filter((candidate) => candidate.textContent?.trim() === label);
  if (matches.length !== 1) throw new Error(`expected 1 button "${label}", found ${matches.length}`);
  return matches[0]!;
}

/**
 * Node 25+ has its own `localStorage` global, undefined unless Node is
 * started with `--localstorage-file`, and vitest's happy-dom setup
 * leaves it in place. Views read preferences from it while rendering.
 */
function installLocalStorage(): void {
  try {
    window.localStorage.getItem("probe");
    return;
  } catch {
    // Missing or unusable: replace it below.
  }
  const items = new Map<string, string>();
  const storage = {
    get length() { return items.size; },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, String(value)); },
    removeItem: (key: string) => { items.delete(key); },
    clear: () => { items.clear(); },
  } as Storage;
  for (const target of new Set<object>([globalThis, window])) {
    Object.defineProperty(target, "localStorage", { value: storage, configurable: true, writable: true });
  }
}

function installLayoutStubs(): void {
  installLocalStorage();
  class LayoutResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      queueMicrotask(() => {
        const contentRect = { x: 0, y: 0, top: 0, left: 0, width: LAYOUT_WIDTH, height: LAYOUT_HEIGHT, right: LAYOUT_WIDTH, bottom: LAYOUT_HEIGHT };
        this.callback([{ target, contentRect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      });
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = LayoutResizeObserver as unknown as typeof ResizeObserver;

  const noop = () => undefined;
  const context2d = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "measureText") return (text: string) => ({ width: text.length * 6 });
      if (prop === "createRadialGradient" || prop === "createLinearGradient") return () => ({ addColorStop: noop });
      return noop;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  HTMLCanvasElement.prototype.getContext = (() => context2d) as unknown as HTMLCanvasElement["getContext"];
}
