//! The brief a spawn hands its helper: from `server/fleet/brief.test.ts`, each test naming its `it`.

use herdr_fleet_orchestrator::brief::{
    Brief, BriefDraft, Overlap, check_brief, overlap, render_brief, write_scope,
};

fn full() -> Brief {
    Brief {
        goal: "Fix the retry.".into(),
        write: vec!["src/retry.ts".into()],
        context: "none".into(),
        done: "One notification per retry.".into(),
        verify: "bun test src/retry.test.ts; paste the result.".into(),
        forbidden: None,
        timebox: None,
    }
}

fn draft(brief: Brief) -> BriefDraft {
    BriefDraft {
        goal: Some(brief.goal),
        write: Some(brief.write),
        context: Some(brief.context),
        done: Some(brief.done),
        verify: Some(brief.verify),
        forbidden: brief.forbidden,
        timebox: brief.timebox,
    }
}

// brief.test.ts: "names every missing field at once, and takes an empty write list as read-only work"
#[test]
fn names_every_missing_field_at_once_and_takes_an_empty_write_list_as_read_only_work() {
    let error = check_brief(None).unwrap_err();
    assert_eq!(error.code, "incomplete_brief");
    assert!(
        error
            .message
            .contains("missing: goal, write, context, done, verify"),
        "{}",
        error.message
    );

    let partial = BriefDraft {
        goal: Some("x".into()),
        write: Some(vec![]),
        context: Some(" ".into()),
        done: Some("d".into()),
        ..BriefDraft::default()
    };
    let error = check_brief(Some(partial)).unwrap_err();
    assert!(
        error.message.contains("missing: context, verify"),
        "{}",
        error.message
    );

    let read_only = check_brief(Some(draft(Brief {
        write: vec![],
        ..full()
    })))
    .unwrap();
    assert_eq!(read_only.write, Vec::<String>::new());
}

// brief.test.ts: "turns into the helper's task, with what it may change and when to stop"
#[test]
fn turns_into_the_helpers_task_with_what_it_may_change_and_when_to_stop() {
    let task = render_brief(
        &Brief {
            timebox: Some("20 minutes".into()),
            ..full()
        },
        Some("Prefer the existing queue."),
    );
    assert!(task.contains("## Goal\n\nFix the retry."), "{task}");
    assert!(
        task.contains("- src/retry.ts\nChange nothing outside these paths."),
        "{task}"
    );
    assert!(
        task.contains("## Done when\n\nOne notification per retry."),
        "{task}"
    );
    assert!(
        task.contains("20 minutes. When it runs out, report what you have and stop."),
        "{task}"
    );
    assert!(
        task.contains("## Notes\n\nPrefer the existing queue."),
        "{task}"
    );
    assert!(!task.contains("## Forbidden"), "{task}");
    assert!(
        render_brief(
            &Brief {
                write: vec![],
                ..full()
            },
            None
        )
        .contains("Nothing: this task only reads."),
    );
}

// brief.test.ts: "finds a path held twice: the same one, or one inside the other, but not a sibling"
#[test]
fn finds_a_path_held_twice_the_same_one_or_one_inside_the_other_but_not_a_sibling() {
    let scope = |cwd: &str, paths: &[&str]| {
        write_scope(
            cwd.as_ref(),
            &paths
                .iter()
                .map(|path| path.to_string())
                .collect::<Vec<_>>(),
        )
    };
    let a = scope("/repo", &["src/retry.ts", "docs"]);
    assert_eq!(
        overlap(&a, &scope("/repo", &["./src/retry.ts"])),
        Some(Overlap {
            mine: "/repo/src/retry.ts".into(),
            theirs: "/repo/src/retry.ts".into()
        })
    );
    assert_eq!(
        overlap(&a, &scope("/repo", &["docs/guide.md"])),
        Some(Overlap {
            mine: "/repo/docs".into(),
            theirs: "/repo/docs/guide.md".into()
        })
    );
    assert!(overlap(&a, &scope("/repo", &["."])).is_some());
    assert_eq!(
        overlap(&a, &scope("/repo", &["src/retry.test.ts", "docs-old"])),
        None
    );
    assert_eq!(overlap(&a, &scope("/other", &["src/retry.ts"])), None);
}

// Not in brief.test.ts: `path.resolve` folds `..` and repeated slashes, so a path that climbs out
// and back in is the same path (Node: resolve("/repo", "src/../docs//x") is "/repo/docs/x").
#[test]
fn resolves_a_write_path_as_node_does() {
    assert_eq!(
        write_scope(
            "/repo".as_ref(),
            &[
                "src/../docs//x".into(),
                "/abs/./y/".into(),
                "../../..".into()
            ]
        ),
        vec![
            "/repo/docs/x".to_string(),
            "/abs/y".to_string(),
            "/".to_string()
        ]
    );
}
