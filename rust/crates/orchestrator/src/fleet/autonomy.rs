//! The projects run without the person (fleet.json's `autonomous`): the standstill call, the
//! threads closed against GitHub, and what a merge read without the person does; `superviseProjects`
//! and its helpers of `server/fleet/orchestrator.ts`. #268 fills it; until then its hook does
//! nothing.

use super::Orchestrator;
use crate::github::PullRequestReading;

/// What the supervision keeps while this server runs (`quietSince`, `andonSent`, `settledSince`,
/// `reconciledAt`).
#[derive(Debug, Default)]
pub(crate) struct State {}

/// Where a merge of a thread's pull request was read in a project run without the person.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeSeen {
    /// as the thread lead's turn ended (`settleThreadTurn`)
    TurnEnded,
    /// by the polling of the open pull requests (`refreshPullRequests`)
    Polled,
}

impl Orchestrator {
    /// A thread's pull request read merged in a project run without the person: whether the thread
    /// closes, waits, and what its coordinator hears (#176's 1-3). #266 calls it from both places a
    /// merge is read; `settleThreadTurn` awaits it before it writes the coordinator's news.
    #[allow(dead_code, reason = "stub: #268; #266 calls it")]
    pub(crate) async fn merged_without_person(
        &self,
        thread: &str,
        reading: &PullRequestReading,
        seen: MergeSeen,
    ) {
        // stub: #268
        let _ = (thread, reading, seen);
    }
}
