//! The skill evidence only Codex records (`codexReadSkills`, `codexReadCall` of
//! `server/skill-activity.ts`): a read of a SKILL.md, as Codex parsed it or as a literal command.
//! The rules the sources share (what a skill document is) stay in `crate::skill_activity`.

use std::sync::LazyLock;

use protocol::js::{self, WHITESPACE};
use protocol::{SkillActivity, SkillStatus};
use regex::Regex;
use serde_json::Value;

use crate::skill_activity::skill_document;

/// Codex records parsed read paths even for commands executed inside code-mode tools.
/// Unknown shell scripts stay unknown: a mention/search of SKILL.md is not a read.
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

    // Expected values: the TypeScript `codexReadCall` and `codexReadSkills`, worked out by hand.
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

    #[test]
    fn reads_the_reads_codex_parsed() {
        let item = |exit_code: Value| {
            json!({
                "type": "CommandExecution",
                "status": "completed",
                "exit_code": exit_code,
                "parsed_cmd": [
                    { "type": "read", "path": "/s/review/SKILL.md" },
                    { "type": "search", "path": "/s/other/SKILL.md" }
                ]
            })
        };
        let read = codex_read_skills(&item(json!(0)));
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].name, "review");
        assert_eq!(read[0].status, SkillStatus::Loaded);
        assert_eq!(
            codex_read_skills(&item(json!(2)))[0].status,
            SkillStatus::Failed
        );
        assert!(codex_read_skills(&item(json!("0"))).is_empty());
    }
}
