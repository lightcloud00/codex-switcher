use std::process::Command;

#[test]
fn build_info_needs_no_export_path_and_contains_only_build_metadata() {
    let output = Command::new(env!("CARGO_BIN_EXE_codex-switcher-capacity-export"))
        .arg("--build-info")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let info: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let object = info.as_object().unwrap();
    assert_eq!(object.len(), 5);
    for key in ["version", "commit", "tree", "dirty", "target"] {
        assert!(object.contains_key(key), "missing {key}");
    }
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
    assert!(output.stderr.is_empty());
}

#[test]
fn version_returns_without_starting_a_capacity_export() {
    let output = Command::new(env!("CARGO_BIN_EXE_codex-switcher-capacity-export"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.starts_with(&format!(
        "codex-switcher-capacity-export {}",
        env!("CARGO_PKG_VERSION")
    )));
    assert_eq!(text.lines().count(), 1);
    assert!(output.stderr.is_empty());
}
