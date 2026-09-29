import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import type { AppSettings } from "../../shared/contracts";
import {
  DEFAULT_POWER_EFFICIENCY,
  effectivePowerEfficiency,
  formatWorkers,
  offeredPowerEfficiencies,
  POWER_EFFICIENCY_PRESETS,
  powerEfficiencyAvailable,
  powerEfficiencyLabel,
  powerEfficiencyName,
  powerEfficiencySignal,
  powerEfficiencyWorkers,
  type PowerEfficiency,
} from "../../shared/powerEfficiency";
import { dispatchSettingsUpdated, SETTINGS_UPDATED_EVENT } from "../lib/uiEvents";
import { nativeApi } from "../nativeApi";
import { toast } from "./Toasts";

/**
 * What the tooltip says the choice costs, where the gauge alone cannot.
 * Measured with the native scanner on an 18-CPU M5 Max, whole `/` (21.6M
 * files, medians of 3): 8 workers finished about 20% sooner than Balanced's
 * 4, while 18 saved only another 2% and used about 65% more CPU time
 * (DEFAULT_POWER_EFFICIENCY has the numbers). Elsewhere the fans are a
 * likely cost, not a measured one.
 */
export function powerTradeoff(platform: string): string {
  const fans = platform === "darwin" ? "runs the fans at full speed" : "can run the fans at full speed";
  return `Aggressive finishes about 20% sooner than Balanced. Maximum saves little more time but uses about 65% more CPU, and ${fans}.`;
}

const TOOLTIP_DELAY_MS = 450;

/** Keyboard focus shows the tooltip; a click's focus doesn't. */
function isFocusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
}
const EDGE = 8;
const FLOATING_GAP = 4;

interface FloatingAnchor {
  top?: number;
  bottom?: number;
  right: number;
}

interface MenuButtonProps {
  preset: PowerEfficiency;
  cpus: number;
  onChoose: (preset: PowerEfficiency) => void;
  platform?: string;
}

/**
 * A framed signal gauge and a chevron. The menu lists the four presets
 * with a share-of-CPUs bar and the worker count each runs here; a preset
 * this machine can't tell apart from the one below it is shown but not
 * offered.
 */
