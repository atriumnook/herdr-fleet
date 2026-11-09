//! ペインの外で起動するエージェント CLI、`opencode api`、git の子プロセスに、起動の種類ごとの決まり(最小の環境変数、作業フォルダー、git の `core.fsmonitor=false`、タイムアウトと kill、出力の大きさと同時に動かす数の上限)を当てる。
//!
//! Responsibility and dependencies: docs/rust-migration/adr/0107-crate-split.md.

mod env;
pub mod git;
pub mod opencode;
mod runner;
mod work_dir;

pub use env::{Env, EnvPolicy, child_env, claude_env};
pub use runner::{Command, KILL_GRACE, Output, RunError, Runner, Session, Stream, StreamLimit};
pub use work_dir::empty_work_dir;
