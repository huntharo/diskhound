//! One-shot process + disk-I/O sample for the Electron live views.
//!
//! Replaces spawning PowerShell `Get-Process` / WMI on every widget tick.
//! CPU% uses two sysinfo refreshes ~180ms apart so the first sample is
//! already a real percentage, not a zero baseline.

use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::{DiskUsage, Process, ProcessesToUpdate, System, ThreadKind};

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

/// One `/proc` entry before userland threads are folded into their process.
///
/// On Linux, sysinfo lists every thread as its own process. A thread's
/// `statm` repeats the process RSS, and `/proc/<pid>/task/<tid>/io`
/// repeats the process I/O counters. Summing those rows counts one
/// Chrome or Node process once per thread, which is how a machine with
/// 126 GB of RAM shows "794 GB" for `ThreadPoolForeg`. CPU time in
/// `stat` is per thread, so that part is added onto the process.
struct TaskSample {
    pid: u32,
    parent_pid: Option<u32>,
    userland_thread: bool,
    name: String,
    memory_bytes: u64,
    /// sysinfo's `cpu_usage`: 100 means one busy core.
    cpu_usage: f32,
    exe_path: Option<String>,
    command_line: Option<String>,
    read_bytes_total: u64,
    write_bytes_total: u64,
}

fn collapse_userland_threads(tasks: Vec<TaskSample>, cpu_count: usize) -> Vec<SampleProcess> {
    let cores = cpu_count.max(1) as f32;
    let mut thread_cpu: HashMap<u32, f32> = HashMap::new();
    let mut processes = Vec::new();
    for task in tasks {
        if task.userland_thread {
            if let Some(parent) = task.parent_pid {
                *thread_cpu.entry(parent).or_insert(0.0) += task.cpu_usage.max(0.0);
            }
            continue;
        }
        processes.push(task);
    }

    let mut out = Vec::with_capacity(processes.len());
    for task in processes {
        let per_core = (task.cpu_usage.max(0.0) + thread_cpu.remove(&task.pid).unwrap_or(0.0))
            .clamp(0.0, cores * 100.0);
        out.push(SampleProcess {
            pid: task.pid,
            name: task.name,
            memory_bytes: task.memory_bytes,
            cpu_percent: per_core / cores,
            cpu_percent_per_core: per_core,
            exe_path: task.exe_path,
            command_line: task.command_line,
            parent_pid: task.parent_pid,
            read_bytes_total: task.read_bytes_total,
            write_bytes_total: task.write_bytes_total,
        });
    }
    out.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes));
    out
}

pub fn run_sample_once() -> Result<(), String> {
    let mut sys = System::new();
    sys.refresh_cpu_all();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    std::thread::sleep(Duration::from_millis(180));
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let cpu_count = sys.cpus().len().max(1);

    let mut tasks = Vec::with_capacity(sys.processes().len());
    for (pid, process) in sys.processes() {
        let pid_u32 = pid.as_u32();
        if pid_u32 == 0 {
            continue;
        }
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
        tasks.push(TaskSample {
            pid: pid_u32,
            parent_pid: process.parent().map(|p| p.as_u32()),
            userland_thread: process.thread_kind() == Some(ThreadKind::Userland),
            name: process_name(process),
            memory_bytes: process.memory(),
            cpu_usage: process.cpu_usage(),
            exe_path: process.exe().map(|p| p.to_string_lossy().into_owned()),
            command_line,
            read_bytes_total,
            write_bytes_total,
        });
    }

    let processes = collapse_userland_threads(tasks, cpu_count);

    let payload = SamplePayload {
        kind: "sample",
        sampled_at: unix_ms(),
        cpu_count,
        processes,
    };
    serde_json::to_writer(std::io::stdout().lock(), &payload).map_err(|e| e.to_string())?;
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(
        pid: u32,
        parent: Option<u32>,
        userland_thread: bool,
        name: &str,
        memory_bytes: u64,
        cpu_usage: f32,
    ) -> TaskSample {
        TaskSample {
            pid,
            parent_pid: parent,
            userland_thread,
            name: name.to_string(),
            memory_bytes,
            cpu_usage,
            exe_path: None,
            command_line: None,
            read_bytes_total: 10,
            write_bytes_total: 20,
        }
    }

    #[test]
    fn thread_rss_is_counted_once_on_the_process() {
        let rows = collapse_userland_threads(
            vec![
                task(1, Some(0), false, "chrome", 2_000, 10.0),
                task(2, Some(1), true, "ThreadPoolForeg", 2_000, 40.0),
                task(3, Some(1), true, "ThreadPoolForeg", 2_000, 25.0),
            ],
            4,
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 1);
        assert_eq!(rows[0].name, "chrome");
        assert_eq!(rows[0].memory_bytes, 2_000);
        assert_eq!(rows[0].read_bytes_total, 10);
        assert_eq!(rows[0].write_bytes_total, 20);
        assert!((rows[0].cpu_percent - 18.75).abs() < 0.01);
        assert!((rows[0].cpu_percent_per_core - 75.0).abs() < 0.01);
    }

    #[test]
    fn a_thread_with_no_process_row_is_dropped() {
        let rows = collapse_userland_threads(
            vec![
                task(5, Some(99), true, "tokio-rt-worker", 9_000, 50.0),
                task(6, None, false, "diskhound", 100, 1.0),
            ],
            1,
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 6);
        assert_eq!(rows[0].memory_bytes, 100);
    }

    #[test]
    fn processes_that_share_a_name_stay_separate() {
        let rows = collapse_userland_threads(
            vec![
                task(10, Some(1), false, "chrome", 500, 1.0),
                task(11, Some(1), false, "chrome", 800, 1.0),
            ],
            2,
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].memory_bytes, 800);
        assert_eq!(rows[1].memory_bytes, 500);
    }
}
