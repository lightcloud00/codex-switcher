#[path = "build_support/provenance.rs"]
mod provenance;

fn main() {
    let manifest_dir = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let source = provenance::discover(&manifest_dir);
    for path in &source.rerun_paths {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rerun-if-changed=build_support/provenance.rs");
    println!(
        "cargo:rustc-env=CODEX_SWITCHER_BUILD_COMMIT={}",
        source.commit.as_deref().unwrap_or("")
    );
    println!(
        "cargo:rustc-env=CODEX_SWITCHER_BUILD_TREE={}",
        source.tree.as_deref().unwrap_or("")
    );
    println!(
        "cargo:rustc-env=CODEX_SWITCHER_BUILD_DIRTY={}",
        match source.dirty {
            Some(true) => "true",
            Some(false) => "false",
            None => "",
        }
    );
    println!(
        "cargo:rustc-env=CODEX_SWITCHER_BUILD_TARGET={}",
        provenance::safe_target(std::env::var("TARGET").ok()).unwrap_or_default()
    );
    tauri_build::build()
}
