//! The routes the minimal core serves and where it listens: `/api/fleet` behind the access control
//! of [`crate::access`], on `127.0.0.1` only (ADR 0242-phase-3-split, "Rust の core が thread を 1 つ
//! 起動して終える").

use std::future::Future;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};

use axum::Router;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use tokio::net::TcpListener;

use crate::access::{self, Refusal};

/// The server's routes: `fleet_api` (the orchestrator's `api::router`) nested at
/// `protocol::FLEET_API` behind [`access::fleet_header`], everything behind [`access::gate`], and a
/// 404 for any other path. The fleet router's own layer covers whatever it answers, its 404
/// included, so the header is asked of any path axum hands it, as `handleFleetRequest` asks it
/// before it looks a route up.
pub fn routes(fleet_api: Router) -> Router {
    Router::new()
        .nest(
            protocol::FLEET_API,
            fleet_api.layer(middleware::from_fn(access::fleet_header)),
        )
        .fallback(not_found)
        // last, so that it runs first and covers the fallback too
        .layer(middleware::from_fn(access::gate))
}

/// No route: phase 4 serves the rest of `/api` and the web UI.
async fn not_found() -> Response {
    Refusal::NotFound.into_response()
}

/// A listener on `127.0.0.1:port`, and on no other address: the access control lets this PC in
/// without a token, and phase 3 has no token (ADR 0242-phase-3-split). TypeScript's `HOST` is not
/// read.
pub async fn listen(port: u16) -> io::Result<TcpListener> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await
}

