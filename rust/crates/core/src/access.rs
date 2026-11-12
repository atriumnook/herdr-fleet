//! Who gets in, for a server with no token and no paired device (`server/access.ts`,
//! `server/auth.ts`, `server/http.ts` and the checks at the top of `server/index.ts`'s `fetch`).
//! Phase 4 adds the token and the paired devices (ADR 0242-phase-3-split).

use std::net::{IpAddr, SocketAddr};

use axum::Json;
use axum::extract::{ConnectInfo, Request};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

/// Headers a proxy adds and a browser or CLI on this PC has no reason to send; a Tailscale login is
/// stated by a proxy too (`PROXY_HEADERS`).
const PROXY_HEADERS: [&str; 7] = [
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "forwarded",
    "via",
    "tailscale-user-login",
];

/// A header as the Fetch API's `Headers.get` reads it: every value of the name, each stripped of the
/// whitespace around it, joined with `", "`; none when the request has no such header. Reading only
/// the first value would let a second `Host` or `Origin` go unseen.
fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|value| {
            String::from_utf8_lossy(value.as_bytes())
                .trim_matches([' ', '\t', '\r', '\n'])
                .to_owned()
        })
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

/// The connection came from this machine: 127/8, ::1, or 127/8 mapped into IPv6
/// (`isLoopbackAddress`).
pub fn is_loopback_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => v4.octets()[0] == 127,
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.octets()[0] == 127)
        }
    }
}

/// Is this Host header a name for this machine itself (`isLoopbackHost`)? It is read as a bare
/// authority and nothing else, as `/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i` reads it: a
/// name or a bracketed address, with a port of one to five digits. A URL parser would read
/// `public.example@localhost` as localhost.
pub fn is_loopback_host(host: &str) -> bool {
    let Some(name) = authority_name(host) else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    // one trailing dot is the DNS root, the same name
    let name = name.strip_suffix('.').unwrap_or(&name);
    name == "localhost"
        || name.ends_with(".localhost")
        || name == "[::1]"
        || is_127_dotted(name)
        || name
            .strip_prefix("[::ffff:")
            .and_then(|rest| rest.strip_suffix(']'))
            .is_some_and(is_127_dotted)
}

/// The name of `host` read as `isLoopbackHost`'s expression reads an authority, its brackets kept;
/// none when the expression does not match.
fn authority_name(host: &str) -> Option<&str> {
    let (name, rest) = if host.starts_with('[') {
        let end = host.find(']')? + 1;
        let inside = &host[1..end - 1];
        let address = |c: char| c.is_ascii_hexdigit() || c == ':' || c == '.';
        if inside.is_empty() || !inside.chars().all(address) {
            return None;
        }
        host.split_at(end)
    } else {
        let end = host.find(':').unwrap_or(host.len());
        let (name, rest) = host.split_at(end);
        let letter = |c: char| c.is_ascii_alphanumeric() || c == '.' || c == '-';
        if name.is_empty() || !name.chars().all(letter) {
            return None;
        }
        (name, rest)
    };
    if rest.is_empty() {
        return Some(name);
    }
    let port = rest.strip_prefix(':')?;
    ((1..=5).contains(&port.len()) && port.bytes().all(|b| b.is_ascii_digit())).then_some(name)
}

/// `/^127(?:\.\d{1,3}){3}$/`.
fn is_127_dotted(name: &str) -> bool {
    let parts: Vec<&str> = name.split('.').collect();
    parts.len() == 4
        && parts[0] == "127"
        && parts[1..]
            .iter()
            .all(|part| (1..=3).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit()))
}

/// Evidence that a request reached this server through a proxy (`cameThroughProxy`): a header a
/// proxy adds, or a Host that is not a name for this machine. Claiming it only ever costs the
/// sender the trust a local connection has, so a forged header gains nothing.
pub fn came_through_proxy(headers: &HeaderMap) -> bool {
    if PROXY_HEADERS.iter().any(|name| headers.contains_key(*name)) {
        return true;
    }
    // no Host at all is not how a browser or a CLI on this PC asks (HTTP/1.0 through a proxy is)
    header(headers, "host").is_none_or(|host| !is_loopback_host(&host))
}

