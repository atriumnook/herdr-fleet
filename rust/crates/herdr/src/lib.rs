//! herdr の socket のクライアント(RPC、イベントの購読、Windows の marker と named pipe)。
//!
//! Responsibility and dependencies: docs/rust-migration/adr/0107-crate-split.md. The interface:
//! docs/rust-migration/adr/0252-herdr-client.md.

mod answer;
mod client;
mod error;
mod events;
mod lines;
pub mod marker;
pub mod pane_status;
pub mod socket;

pub use answer::{ANSWERS, Answer};
pub use client::Herdr;
pub use error::HerdrError;
pub use events::{EventFrame, EventSender, EventSource, EventStream, SnapshotFuture, StreamItem};