/// Serves `routes` on `listener` until `shutdown` resolves, each request carrying the address its
/// connection came from for the access control.
pub async fn serve(
    listener: TcpListener,
    routes: Router,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    axum::serve(
        listener,
        routes.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::routing::{get, post};
    use std::io::{Read, Write};
    use tokio::sync::oneshot;

    /// Stands in for the orchestrator's router: what reaches it says so.
    fn fleet_stub() -> Router {
        Router::new()
            .route(
                "/runs",
                get(|| async { "reached runs" }).post(|| async { "reached runs" }),
            )
            .route("/spawn", post(|| async { "reached spawn" }))
            .fallback(|| async { (StatusCode::NOT_FOUND, "fleet fallback") })
    }

    struct Server {
        port: u16,
        stop: Option<oneshot::Sender<()>>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            if let Some(stop) = self.stop.take() {
                let _ = stop.send(());
            }
        }
    }

    /// A listener on a free port of 7400-7499 (the standing orders' range).
    async fn free_listener() -> TcpListener {
        for port in 7400..7500 {
            if let Ok(listener) = listen(port).await {
                return listener;
            }
        }
        panic!("no free port in 7400-7499");
    }

    /// The routes served on a free port of 7400-7499.
    async fn start() -> Server {
        let listener = free_listener().await;
        let port = listener.local_addr().unwrap().port();
        let (stop, stopped) = oneshot::channel();
        tokio::spawn(serve(listener, routes(fleet_stub()), async {
            let _ = stopped.await;
        }));
        Server {
            port,
            stop: Some(stop),
        }
    }

    /// Sends `head` (the request line and headers, no blank line) and a body over a new connection,
    /// and returns the status and the body.
    async fn send(port: u16, head: String, body: &'static str) -> (u16, String) {
        tokio::task::spawn_blocking(move || {
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let request = format!(
                "{head}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(request.as_bytes()).unwrap();
            let mut answer = String::new();
            stream.read_to_string(&mut answer).unwrap();
            let status = answer[9..12].parse().unwrap();
            let body = answer
                .split_once("\r\n\r\n")
                .map(|(_, body)| body.to_owned())
                .unwrap_or_default();
            (status, body)
        })
        .await
        .unwrap()
    }

    fn error(code: &str, message: &str) -> String {
        serde_json::json!({ "error": { "code": code, "message": message } }).to_string()
    }

    #[tokio::test]
    async fn listens_on_the_loopback_address_only() {
        let listener = free_listener().await;
        assert_eq!(
            listener.local_addr().unwrap().ip(),
            std::net::IpAddr::from(Ipv4Addr::LOCALHOST)
        );
    }

    // what the fleet CLI sends (cli/src/http.rs: `x-herdr-fleet: 1`, no Origin), and a GET
    #[tokio::test]
    async fn lets_the_fleet_cli_in() {
        let server = start().await;
        let host = format!("Host: 127.0.0.1:{}", server.port);
        let get = send(
            server.port,
            format!("GET /api/fleet/runs HTTP/1.1\r\n{host}"),
            "",
        )
        .await;
        assert_eq!(get, (200, "reached runs".to_owned()));
        let post = format!("POST /api/fleet/spawn HTTP/1.1\r\n{host}\r\nx-herdr-fleet: 1");
        assert_eq!(
            send(server.port, post, "{}").await,
            (200, "reached spawn".to_owned())
        );
        let localhost = format!(
            "GET /api/fleet/runs HTTP/1.1\r\nHost: localhost:{}",
            server.port
        );
        assert_eq!(send(server.port, localhost, "").await.0, 200);
    }

    // ADR 0242-phase-3-split: a Host that is not this machine (a DNS-rebound page) is refused
    #[tokio::test]
    async fn refuses_a_host_that_is_not_this_machine() {
        let server = start().await;
        for host in [
            "evil.example:7400",
            "192.168.0.10:7400",
            "public.example@localhost",
        ] {
            let head = format!("GET /api/fleet/runs HTTP/1.1\r\nHost: {host}");
            assert_eq!(
                send(server.port, head, "").await,
                (
                    401,
                    error("unauthorized", "pair this device, or use the token")
                ),
                "{host}"
            );
        }
    }

    // ADR 0242-phase-3-split: `Host: localhost` with a forwarding header came through a proxy
    #[tokio::test]
    async fn refuses_a_forwarded_request_to_localhost() {
        let server = start().await;
        for header in [
            "X-Forwarded-For: 127.0.0.1",
            "X-Forwarded-Host: localhost",
            "X-Forwarded-Proto: http",
            "X-Real-IP: 127.0.0.1",
            "Forwarded: for=127.0.0.1",
            "Via: 1.1 proxy",
            "Tailscale-User-Login: me@example.com",
        ] {
            let head = format!("GET /api/fleet/runs HTTP/1.1\r\nHost: localhost\r\n{header}");
            assert_eq!(
                send(server.port, head, "").await,
                (
                    401,
                    error("unauthorized", "pair this device, or use the token")
                ),
                "{header}"
            );
        }
    }

    // server/fleet/api.test.ts, "refuses a change without X-Herdr-Fleet: 1, which a page on another
    // site cannot send": `POST /spawn` without the header is 403, before any route is looked up
    #[tokio::test]
    async fn refuses_a_change_without_x_herdr_fleet() {
        let server = start().await;
        let host = format!("Host: 127.0.0.1:{}", server.port);
        let refused = (403, error("invalid_fleet_request", "Send X-Herdr-Fleet: 1"));
        for path in [
            "/api/fleet/spawn",
            "/api/fleet/runs",
            "/api/fleet/no-such-route",
            "/api/fleet",
        ] {
            let head = format!("POST {path} HTTP/1.1\r\n{host}");
            assert_eq!(send(server.port, head, "{}").await, refused, "{path}");
        }
        let head = format!("OPTIONS /api/fleet/runs HTTP/1.1\r\n{host}");
        assert_eq!(send(server.port, head, "").await, refused);
    }

    // server/index.ts:1113-1115: a change from another site's page, the header included
    #[tokio::test]
    async fn refuses_a_change_from_another_origin() {
        let server = start().await;
        let host = format!("Host: 127.0.0.1:{}", server.port);
        let head = format!(
            "POST /api/fleet/spawn HTTP/1.1\r\n{host}\r\nx-herdr-fleet: 1\r\nOrigin: http://evil.example"
        );
        assert_eq!(
            send(server.port, head, "{}").await,
            (403, error("invalid_origin", "Use controls from this app"))
        );
        let head = format!(
            "POST /api/fleet/spawn HTTP/1.1\r\n{host}\r\nx-herdr-fleet: 1\r\nSec-Fetch-Site: cross-site"
        );
        assert_eq!(send(server.port, head, "{}").await.0, 403);
        let head = format!(
            "POST /api/fleet/spawn HTTP/1.1\r\n{host}\r\nx-herdr-fleet: 1\r\nOrigin: http://127.0.0.1:{}",
            server.port
        );
        assert_eq!(send(server.port, head, "{}").await.0, 200);
    }

    // a path that spells /api/fleet otherwise reaches no fleet route: axum routes the path as sent
    #[tokio::test]
    async fn routes_no_other_spelling_of_the_fleet_path() {
        let server = start().await;
        let host = format!("Host: 127.0.0.1:{}", server.port);
        let not_found = (404, error("not_found", "not found"));
        for path in [
            "/api/%66leet/runs",
            "/%61pi/fleet/runs",
            "/api/fleetx",
            "/",
            "/api/other",
        ] {
            let head = format!("GET {path} HTTP/1.1\r\n{host}");
            assert_eq!(send(server.port, head, "").await, not_found, "{path}");
        }
        let head = format!("GET /api//fleet/runs HTTP/1.1\r\n{host}");
        assert_eq!(send(server.port, head, "").await, not_found);
        // the fleet router's own 404 behind the header check
        let head = format!("GET /api/fleet/no-such-route HTTP/1.1\r\n{host}");
        assert_eq!(
            send(server.port, head, "").await,
            (404, "fleet fallback".to_owned())
        );
    }
}