/// A browser request from this app's own pages, or from no page (`sameOrigin`): `Sec-Fetch-Site`
/// same-origin or none (a typed address) when it is sent, and an `Origin`, when there is one,
/// equal to the request's own. A request with no Origin is not from a browser page.
///
/// The request's own origin is `http://` and its Host, as Bun builds `request.url`. TypeScript
/// switches it to `https:` under `X-Forwarded-Proto: https`; here that header is a proxy's, which
/// [`check`] refuses before it asks this. The Origin is compared as a serialized origin (scheme,
/// host and port, the scheme and host in lower case, a default port dropped): an Origin that
/// `URL` would fold into one, with a path or a user in it, is refused here. No browser sends one.
pub fn same_origin(headers: &HeaderMap) -> bool {
    if let Some(site) = header(headers, "sec-fetch-site")
        && !site.is_empty()
        && site != "same-origin"
        && site != "none"
    {
        return false;
    }
    let Some(origin) = header(headers, "origin").filter(|origin| !origin.is_empty()) else {
        return true;
    };
    let own = header(headers, "host").and_then(|host| serialized_origin(&format!("http://{host}")));
    own.is_some() && serialized_origin(&origin) == own
}

/// `scheme://host[:port]` read as an origin: the scheme (http or https) and the host in lower case,
/// the port as a number and dropped when it is the scheme's default; none for anything else.
fn serialized_origin(text: &str) -> Option<(String, String, Option<u16>)> {
    let (scheme, authority) = text.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let default = match scheme.as_str() {
        "http" => 80,
        "https" => 443,
        _ => return None,
    };
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']')? + 1;
        let (host, rest) = authority.split_at(end);
        (host, rest)
    } else {
        let end = authority.find(':').unwrap_or(authority.len());
        authority.split_at(end)
    };
    let allowed = |c: char| c.is_ascii_alphanumeric() || ".-[]:".contains(c);
    if host.is_empty() || !host.chars().all(allowed) {
        return None;
    }
    let port = match port {
        "" => None,
        port => {
            let digits = port.strip_prefix(':')?;
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            Some(digits.parse::<u16>().ok()?).filter(|port| *port != default)
        }
    };
    Some((scheme, host.to_ascii_lowercase(), port))
}

/// Paths a request must be let in for (`requiresAuth`): the socket and `/api/`, but for the health
/// check, the token page and pairing, which phase 4 serves.
pub fn requires_auth(path: &str) -> bool {
    if path == "/ws" {
        return true;
    }
    path.starts_with("/api/")
        && path != "/api/health"
        && path != "/api/auth"
        && path != "/api/devices/pair"
}

/// Why a request was turned away, answered as `server/index.ts` and `server/fleet/api.ts` answer it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// `unauthorizedJson("pairing_required")`: not this PC, or this PC through a proxy
    Unauthorized,
    /// a change from another site's page
    InvalidOrigin,
    /// a path with an empty segment
    NotFound,
    /// a change to `/api/fleet` without `X-Herdr-Fleet: 1`
    InvalidFleetRequest,
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            // `unauthorizedJson("pairing_required")`, server/auth.ts
            Refusal::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "pair this device, or use the token",
            ),
            // server/index.ts:1114
            Refusal::InvalidOrigin => (
                StatusCode::FORBIDDEN,
                "invalid_origin",
                "Use controls from this app",
            ),
            // server/index.ts:1117
            Refusal::NotFound => (StatusCode::NOT_FOUND, "not_found", "not found"),
            // server/fleet/api.ts:58
            Refusal::InvalidFleetRequest => (
                StatusCode::FORBIDDEN,
                "invalid_fleet_request",
                "Send X-Herdr-Fleet: 1",
            ),
        };
        let body = serde_json::json!({ "error": { "code": code, "message": message } });
        (status, Json(body)).into_response()
    }
}

/// The checks `server/index.ts`'s `fetch` makes of every request before it routes one: the
/// access decision, then a change's origin, then an empty path segment. `peer` is the address the
/// connection came from; none (no `ConnectInfo`) is not this PC.
pub fn check(
    peer: Option<IpAddr>,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
) -> Result<(), Refusal> {
    // `decideAccess` with no token and no device: this PC, not through a proxy (`loopback &&
    // !forwarded`). A Tailscale login is a proxy's header, so it never gets this far as this PC.
    let this_pc = peer.is_some_and(is_loopback_address) && !came_through_proxy(headers);
    if requires_auth(path) && !this_pc {
        return Err(Refusal::Unauthorized);
    }
    let mutating = !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS);
    if path.starts_with("/api/") && mutating && !same_origin(headers) {
        return Err(Refusal::InvalidOrigin);
    }
    // No route has an empty segment ("//"): refused here, a check on the path cannot read one route
    // as another
    if path.starts_with("/api/") && path.contains("//") {
        return Err(Refusal::NotFound);
    }
    Ok(())
}

