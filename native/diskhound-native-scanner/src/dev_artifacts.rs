//! Compact Dev Artifacts accumulator — same classification rules as
//! `src/shared/devArtifacts.ts`. Runs on the index-writer thread so
//! every emitted file (MFT, walker, inherit) is classified once.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[derive(Clone, Copy)]
enum Kind {
    Worktree,
    NodeModules,
    PackageCache,
    RustTarget,
    CargoRegistry,
    JsBuild,
    Python,
    GoModule,
    Jvm,
    Dotnet,
    CompilerCache,
    CmakeBuild,
    Terraform,
    DiagLogs,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Worktree => "worktree",
            Kind::NodeModules => "node-modules",
            Kind::PackageCache => "package-cache",
            Kind::RustTarget => "rust-target",
            Kind::CargoRegistry => "cargo-registry",
            Kind::JsBuild => "js-build",
            Kind::Python => "python",
            Kind::GoModule => "go-module",
            Kind::Jvm => "jvm",
            Kind::Dotnet => "dotnet",
            Kind::CompilerCache => "compiler-cache",
            Kind::CmakeBuild => "cmake-build",
            Kind::Terraform => "terraform",
            Kind::DiagLogs => "diag-logs",
        }
    }
}

struct AccRec {
    kind: Kind,
    size: u64,
    files: u64,
}

pub struct DevArtifactAcc {
    artifacts: HashMap<String, AccRec>,
    projects: HashSet<String>,
}

impl DevArtifactAcc {
    pub fn new() -> Self {
        Self {
            artifacts: HashMap::new(),
            projects: HashSet::new(),
        }
    }

    pub fn root_count(&self) -> usize {
        self.artifacts.values().filter(|rec| rec.size > 0).count()
    }

    pub fn add(&mut self, path: &str, size: u64, extra_hardlink: bool) {
        if let Some(name) = file_name(path) {
            if is_project_marker(name) {
                if let Some(dir) = parent_path(path) {
                    self.projects.insert(dir);
                }
            }
        }
        let Some((root, kind)) = classify(path) else {
            return;
        };
        let occupancy = if extra_hardlink { 0 } else { size };
        let entry = self.artifacts.entry(root).or_insert(AccRec {
            kind,
            size: 0,
            files: 0,
        });
        entry.size = entry.size.saturating_add(occupancy);
        entry.files = entry.files.saturating_add(1);
    }
}

#[derive(Serialize)]
struct SidecarFile {
    version: u32,
    #[serde(rename = "rootPath")]
    root_path: String,
    #[serde(rename = "generatedAt")]
    generated_at: u64,
    roots: Vec<SidecarRoot>,
    projects: Vec<String>,
}

#[derive(Serialize)]
struct SidecarRoot {
    path: String,
    kind: String,
    size: u64,
    files: u64,
}

const ROOT_CAP: usize = 2500;

pub fn write_sidecar(output: &Path, scan_root: &str, acc: &DevArtifactAcc) -> io::Result<()> {
    let mut roots: Vec<SidecarRoot> = acc
        .artifacts
        .iter()
        .filter(|(_, rec)| rec.size > 0)
        .map(|(path, rec)| SidecarRoot {
            path: path.clone(),
            kind: rec.kind.as_str().to_string(),
            size: rec.size,
            files: rec.files,
        })
        .collect();
    roots.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
    if roots.len() > ROOT_CAP {
        roots.truncate(ROOT_CAP);
    }
    let projects = projects_for_roots(&acc.projects, &roots);
    let generated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let sidecar = SidecarFile {
        version: 1,
        root_path: scan_root.to_string(),
        generated_at,
        roots,
        projects,
    };
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = output.with_extension("json.tmp");
    let file = File::create(&tmp)?;
    serde_json::to_writer(file, &sidecar).map_err(io::Error::other)?;
    std::fs::rename(tmp, output)?;
    Ok(())
}

fn is_project_marker(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "package.json"
            | "cargo.toml"
            | "go.mod"
            | "pyproject.toml"
            | "composer.json"
            | "gemfile"
            | "mix.exs"
            | "package.swift"
            | ".terraform.lock.hcl"
    )
}

