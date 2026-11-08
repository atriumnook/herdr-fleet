//! What a transcript shows of the skills an agent used (`server/skill-activity.ts`): no filesystem
//! lookup, the evidence is the transcript's own.
//!
//! omp uses only `skill_invocation_prompt`; the others are moved here for Claude Code and Codex
//! (#201, #202), and #206 removes their `allow(dead_code)`.

use std::sync::LazyLock;

use protocol::js::{self, WHITESPACE, utf16_len};
use protocol::{SkillActivity, SkillEvidence, SkillStatus};
use regex::Regex;
use serde_json::Value;

/// A skill's name as it may be shown: one line of at most 200 code units, no markup.
fn label(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let length = utf16_len(text);
    (length > 0 && length <= 200 && !text.contains(['\r', '\n', '<', '>'])).then(|| text.to_owned())
}

/// A path that is one line of at most 4096 code units.
fn one_line_path(path: &str) -> bool {
    utf16_len(path) <= 4096 && !path.contains(['\r', '\n'])
}

/// Node's `path.posix.dirname`.
fn posix_dirname(path: &str) -> &str {
    if path.is_empty() {
        return ".";
    }
    let bytes = path.as_bytes();
    let has_root = bytes[0] == b'/';
    let mut end = None;
    let mut matched_slash = true;
    for index in (1..bytes.len()).rev() {
        if bytes[index] == b'/' {
            if !matched_slash {
                end = Some(index);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None if has_root => "/",
        None => ".",
        Some(1) if has_root => "//",
        Some(end) => &path[..end],
    }
}

/// Node's `path.posix.basename` without an extension to strip.
fn posix_basename(path: &str) -> &str {
    let bytes = path.as_bytes();
    let mut start = 0;
    let mut end = None;
    let mut matched_slash = true;
    for index in (0..bytes.len()).rev() {
        if bytes[index] == b'/' {
            if !matched_slash {
                start = index + 1;
                break;
            }
        } else if end.is_none() {
            matched_slash = false;
            end = Some(index + 1);
        }
    }
    end.map_or("", |end| &path[start..end])
}

/// A SKILL.md the transcript names, read as the skill in its folder.
#[allow(dead_code)]
pub(crate) fn skill_document(path: Option<&Value>) -> Option<SkillActivity> {
    let path = path?.as_str()?;
    if !one_line_path(path) {
        return None;
    }
    let normalized = path.replace('\\', "/");
    if !normalized.ends_with("/SKILL.md") {
        return None;
    }
    let name = label(Some(&Value::String(
        posix_basename(posix_dirname(&normalized)).to_owned(),
    )))?;
    (name != ".").then(|| SkillActivity {
        name,
        path: Some(path.to_owned()),
        evidence: SkillEvidence::Instructions,
        status: SkillStatus::Loaded,
    })
}

static SELECTED_SKILL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^<skill>{WHITESPACE}*<name>([^<>\r\n]+)</name>{WHITESPACE}*<path>([^<>\r\n]+)</path>(?s:.)*</skill>$"
    ))
    .expect("SELECTED_SKILL")
});

/// Codex's explicitly selected skill is injected as one complete user-context envelope.
#[allow(dead_code)]
pub(crate) fn selected_skill(text: &str) -> Option<SkillActivity> {
    let captures = SELECTED_SKILL.captures(js::trim(text))?;
    let name = label(Some(&Value::String(captures[1].to_owned())))?;
    let document = skill_document(Some(&Value::String(captures[2].to_owned())))?;
    Some(SkillActivity { name, ..document })
}

static SKILL_INSTRUCTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^The user explicitly invoked the "([^"]+)" skill\. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions\.\n\n<skill-instruction name="([^"]+)" location="([^"]+)">\n(?s:.)*?\n</skill-instruction>"#)
        .expect("SKILL_INSTRUCTION")
});
static LEGACY_SKILL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^<skill name="([^"]+)" location="([^"]+)">\n(?s:.)*?\n</skill>(?:\n\n((?s:.)+))?$"#,
    )
    .expect("LEGACY_SKILL")
});
static USER_REQUEST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\n\n<user-request>\n((?s:.)*?)\n</user-request>$").expect("USER_REQUEST")
});

/// pi names the skill file it loaded: a SKILL.md, or a standalone `.md` skill (`--skill review.md`).
fn loaded_skill(name: &str, location: &str) -> Option<SkillActivity> {
    let skill = label(Some(&Value::String(name.to_owned())))?;
    if location.is_empty() || !one_line_path(location) {
        return None;
    }
    Some(SkillActivity {
        name: skill,
        path: Some(location.to_owned()),
        evidence: SkillEvidence::Instructions,
        status: SkillStatus::Loaded,
    })
}

/// A skill invocation's prompt: the skills it loaded and what the user asked with them.
pub(crate) struct SkillInvocation {
    pub(crate) skills: Vec<SkillActivity>,
    pub(crate) request: String,
}

