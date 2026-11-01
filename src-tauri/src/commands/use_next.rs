//! The Use next tab: every Codex account in the order the adaptive router would pick it.

use crate::capacity_export::{use_next_plan, UseNextPlan};
use crate::types::UsageInfo;

/// Rank the Codex accounts from the usage readings the window already holds (no new usage calls).
#[tauri::command]
pub async fn get_use_next_plan(usages: Vec<UsageInfo>) -> Result<UseNextPlan, String> {
    use_next_plan(&usages).await.map_err(|e| e.to_string())
}
