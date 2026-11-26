//! Terminal saved-login failures, separate from transient access/usage errors.
//! Keep behavior aligned with src/lib/accountAuth.ts and the shared fixtures.

pub fn is_sign_in_failure(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    [
        "invalid_grant",
        "refresh_token_reused",
        "refresh_token_expired",
        "refresh_token_invalidated",
        "refresh_token_revoked",
        "missing refresh token",
        "session has ended",
    ]
    .iter()
    .any(|marker| contains_word(&error, marker))
        || error
            .split_once("token refresh failed:")
            .is_some_and(|(_, response)| {
                contains_word(response, "token_revoked")
                    || contains_word(response, "token_invalidated")
            })
}

fn contains_word(haystack: &str, word: &str) -> bool {
    haystack.match_indices(word).any(|(start, _)| {
        let before = haystack[..start].chars().next_back();
        let after = haystack[start + word.len()..].chars().next();
        !before.is_some_and(|c| c.is_alphanumeric() || c == '_')
            && !after.is_some_and(|c| c.is_alphanumeric() || c == '_')
    })
}

#[cfg(test)]
mod tests {
    use super::is_sign_in_failure;

    #[test]
    fn terminal_refresh_failures_need_relogin() {
        for error in [
            "invalid_grant",
            "refresh_token_reused",
            "refresh_token_expired",
            "refresh_token_invalidated",
            "refresh_token_revoked",
            "Missing refresh token",
            "Your session has ended",
            "Token refresh failed: 401 - token_revoked",
        ] {
            assert!(is_sign_in_failure(error), "{error}");
        }
    }

    #[test]
    fn transient_access_failures_do_not_need_relogin() {
        for error in [
            "API error: 401 Unauthorized",
            "HTTP 401",
            "invalid_token",
            "token_expired",
            "token_revoked",
            "token_invalidated",
            "429 Too Many Requests",
            "Token refresh returned an invalid or expired id_token",
            "Token refresh failed: 401 Unauthorized - ",
            "not_invalid_grant",
            "refresh_token_expired_later",
            "timed out",
            "",
        ] {
            assert!(!is_sign_in_failure(error), "{error}");
        }
    }
}