/// The prompt omp records when the user invokes a skill (`/skill:name`, `$name`, a keyword): the
/// whole SKILL.md before the request, tens of KB the user never typed. Mirrors pi's own
/// `parseSkillBlock` (core/skill-invocation.ts): chained invocations, then `<user-request>`, or the
/// legacy `<skill name location>` form. Anything else is left as the user's text.
pub(crate) fn skill_invocation_prompt(text: &str) -> Option<SkillInvocation> {
    let mut skills = Vec::new();
    let mut remainder = text;
    let mut found = SKILL_INSTRUCTION.captures(remainder);
    while let Some(captures) = found {
        if captures[1] != captures[2] {
            return None;
        }
        skills.push(loaded_skill(&captures[1], &captures[3])?);
        remainder = &remainder[captures[0].len()..];
        if !remainder.starts_with("\n\nThe user explicitly invoked the ") {
            break;
        }
        remainder = &remainder[2..];
        found = SKILL_INSTRUCTION.captures(remainder);
        found.as_ref()?;
    }
    if !skills.is_empty() {
        if remainder.is_empty() {
            return Some(SkillInvocation {
                skills,
                request: String::new(),
            });
        }
        let request = USER_REQUEST.captures(remainder)?;
        return Some(SkillInvocation {
            skills,
            request: js::trim(&request[1]).to_owned(),
        });
    }
    let legacy = LEGACY_SKILL.captures(text)?;
    let skill = loaded_skill(&legacy[1], &legacy[2])?;
    let request = legacy
        .get(3)
        .map_or("", |request| js::trim(request.as_str()));
    Some(SkillInvocation {
        skills: vec![skill],
        request: request.to_owned(),
    })
}

/// Claude Code's Skill tool call names the skill it asks for.
#[allow(dead_code)]
pub(crate) fn invoked_skill(name: &str, input: &Value) -> Option<SkillActivity> {
    if name != "Skill" {
        return None;
    }
    let skill = label(input.get("skill"))?;
    Some(SkillActivity {
        name: skill,
        path: None,
        evidence: SkillEvidence::Invocation,
        status: SkillStatus::Requested,
    })
}

/// Codex records parsed read paths even for commands executed inside code-mode tools.
/// Unknown shell scripts stay unknown: a mention/search of SKILL.md is not a read.
#[allow(dead_code)]
pub(crate) fn codex_read_skills(value: &Value) -> Vec<SkillActivity> {
    let Some(item) = value.as_object() else {
        return Vec::new();
    };
    let Some(parsed) = item.get("parsed_cmd").and_then(Value::as_array) else {
        return Vec::new();
    };
    if item.get("type").and_then(Value::as_str) != Some("CommandExecution") {
        return Vec::new();
    }
    let status = item.get("status").and_then(Value::as_str);
    if status != Some("completed") && status != Some("failed") {
        return Vec::new();
    }
    let status = match item.get("exit_code") {
        Some(Value::Number(code)) if code.as_f64() == Some(0.0) => SkillStatus::Loaded,
        Some(Value::Number(_)) => SkillStatus::Failed,
        _ => return Vec::new(),
    };
    parsed
        .iter()
        .filter(|command| command.get("type").and_then(Value::as_str) == Some("read"))
        .filter_map(|command| skill_document(command.get("path")))
        .map(|skill| SkillActivity { status, ..skill })
        .collect()
}

static READ_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    let s = WHITESPACE;
    Regex::new(&format!(
        r#"^(?:cat|head(?:{s}+-n{s}+[0-9]+)?|sed{s}+-n{s}+['"]?[0-9]+(?:,[0-9]+)?p['"]?){s}+(?:"([^"\n]+)"|'([^'\n]+)'|([^{inner}]+)){s}*$"#,
        inner = &s[1..s.len() - 1]
    ))
    .expect("READ_COMMAND")
});

/// Older Codex rollouts only record tool calls. Recognize a literal, single file
/// read; shell scripts, searches, writes, interpolated paths and mentions stay out.
#[allow(dead_code)]
pub(crate) fn codex_read_call(name: &str, args: &Value) -> Option<SkillActivity> {
    let requested = |skill: SkillActivity| SkillActivity {
        status: SkillStatus::Requested,
        ..skill
    };
    if name == "read_file" || name == "Read" {
        let path = args
            .get("file_path")
            .filter(|path| !path.is_null())
            .or_else(|| args.get("path"));
        return skill_document(path).map(requested);
    }
    if name != "exec_command" && name != "shell_command" && name != "shell" {
        return None;
    }
    let command = args
        .get("cmd")
        .filter(|cmd| !cmd.is_null())
        .or_else(|| args.get("command"))?
        .as_str()?;
    if command.contains(['\n', ';', '&', '|', '<', '>', '`', '$']) {
        return None;
    }
    let captures = READ_COMMAND.captures(js::trim(command))?;
    let path = captures
        .get(1)
        .or_else(|| captures.get(2))
        .or_else(|| captures.get(3))?;
    skill_document(Some(&Value::String(path.as_str().to_owned()))).map(requested)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Expected values: node's path.posix (the TypeScript's basename(dirname(…))), worked out by hand
    // from its algorithm.
    #[test]
    fn names_the_folder_of_a_skill_document() {
        let name = |path: &str| skill_document(Some(&json!(path))).map(|skill| skill.name);
        assert_eq!(
            name("/home/a/.claude/skills/review/SKILL.md").as_deref(),
            Some("review")
        );
        assert_eq!(
            name("C:\\skills\\deploy\\SKILL.md").as_deref(),
            Some("deploy")
        );
        assert_eq!(name("a//SKILL.md").as_deref(), Some("a"));
        assert_eq!(name("/SKILL.md"), None);
        assert_eq!(name("./SKILL.md"), None);
        assert_eq!(name("review/skill.md"), None);
    }

    #[test]
    fn reads_a_literal_read_of_a_skill_document() {
        let skill = |command: &str| {
            codex_read_call("exec_command", &json!({ "cmd": command })).map(|skill| skill.name)
        };
        assert_eq!(skill("cat /s/review/SKILL.md").as_deref(), Some("review"));
        assert_eq!(
            skill("sed -n '1,200p' \"/s/my skill/SKILL.md\"").as_deref(),
            Some("my skill")
        );
        assert_eq!(skill("head -n 40 /s/x/SKILL.md").as_deref(), Some("x"));
        assert_eq!(skill("cat /s/x/SKILL.md | head"), None);
        assert_eq!(skill("grep foo /s/x/SKILL.md"), None);
    }
}
