//! Request boundaries for the optional browser interface.
//! Local callers can use the same controls as the desktop; unauthenticated
//! network callers and unrelated browser origins cannot reach those controls.
use std::io::Read;
use std::net::{IpAddr, SocketAddr};

use serde_json::Value;
use tiny_http::{Method, Request};
use url::Url;

pub(crate) const MAX_COMMAND_BYTES: usize = 2 * 1024 * 1024;
// An encrypted backup is at most 8 MiB before base64 and its JSON envelope.
pub(crate) const MAX_BACKUP_BYTES: usize = 12 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RequestRejection {
    pub status: u16,
    pub message: &'static str,
}

impl RequestRejection {
    fn forbidden() -> Self {
        Self {
            status: 403,
            message:
                "This browser interface only accepts requests from a local, same-origin client.",
        }
    }
}

pub(crate) fn local_bind_address(host: &str, port: u16) -> anyhow::Result<String> {
    if host.eq_ignore_ascii_case("localhost") {
        return Ok(format!("localhost:{port}"));
    }
    let plain_host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    let ip: IpAddr = plain_host.parse().map_err(|_| {
        anyhow::anyhow!("The browser interface requires a loopback IP or localhost.")
    })?;
    if !ip.to_canonical().is_loopback() {
        anyhow::bail!(
            "The browser interface is local-only. Bind to 127.0.0.1 or ::1; use an authenticated tunnel for another device."
        );
    }
    Ok(SocketAddr::new(ip, port).to_string())
}

fn single_header<'a>(
    request: &'a Request,
    name: &'static str,
) -> Result<Option<&'a str>, RequestRejection> {
    let mut matching = request
        .headers()
        .iter()
        .filter(|header| header.field.equiv(name));
    let first = matching.next().map(|header| header.value.as_str().trim());
    if matching.next().is_some() {
        return Err(RequestRejection::forbidden());
    }
    Ok(first)
}

fn local_authority(host: &str) -> Option<Url> {
    // Parse an HTTP authority, not a permissive URL containing a username,
    // path, query, fragment, or a non-loopback DNS name.
    let parsed = Url::parse(&format!("http://{host}")).ok()?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || host.contains(['/', '\\', '@', '?', '#'])
    {
        return None;
    }
    let local = match parsed.host()? {
        url::Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(ip) => ip.is_loopback(),
        url::Host::Ipv6(ip) => ip.to_canonical().is_loopback(),
    };
    local.then_some(parsed)
}

/// Validate before serving even static content, so DNS rebinding cannot obtain
/// this app under an attacker-controlled Host and subsequently invoke commands.
pub(crate) fn validate_local_request(request: &Request) -> Result<(), RequestRejection> {
    if !request
        .remote_addr()
        .is_some_and(|addr| addr.ip().to_canonical().is_loopback())
    {
        return Err(RequestRejection::forbidden());
    }
    let host = single_header(request, "Host")?.ok_or_else(RequestRejection::forbidden)?;
    let expected = local_authority(host).ok_or_else(RequestRejection::forbidden)?;
    // Opening a local dashboard from a documentation link is safe. The peer
    // and authority checks apply to every route; CSRF checks protect commands.
    if request.method() != &Method::Post {
        return Ok(());
    }

    if let Some(origin) = single_header(request, "Origin")? {
        let parsed = Url::parse(origin).map_err(|_| RequestRejection::forbidden())?;
        if parsed.origin() != expected.origin()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(RequestRejection::forbidden());
        }
    }
    // Fetch metadata is supplemental; non-browser local clients may omit it.
    if let Some(site) = single_header(request, "Sec-Fetch-Site")? {
        if !matches!(site, "same-origin" | "none") {
            return Err(RequestRejection::forbidden());
        }
    }
    Ok(())
}

