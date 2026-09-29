#!/usr/bin/env python3
"""Time whole scans at several worker counts and print the Power Efficiency table.

Each run is the release native scanner, started the way the app starts a scan
with a Power Efficiency preset: `--workers N` plus the index, folder-tree and
Dev Artifacts outputs, written to a temp dir and deleted after the run. It runs
under `/usr/bin/time`, so CPU time is the scan's own user + system seconds.
Whole-machine busy time is sampled every half second while it runs (macOS
`host_statistics`, Linux `/proc/stat`), and for 10 s before it. Rounds rotate
the order so drift in the machine or the cache does not favour one count. The
first scan is an untimed warm-up.

    scripts/bench-scan-workers.py / --workers 18 8 4 2 --rounds 3

Hold the machine quiet: a VM, an indexer or a build skews every column.
macOS and Linux only; the Windows walkers have no /usr/bin/time here.
"""

import argparse
import ctypes
import fcntl
import json
import os
import pathlib
import platform
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time

REPO = pathlib.Path(__file__).resolve().parent.parent
CRATE = REPO / "native/diskhound-native-scanner"
SCANNER = CRATE / "target/release/diskhound-native-scanner"


def cpu_ticks():
    """(busy, total) ticks for the whole machine since boot."""
    if platform.system() == "Darwin":
        lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        lib.mach_host_self.restype = ctypes.c_uint
        ticks = (ctypes.c_uint * 4)()
        count = ctypes.c_uint(4)
        # HOST_CPU_LOAD_INFO: user, system, idle, nice.
        if lib.host_statistics(lib.mach_host_self(), 3, ticks, ctypes.byref(count)):
            raise OSError("host_statistics failed")
        return sum(ticks) - ticks[2], sum(ticks)
    fields = [int(x) for x in open("/proc/stat").readline().split()[1:]]
    idle = fields[3] + fields[4]
    return sum(fields) - idle, sum(fields)


def busy_percent(before, after):
    # The Mach counters are 32-bit and wrap.
    busy, total = ((a - b) % 2**32 for a, b in zip(after, before))
    return 100 * busy / total if total else None


def percent(value):
    return "n/a" if value is None else f"{value:.0f}%"


def cpu_seconds(time_output):
    """User + system seconds from BSD or GNU `/usr/bin/time` output."""
    user = re.search(r"([\d.]+) user|User time \(seconds\): ([\d.]+)", time_output)
    system = re.search(r"([\d.]+) sys|System time \(seconds\): ([\d.]+)", time_output)
    return sum(float(next(g for g in m.groups() if g)) for m in (user, system))


def peak_rss_gib(time_output):
    match = re.search(r"(\d+)\s+maximum resident set size|Maximum resident set size \(kbytes\): (\d+)", time_output)
    if not match:
        return None
    # BSD reports bytes, GNU kilobytes.
    return int(match.group(1)) / 2**30 if match.group(1) else int(match.group(2)) / 2**20


def scan(root, workers):
    before_idle = cpu_ticks()
    time.sleep(10)
    idle_before = busy_percent(before_idle, cpu_ticks())

    out_dir = pathlib.Path(tempfile.mkdtemp(prefix="diskhound-bench-"))
    flag = "-l" if platform.system() == "Darwin" else "-v"
    env = dict(os.environ)
    # It would override --workers.
    env.pop("DISKHOUND_PARALLEL_THREADS", None)
    before = cpu_ticks()
    started = time.monotonic()
    process = subprocess.Popen(
        [
            "/usr/bin/time", flag, str(SCANNER), "--root", root, "--workers", str(workers),
            "--index-output", str(out_dir / "scan.ndjson.gz"),
            "--folder-tree-output", str(out_dir / "scan.folder-tree.ndjson.gz"),
            "--dev-artifacts-output", str(out_dir / "scan.dev-artifacts.json.gz"),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        # Its own group, so an interrupt never leaves a scan running.
        start_new_session=True,
    )
    # A whole drive streams gigabytes of progress snapshots; keep the last line.
    tail = {"last": b""}

    def drain():
        buf = b""
        for chunk in iter(lambda: process.stdout.read(1 << 20), b""):
            buf = (buf + chunk)[-(16 << 20):]
        lines = [line for line in buf.split(b"\n") if line.strip()]
        tail["last"] = lines[-1] if lines else b""

    reader = threading.Thread(target=drain)
    reader.start()
    try:
        err = process.stderr.read().decode("utf8", "replace")
        process.wait()
        reader.join()
    except BaseException:
        os.killpg(process.pid, 9)
        raise
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)
    wall = time.monotonic() - started
    if process.returncode:
        sys.exit(f"scan failed:\n{err}")
    done = json.loads(tail["last"])
    if done.get("type") != "done":
        sys.exit(f"scan did not finish:\n{err}")
    snapshot = done["snapshot"]
    return {
        "workers": workers,
        "wall": wall,
        "cpu_s": cpu_seconds(err),
        "rss_gib": peak_rss_gib(err),
        "machine": busy_percent(before, cpu_ticks()),
        "idle_before": idle_before,
        "files": snapshot["filesVisited"],
        "dirs": snapshot["directoriesVisited"],
        "bytes": snapshot["bytesSeen"],
        "skipped": snapshot["skippedEntries"],
        "walking": next((line for line in err.splitlines() if "walking with" in line), None),
    }


