import { useEffect, useState } from "preact/hooks";
import { getSizeUnitBase, subscribeSizeUnits } from "./format";

/** Repaint formatted text and canvases when a settings broadcast changes units. */
export function useSizeUnitBase() {
  const [base, setBase] = useState(getSizeUnitBase);
  useEffect(() => {
    const update = () => setBase(getSizeUnitBase());
    const unsubscribe = subscribeSizeUnits(update);
    update();
    return unsubscribe;
  }, []);
  return base;
}
