// @vitest-environment happy-dom
import * as FS from "node:fs";
import "node:fs/promises";
import * as Path from "node:path";

import { h } from "preact";
import { act } from "preact/test-utils";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  PowerEfficiencyControl,
  PowerEfficiencyMenuButton,
} from "../renderer/components/PowerEfficiencyControl";
import { ToastProvider } from "../renderer/components/Toasts";
import type { AppSettings } from "../shared/contracts";
import {
  DEFAULT_POWER_EFFICIENCY,
  powerEfficiencyLabel,
  powerEfficiencySignal,
  powerEfficiencyWorkers,
  type PowerEfficiency,
} from "../shared/powerEfficiency";
import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { bootMainProcess, type MainProcess } from "../test/mainProcessHarness";
import { bootRenderer, button, click, one, type Renderer } from "../test/rendererHarness";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFsPromises(await importOriginal()));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentChildProcess(await importOriginal()));
vi.mock("node:worker_threads", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentWorkerThreads(await importOriginal()));
vi.mock("electron", async () =>
  (await import("../test/mainProcessHarness")).fakeElectron());
vi.mock("../shared/crashLog", async (importOriginal) =>
  (await import("../test/mainProcessHarness")).settledCrashLog(await importOriginal()));

let main: MainProcess;
let ui: Renderer;

beforeAll(async () => {
  main = await bootMainProcess();
  ui = await bootRenderer();
}, 60_000);

const menu = (root: ParentNode) => root.querySelector<HTMLElement>(".power-menu");
const row = (root: ParentNode, name: string) => {
  const match = [...root.querySelectorAll<HTMLElement>(".power-menu-item")]
    .find((item) => item.querySelector(".power-menu-name")?.textContent === name);
  if (!match) throw new Error(`no ${name} row`);
  return match;
};
const highlighted = (root: ParentNode) =>
  root.querySelector(".power-menu-item.highlighted .power-menu-name")?.textContent ?? null;
const litBars = (root: ParentNode) => root.querySelectorAll(".power-gauge i.lit").length;

async function key(target: Element, name: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  await act(() => {
    target.dispatchEvent(event);
  });
  return event;
}
async function pointer(target: Element, kind: "mousedown" | "mouseenter" | "mouseleave"): Promise<void> {
  await act(() => {
    target.dispatchEvent(new MouseEvent(kind, { bubbles: kind === "mousedown", cancelable: true }));
  });
}
/** A real press: mousedown (where outside-click handlers look), then click. */
async function press(target: Element): Promise<void> {
  await pointer(target, "mousedown");
  await click(target);
}
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

function mountButton(preset: PowerEfficiency, cpus: number) {
  const chosen: PowerEfficiency[] = [];
  const view = ui.mount(h(PowerEfficiencyMenuButton, { preset, cpus, platform: "darwin", onChoose: (p: PowerEfficiency) => chosen.push(p) }));
  return { view, chosen, trigger: one<HTMLButtonElement>(view, ".power-btn") };
}