export function PowerEfficiencyMenuButton({ preset, cpus, onChoose, platform = nativeApi.platform }: MenuButtonProps) {
  const current = effectivePowerEfficiency(preset, cpus);
  const workers = powerEfficiencyWorkers(preset, cpus);
  const name = powerEfficiencyName(current);
  const lit = powerEfficiencySignal(workers, cpus);

  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Focus handed back by the menu is not a reason to show the tooltip. */
  const refocusing = useRef(false);
  /** The highlighted row while the menu is open, or null when closed. */
  const [highlighted, setHighlighted] = useState<PowerEfficiency | null>(null);
  const [tipOpen, setTipOpen] = useState(false);
  const [anchor, setAnchor] = useState<FloatingAnchor | null>(null);
  const open = highlighted !== null;

  const measure = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const right = Math.max(EDGE, window.innerWidth - rect.right);
    const menuHeight = menuRef.current?.getBoundingClientRect().height ?? 0;
    const belowTop = rect.bottom + FLOATING_GAP;
    const belowFits = menuHeight === 0 || belowTop + menuHeight <= window.innerHeight - EDGE;
    if (!belowFits && rect.top - FLOATING_GAP - menuHeight >= EDGE) {
      setAnchor({ bottom: window.innerHeight - rect.top + FLOATING_GAP, right });
      return;
    }
    const top = menuHeight === 0
      ? belowTop
      : Math.min(belowTop, Math.max(EDGE, window.innerHeight - menuHeight - EDGE));
    setAnchor({ top, right });
  }, []);

  const clearTipTimer = () => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = null;
  };

  const close = useCallback((refocus: boolean) => {
    setHighlighted(null);
    if (refocus) {
      refocusing.current = true;
      buttonRef.current?.focus();
      refocusing.current = false;
    }
  }, []);

  const openMenu = useCallback(() => {
    clearTipTimer();
    setTipOpen(false);
    measure();
    setHighlighted(current);
  }, [current, measure]);

  const choose = useCallback((next: PowerEfficiency) => {
    if (!powerEfficiencyAvailable(next, cpus)) return;
    close(true);
    onChoose(next);
  }, [close, cpus, onChoose]);

  // An open menu takes the keys; it hands focus back when it closes.
  useLayoutEffect(() => {
    if (!open) return;
    // The first anchor renders the menu; now its real height is available
    // so it can flip above the trigger or clamp inside the viewport.
    measure();
    menuRef.current?.focus();
  }, [open, measure]);

  // A press anywhere else closes it. The button and the menu are both in
  // the wrapper, so pressing the button again leaves it to the click,
  // which closes it, instead of closing here and reopening on the click.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close(false);
    };
    const onResize = () => close(false);
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("scroll", onResize, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("scroll", onResize, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onResize);
    };
  }, [open, close]);

  useEffect(() => clearTipTimer, []);

  const onMenuKey = (event: KeyboardEvent) => {
    if (highlighted === null) return;
    const offered = offeredPowerEfficiencies(cpus);
    const at = POWER_EFFICIENCY_PRESETS.indexOf(highlighted);
    const step = (forward: boolean): PowerEfficiency => {
      const next = forward
        ? offered.find((p) => POWER_EFFICIENCY_PRESETS.indexOf(p) > at)
        : [...offered].reverse().find((p) => POWER_EFFICIENCY_PRESETS.indexOf(p) < at);
      return next ?? highlighted;
    };
    switch (event.key) {
      case "ArrowDown":
      case "j":
        setHighlighted(step(true));
        break;
      case "ArrowUp":
      case "k":
        setHighlighted(step(false));
        break;
      case "Home":
        setHighlighted(offered[0]);
        break;
      case "End":
        setHighlighted(offered[offered.length - 1]);
        break;
      case "Enter":
      case " ":
        choose(highlighted);
        break;
      case "Escape":
        close(true);
        break;
      case "Shift":
      case "Control":
      case "Alt":
      case "Meta":
        // The first half of a chord, not a key of its own.
        return;
      default:
        // Anything else closes the menu and carries on to the app.
        close(true);
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onButtonKey = (event: KeyboardEvent) => {
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      openMenu();
    }
  };

  const showTipSoon = () => {
    if (open) return;
    clearTipTimer();
    tipTimer.current = setTimeout(() => {
      measure();
      setTipOpen(true);
    }, TOOLTIP_DELAY_MS);
  };
  const hideTip = () => {
    clearTipTimer();
    setTipOpen(false);
  };

  const summary = `${formatWorkers(workers)} of ${cpus} CPUs`;

  return (
    <div className="power-control" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`power-btn${open ? " open" : ""}`}
        aria-label={`Power Efficiency: ${name}, ${summary}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close(true) : openMenu())}
        onKeyDown={onButtonKey}
        onMouseEnter={showTipSoon}
        onMouseLeave={hideTip}
        onFocus={(event) => {
          if (!refocusing.current && isFocusVisible(event.currentTarget as HTMLElement)) showTipSoon();
        }}
        onBlur={hideTip}
      >
        <span className="power-gauge" aria-hidden="true" data-lit={lit}>
          {POWER_EFFICIENCY_PRESETS.map((p, index) => (
            <i key={p} className={index < lit ? "lit" : undefined} />
          ))}
        </span>
        <svg className="power-chevron" width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M1.5 3L4 5.5L6.5 3" />
        </svg>
      </button>

      {/* An open menu says it all; the tooltip would only cover it. */}
      {tipOpen && !open && anchor && (
        <div
          className="power-tip"
          role="tooltip"
          style={{
            top: anchor.top === undefined ? undefined : `${anchor.top}px`,
            right: `${anchor.right}px`,
          }}
        >
          <div className="power-tip-title">Power Efficiency: {name}</div>
          <div className="power-tip-count">{summary}</div>
          <div className="power-tip-body">{powerTradeoff(platform)}</div>
          <div className="power-tip-body">Used from the next scan, and remembered.</div>
        </div>
      )}

      {open && anchor && (
        <div
          ref={menuRef}
          className="power-menu"
          role="menu"
          aria-label="Power Efficiency"
          tabIndex={-1}
          aria-activedescendant={`power-item-${highlighted}`}
          style={{
            top: anchor.top === undefined ? undefined : `${anchor.top}px`,
            bottom: anchor.bottom === undefined ? undefined : `${anchor.bottom}px`,
            right: `${anchor.right}px`,
          }}
          onKeyDown={onMenuKey}
        >
          <div className="power-menu-head" aria-hidden="true">
            <span>Scan workers</span>
            <span>{cpus} CPUs</span>
          </div>
          {POWER_EFFICIENCY_PRESETS.map((p, index) => {
            const offered = powerEfficiencyAvailable(p, cpus);
            const count = powerEfficiencyWorkers(p, cpus);
            const below = index > 0 ? powerEfficiencyName(POWER_EFFICIENCY_PRESETS[index - 1]) : "";
            const classes = [
              "power-menu-item",
              p === current ? "current" : "",
              p === highlighted && offered ? "highlighted" : "",
            ].filter(Boolean).join(" ");
            return (
              <div
                key={p}
                id={`power-item-${p}`}
                className={classes}
                role="menuitemradio"
                aria-checked={p === current}
                aria-disabled={!offered}
                title={offered ? undefined : `Same as ${below} with ${cpus} CPUs`}
                onMouseEnter={() => { if (offered) setHighlighted(p); }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(p)}
              >
                <span className="power-menu-check" aria-hidden="true">
                  {p === current && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="2.5,6.5 5,9 9.5,3.5" />
                    </svg>
                  )}
                </span>
                <span className="power-menu-name">{powerEfficiencyName(p)}</span>
                <span className="power-menu-share" aria-hidden="true">
                  <i style={{ width: `${Math.min(100, (count / Math.max(1, cpus)) * 100)}%` }} />
                </span>
                <span className="power-menu-count">{formatWorkers(count)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The saved Power Efficiency choice, kept current from settings pushes. */
export function usePowerEfficiency(): PowerEfficiency | null {
  const [preset, setPreset] = useState<PowerEfficiency | null>(null);
  useEffect(() => {
    let cancelled = false;
    void nativeApi.getSettings().then((s) => {
      if (!cancelled && s) setPreset(s.scanning.powerEfficiency ?? DEFAULT_POWER_EFFICIENCY);
    });
    const apply = (next: AppSettings | null | undefined) => {
      if (next) setPreset(next.scanning.powerEfficiency ?? DEFAULT_POWER_EFFICIENCY);
    };
    const onLocal = (event: Event) => apply((event as CustomEvent<AppSettings>).detail);
    const unsubscribe = nativeApi.onSettingsUpdated(apply);
    window.addEventListener(SETTINGS_UPDATED_EVENT, onLocal as EventListener);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener(SETTINGS_UPDATED_EVENT, onLocal as EventListener);
    };
  }, []);
  return preset;
}

interface ControlProps {
  /** Rescans the selected root now. Omitted when there's nothing to rescan. */
  onRescan?: () => void;
  /** True while a scan runs: it keeps its workers, so the notice says so. */
  scanning?: boolean;
}

/**
 * The saved control. Choosing saves the preset and leaves any running
 * scan alone; the next scan, scheduled or manual, uses it.
 */
export function PowerEfficiencyControl({ onRescan, scanning = false }: ControlProps) {
  const saved = usePowerEfficiency();
  const cpus = nativeApi.cpuCount || 1;
  const [preset, setPreset] = useState<PowerEfficiency | null>(null);
  useEffect(() => { setPreset(saved); }, [saved]);

  const onChoose = useCallback(async (next: PowerEfficiency) => {
    const previous = preset;
    setPreset(next);
    const label = powerEfficiencyLabel(next, cpus);
    try {
      const settings = await nativeApi.setPowerEfficiency(next);
      if (settings) dispatchSettingsUpdated(settings);
    } catch (error) {
      setPreset(previous);
      toast("error", "Couldn't save Power Efficiency", error instanceof Error ? error.message : String(error));
      return;
    }
    if (scanning) {
      toast("success", `${label} from the next scan`, "The running scan keeps its workers.", { id: "power-efficiency" });
    } else if (onRescan) {
      toast("success", `${label} from the next scan`, undefined, {
        id: "power-efficiency",
        action: { label: "Rescan now", run: onRescan },
      });
    } else {
      toast("success", `${label} from the next scan`, undefined, { id: "power-efficiency" });
    }
  }, [cpus, onRescan, preset, scanning]);

  if (!preset) return null;
  return <PowerEfficiencyMenuButton preset={preset} cpus={cpus} onChoose={(p) => void onChoose(p)} />;
}
