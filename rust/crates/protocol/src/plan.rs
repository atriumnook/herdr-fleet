//! A thread lead's plan (`shared/plan.ts`): a tree of claims the person reads level by level and
//! answers in place, before the lead builds a large change. This module holds the types, the
//! limits and the checks the server and the client share (`parsePlan`, `numberClaims`, `planAsks`,
//! `planOpen`).

use std::collections::HashSet;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::js;

/// A plan as the lead writes it and the server keeps it. The fields are in the order plan.ts's
/// `preparePlan` writes a new plan's keys in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
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
    /// Counts the plans this thread's lead handed over: answers name the one they answer.
    pub version: u32,
    /// When the server took it (epoch ms).
    pub written_at: i64,
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
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lang: Option<String>,
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
    /// The option picked for each decision, by its id, in the order the object lists them.
    pub choices: IndexMap<String, String>,
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

/// How [`parse_plan`] reads a plan.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ParsePlanOptions {
    /// A plan the server kept, read back, whose code exhibits hold the lines it read.
    pub stored: bool,
}

/// `parsePlan`: checks a plan the lead wrote and answers it in the shape the fleet keeps, or every
/// problem found, so the lead fixes them all at once. Unknown keys are left out. The problems are
/// TypeScript's, word for word and in its order. A `null` reads as an absent field, as there,
/// except where TypeScript tells them apart: `claims` absent is required, `null` is none; and a
/// stored code exhibit's `lines: null` is wrong, as an absent one is not.
///
/// Line numbers past `u32` are refused as no line number, where TypeScript takes any integer.
pub fn parse_plan(value: &Value, options: ParsePlanOptions) -> Result<PlanInput, Vec<String>> {
    let Value::Object(value) = value else {
        return Err(vec!["the plan must be a JSON object".into()]);
    };
    let mut check = Check {
        errors: Vec::new(),
        asks: HashSet::new(),
        stored: options.stored,
    };
    let l = PLAN_LIMITS;
    let title = check.text(value.get("title"), "title", l.title, true);
    let why = check.texts(value.get("why"), "why", l.why, l.quote);
    let claims = check.claims(value.get("claims"), "claims", 1);
    match value.get("claims") {
        Some(Value::Array(claims)) if claims.is_empty() => {
            check.fail("claims must hold at least one claim".into())
        }
        None => check.fail("claims is required".into()),
        _ => {}
    }
    let mut shared = None;
    match value.get("shared") {
        None | Some(Value::Null) => {}
        Some(Value::Object(fields)) => {
            let text = check.text(fields.get("text"), "shared.text", l.text, true);
            let exhibit = check.exhibit(fields.get("exhibit"), "shared.exhibit");
            shared = text.map(|text| PlanShared { text, exhibit });
        }
        Some(_) => check.fail("shared must be an object".into()),
    }
    let scope = check.texts(value.get("scope"), "scope", l.scope, l.text);
    if check.asks.len() > l.asks {
        check.fail(format!(
            "a plan asks at most {} decisions; ask only what changes what you build",
            l.asks
        ));
    }
    match title {
        Some(title) if check.errors.is_empty() => Ok(PlanInput {
            title,
            why,
            claims,
            shared,
            scope,
        }),
        _ if check.errors.is_empty() => Err(vec!["title is required".into()]),
        _ => Err(check.errors),
    }
}

/// The problems found so far, and the decisions' ids, to find one used twice.
struct Check {
    errors: Vec<String>,
    asks: HashSet<String>,
    stored: bool,
}

