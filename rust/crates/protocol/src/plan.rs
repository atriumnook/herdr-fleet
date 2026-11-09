//! A thread lead's plan (`shared/plan.ts`): a tree of claims the person reads level by level and
//! answers in place, before the lead builds a large change. This module holds the types and the
//! limits; the checks (`parsePlan`, `numberClaims`, `planAsks`, `planOpen`) come with #250.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A plan as the lead writes it and the server keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// Counts the plans this thread's lead handed over: answers name the one they answer.
    pub version: u32,
    /// When the server took it (epoch ms).
    pub written_at: i64,
    /// The change and the place, in a few words.
    pub title: String,
    /// The person's own words that asked for it.
    pub why: Vec<String>,
    /// What someone can now do or see, each with how it works and where.
    pub claims: Vec<PlanClaim>,
    /// What the claims share, such as one new table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared: Option<PlanShared>,
    /// What the change leaves alone.
    pub scope: Vec<String>,
    /// When the person answered this version (epoch ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<PlanAnswer>,
    /// When the lead went on to another turn without the answers, which closed this version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<i64>,
}

/// The plan as the lead wrote it, before the server reads its code and numbers its version
/// (`PlanInput`: `Plan` without `version`, `writtenAt`, `answeredAt`, `answer` and `closedAt`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanInput {
    pub title: String,
    pub why: Vec<String>,
    pub claims: Vec<PlanClaim>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared: Option<PlanShared>,
    pub scope: Vec<String>,
}

/// What the claims of a plan share.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanShared {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exhibit: Option<PlanExhibit>,
}

/// One claim: a sentence that can be true or false, its exhibit, a decision on it, and the claims
/// under it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanClaim {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exhibit: Option<PlanExhibit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask: Option<PlanAsk>,
    pub children: Vec<PlanClaim>,
}

/// What proves a claim. `Code` names lines of a file in the thread's worktree, which the server
/// reads into `lines`; with `text` it is code the lead proposes, shown as written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PlanExhibit {
    Code {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        end: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lang: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lines: Option<Vec<String>>,
    },
    Schema {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lang: Option<String>,
        text: String,
    },
    Calls {
        rows: Vec<PlanCallRow>,
    },
    List {
        items: Vec<String>,
    },
}

/// One row of a call tree: its depth (0 to 5), what is called, and where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanCallRow {
    pub depth: u32,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

/// A decision for the person, with the option the lead recommends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanAsk {
    pub id: String,
    pub question: String,
    pub options: Vec<PlanOption>,
    pub recommended: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanOption {
    pub value: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The person's answers to one version of a plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanAnswer {
    pub version: u32,
    /// The option picked for each decision, by its id.
    pub choices: BTreeMap<String, String>,
    /// The decisions the person looked at: the others keep the lead's recommendation, unopened.
    pub seen: Vec<String>,
    /// Comments on claims, by the claim's number (1, 1.2, 1.2.1, shared).
    pub comments: Vec<PlanComment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanComment {
    pub claim: String,
    pub text: String,
}

/// What a run keeps of its plan, so the thread list can say a plan waits without reading it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanMark {
    pub version: u32,
    pub asks: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<i64>,
}

/// One claim with its number (1, 1.2, 1.2.1) and its level, in reading order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumberedClaim<'a> {
    pub id: String,
    pub level: u32,
    pub claim: &'a PlanClaim,
}

/// How long and how many the parts of a plan may be (`PLAN_LIMITS`). Lengths count UTF-16 code
/// units, as JavaScript's `length`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanLimits {
    pub title: usize,
    pub why: usize,
    pub quote: usize,
    pub claims: usize,
    pub depth: usize,
    pub text: usize,
    pub asks: usize,
    pub options: usize,
    pub code_lines: usize,
    pub code_line: usize,
    pub schema: usize,
    pub rows: usize,
    pub items: usize,
    pub scope: usize,
    pub comments: usize,
    pub comment: usize,
    pub note: usize,
}

pub const PLAN_LIMITS: PlanLimits = PlanLimits {
    title: 120,
    why: 5,
    quote: 600,
    claims: 5,
    depth: 3,
    text: 300,
    asks: 5,
    options: 5,
    code_lines: 60,
    code_line: 480,
    schema: 4000,
    rows: 30,
    items: 12,
    scope: 8,
    comments: 50,
    comment: 2000,
    note: 4000,
};
