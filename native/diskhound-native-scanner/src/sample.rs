//! One-shot process + disk-I/O sample for the Electron live views.
//!
//! Replaces spawning PowerShell `Get-Process` / WMI on every widget tick.
//! CPU% uses two sysinfo refreshes ~180ms apart so the first sample is
//! already a real percentage, not a zero baseline.

use serde::Serialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::{DiskUsage, Process, ProcessesToUpdate, System};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SampleProcess {
    pid: u32,
    name: String,
    memory_bytes: u64,
    cpu_percent: f32,
    cpu_percent_per_core: f32,
    exe_path: Option<String>,
    command_line: Option<String>,
    parent_pid: Option<u32>,
    read_bytes_total: u64,
    write_bytes_total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SamplePayload {
    #[serde(rename = "type")]
    kind: &'static str,
    sampled_at: u64,
    cpu_count: usize,
    processes: Vec<SampleProcess>,
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn process_name(process: &Process) -> String {
    let raw = process.name().to_string_lossy().into_owned();
    if cfg!(windows) && !raw.to_lowercase().ends_with(".exe") && !raw.is_empty() {
        format!("{raw}.exe")
    } else {
        raw
    }
}

fn disk_totals(usage: DiskUsage) -> (u64, u64) {
    (usage.total_read_bytes, usage.total_written_bytes)
}

pub fn run_sample_once() -> Result<(), String> {
    let mut sys = System::new();
    sys.refresh_cpu_all();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    std::thread::sleep(Duration::from_millis(180));
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let cpu_count = sys.cpus().len().max(1);

    let mut processes = Vec::with_capacity(sys.processes().len());
    for (pid, process) in sys.processes() {
        let pid_u32 = pid.as_u32();
        if pid_u32 == 0 {
            continue;
        }
        let per_core = process.cpu_usage().max(0.0);
        let (read_bytes_total, write_bytes_total) = disk_totals(process.disk_usage());
        let cmd = process.cmd();
        let command_line = if cmd.is_empty() {
            None
        } else {
            Some(
                cmd.iter()
                    .map(|c| c.to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join(" "),
            )
        };
        processes.push(SampleProcess {
            pid: pid_u32,
            name: process_name(process),
            memory_bytes: process.memory(),
            cpu_percent: per_core / cpu_count as f32,
            cpu_percent_per_core: per_core,
            exe_path: process.exe().map(|p| p.to_string_lossy().into_owned()),
            command_line,
            parent_pid: process.parent().map(|p| p.as_u32()),
            read_bytes_total,
            write_bytes_total,
        });
    }

    processes.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes));

    let payload = SamplePayload {
        kind: "sample",
        sampled_at: unix_ms(),
        cpu_count,
        processes,
    };
    serde_json::to_writer(std::io::stdout().lock(), &payload)
        .map_err(|e| e.to_string())?;
    println!();
    Ok(())
}