describe("the Power Efficiency button", () => {
  it("lights one bar per offered preset up to the workers it runs", () => {
    expect(litBars(mountButton("miser", 18).view)).toBe(1);
    expect(litBars(mountButton("balanced", 18).view)).toBe(2);
    expect(litBars(mountButton("aggressive", 18).view)).toBe(3);
    expect(litBars(mountButton("drain-my-battery", 18).view)).toBe(4);
    // At 4 CPUs Balanced already runs every CPU: as full as the menu goes.
    expect(litBars(mountButton("drain-my-battery", 4).view)).toBe(2);
    const { trigger } = mountButton("balanced", 18);
    expect(trigger.getAttribute("aria-label")).toBe("Power Efficiency: Balanced, 4 workers of 18 CPUs");
    expect(trigger.textContent).toBe("");
  });

  it("shows a tooltip on hover, and hides it while the menu is open", async () => {
    const { view, trigger } = mountButton("balanced", 18);
    await pointer(trigger, "mouseenter");
    await wait(500);
    const tip = one(view, ".power-tip");
    expect(tip.textContent).toContain("Power Efficiency: Balanced");
    expect(tip.textContent).toContain("4 workers of 18 CPUs");
    expect(tip.textContent).toContain("Above Balanced");
    expect(tip.textContent).toContain("runs the fans at full speed");
    expect(tip.textContent).toContain("Used from the next scan, and remembered.");
    expect(tip.textContent).not.toMatch(/thread/i);

    await press(trigger);
    expect(menu(view)).not.toBeNull();
    expect(view.querySelector(".power-tip")).toBeNull();
    await pointer(trigger, "mouseleave");
  });

  it("opens with a caption and a row per preset, and a second press closes it", async () => {
    const { view, trigger, chosen } = mountButton("aggressive", 18);
    await press(trigger);
    const open = menu(view)!;
    expect(open.querySelector(".power-menu-head")?.textContent).toBe("Scan workers18 CPUs");
    expect([...open.querySelectorAll(".power-menu-item")].map((item) => item.textContent)).toEqual([
      "Miser2 workers", "Balanced4 workers", "Aggressive8 workers", "Drain My Battery18 workers",
    ]);
    expect(open.querySelector(".power-menu-item.current")?.textContent).toContain("Aggressive");
    expect(highlighted(view)).toBe("Aggressive");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(open);

    // The press lands inside the control, so the outside-press handler
    // leaves it to the click, which closes the menu and doesn't reopen it.
    await press(trigger);
    expect(menu(view)).toBeNull();
    expect(chosen).toEqual([]);

    await press(trigger);
    await pointer(document.body, "mousedown");
    expect(menu(view)).toBeNull();
  });

  it("chooses with the mouse, and a row this machine can't offer does nothing", async () => {
    const { view, trigger, chosen } = mountButton("aggressive", 8);
    await press(trigger);
    const drain = row(view, "Drain My Battery");
    expect(drain.getAttribute("aria-disabled")).toBe("true");
    expect(drain.title).toBe("Same as Aggressive with 8 CPUs");
    await pointer(drain, "mouseenter");
    expect(highlighted(view)).toBe("Aggressive");
    await click(drain);
    expect(chosen).toEqual([]);

    const miser = row(view, "Miser");
    await pointer(miser, "mouseenter");
    expect(highlighted(view)).toBe("Miser");
    await click(miser);
    expect(chosen).toEqual(["miser"]);
    expect(menu(view)).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("follows the keyboard, skipping presets this machine can't offer", async () => {
    const { view, trigger, chosen } = mountButton("miser", 4);
    trigger.focus();
    await key(trigger, "ArrowDown");
    const open = menu(view)!;
    expect(highlighted(view)).toBe("Miser");
    expect(row(view, "Aggressive").getAttribute("aria-disabled")).toBe("true");
    expect(row(view, "Drain My Battery").getAttribute("aria-disabled")).toBe("true");

    await key(open, "ArrowDown");
    expect(highlighted(view)).toBe("Balanced");
    // Aggressive and Drain My Battery run 4 workers here, like Balanced.
    await key(open, "ArrowDown");
    expect(highlighted(view)).toBe("Balanced");
    await key(open, "k");
    expect(highlighted(view)).toBe("Miser");
    await key(open, "End");
    expect(highlighted(view)).toBe("Balanced");
    await key(open, "Home");
    expect(highlighted(view)).toBe("Miser");
    await key(open, "j");
    await key(open, "Enter");
    expect(chosen).toEqual(["balanced"]);
    expect(menu(view)).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await click(trigger);
    await key(menu(view)!, " ");
    expect(chosen).toEqual(["balanced", "miser"]);

    await click(trigger);
    await key(menu(view)!, "Escape");
    expect(menu(view)).toBeNull();
    expect(chosen).toHaveLength(2);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on any other key and lets the key through", async () => {
    const { view, trigger, chosen } = mountButton("drain-my-battery", 18);
    const seen: string[] = [];
    const onKey = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", onKey);
    try {
      await click(trigger);
      await key(menu(view)!, "ArrowUp");
      expect(seen).toEqual([]);
      const passed = await key(menu(view)!, "f");
      expect(menu(view)).toBeNull();
      expect(passed.defaultPrevented).toBe(false);
      expect(seen).toEqual(["f"]);
      expect(chosen).toEqual([]);
    } finally {
      window.removeEventListener("keydown", onKey);
    }
  });

  it("browses the menu without IPC or disk", async () => {
    const { view, trigger } = mountButton("aggressive", 18);
    ui.takeIpc();
    const { io } = await measureFsIo(async () => {
      for (let i = 0; i < 5; i++) {
        await press(trigger);
        for (const name of ["Miser", "Balanced", "Aggressive", "Drain My Battery"]) {
          await pointer(row(view, name), "mouseenter");
        }
        await key(menu(view)!, "Home");
        await key(menu(view)!, "End");
        await key(menu(view)!, "Escape");
      }
    }, { countProcesses: true });
    expect(ui.takeIpc()).toEqual([]);
    expectIoBudget({
      scenario: "renderer-power-menu-browse",
      note: "open the Power Efficiency menu 5 times, hover every row and arrow through it, close: 0 IPC, 0 reads, 0 writes",
      io,
    });
  });
});

describe("the saved Power Efficiency control", () => {
  it("saves a choice through main, says when it applies, and offers a rescan", async () => {
    const cpus = window.diskhound!.cpuCount;
    const rescans: string[] = [];
    const view = ui.mount(h(ToastProvider, null, h(PowerEfficiencyControl, { onRescan: () => rescans.push("rescan") })));
    await ui.settle();
    expect(ui.takeIpc()).toEqual(["diskhound:get-settings"]);
    expect(litBars(view)).toBe(powerEfficiencySignal(powerEfficiencyWorkers(DEFAULT_POWER_EFFICIENCY, cpus), cpus));

    await press(one(view, ".power-btn"));
    await click(row(view, "Miser"));
    await ui.settle();
    expect(ui.takeIpc()).toEqual(["diskhound:set-power-efficiency"]);
    const saved = JSON.parse(FS.readFileSync(Path.join(main.userData, "settings.json"), "utf8")) as AppSettings;
    expect(saved.scanning.powerEfficiency).toBe("miser");
    expect(litBars(view)).toBe(1);

    const title = one(view, ".toast-title").textContent;
    expect(title).toBe(`${powerEfficiencyLabel("miser", cpus)} from the next scan`);
    await click(button(view, "Rescan now"));
    expect(rescans).toEqual(["rescan"]);
  });

  it("says a running scan keeps its workers", async () => {
    const cpus = window.diskhound!.cpuCount;
    const view = ui.mount(h(ToastProvider, null, h(PowerEfficiencyControl, { scanning: true, onRescan: () => {} })));
    await ui.settle();
    ui.takeIpc();
    await press(one(view, ".power-btn"));
    await click(row(view, "Miser"));
    await ui.settle();
    // Miser was already saved: still confirmed, and main writes nothing.
    expect(one(view, ".toast-title").textContent).toBe(`${powerEfficiencyLabel("miser", cpus)} from the next scan`);
    expect(one(view, ".toast-body").textContent).toBe("The running scan keeps its workers.");
    expect(view.querySelector(".toast-action")).toBeNull();
  });
});
