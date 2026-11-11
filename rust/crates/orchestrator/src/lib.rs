//! fleet の run、委ねたターン、thread、役割、エージェント adapter の起動の引数と環境変数、使用量とモデル一覧、run の記録、herdr を操作する Runtime(今の `HerdrRuntime`)を持ち、`/api/fleet` のルートを公開する。
//!
//! Responsibility and dependencies: docs/rust-migration/adr/0107-crate-split.md. The modules and
//! the issue that fills each: docs/rust-migration/adr/0242-phase-3-split.md ("Issue の分け方").
//! Each module is public, so its issue decides what it exposes without writing this file.

pub mod clock;
pub mod error;

pub mod agents;
pub mod brief;
pub mod config;
pub mod entrances;
pub mod launch;

pub mod events;
pub mod outbox;
pub mod registry;
pub mod report;

pub mod plan;

pub mod github;
pub mod models;
pub mod thread;
pub mod usage;

pub mod metrics;
pub mod settings;

pub mod fleet;
pub mod herdr_runtime;
pub mod runtime;

pub mod api;

mod safe_open;

pub use clock::{Clock, SystemClock};
pub use error::FleetError;
