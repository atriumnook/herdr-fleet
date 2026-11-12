//! HTTP・WebSocket のサーバー(ルート、アクセス制御、attach とミラー、エージェントの状態の購読、transcript の場所の特定、push 通知、サイドチャット、Explain、Web UI の配信)。
//!
//! Responsibility and dependencies: docs/rust-migration/adr/0107-crate-split.md.
//!
//! Phase 3 holds the minimal core of ADR 0242-phase-3-split ("Rust の core が thread を 1 つ起動して
//! 終える", #270): `/api/fleet` behind the access control of a server with no token and no paired
//! device, the orchestrator over herdr, the receiver of herdr's pane status, and the pull request
//! poll. Phase 4 adds the other routes, the token and the paired devices.

pub mod access;
pub mod app;
pub mod start;
