import { spawn } from "node:child_process";

import { resolveNativeScannerBinary } from "./nativeScanner";

export interface NativeSampleProcess {
  pid: number;
  name: string;
  memoryBytes: number;
  cpuPercent: number;
  cpuPercentPerCore: number;
  exePath: string | null;
  commandLine: string | null;
  parentPid: number | null;
  readBytesTotal: number;
  writeBytesTotal: number;
}

export interface NativeSamplePayload {
  type: "sample";
  sampledAt: number;
  cpuCount: number;
  processes: NativeSampleProcess[];
}

const SAMPLE_TTL_MS = 700;
const SAMPLE_TIMEOUT_MS = 8_000;

let projectRootForSample = "";
let inflight: Promise<NativeSamplePayload | null> | null = null;
let cache: { at: number; payload: NativeSamplePayload } | null = null;

export function initNativeProcessSample(projectRoot: string): void {
  projectRootForSample = projectRoot;
}

export async function getNativeSample(): Promise<NativeSamplePayload | null> {
  if (cache && Date.now() - cache.at < SAMPLE_TTL_MS) {
    return cache.payload;
  }
  if (inflight) return inflight;
  inflight = runSample().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function runSample(): Promise<NativeSamplePayload | null> {
  const binary = resolveNativeScannerBinary(projectRootForSample);
  if (!binary) return null;

  const payload = await new Promise<NativeSamplePayload | null>((resolve) => {
    const child = spawn(binary, ["--mode", "sample"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (value: NativeSamplePayload | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, SAMPLE_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).find((row) => row.startsWith("{"));
      if (!line) {
        finish(null);
        return;
      }
      try {
        const parsed = JSON.parse(line) as NativeSamplePayload;
        if (!parsed || parsed.type !== "sample" || !Array.isArray(parsed.processes)) {
          finish(null);
          return;
        }
        finish(parsed);
      } catch {
        finish(null);
      }
    });
  });

  if (payload) {
    cache = { at: Date.now(), payload };
  }
  return payload;
}