def preset(workers, cores):
    if workers == cores and workers > 8:
        return "Drain My Battery"
    return {2: "Miser", 4: "Balanced", 8: "Aggressive"}.get(workers, "")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("root", help="directory or volume to scan, e.g. / (what the app scans for the startup disk)")
    parser.add_argument("--workers", type=int, nargs="+", default=[os.cpu_count() or 8, 8, 4, 2])
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--out", type=pathlib.Path, help="write every run as JSON here")
    parser.add_argument("--lock", help="flock this file for the whole block")
    args = parser.parse_args()

    subprocess.run(["cargo", "build", "--release"], cwd=CRATE, check=True)
    lock = open(args.lock, "w") if args.lock else None
    if lock:
        print(f"waiting for {args.lock}", file=sys.stderr)
        fcntl.flock(lock, fcntl.LOCK_EX)
    cores = os.cpu_count() or 1
    base = max(args.workers)
    print(f"warm-up: {base} workers", file=sys.stderr)
    scan(args.root, base)
    runs = []
    for round_ in range(args.rounds):
        shift = round_ % len(args.workers)
        order = args.workers[shift:] + args.workers[:shift]
        if round_ % 2:
            order.reverse()
        for workers in order:
            run = scan(args.root, workers)
            run["round"] = round_ + 1
            # The scan's own share of every core, which background load cannot move.
            run["share"] = 100 * run["cpu_s"] / (run["wall"] * cores)
            runs.append(run)
            print(
                f"round {round_ + 1}, {workers} workers: {run['wall']:.1f} s, "
                f"{run['cpu_s']:.0f} CPU-s, machine {percent(run['machine'])} "
                f"(idle before {percent(run['idle_before'])})",
                file=sys.stderr,
            )
            if args.out:
                args.out.write_text(json.dumps(runs, indent=1))

    def median(workers, key):
        values = [r[key] for r in runs if r["workers"] == workers and r[key] is not None]
        return statistics.median(values) if values else None

    b_time, b_cpu, b_share = (median(base, k) for k in ("wall", "cpu_s", "share"))
    print(f"\nMedian of {args.rounds}; Δ against {base} workers; {cores} cores.\n")
    print("| Preset | Workers | Scan time | Δ time | CPU time | Δ CPU time | Machine used | Δ machine | Whole machine |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for workers in sorted(args.workers, reverse=True):
        t, c, s, m = (median(workers, k) for k in ("wall", "cpu_s", "share", "machine"))
        first = workers == base
        pct = lambda x, y: "baseline" if first else f"{(x - y) / y * 100:+.0f}%" if y else "n/a"
        pts = "baseline" if first else f"{s - b_share:+.0f} pts"
        print(
            f"| {preset(workers, cores)} | {workers} | {t:.0f} s | {pct(t, b_time)} | {c:,.0f} CPU-s "
            f"| {pct(c, b_cpu)} | {s:.0f}% | {pts} | {percent(m)} |"
        )


if __name__ == "__main__":
    main()
