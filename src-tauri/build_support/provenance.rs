use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[derive(Debug, Default)]
pub struct GitProvenance {
    pub commit: Option<String>,
    pub tree: Option<String>,
    pub dirty: Option<bool>,
    pub rerun_paths: Vec<PathBuf>,
}

fn git_bytes(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .args(["-c", "core.fsmonitor=false", "-C"])
        .arg(dir)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

fn git_text(dir: &Path, args: &[&str]) -> Option<String> {
    let text = String::from_utf8(git_bytes(dir, args)?).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn object_id(value: String) -> Option<String> {
    ((value.len() == 40 || value.len() == 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

fn git_path(dir: &Path, name: &str) -> Option<PathBuf> {
    git_text(
        dir,
        &["rev-parse", "--path-format=absolute", "--git-path", name],
    )
    .map(PathBuf::from)
}

fn watch(paths: &mut BTreeSet<PathBuf>, path: PathBuf) {
    // Cargo instructions are line based. Never let a filename add instructions.
    if path
        .to_str()
        .is_some_and(|value| !value.contains(['\r', '\n']))
    {
        paths.insert(path);
    }
}

fn watch_existing_parent(paths: &mut BTreeSet<PathBuf>, path: &Path) {
    if let Some(parent) = path.ancestors().skip(1).find(|parent| parent.exists()) {
        watch(paths, parent.to_path_buf());
    }
}

/// Capture source identity without reading auth, remotes, usernames or wall-clock time.
/// Git paths are resolved by Git itself: a linked worktree has its own HEAD/index
/// and shares refs/packed-refs with the main repository.
pub fn discover(manifest_dir: &Path) -> GitProvenance {
    let mut provenance = GitProvenance::default();
    let Some(root) = git_text(manifest_dir, &["rev-parse", "--show-toplevel"]).map(PathBuf::from)
    else {
        return provenance;
    };
    // An unpacked source archive inside an unrelated repository must not inherit
    // that repository's commit merely because Git walked up to it.
    if git_bytes(
        manifest_dir,
        &["ls-files", "--error-unmatch", "--", "Cargo.toml"],
    )
    .is_none()
    {
        return provenance;
    }

    provenance.commit =
        git_text(manifest_dir, &["rev-parse", "--verify", "HEAD^{commit}"]).and_then(object_id);
    provenance.tree =
        git_text(manifest_dir, &["rev-parse", "--verify", "HEAD^{tree}"]).and_then(object_id);
    if provenance.commit.is_some() && provenance.tree.is_some() {
        provenance.dirty = git_bytes(
            &root,
            &["status", "--porcelain=v1", "--untracked-files=all"],
        )
        .map(|output| !output.is_empty());
    }

    let mut paths = BTreeSet::new();
    let git_file = root.join(".git");
    if git_file.is_file() {
        watch(&mut paths, git_file);
    }
    for name in ["HEAD", "index", "packed-refs", "info/exclude", "reftable"] {
        if let Some(path) = git_path(manifest_dir, name).filter(|path| path.exists()) {
            watch(&mut paths, path);
        }
    }
    if let Some(reference) = git_text(manifest_dir, &["symbolic-ref", "-q", "HEAD"]) {
        if let Some(path) = git_path(manifest_dir, &reference) {
            if path.exists() {
                watch(&mut paths, path);
            } else {
                // A packed branch gains a loose ref on its next commit. Watch
                // the containing refs directory without repeatedly watching a
                // nonexistent file (which would force every build to rerun).
                watch_existing_parent(&mut paths, &path);
            }
        }
    }

    if let Some(files) = git_bytes(
        &root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    ) {
        for name in files
            .split(|byte| *byte == 0)
            .filter(|name| !name.is_empty())
        {
            let Ok(name) = std::str::from_utf8(name) else {
                // A path that cannot be represented in Cargo's line protocol
                // prevents a reliable incremental dirty-state observation.
                provenance.dirty = None;
                continue;
            };
            let relative = Path::new(name);
            if relative
                .components()
                .all(|component| matches!(component, Component::Normal(_)))
                && !name.contains(['\r', '\n'])
            {
                watch(&mut paths, root.join(relative));
            } else {
                provenance.dirty = None;
            }
        }
    } else {
        provenance.dirty = None;
    }

    // New source files also matter. These directories exclude target/dist and
    // node_modules, so normal build output does not cause endless rebuilds.
    for relative in [
        "src",
        "tests",
        "scripts",
        "public",
        ".github",
        "src-tauri/src",
        "src-tauri/tests",
        "src-tauri/build_support",
        "src-tauri/capabilities",
    ] {
        let path = root.join(relative);
        if path.is_dir() {
            watch(&mut paths, path);
        }
    }
    provenance.rerun_paths = paths.into_iter().collect();
    provenance
}

pub fn safe_target(value: Option<String>) -> Option<String> {
    value.filter(|value| {
        !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    })
}
