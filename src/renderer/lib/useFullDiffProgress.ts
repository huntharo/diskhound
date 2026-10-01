import { useEffect, useState } from "preact/hooks";
import type { FullDiffProgress } from "../../shared/contracts";
import { nativeApi } from "../nativeApi";

/** Subscribe before reading so a window opened mid-comparison misses no update. */
export function useFullDiffProgress(): FullDiffProgress[] {
  const [progress, setProgress] = useState<FullDiffProgress[]>([]);
  useEffect(() => {
    let disposed = false;
    const accept = (incoming: FullDiffProgress) => {
      if (disposed) return;
      setProgress((previous) => {
        const samePair = (item: FullDiffProgress) => item.rootPath === incoming.rootPath
          && item.baselineId === incoming.baselineId && item.currentId === incoming.currentId;
        if (previous.some((item) => samePair(item) && item.revision >= incoming.revision)) return previous;
        return [...previous.filter((item) => !samePair(item)), incoming].slice(-32);
      });
    };
    const unsubscribe = nativeApi.onFullDiffProgress(accept);
    void nativeApi.getFullDiffProgress().then((items) => items?.forEach(accept)).catch(() => undefined);
    return () => { disposed = true; unsubscribe(); };
  }, []);
  return progress;
}