fn classify(path: &str) -> Option<(String, Kind)> {
    let parts = split_segments(path);
    for i in 0..parts.len() {
        let lower = parts[i].to_ascii_lowercase();
        if lower == "target" {
            if i + 1 < parts.len() {
                let next = parts[i + 1].to_ascii_lowercase();
                if matches!(next.as_str(), "debug" | "release" | "doc" | "incremental") {
                    return Some((join_segments(path, &parts, i + 2), Kind::RustTarget));
                }
            }
            return Some((join_segments(path, &parts, i + 1), Kind::RustTarget));
        }
        if lower == ".cargo" && i + 1 < parts.len() && parts[i + 1].eq_ignore_ascii_case("registry")
        {
            return Some((join_segments(path, &parts, i + 2), Kind::CargoRegistry));
        }
        if lower == "pkg" && i + 1 < parts.len() && parts[i + 1].eq_ignore_ascii_case("mod") {
            return Some((join_segments(path, &parts, i + 2), Kind::GoModule));
        }
        if lower == ".cache" && i + 1 < parts.len() {
            let next = parts[i + 1].to_ascii_lowercase();
            if matches!(next.as_str(), "ccache" | "sccache" | "yarn" | "pnpm") {
                let kind = if next == "yarn" || next == "pnpm" {
                    Kind::PackageCache
                } else {
                    Kind::CompilerCache
                };
                return Some((join_segments(path, &parts, i + 2), kind));
            }
        }
        // Only the provider downloads, which `terraform init` puts back
        // from the lock file. The rest of .terraform records the selected
        // workspace and the last backend config, so it stays.
        if lower == ".terraform" && i + 1 < parts.len() {
            let next = parts[i + 1].to_ascii_lowercase();
            if matches!(next.as_str(), "providers" | "plugins") {
                return Some((join_segments(path, &parts, i + 2), Kind::Terraform));
            }
        }
        // The documented plugin_cache_dir. `.terraform.d/plugins` holds
        // providers installed by hand, so it stays.
        if lower == ".terraform.d"
            && i + 1 < parts.len()
            && parts[i + 1].eq_ignore_ascii_case("plugin-cache")
        {
            return Some((join_segments(path, &parts, i + 2), Kind::Terraform));
        }
        if let Some(kind) = mapped_kind(&lower) {
            let depth = if matches!(kind, Kind::Worktree) && i + 1 < parts.len() {
                i + 2
            } else {
                i + 1
            };
            return Some((join_segments(path, &parts, depth), kind));
        }
        if matches!(lower.as_str(), "dist" | "build" | "out") {
            return Some((join_segments(path, &parts, i + 1), Kind::JsBuild));
        }
    }
    None
}

fn mapped_kind(lower: &str) -> Option<Kind> {
    Some(match lower {
        "node_modules" => Kind::NodeModules,
        ".pnpm-store" | ".yarn" | ".bun" => Kind::PackageCache,
        ".next" | ".nuxt" | ".output" | ".turbo" | ".parcel-cache" | ".svelte-kit"
        | ".vercel" | ".netlify" => Kind::JsBuild,
        "__pycache__" | ".venv" | "venv" | ".tox" | ".mypy_cache" | ".pytest_cache"
        | ".ruff_cache" => Kind::Python,
        ".gradle" | ".m2" => Kind::Jvm,
        ".nuget" => Kind::Dotnet,
        "cmakefiles" | "cmake-build-debug" | "cmake-build-release" => Kind::CmakeBuild,
        "ccache" | "sccache" => Kind::CompilerCache,
        ".worktrees" => Kind::Worktree,
        "diagoutputdir" | "rdclientautotrace" => Kind::DiagLogs,
        _ => return None,
    })
}

fn split_segments(path: &str) -> Vec<&str> {
    path.split(['\\', '/']).filter(|s| !s.is_empty()).collect()
}

fn join_segments(original: &str, parts: &[&str], count: usize) -> String {
    let take = parts.iter().take(count);
    if original.starts_with("\\\\") || original.starts_with("//") {
        return format!("\\\\{}", take.cloned().collect::<Vec<_>>().join("\\"));
    }
    let sep = if original.contains('\\') { "\\" } else { "/" };
    let joined = take.cloned().collect::<Vec<_>>().join(sep);
    if original.chars().nth(1) == Some(':') {
        return joined;
    }
    if original.starts_with('/') {
        return format!("/{joined}");
    }
    joined
}

fn file_name(path: &str) -> Option<&str> {
    path.rsplit(['\\', '/']).find(|s| !s.is_empty())
}

fn trim_slash(path: &str) -> &str {
    path.trim_end_matches(['\\', '/'])
}

fn projects_for_roots(projects: &HashSet<String>, roots: &[SidecarRoot]) -> Vec<String> {
    let by_lower: HashMap<String, String> = projects
        .iter()
        .map(|project| (trim_slash(project).to_ascii_lowercase(), project.clone()))
        .collect();
    let mut kept = HashSet::new();
    for root in roots {
        let mut cursor = trim_slash(&root.path).to_string();
        loop {
            if let Some(orig) = by_lower.get(&cursor.to_ascii_lowercase()) {
                kept.insert(orig.clone());
                break;
            }
            match parent_path(&cursor) {
                Some(parent) if parent != cursor => cursor = parent,
                _ => break,
            }
        }
    }
    kept.into_iter().collect()
}

