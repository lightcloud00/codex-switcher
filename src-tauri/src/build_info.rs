//! Non-secret identity of the compiled binary. This never inspects live accounts.
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct BuildInfo {
    pub version: &'static str,
    pub commit: Option<&'static str>,
    pub tree: Option<&'static str>,
    pub dirty: Option<bool>,
    pub target: Option<&'static str>,
}

fn present(value: Option<&'static str>) -> Option<&'static str> {
    value.filter(|value| !value.is_empty())
}

pub fn current_build_info() -> BuildInfo {
    BuildInfo {
        version: env!("CARGO_PKG_VERSION"),
        commit: present(option_env!("CODEX_SWITCHER_BUILD_COMMIT")),
        tree: present(option_env!("CODEX_SWITCHER_BUILD_TREE")),
        dirty: match option_env!("CODEX_SWITCHER_BUILD_DIRTY") {
            Some("true") => Some(true),
            Some("false") => Some(false),
            _ => None,
        },
        target: present(option_env!("CODEX_SWITCHER_BUILD_TARGET")),
    }
}

impl BuildInfo {
    pub fn display_version(&self) -> String {
        let Some(commit) = self.commit else {
            return format!("{} (source unknown)", self.version);
        };
        let revision = commit.get(..8).unwrap_or(commit);
        let status = match self.dirty {
            Some(true) => "; modified sources",
            Some(false) => "",
            None => "; change status unknown",
        };
        format!("{} ({revision}{status})", self.version)
    }
}

#[tauri::command]
pub fn get_build_info() -> BuildInfo {
    current_build_info()
}

#[cfg(test)]
mod tests {
    use super::BuildInfo;

    #[test]
    fn an_unverified_source_never_looks_like_a_clean_revision() {
        let mut info = BuildInfo {
            version: "0.2.20",
            commit: None,
            tree: None,
            dirty: None,
            target: None,
        };
        assert_eq!(info.display_version(), "0.2.20 (source unknown)");
        info.commit = Some("1234567890abcdef1234567890abcdef12345678");
        assert_eq!(
            info.display_version(),
            "0.2.20 (12345678; change status unknown)"
        );
        info.dirty = Some(true);
        assert_eq!(
            info.display_version(),
            "0.2.20 (12345678; modified sources)"
        );
    }
}