/// The check `handleFleetRequest` makes first: anything but a GET carries `X-Herdr-Fleet: 1`.
pub fn check_fleet(method: &Method, headers: &HeaderMap) -> Result<(), Refusal> {
    let header = header(headers, protocol::FLEET_HEADER);
    if *method != Method::GET && header.as_deref() != Some(protocol::FLEET_HEADER_VALUE) {
        return Err(Refusal::InvalidFleetRequest);
    }
    Ok(())
}

/// [`check`] as a middleware of the whole server.
pub async fn gate(request: Request, next: Next) -> Response {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(address)| address.ip());
    if let Err(refusal) = check(
        peer,
        request.method(),
        request.uri().path(),
        request.headers(),
    ) {
        return refusal.into_response();
    }
    next.run(request).await
}

/// [`check_fleet`] as a middleware of the `/api/fleet` router, so that it covers whatever path
/// that router answers, its 404 included.
pub async fn fleet_header(request: Request, next: Next) -> Response {
    if let Err(refusal) = check_fleet(request.method(), request.headers()) {
        return refusal.into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    // server/access.test.ts, "knows a name for this machine from a proxied Host"
    #[test]
    fn knows_a_name_for_this_machine_from_a_proxied_host() {
        for host in [
            "localhost",
            "localhost:7317",
            "LOCALHOST:5173",
            "herdr.localhost:7317",
            "127.0.0.1:7317",
            "127.9.9.9",
            "[::1]:7317",
            "localhost.:7317",
            "[::ffff:127.0.0.1]:7317",
        ] {
            assert!(is_loopback_host(host), "{host}");
        }
        for host in [
            "app.example.test",
            "app.example.test:8443",
            "192.168.0.10:7317",
            "localhost.example.test",
            "127.0.0.1.example.test",
            "[fd7a::1]:7317",
            "",
            "0.0.0.0:7317",
            "[::ffff:192.168.0.10]",
        ] {
            assert!(!is_loopback_host(host), "{host}");
        }
        // not an authority: a URL parser would have read these as localhost
        for host in [
            "public.example@localhost:7317",
            "localhost/x@public.example",
            "localhost:7317/x",
            "localhost?x",
            "local host",
            "localhost:port",
            "localhost..",
            "127.0.0.1@public.example",
        ] {
            assert!(!is_loopback_host(host), "{host}");
        }
    }

    // worked out from the regular expression of `isLoopbackHost`: a port has 1 to 5 digits, and a
    // bracketed address only hex digits, `:` and `.`
    #[test]
    fn reads_a_port_and_a_bracketed_address_as_the_expression_does() {
        for host in ["localhost:1", "localhost:99999", "[::1]", "127.0.0.1:"] {
            let expected = host != "127.0.0.1:";
            assert_eq!(is_loopback_host(host), expected, "{host}");
        }
        for host in [
            "localhost:123456",
            "[::1]x",
            "[::1]:",
            "[::g]",
            "[]",
            "127.0.0.1:7317:1",
        ] {
            assert!(!is_loopback_host(host), "{host}");
        }
    }

    // server/access.test.ts, "sees a proxy in a forwarding header or in a Host that is not this machine"
    #[test]
    fn sees_a_proxy_in_a_forwarding_header_or_in_a_host_that_is_not_this_machine() {
        assert!(!came_through_proxy(&headers(&[("host", "localhost:7317")])));
        assert!(!came_through_proxy(&headers(&[
            ("host", "127.0.0.1:7317"),
            ("origin", "http://127.0.0.1:7317"),
        ])));
        // no Host at all: HTTP/1.0 through a proxy, never a local browser or CLI
        assert!(came_through_proxy(&headers(&[])));
        assert!(came_through_proxy(&headers(&[(
            "host",
            "public.example@localhost:7317"
        )])));
        assert!(came_through_proxy(&headers(&[(
            "host",
            "app.example.test"
        )])));
        for name in [
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
            "x-real-ip",
            "forwarded",
            "via",
        ] {
            assert!(
                came_through_proxy(&headers(&[("host", "127.0.0.1:7317"), (name, "x")])),
                "{name}"
            );
        }
    }

    // server/access.test.ts, "asks a tagged PC's visitors to pair, …": a login header alone marks a proxy
    #[test]
    fn a_login_header_alone_marks_a_proxy() {
        assert!(came_through_proxy(&headers(&[
            ("host", "localhost:7317"),
            ("tailscale-user-login", "them@example.com"),
        ])));
    }

    // server/access.test.ts, "refuses a DNS-rebound page: loopback address, foreign Host, no Tailscale owner"
    #[test]
    fn refuses_a_dns_rebound_page() {
        assert!(came_through_proxy(&headers(&[
            ("host", "evil.example:7317"),
            ("origin", "http://evil.example:7317"),
        ])));
    }

    // two Host headers: the Fetch API's `Headers.get` joins them with ", ", which is no authority
    #[test]
    fn two_hosts_are_no_name_for_this_machine() {
        assert!(came_through_proxy(&headers(&[
            ("host", "localhost:7317"),
            ("host", "evil.example"),
        ])));
    }

    // server/access.test.ts, "knows loopback addresses in every spelling"
    #[test]
    fn knows_loopback_addresses_in_every_spelling() {
        for address in ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"] {
            assert!(is_loopback_address(address.parse().unwrap()), "{address}");
        }
        for address in [
            "192.168.0.10",
            "100.64.0.2",
            "::ffff:192.168.0.10",
            "fd7a::1",
        ] {
            assert!(!is_loopback_address(address.parse().unwrap()), "{address}");
        }
    }

    // server/machines.test.ts, "refuses a change from another site" (its sameOrigin lines), with the
    // Host the request was sent to standing for `request.url`
    #[test]
    fn refuses_a_change_from_another_site() {
        let host = ("host", "localhost:7317");
        assert!(!same_origin(&headers(&[
            host,
            ("origin", "http://evil.test")
        ])));
        assert!(same_origin(&headers(&[
            host,
            ("origin", "http://localhost:7317")
        ])));
        assert!(!same_origin(&headers(&[
            host,
            ("sec-fetch-site", "cross-site")
        ])));
    }

    // server/http.ts `sameOrigin`, worked out by hand: a request with no Origin is no browser
    // page's; `same-origin` and `none` (a typed address) are this app's; an Origin is compared as
    // `URL.origin` reads it (scheme, host and port, a default port dropped)
    #[test]
    fn compares_the_origin_as_a_url_origin() {
        let host = ("host", "127.0.0.1:7400");
        assert!(same_origin(&headers(&[host])));
        assert!(same_origin(&headers(&[
            host,
            ("sec-fetch-site", "same-origin")
        ])));
        assert!(same_origin(&headers(&[host, ("sec-fetch-site", "none")])));
        assert!(!same_origin(&headers(&[
            host,
            ("sec-fetch-site", "same-site")
        ])));
        assert!(same_origin(&headers(&[
            host,
            ("origin", "HTTP://127.0.0.1:7400")
        ])));
        assert!(!same_origin(&headers(&[
            host,
            ("origin", "http://127.0.0.1:7401")
        ])));
        assert!(!same_origin(&headers(&[
            host,
            ("origin", "https://127.0.0.1:7400")
        ])));
        assert!(!same_origin(&headers(&[
            host,
            ("origin", "http://localhost:7400")
        ])));
        assert!(!same_origin(&headers(&[host, ("origin", "null")])));
        let bare = ("host", "localhost");
        assert!(same_origin(&headers(&[
            bare,
            ("origin", "http://localhost:80")
        ])));
        assert!(same_origin(&headers(&[
            bare,
            ("origin", "http://LocalHost")
        ])));
        assert!(!same_origin(&headers(&[
            bare,
            ("origin", "http://localhost:8080")
        ])));
        // two Origin headers join into one value no URL parser reads
        assert!(!same_origin(&headers(&[
            bare,
            ("origin", "http://localhost"),
            ("origin", "http://localhost"),
        ])));
    }

    // server/access.test.ts, "never lets a request in without a token or a device, even before
    // anything is paired" (`loopback: false`) and "lets this PC in without a token, but not through
    // a proxy", through the checks of server/index.ts's `fetch`
    #[test]
    fn lets_this_pc_in_and_nothing_else() {
        let local: Option<IpAddr> = Some("127.0.0.1".parse().unwrap());
        let host = headers(&[("host", "127.0.0.1:7400")]);
        assert_eq!(check(local, &Method::GET, "/api/fleet/runs", &host), Ok(()));
        let mapped = Some("::ffff:127.0.0.1".parse().unwrap());
        assert_eq!(
            check(mapped, &Method::GET, "/api/fleet/runs", &host),
            Ok(())
        );
        for peer in ["192.168.0.10", "100.64.0.2", "::ffff:192.168.0.10"] {
            let peer = Some(peer.parse().unwrap());
            assert_eq!(
                check(peer, &Method::GET, "/api/fleet/runs", &host),
                Err(Refusal::Unauthorized)
            );
        }
        assert_eq!(
            check(None, &Method::GET, "/api/fleet/runs", &host),
            Err(Refusal::Unauthorized)
        );
        let forwarded = headers(&[("host", "localhost:7400"), ("x-forwarded-for", "127.0.0.1")]);
        assert_eq!(
            check(local, &Method::GET, "/api/fleet/runs", &forwarded),
            Err(Refusal::Unauthorized)
        );
        // what needs no access in server/auth.ts passes the access check (phase 4 serves it)
        let foreign = headers(&[("host", "evil.example")]);
        assert_eq!(check(None, &Method::GET, "/", &foreign), Ok(()));
        assert_eq!(check(None, &Method::GET, "/api/health", &foreign), Ok(()));
    }

    // server/index.ts:1113-1115: a change to /api/ is this app's page's or no page's
    #[test]
    fn refuses_a_change_from_another_origin() {
        let local = Some("127.0.0.1".parse().unwrap());
        let other = headers(&[
            ("host", "127.0.0.1:7400"),
            ("origin", "http://evil.example"),
        ]);
        for method in [Method::POST, Method::PUT, Method::DELETE, Method::PATCH] {
            assert_eq!(
                check(local, &method, "/api/fleet/spawn", &other),
                Err(Refusal::InvalidOrigin),
                "{method}"
            );
        }
        for method in [Method::GET, Method::HEAD, Method::OPTIONS] {
            assert_eq!(
                check(local, &method, "/api/fleet/runs", &other),
                Ok(()),
                "{method}"
            );
        }
    }

    // server/index.ts:1116-1118: no route has an empty segment
    #[test]
    fn finds_no_api_path_with_an_empty_segment() {
        let local = Some("127.0.0.1".parse().unwrap());
        let host = headers(&[("host", "127.0.0.1:7400")]);
        assert_eq!(
            check(local, &Method::GET, "/api//fleet/runs", &host),
            Err(Refusal::NotFound)
        );
        assert_eq!(
            check(local, &Method::GET, "/api/fleet/runs//x", &host),
            Err(Refusal::NotFound)
        );
    }

    // server/fleet/api.test.ts, "refuses a change without X-Herdr-Fleet: 1, which a page on another
    // site cannot send", with the 403 lines of its usage refresh and clear, entrances, plan and
    // settings tests (ADR 0269-fleet-api hands them to the core): every method but GET needs it
    #[test]
    fn refuses_a_change_without_x_herdr_fleet() {
        let none = headers(&[]);
        for method in [Method::POST, Method::HEAD, Method::OPTIONS, Method::DELETE] {
            assert_eq!(
                check_fleet(&method, &none),
                Err(Refusal::InvalidFleetRequest),
                "{method}"
            );
        }
        assert_eq!(check_fleet(&Method::GET, &none), Ok(()));
        assert_eq!(
            check_fleet(&Method::POST, &headers(&[("x-herdr-fleet", "1")])),
            Ok(())
        );
        // the Fetch API strips a value's surrounding whitespace
        assert_eq!(
            check_fleet(&Method::POST, &headers(&[("x-herdr-fleet", " 1\t")])),
            Ok(())
        );
        for value in ["0", "true", "1 1", ""] {
            assert_eq!(
                check_fleet(&Method::POST, &headers(&[("x-herdr-fleet", value)])),
                Err(Refusal::InvalidFleetRequest),
                "{value:?}"
            );
        }
        // two of them read as "1, 1"
        assert_eq!(
            check_fleet(
                &Method::POST,
                &headers(&[("x-herdr-fleet", "1"), ("x-herdr-fleet", "1")])
            ),
            Err(Refusal::InvalidFleetRequest)
        );
    }

    // server/auth.ts `requiresAuth`
    #[test]
    fn asks_who_it_is_of_the_api_and_the_socket_only() {
        for path in ["/api/fleet/runs", "/api/fleet", "/api/other", "/ws"] {
            assert!(requires_auth(path), "{path}");
        }
        for path in [
            "/",
            "/index.html",
            "/api/health",
            "/api/auth",
            "/api/devices/pair",
            "/apix",
        ] {
            assert!(!requires_auth(path), "{path}");
        }
    }
}
