//! Public diagnostic categories are derived solely from a captured HTTP status.

pub(crate) fn usage_error_kind(http_status: Option<u16>) -> &'static str {
    match http_status {
        Some(401) => "auth",
        Some(403) => "permission",
        Some(429) => "rate_limit",
        Some(500..=599) => "service",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_supported_responses() {
        for (status, kind) in [(401, "auth"), (403, "permission"), (429, "rate_limit")] {
            assert_eq!(usage_error_kind(Some(status)), kind);
        }
        for status in 500..=599 {
            assert_eq!(usage_error_kind(Some(status)), "service");
        }
    }

    #[test]
    fn missing_or_unclassified_status_stays_unknown() {
        assert_eq!(usage_error_kind(None), "unknown");
        for status in [0, 200, 301, 400, 404, 408, 499, 600, u16::MAX] {
            assert_eq!(usage_error_kind(Some(status)), "unknown");
        }
    }
}
