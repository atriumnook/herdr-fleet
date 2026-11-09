//! The brief a spawn hands its agent; from `server/fleet/brief.ts`.
//!
//! A helper cannot see its caller's conversation, so a brief missing one of its fields leaves it
//! to guess (pstack's orchestrate brief, less what the fleet adds itself: the report shape and the
//! standing orders).

use std::path::{Path, PathBuf};

use crate::FleetError;
use crate::config::resolve;

/// What an agent handing work on has to say about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Brief {
    /// The outcome, in one sentence.
    pub goal: String,
    /// The paths the helper may change, from its folder; none for work that only reads.
    pub write: Vec<String>,
    /// The files, earlier results and decisions it needs; "none" when it depends on nothing.
    pub context: String,
    /// A checkable condition for done.
    pub done: String,
    /// How to check it, and the evidence to return.
    pub verify: String,
    pub forbidden: Option<String>,
    pub timebox: Option<String>,
}

/// A brief as given (TypeScript's `Partial<Brief>`): any field may be missing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BriefDraft {
    pub goal: Option<String>,
    pub write: Option<Vec<String>>,
    pub context: Option<String>,
    pub done: Option<String>,
    pub verify: Option<String>,
    pub forbidden: Option<String>,
    pub timebox: Option<String>,
}

/// A path of one write scope that is, contains or lies within a path of another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overlap {
    pub mine: String,
    pub theirs: String,
}

/// The brief's fields, each present, or a `FleetError` that names every one missing. An empty
/// write list is present: the helper only reads.
pub fn check_brief(brief: Option<BriefDraft>) -> Result<Brief, FleetError> {
    let brief = brief.unwrap_or_default();
    let blank = |field: &Option<String>| {
        field
            .as_deref()
            .is_none_or(|text| protocol::js::trim(text).is_empty())
    };
    let missing: Vec<&str> = [
        ("goal", blank(&brief.goal)),
        ("write", brief.write.is_none()),
        ("context", blank(&brief.context)),
        ("done", blank(&brief.done)),
        ("verify", blank(&brief.verify)),
    ]
    .into_iter()
    .filter_map(|(key, missing)| missing.then_some(key))
    .collect();
    match brief {
        BriefDraft {
            goal: Some(goal),
            write: Some(write),
            context: Some(context),
            done: Some(done),
            verify: Some(verify),
            forbidden,
            timebox,
        } if missing.is_empty() => Ok(Brief {
            goal,
            write,
            context,
            done,
            verify,
            forbidden,
            timebox,
        }),
        _ => Err(FleetError::new(
            "incomplete_brief",
            format!(
                "An agent hands work on with a full brief; missing: {}. Give --goal, --write <path> (or --read-only), --context (or \"none\"), --done and --verify.",
                missing.join(", ")
            ),
        )),
    }
}

/// The brief as the helper's task.
pub fn render_brief(brief: &Brief, note: Option<&str>) -> String {
    let may_change = if brief.write.is_empty() {
        "Nothing: this task only reads.".to_owned()
    } else {
        let paths: Vec<String> = brief.write.iter().map(|path| format!("- {path}")).collect();
        format!("{}\nChange nothing outside these paths.", paths.join("\n"))
    };
    let mut parts = vec![
        "## Goal".to_owned(),
        protocol::js::trim(&brief.goal).to_owned(),
        "## You may change".to_owned(),
        may_change,
        "## Context".to_owned(),
        protocol::js::trim(&brief.context).to_owned(),
        "## Done when".to_owned(),
        protocol::js::trim(&brief.done).to_owned(),
        "## Verify".to_owned(),
        protocol::js::trim(&brief.verify).to_owned(),
    ];
    if let Some(forbidden) = given(brief.forbidden.as_deref()) {
        parts.extend(["## Forbidden".to_owned(), forbidden.to_owned()]);
    }
    if let Some(timebox) = given(brief.timebox.as_deref()) {
        parts.extend([
            "## Timebox".to_owned(),
            format!("{timebox}. When it runs out, report what you have and stop."),
        ]);
    }
    if let Some(note) = given(note) {
        parts.extend(["## Notes".to_owned(), note.to_owned()]);
    }
    parts.join("\n\n")
}

/// A field given with text in it, trimmed.
fn given(field: Option<&str>) -> Option<&str> {
    field
        .map(protocol::js::trim)
        .filter(|text| !text.is_empty())
}

/// The write paths as absolute paths, so two runs in the same folder compare whatever they wrote.
pub fn write_scope(cwd: &Path, write: &[String]) -> Vec<String> {
    write
        .iter()
        .map(|path| resolve(cwd, path).to_string_lossy().into_owned())
        .collect()
}

/// The first path of `a` that is, contains or lies within a path of `b`. The paths are compared
/// part by part, so a folder whose name starts with `..` lies within its parent; TypeScript reads
/// `relative()`'s text and takes such a folder for one outside (`brief.ts:57`). Both lists are
/// `write_scope`'s results: a path with `.` or `..` left in it is not folded here.
pub fn overlap(a: &[String], b: &[String]) -> Option<Overlap> {
    let within = |inner: &str, outer: &str| PathBuf::from(inner).starts_with(outer);
    a.iter().find_map(|mine| {
        b.iter()
            .find(|theirs| within(mine, theirs) || within(theirs, mine))
            .map(|theirs| Overlap {
                mine: mine.clone(),
                theirs: theirs.clone(),
            })
    })
}