pub(crate) fn parse_command_json(
    request: &mut Request,
    max_bytes: usize,
) -> Result<Value, RequestRejection> {
    let content_type = single_header(request, "Content-Type")?;
    if !content_type
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(RequestRejection {
            status: 415,
            message: "Commands require application/json.",
        });
    }
    let too_large = || RequestRejection {
        status: 413,
        message: "The command request is too large.",
    };
    if request
        .body_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err(too_large());
    }
    let mut body = Vec::new();
    request
        .as_reader()
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|_| RequestRejection {
            status: 400,
            message: "Could not read the command request.",
        })?;
    if body.len() > max_bytes {
        return Err(too_large());
    }
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_slice(&body).map_err(|_| RequestRejection {
        status: 400,
        message: "Invalid command JSON.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tiny_http::{Method, TestRequest};

    fn request(
        remote: &str,
        host: &str,
        origin: Option<&str>,
        content_type: &str,
        body: &'static str,
    ) -> Request {
        let mut builder = TestRequest::new()
            .with_method(Method::Post)
            .with_remote_addr(remote.parse().unwrap())
            .with_header(format!("Host: {host}").parse().unwrap())
            .with_header(format!("Content-Type: {content_type}").parse().unwrap())
            .with_body(body);
        if let Some(origin) = origin {
            builder = builder.with_header(format!("Origin: {origin}").parse().unwrap());
        }
        builder.into()
    }

    #[test]
    fn accepts_local_ipv4_ipv6_and_nonbrowser_clients() {
        for (peer, host, origin) in [
            (
                "127.0.0.1:1000",
                "localhost:3210",
                Some("http://localhost:3210"),
            ),
            ("[::1]:1000", "[::1]:3210", Some("http://[::1]:3210")),
            ("127.0.0.1:1000", "127.0.0.1:3210", None),
        ] {
            let req = request(peer, host, origin, "application/json; charset=utf-8", "{}");
            assert_eq!(validate_local_request(&req), Ok(()));
        }
    }

    #[test]
    fn rejects_remote_peers_spoofed_hosts_and_cross_origin_requests() {
        for (peer, host, origin) in [
            ("192.0.2.1:1000", "localhost:3210", None),
            ("127.0.0.1:1000", "attacker.example:3210", None),
            ("127.0.0.1:1000", "localhost.evil.example:3210", None),
            (
                "127.0.0.1:1000",
                "localhost:3210",
                Some("https://attacker.example"),
            ),
            (
                "127.0.0.1:1000",
                "localhost:3210",
                Some("http://localhost:3211"),
            ),
            ("127.0.0.1:1000", "localhost:3210", Some("null")),
            (
                "127.0.0.1:1000",
                "localhost:3210",
                Some("http://localhost:3210/private"),
            ),
            ("127.0.0.1:1000", "localhost:3210@attacker.example", None),
            ("127.0.0.1:1000", "localhost:3210/path", None),
        ] {
            let req = request(peer, host, origin, "application/json", "{}");
            assert_eq!(
                validate_local_request(&req).unwrap_err().status,
                403,
                "{peer} {host} {origin:?}"
            );
        }
    }

    #[test]
    fn rejects_duplicate_security_headers_and_cross_site_fetches() {
        for extra in [
            "Host: attacker.example",
            "Origin: http://attacker.example",
            "Sec-Fetch-Site: cross-site",
        ] {
            let req: Request = TestRequest::new()
                .with_method(Method::Post)
                .with_remote_addr("127.0.0.1:1000".parse().unwrap())
                .with_header("Host: localhost:3210".parse().unwrap())
                .with_header("Origin: http://localhost:3210".parse().unwrap())
                .with_header(extra.parse().unwrap())
                .into();
            assert_eq!(validate_local_request(&req).unwrap_err().status, 403);
        }
    }

    #[test]
    fn a_documentation_link_can_open_the_local_dashboard() {
        let request: Request = TestRequest::new()
            .with_method(Method::Get)
            .with_remote_addr("127.0.0.1:1000".parse().unwrap())
            .with_header("Host: localhost:3210".parse().unwrap())
            .with_header("Sec-Fetch-Site: cross-site".parse().unwrap())
            .into();
        assert_eq!(validate_local_request(&request), Ok(()));
    }

    #[test]
    fn command_parser_rejects_forms_malformed_and_oversized_bodies() {
        for content_type in [
            "text/plain",
            "application/x-www-form-urlencoded",
            "multipart/form-data",
        ] {
            let mut req = request("127.0.0.1:1000", "localhost:3210", None, content_type, "{}");
            assert_eq!(parse_command_json(&mut req, 32).unwrap_err().status, 415);
        }
        let mut invalid = request(
            "127.0.0.1:1000",
            "localhost:3210",
            None,
            "application/json",
            "{",
        );
        assert_eq!(
            parse_command_json(&mut invalid, 32).unwrap_err().status,
            400
        );
        let mut oversized = request(
            "127.0.0.1:1000",
            "localhost:3210",
            None,
            "application/json",
            r#"{"payload":"too large"}"#,
        );
        assert_eq!(
            parse_command_json(&mut oversized, 8).unwrap_err().status,
            413
        );
        let mut valid = request(
            "127.0.0.1:1000",
            "localhost:3210",
            None,
            "application/json",
            r#"{"ok":true}"#,
        );
        assert_eq!(
            parse_command_json(&mut valid, 32).unwrap(),
            serde_json::json!({"ok": true})
        );
    }

    #[test]
    fn bind_configuration_is_explicitly_loopback_only() {
        assert_eq!(
            local_bind_address("127.0.0.1", 3210).unwrap(),
            "127.0.0.1:3210"
        );
        assert_eq!(
            local_bind_address("localhost", 3210).unwrap(),
            "localhost:3210"
        );
        assert_eq!(local_bind_address("::1", 3210).unwrap(), "[::1]:3210");
        assert_eq!(local_bind_address("[::1]", 3210).unwrap(), "[::1]:3210");
        for host in ["0.0.0.0", "::", "192.0.2.1", "switcher.example"] {
            assert!(local_bind_address(host, 3210).is_err(), "{host}");
        }
    }
}
