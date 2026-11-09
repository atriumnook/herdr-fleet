//! herdr-fleet の HTTP・WebSocket・SSE の型、ルートのパスとヘッダー名、fleet の記録の型と、サーバーとクライアントの両方が使う規則(計画の検査、通知の条件、秘密の入力の判定、Codex の patch の読み取り)と、2 つ以上の crate が使う型を持つ。
//!
//! Responsibility and dependencies: docs/rust-migration/adr/0107-crate-split.md.

mod absent;
mod conversation;
mod fleet;
mod fleet_api;
pub mod fleet_cli;
pub mod js;
mod patch;
mod plan;
mod prompt;

pub use conversation::*;
pub use fleet::*;
pub use fleet_api::*;
pub use patch::*;
pub use plan::*;
pub use prompt::*;