fn parent_path(path: &str) -> Option<String> {
    let idx = path.rfind(['\\', '/'])?;
    if idx == 0 {
        return Some(path[..=0].to_string());
    }
    Some(path[..idx].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_node_modules() {
        let (root, kind) = classify(r"C:\proj\app\node_modules\preact\dist\preact.js").unwrap();
        assert_eq!(root, r"C:\proj\app\node_modules");
        assert!(matches!(kind, Kind::NodeModules));
    }

    #[test]
    fn classifies_rust_target() {
        let (root, kind) = classify("/home/dev/diskhound/target/debug/diskhound").unwrap();
        assert_eq!(root, "/home/dev/diskhound/target/debug");
        assert!(matches!(kind, Kind::RustTarget));
    }

    #[test]
    fn classifies_terraform_providers() {
        let (root, kind) = classify(
            "/Users/dev/infra/env/prod/.terraform/providers/registry.terraform.io/hashicorp/aws/6.54.0/darwin_arm64/terraform-provider-aws_v6.54.0_x5",
        )
        .unwrap();
        assert_eq!(root, "/Users/dev/infra/env/prod/.terraform/providers");
        assert!(matches!(kind, Kind::Terraform));

        let (root, kind) = classify(
            r"C:\infra\old\.terraform\plugins\windows_amd64\terraform-provider-aws_v2.70.0_x4.exe",
        )
        .unwrap();
        assert_eq!(root, r"C:\infra\old\.terraform\plugins");
        assert!(matches!(kind, Kind::Terraform));

        let (root, kind) = classify(
            "/home/dev/.terraform.d/plugin-cache/registry.terraform.io/hashicorp/aws/6.54.0/linux_amd64/terraform-provider-aws_v6.54.0_x5",
        )
        .unwrap();
        assert_eq!(root, "/home/dev/.terraform.d/plugin-cache");
        assert!(matches!(kind, Kind::Terraform));
    }

    #[test]
    fn leaves_terraform_state_and_hand_installed_plugins_alone() {
        for path in [
            "/Users/dev/infra/env/prod/.terraform/terraform.tfstate",
            "/Users/dev/infra/env/prod/.terraform/environment",
            "/Users/dev/infra/env/prod/.terraform/modules/modules.json",
            "/home/dev/.terraform.d/plugins/example.com/me/thing/1.0.0/linux_amd64/terraform-provider-thing",
        ] {
            assert!(classify(path).is_none(), "{path}");
        }
    }

    #[test]
    fn terraform_lock_file_marks_a_project() {
        let mut acc = DevArtifactAcc::new();
        acc.add("/Users/dev/infra/prod/.terraform.lock.hcl", 1_000, false);
        acc.add(
            "/Users/dev/infra/prod/.terraform/providers/registry.terraform.io/hashicorp/aws/6.54.0/darwin_arm64/terraform-provider-aws_v6.54.0_x5",
            800_000_000,
            false,
        );
        let roots = vec![SidecarRoot {
            path: "/Users/dev/infra/prod/.terraform/providers".to_string(),
            kind: "terraform".to_string(),
            size: 800_000_000,
            files: 1,
        }];
        assert_eq!(
            projects_for_roots(&acc.projects, &roots),
            vec!["/Users/dev/infra/prod".to_string()]
        );
    }

    #[test]
    fn classifies_diag_output_dir_before_nested_rdp_trace() {
        let (root, kind) = classify(
            r"C:\Users\thoma\AppData\Local\Temp\DiagOutputDir\RdClientAutoTrace\a.etl",
        )
        .unwrap();
        assert_eq!(root, r"C:\Users\thoma\AppData\Local\Temp\DiagOutputDir");
        assert!(matches!(kind, Kind::DiagLogs));
    }

    #[test]
    fn classifies_standalone_rdclient_auto_trace() {
        let (root, kind) =
            classify(r"C:\Users\thoma\AppData\Local\Temp\RdClientAutoTrace\a.etl").unwrap();
        assert_eq!(root, r"C:\Users\thoma\AppData\Local\Temp\RdClientAutoTrace");
        assert!(matches!(kind, Kind::DiagLogs));
    }

    #[test]
    fn writes_sidecar_json() {
        let mut acc = DevArtifactAcc::new();
        acc.add(r"C:\proj\node_modules\x.js", 1000, false);
        let dir = std::env::temp_dir().join(format!("dh-dev-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("scan.dev-artifacts.json");
        write_sidecar(&out, r"C:\", &acc).unwrap();
        let raw = std::fs::read_to_string(&out).unwrap();
        assert!(raw.contains("node-modules"));
        assert!(raw.contains("rootPath"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_sidecar_keeps_largest_roots_and_their_projects() {
        let mut acc = DevArtifactAcc::new();
        for i in 0..3_000 {
            let project = format!(r"C:\p{i}");
            acc.projects.insert(project.clone());
            acc.add(&format!(r"{project}\node_modules\x.js"), 1_000 + i as u64, false);
        }
        let dir = std::env::temp_dir().join(format!("dh-dev-cap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("scan.dev-artifacts.json");
        write_sidecar(&out, r"C:\", &acc).unwrap();
        let raw = std::fs::read_to_string(&out).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let roots = parsed["roots"].as_array().unwrap();
        assert_eq!(roots.len(), 2500);
        let projects = parsed["projects"].as_array().unwrap();
        assert!(projects.len() <= 2500);
        assert!(projects.len() > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