/// A field that is absent or `null`: TypeScript's `v === undefined || v === null`.
fn nullish(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

/// `/^[a-z0-9][a-z0-9_-]{0,31}$/i`: a decision's id and an option's value.
fn is_id(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && text.len() <= 32
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `Number.isInteger(value)`: a JSON number with no fraction, as a float.
fn integer(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|number| number.is_finite() && number.fract() == 0.0)
}

impl Check {
    fn fail(&mut self, error: String) {
        self.errors.push(error);
    }

    /// A required or optional string, trimmed, of at most `max` UTF-16 code units.
    fn text(
        &mut self,
        value: Option<&Value>,
        at: &str,
        max: usize,
        required: bool,
    ) -> Option<String> {
        match value {
            None | Some(Value::Null) => {
                if required {
                    self.fail(format!("{at} is required"));
                }
                None
            }
            Some(Value::String(text)) if !js::trim(text).is_empty() => {
                if js::utf16_len(text) > max {
                    self.fail(format!("{at} is longer than {max} characters"));
                    return None;
                }
                Some(js::trim(text).to_owned())
            }
            Some(_) => {
                self.fail(format!("{at} must be a non-empty string"));
                None
            }
        }
    }

    /// A list of at most `count` strings; the ones past `count` are left out.
    fn texts(&mut self, value: Option<&Value>, at: &str, count: usize, max: usize) -> Vec<String> {
        match value {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => {
                if items.len() > count {
                    self.fail(format!("{at} has more than {count} entries"));
                }
                items
                    .iter()
                    .take(count)
                    .enumerate()
                    .filter_map(|(index, each)| {
                        self.text(Some(each), &format!("{at}[{index}]"), max, true)
                    })
                    .collect()
            }
            Some(_) => {
                self.fail(format!("{at} must be a list of strings"));
                Vec::new()
            }
        }
    }

    fn line(&mut self, value: Option<&Value>, at: &str) -> Option<u32> {
        if nullish(value) {
            return None;
        }
        let line = value
            .and_then(integer)
            .filter(|line| *line >= 1.0 && *line <= f64::from(u32::MAX));
        if line.is_none() {
            self.fail(format!("{at} must be a line number from 1"));
        }
        line.map(|line| line as u32)
    }

    fn exhibit(&mut self, value: Option<&Value>, at: &str) -> Option<PlanExhibit> {
        let fields = match value {
            None | Some(Value::Null) => return None,
            Some(Value::Object(fields)) => fields,
            Some(_) => {
                self.fail(format!("{at} must be an object"));
                return None;
            }
        };
        let l = PLAN_LIMITS;
        match fields.get("kind").and_then(Value::as_str) {
            Some("code") => {
                let path = self.text(fields.get("path"), &format!("{at}.path"), 500, true);
                let code = self.text(fields.get("text"), &format!("{at}.text"), l.schema, false);
                let lang = self.text(fields.get("lang"), &format!("{at}.lang"), 20, false);
                let start = self.line(fields.get("start"), &format!("{at}.start"));
                let end = self.line(fields.get("end"), &format!("{at}.end")).or(start);
                if code.is_none() {
                    match (start, end) {
                        (None, _) => self.fail(format!(
                            "{at} needs start (and end) to show lines of {}, or text for code it proposes",
                            path.as_deref().unwrap_or("the file")
                        )),
                        (Some(start), Some(end))
                            if end < start || u64::from(end - start) + 1 > l.code_lines as u64 =>
                        {
                            self.fail(format!("{at} must show 1 to {} lines", l.code_lines))
                        }
                        _ => {}
                    }
                }
                let mut lines = None;
                if self.stored
                    && let Some(read) = fields.get("lines")
                {
                    match read {
                        Value::Array(read)
                            if read.len() <= l.code_lines
                                && read.iter().all(|each| {
                                    each.as_str()
                                        .is_some_and(|each| js::utf16_len(each) <= l.code_line)
                                }) =>
                        {
                            lines = Some(
                                read.iter()
                                    .filter_map(|each| each.as_str().map(str::to_owned))
                                    .collect(),
                            );
                        }
                        _ => self.fail(format!("{at}.lines must be up to {} lines", l.code_lines)),
                    }
                }
                Some(PlanExhibit::Code {
                    path: path?,
                    start,
                    end,
                    lang,
                    text: code,
                    lines,
                })
            }
            Some("schema") => {
                let text = self.text(fields.get("text"), &format!("{at}.text"), l.schema, true);
                let lang = self.text(fields.get("lang"), &format!("{at}.lang"), 20, false);
                Some(PlanExhibit::Schema { lang, text: text? })
            }
            Some("calls") => {
                let rows = match fields.get("rows") {
                    Some(Value::Array(rows)) if !rows.is_empty() => rows,
                    _ => {
                        self.fail(format!("{at}.rows must be a non-empty list"));
                        return None;
                    }
                };
                if rows.len() > l.rows {
                    self.fail(format!("{at}.rows has more than {} rows", l.rows));
                }
                let rows = rows
                    .iter()
                    .take(l.rows)
                    .enumerate()
                    .filter_map(|(index, row)| self.row(row, &format!("{at}.rows[{index}]")))
                    .collect();
                Some(PlanExhibit::Calls { rows })
            }
            Some("list") => {
                let items =
                    self.texts(fields.get("items"), &format!("{at}.items"), l.items, l.text);
                if items.is_empty() {
                    self.fail(format!("{at}.items must be a non-empty list"));
                }
                Some(PlanExhibit::List { items })
            }
            _ => {
                self.fail(format!("{at}.kind must be code, schema, calls or list"));
                None
            }
        }
    }

    /// One row of a call tree. A depth that is no integer from 0 to 5 is a problem, so the depth
    /// of a plan the check answers is always one.
    fn row(&mut self, row: &Value, at: &str) -> Option<PlanCallRow> {
        let Value::Object(row) = row else {
            self.fail(format!("{at} must be an object"));
            return None;
        };
        let depth = match row.get("depth") {
            None | Some(Value::Null) => Some(0.0),
            Some(depth) => integer(depth).filter(|depth| (0.0..=5.0).contains(depth)),
        };
        if depth.is_none() {
            self.fail(format!("{at}.depth must be 0 to 5"));
        }
        let text = self.text(row.get("text"), &format!("{at}.text"), 200, true);
        let place = self.text(row.get("at"), &format!("{at}.at"), 500, false);
        Some(PlanCallRow {
            depth: depth.unwrap_or(0.0) as u32,
            text: text?,
            at: place,
        })
    }

    fn ask(&mut self, value: Option<&Value>, at: &str) -> Option<PlanAsk> {
        let fields = match value {
            None | Some(Value::Null) => return None,
            Some(Value::Object(fields)) => fields,
            Some(_) => {
                self.fail(format!("{at} must be an object"));
                return None;
            }
        };
        let l = PLAN_LIMITS;
        let id = fields.get("id").and_then(Value::as_str);
        match id {
            Some(id) if is_id(id) => {
                if !self.asks.insert(id.to_owned()) {
                    self.fail(format!("{at}.id {id} is used twice"));
                }
            }
            _ => self.fail(format!(
                "{at}.id must be letters, digits, - and _ (up to 32)"
            )),
        }
        let question = self.text(
            fields.get("question"),
            &format!("{at}.question"),
            l.text,
            true,
        );
        let options = match fields.get("options") {
            Some(Value::Array(options)) if (2..=l.options).contains(&options.len()) => options,
            _ => {
                self.fail(format!("{at}.options must hold 2 to {} options", l.options));
                return None;
            }
        };
        let mut values = HashSet::new();
        let mut parsed = Vec::new();
        for (index, option) in options.iter().enumerate() {
            let at = format!("{at}.options[{index}]");
            let Value::Object(option) = option else {
                self.fail(format!("{at} must be an object"));
                continue;
            };
            let value = match option.get("value").and_then(Value::as_str) {
                Some(value) if is_id(value) => value,
                _ => {
                    self.fail(format!(
                        "{at}.value must be letters, digits, - and _ (up to 32)"
                    ));
                    continue;
                }
            };
            if !values.insert(value) {
                self.fail(format!("{at}.value {value} is used twice"));
            }
            let label = self.text(option.get("label"), &format!("{at}.label"), l.title, true);
            let note = self.text(option.get("note"), &format!("{at}.note"), l.text, false);
            if let Some(label) = label {
                parsed.push(PlanOption {
                    value: value.to_owned(),
                    label,
                    note,
                });
            }
        }
        let recommended = fields.get("recommended").and_then(Value::as_str);
        if !recommended.is_some_and(|recommended| values.contains(recommended)) {
            self.fail(format!(
                "{at}.recommended must be one of its options' values"
            ));
        }
        Some(PlanAsk {
            id: id?.to_owned(),
            question: question?,
            options: parsed,
            recommended: recommended?.to_owned(),
        })
    }

    fn claims(&mut self, value: Option<&Value>, at: &str, depth: usize) -> Vec<PlanClaim> {
        let l = PLAN_LIMITS;
        let claims = match value {
            None | Some(Value::Null) => return Vec::new(),
            Some(Value::Array(claims)) => claims,
            Some(_) => {
                self.fail(format!("{at} must be a list of claims"));
                return Vec::new();
            }
        };
        if depth > l.depth && !claims.is_empty() {
            self.fail(format!("{at}: a plan has at most {} levels", l.depth));
            return Vec::new();
        }
        if claims.len() > l.claims {
            self.fail(format!("{at} has more than {} claims", l.claims));
        }
        let mut out = Vec::new();
        for (index, claim) in claims.iter().take(l.claims).enumerate() {
            let at = format!("{at}[{index}]");
            let Value::Object(claim) = claim else {
                self.fail(format!("{at} must be an object"));
                continue;
            };
            let text = self.text(claim.get("text"), &format!("{at}.text"), l.text, true);
            let exhibit = self.exhibit(claim.get("exhibit"), &format!("{at}.exhibit"));
            let ask = self.ask(claim.get("ask"), &format!("{at}.ask"));
            let children = self.claims(claim.get("children"), &format!("{at}.children"), depth + 1);
            if let Some(text) = text {
                out.push(PlanClaim {
                    text,
                    exhibit,
                    ask,
                    children,
                });
            }
        }
        out
    }
}

/// `planOpen`: a plan still takes answers: none were sent, and the lead has not gone on without
/// them. It reads a [`Plan`]'s or a [`PlanMark`]'s `answered_at` and `closed_at`.
pub fn plan_open(answered_at: Option<i64>, closed_at: Option<i64>) -> bool {
    answered_at.is_none() && closed_at.is_none()
}

/// `numberClaims`: the claims in reading order, numbered (1, 1.2, 1.2.1). `shared` has no place
/// among them: comments name it "shared".
pub fn number_claims(claims: &[PlanClaim]) -> Vec<NumberedClaim<'_>> {
    fn walk<'a>(
        claims: &'a [PlanClaim],
        prefix: &str,
        level: u32,
        out: &mut Vec<NumberedClaim<'a>>,
    ) {
        for (index, claim) in claims.iter().enumerate() {
            let id = if prefix.is_empty() {
                (index + 1).to_string()
            } else {
                format!("{prefix}.{}", index + 1)
            };
            out.push(NumberedClaim {
                id: id.clone(),
                level,
                claim,
            });
            walk(&claim.children, &id, level + 1, out);
        }
    }
    let mut out = Vec::new();
    walk(claims, "", 1, &mut out);
    out
}

/// One decision of a plan with the number the person sees (D1, D2, …) and the claim it sits on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumberedAsk<'a> {
    pub number: String,
    pub claim: String,
    pub ask: &'a PlanAsk,
}

/// `planAsks`: the plan's decisions in reading order.
pub fn plan_asks(claims: &[PlanClaim]) -> Vec<NumberedAsk<'_>> {
    number_claims(claims)
        .into_iter()
        .filter_map(|numbered| numbered.claim.ask.as_ref().map(|ask| (numbered.id, ask)))
        .enumerate()
        .map(|(index, (claim, ask))| NumberedAsk {
            number: format!("D{}", index + 1),
            claim,
            ask,
        })
        .collect()
}
