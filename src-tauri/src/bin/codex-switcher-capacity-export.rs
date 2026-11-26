use std::path::PathBuf;

fn argument(name: &str) -> Option<PathBuf> {
    let mut values = std::env::args_os().skip(1);
    while let Some(value) = values.next() {
        if value == name {
            return values.next().map(PathBuf::from);
        }
    }
    None
}

fn flag(name: &str) -> bool {
    std::env::args_os().skip(1).any(|value| value == name)
}

#[tokio::main]
async fn main() {
    // These modes identify the binary before any export arguments, account
    // stores, admission receipts or network-backed usage are consulted.
    if flag("--build-info") {
        println!(
            "{}",
            serde_json::to_string(&codex_switcher_lib::build_info::current_build_info())
                .expect("build metadata is serializable")
        );
        return;
    }
    if flag("--version") {
        println!(
            "codex-switcher-capacity-export {}",
            codex_switcher_lib::build_info::current_build_info().display_version()
        );
        return;
    }
    let output = argument("--output").unwrap_or_else(|| {
        eprintln!("--output is required");
        std::process::exit(2);
    });
    let admission = argument("--admission");
    let include_claude_seats = flag("--include-claude-seats");
    if codex_switcher_lib::capacity_export::export_capacity_with_diagnostics(
        &output,
        admission.as_deref(),
        include_claude_seats,
        flag("--write-refresh-diagnostics"),
    )
    .await
    .is_err()
    {
        // Keep every CLI error path identity- and credential-free. Detailed
        // backend errors stay inside the Switcher trust boundary.
        eprintln!("capacity export failed");
        std::process::exit(2);
    }
}
