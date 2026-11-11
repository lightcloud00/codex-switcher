#[path = "../build_support/provenance.rs"]
mod provenance;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    sandbox: PathBuf,
    repo: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let sandbox = std::env::temp_dir().join(format!(
            "switcher-build-provenance-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        let repo = sandbox.join("repo");
        fs::create_dir_all(repo.join("src-tauri/src")).unwrap();
        fs::create_dir_all(sandbox.join("empty-hooks")).unwrap();
        let fixture = Self { sandbox, repo };
        fixture.git(&["init"]);
        fixture.git(&["config", "user.name", "Build Fixture"]);
        fixture.git(&["config", "user.email", "build-fixture@example.com"]);
        fixture.git(&["config", "commit.gpgsign", "false"]);
        fixture.git(&[
            "config",
            "core.hooksPath",
            fixture.sandbox.join("empty-hooks").to_str().unwrap(),
        ]);
        fs::write(
            fixture.repo.join("src-tauri/Cargo.toml"),
            "[package]\nname = \"provenance-fixture\"\nversion = \"0.0.0\"\n",
        )
        .unwrap();
        fs::write(fixture.repo.join("src-tauri/src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(
            fixture.repo.join(".gitignore"),
            "target/\nnode_modules/\ndist/\n",
        )
        .unwrap();
        fixture.git(&["add", "."]);
        fixture.git(&["commit", "-m", "Initial fixture"]);
        fixture
    }

    fn git_at(&self, dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(["-c", "core.fsmonitor=false", "-C"])
            .arg(dir)
            .args(args)
            .output()
            .expect("Git is required for the build provenance fixture");
        assert!(
            output.status.success(),
            "fixture git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn git(&self, args: &[&str]) -> String {
        self.git_at(&self.repo, args)
    }

    fn read(&self) -> provenance::GitProvenance {
        provenance::discover(&self.repo.join("src-tauri"))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.sandbox);
    }
}

#[test]
fn records_clean_dirty_and_changed_commits_without_using_build_output() {
    let fixture = Fixture::new();
    let initial = fixture.read();
    assert_eq!(
        initial.commit.as_deref(),
        Some(fixture.git(&["rev-parse", "HEAD"]).as_str())
    );
    assert_eq!(
        initial.tree.as_deref(),
        Some(fixture.git(&["rev-parse", "HEAD^{tree}"]).as_str())
    );
    assert_eq!(initial.dirty, Some(false));

    fs::create_dir_all(fixture.repo.join("src-tauri/target")).unwrap();
    fs::write(
        fixture.repo.join("src-tauri/target/build-output"),
        "ignored",
    )
    .unwrap();
    fs::create_dir_all(fixture.repo.join("node_modules")).unwrap();
    fs::write(fixture.repo.join("node_modules/generated"), "ignored").unwrap();
    let ignored = fixture.read();
    assert_eq!(ignored.dirty, Some(false));
    assert!(!ignored.rerun_paths.iter().any(|path| {
        path == &fixture.repo
            || path.starts_with(fixture.repo.join("src-tauri/target"))
            || path.starts_with(fixture.repo.join("node_modules"))
    }));

    fs::write(
        fixture.repo.join("src-tauri/src/main.rs"),
        "fn main() { println!(\"fixture\"); }\n",
    )
    .unwrap();
    assert_eq!(fixture.read().dirty, Some(true));
    fixture.git(&["add", "src-tauri/src/main.rs"]);
    fixture.git(&["commit", "-m", "Change fixture"]);
    let changed = fixture.read();
    assert_ne!(changed.commit, initial.commit);
    assert_ne!(changed.tree, initial.tree);
    assert_eq!(changed.dirty, Some(false));

    let new_source = fixture.repo.join("src-tauri/src/new.rs");
    fs::write(&new_source, "// new source\n").unwrap();
    let untracked = fixture.read();
    assert_eq!(untracked.dirty, Some(true));
    assert!(untracked.rerun_paths.contains(&new_source));
    assert!(untracked
        .rerun_paths
        .contains(&fixture.repo.join("src-tauri/src")));
}

#[test]
fn linked_worktrees_watch_their_own_head_and_index_and_shared_refs() {
    let fixture = Fixture::new();
    let linked = fixture.sandbox.join("linked");
    fixture.git(&[
        "worktree",
        "add",
        "-b",
        "fixture-linked",
        linked.to_str().unwrap(),
        "HEAD",
    ]);
    assert!(linked.join(".git").is_file());

    let read = || provenance::discover(&linked.join("src-tauri"));
    let initial = read();
    assert_eq!(initial.dirty, Some(false));
    for name in ["HEAD", "index", "refs/heads/fixture-linked"] {
        let path = fixture.git_at(
            &linked,
            &["rev-parse", "--path-format=absolute", "--git-path", name],
        );
        assert!(
            initial.rerun_paths.contains(&PathBuf::from(path)),
            "missing {name}"
        );
    }
    assert!(initial.rerun_paths.contains(&linked.join(".git")));
    assert!(!initial
        .rerun_paths
        .contains(&fixture.repo.join(".git/HEAD")));

    fixture.git(&["pack-refs", "--all", "--prune"]);
    let packed = read();
    let packed_path = fixture.git_at(
        &linked,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "packed-refs",
        ],
    );
    assert!(packed.rerun_paths.contains(&PathBuf::from(packed_path)));
    assert_eq!(packed.commit, initial.commit);

    fs::write(
        linked.join("src-tauri/src/main.rs"),
        "fn main() { /* linked */ }\n",
    )
    .unwrap();
    fixture.git_at(&linked, &["add", "src-tauri/src/main.rs"]);
    fixture.git_at(&linked, &["commit", "-m", "Linked change"]);
    assert_ne!(read().commit, initial.commit);

    fixture.git_at(&linked, &["checkout", "--detach"]);
    let detached = read();
    assert_eq!(detached.dirty, Some(false));
    assert_eq!(
        detached.commit.as_deref(),
        Some(fixture.git_at(&linked, &["rev-parse", "HEAD"]).as_str())
    );
}

#[test]
fn an_untracked_archive_does_not_borrow_a_parent_repositories_identity() {
    let fixture = Fixture::new();
    let archive = fixture.repo.join("untracked-archive/src-tauri");
    fs::create_dir_all(&archive).unwrap();
    fs::write(
        archive.join("Cargo.toml"),
        "[package]\nname = \"archive\"\n",
    )
    .unwrap();
    let unknown = provenance::discover(&archive);
    assert_eq!(
        (unknown.commit, unknown.tree, unknown.dirty),
        (None, None, None)
    );

    let outside = fixture.sandbox.join("source-archive");
    fs::create_dir_all(&outside).unwrap();
    let unknown = provenance::discover(&outside);
    assert_eq!(
        (unknown.commit, unknown.tree, unknown.dirty),
        (None, None, None)
    );
}

#[test]
fn a_custom_target_path_is_not_embedded_as_machine_metadata() {
    assert_eq!(
        provenance::safe_target(Some("/private/build/target.json".into())),
        None
    );
    assert_eq!(
        provenance::safe_target(Some("aarch64-apple-darwin".into())),
        Some("aarch64-apple-darwin".into())
    );
    assert_eq!(provenance::safe_target(None), None);
}
