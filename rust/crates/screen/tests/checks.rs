//! The agent adapters' looks at their CLIs' screens and Cursor's usage screen (#200): the corpus
//! cases of the slice `Checks`, the tests of server/fleet/adapters.test.ts that read a screen, and
//! the answers TypeScript's adapters give to screens the corpus does not hold.

mod common;

use herdr_fleet_screen::{ScreenChecks, cursor_usage, screen_checks};
use protocol::{FleetAgentKind, UsageReading, UsageWindow};
use serde_json::Value;

#[test]
fn checks_cases() {
    common::check(common::Slice::Checks);
}

/// `Date.parse` of these times in UTC, as Python's `datetime` computes them (not the code under test).
const OCT_4_2026_7H: i64 = 1_791_097_200_000;
const OCT_23_2026: f64 = 1_792_713_600_000.0;
const OCT_26_2026: f64 = 1_792_972_800_000.0;
const DEC_20_2026: i64 = 1_797_724_800_000;
const JAN_2_2027: f64 = 1_798_848_000_000.0;

fn monthly(used_percent: f64, resets_at: Option<f64>, read_at: i64) -> UsageReading {
    UsageReading {
        windows: vec![UsageWindow {
            name: "monthly".into(),
            used_percent,
            resets_at,
        }],
        read_at: read_at as f64,
    }
}

/// server/fleet/adapters.test.ts, `cursor usage`: as cursor-agent 2026.09.23 draws its /usage pager
/// (src/components/usage-pager.tsx).
const PAGER: &str = concat!(
    "Usage · Pro                                        Resets Oct 23\n",
    "Monthly plan and on-demand usage\n",
    "Category        Current         Usage\n",
    "Included        12% used        ███░░░░░░░░░░░░░░░░░\n",
    "  Auto          10% used        ██░░░░░░░░░░░░░░░░░░\n",
    "  API           2% used         █░░░░░░░░░░░░░░░░░░░\n",
    "On-Demand       Disabled        ————————————————————\n",
    "On-demand usage is off",
);

/// `is typed as /usage and read as the included share, until the next reset date`. The command
/// typed (`usageCommand`) is the launch side of the adapter, which phase 3 moves.
#[test]
fn is_typed_as_usage_and_read_as_the_included_share_until_the_next_reset_date() {
    assert_eq!(
        cursor_usage(PAGER, OCT_4_2026_7H),
        Some(monthly(12.0, Some(OCT_23_2026), OCT_4_2026_7H))
    );
}

/// `reads the pager as cursor-agent 2026.09.23 drew it under ja_JP`: captured from a live pane
/// (`/usage` typed into cursor-agent; Esc closed it).
#[test]
fn reads_the_pager_as_cursor_agent_2026_09_23_drew_it_under_ja_jp() {
    let live = concat!(
        "────────────────────────────────────────────────\n",
        " Usage • Pro                                    Resets 10月26日\n",
        " Monthly plan and on-demand usage\n",
        " Category        Current             Usage\n",
        " Included        1% used             █░░░░░░░░░░░░░░░░░░░░\n",
        "   Auto          0% used             ░░░░░░░░░░░░░░░░░░░░░\n",
        "   API           1% used             █░░░░░░░░░░░░░░░░░░░░\n",
        " On-Demand       Disabled            ———————————————————————\n",
        " On-demand usage is off\n",
        " View in dashboard: cursor.com/dashboard?tab=usage\n",
        " Esc to close",
    );
    assert_eq!(
        cursor_usage(live, OCT_4_2026_7H),
        Some(monthly(1.0, Some(OCT_26_2026), OCT_4_2026_7H))
    );
}

/// `reads the narrow layout, a reset date in the next year, and nothing before the pager shows`.
#[test]
fn reads_the_narrow_layout_a_reset_date_in_the_next_year_and_nothing_before_the_pager_shows() {
    let narrow = "Usage · Pro\nResets Jan 2\nIncluded: 97% used\nAuto: 90% used";
    assert_eq!(
        cursor_usage(narrow, DEC_20_2026).unwrap().windows,
        monthly(97.0, Some(JAN_2_2027), DEC_20_2026).windows
    );
    assert_eq!(cursor_usage("Loading usage data...", OCT_4_2026_7H), None);
}

/// What TypeScript's `cursorUsage` returns for usage screens the tests above do not hold (Bun 1.4.4):
/// a day or a month past the end rolls over as `Date.UTC` rolls it, a reset at `now` is the next
/// year's, the last `Included` and the last date of each spelling count (the English one first),
/// `\b` and `\s` are JavaScript's, and the years 0 to 99 and the times past JavaScript's dates are
/// read as `Date.UTC` reads them.
#[test]
fn reads_usage_screens_as_typescript_does() {
    let at = OCT_4_2026_7H;
    let cases: [(&str, i64, Option<UsageReading>); 22] = [
        (
            "Included 12% used\nResets Feb 31",
            at,
            Some(monthly(12.0, Some(1_804_032_000_000.0), at)),
        ),
        (
            "Included 12% used\nResets 13月5日",
            at,
            Some(monthly(12.0, Some(1_799_107_200_000.0), at)),
        ),
        (
            "Included 12% used\nResets 0月0日",
            at,
            Some(monthly(12.0, Some(1_795_996_800_000.0), at)),
        ),
        ("Included 1.50% used", at, Some(monthly(1.5, None, at))),
        (
            "Included:\n  7% used\nIncluded 8% used",
            at,
            Some(monthly(8.0, None, at)),
        ),
        (
            "Included 9% used Resets Oct 233",
            at,
            Some(monthly(9.0, None, at)),
        ),
        (
            "Included 9% used Resets Oct 4",
            1_791_072_000_000,
            Some(monthly(9.0, Some(1_822_608_000_000.0), 1_791_072_000_000)),
        ),
        (
            "Included 9% used Resets Oct 4",
            1_791_071_999_999,
            Some(monthly(9.0, Some(1_791_072_000_000.0), 1_791_071_999_999)),
        ),
        (
            "Included 9% used Resets Oct 4 Resets 11月7日",
            at,
            Some(monthly(9.0, Some(1_822_608_000_000.0), at)),
        ),
        (
            "Included 9% used Resets 11月7日 Resets Oct 4",
            at,
            Some(monthly(9.0, Some(1_822_608_000_000.0), at)),
        ),
        (
            "Included 9% used Resets Octo 4",
            at,
            Some(monthly(9.0, None, at)),
        ),
        (
            "Included 9% used Resets Oct 4é",
            at,
            Some(monthly(9.0, Some(1_822_608_000_000.0), at)),
        ),
        (
            "Included\u{a0}\u{3000} 5% used",
            at,
            Some(monthly(5.0, None, at)),
        ),
        ("Included 5 % used", at, None),
        ("Included 007% used", at, Some(monthly(7.0, None, at))),
        (
            "Included 9% used Resets Feb 29",
            1_803_859_200_000,
            Some(monthly(9.0, Some(1_835_395_200_000.0), 1_803_859_200_000)),
        ),
        // in the year 99, Date.UTC takes the next year, 100, as is, and 99 as 1999
        (
            "Included 1% used Resets Jan 1",
            -59_042_995_200_000,
            Some(monthly(1.0, Some(915_148_800_000.0), -59_042_995_200_000)),
        ),
        // past the last day of JavaScript's dates the reset date is NaN, and left out
        (
            "Included 1% used Resets Sep 14",
            8_640_000_000_000_000,
            Some(monthly(1.0, None, 8_640_000_000_000_000)),
        ),
        (
            "Included 1% used Resets Sep 13",
            8_639_999_913_600_000,
            Some(monthly(
                1.0,
                Some(8_640_000_000_000_000.0),
                8_639_999_913_600_000,
            )),
        ),
        (
            "Included 1% used Resets Sep 12",
            8_639_999_913_600_000,
            Some(monthly(1.0, None, 8_639_999_913_600_000)),
        ),
        (
            "Included 1% used Resets Jan 1",
            i64::MAX,
            Some(monthly(1.0, None, i64::MAX)),
        ),
        (
            "Included 1% used Resets Jan 1",
            i64::MIN,
            Some(monthly(1.0, None, i64::MIN)),
        ),
    ];
    for (screen, now, expected) in cases {
        assert_eq!(cursor_usage(screen, now), expected, "{screen:?} at {now}");
    }
}

/// server/fleet/adapters.test.ts, pi adapter: `calls a turn failed by its last Error: line only
/// when no HANDOFF follows`. A turn without output (`piTurnError(undefined)`) is the caller's
/// `None` (ScreenChecks::turn_error); an empty output is none as well (`!output`).
#[test]
fn calls_a_turn_failed_by_its_last_error_line_only_when_no_handoff_follows() {
    let turn_error = screen_checks(FleetAgentKind::Pi).turn_error;
    assert_eq!(
        turn_error("working...\nError: 401 unauthorized\n").as_deref(),
        Some("401 unauthorized")
    );
    assert_eq!(
        turn_error("Error: first\nmore\nError: second").as_deref(),
        Some("second")
    );
    assert_eq!(
        turn_error("Error: test failed earlier\nHANDOFF\noutcome: fixed"),
        None
    );
    assert_eq!(turn_error(""), None);
}

/// server/fleet/adapters.test.ts, opencode adapter: `refuses an opencode that is not version 2 while
/// starting, not once ready: it has no ready check (fixtures/screens: its help)`.
#[test]
fn refuses_an_opencode_that_is_not_version_2_while_starting_not_once_ready() {
    assert!(
        screen_checks(FleetAgentKind::Opencode)
            .ready_error
            .is_none()
    );
}

/// Which looks each adapter has: server/fleet/adapters.ts:147-476 defines `question`, `readyError`,
/// `inputReady` and `draft` on these adapters alone.
#[test]
fn each_adapter_has_the_looks_typescript_gives_it() {
    use FleetAgentKind::*;
    let has = |checks: ScreenChecks| {
        [
            checks.question.is_some(),
            checks.ready_error.is_some(),
            checks.input_ready.is_some(),
            checks.draft.is_some(),
        ]
    };
    assert_eq!(has(screen_checks(Pi)), [false, false, false, true]);
    assert_eq!(has(screen_checks(Claude)), [false, false, false, true]);
    assert_eq!(has(screen_checks(Codex)), [false, false, false, false]);
    assert_eq!(has(screen_checks(Cursor)), [true, false, true, false]);
    assert_eq!(has(screen_checks(Agy)), [true, true, true, false]);
    assert_eq!(has(screen_checks(Opencode)), [true, false, false, true]);
}

/// The answers of TypeScript's adapters (server/fleet/adapters.ts, Bun 1.4.4) to screens the corpus
/// does not hold: each row is `[kind, look, screen, answer]`, for every adapter that has the look.
/// The screens try the lines JavaScript ends (`\r`, U+2028), `\s` and `\b` as JavaScript has them,
/// `slice` with a negative end, a `\s` that runs into the next line, and the last of several
/// matches.
const RECORDED: &str = r##"
["pi","startupError","Error: boom","boom"]
["pi","startupError","  error: lower case",null]
["pi","startupError","x\nError: first\nError: second\r\n","second"]
["pi","startupError","Error: last\nError:  \n",null]
["pi","startupError","Error: a\u2028b","a"]
["pi","startupError","no error here",null]
["pi","startupError","warning: Error: inside a line",null]
["pi","startupError","\tError: tabbed  ","tabbed"]
["pi","startupError","\n\n  Error: after blank lines","after blank lines"]
["pi","startupError","Usage:\n  opencode [project]   start opencode tui\n",null]
["pi","startupError","opencode [project]\nstart opencode tui",null]
["pi","startupError","Error: x\r","x"]
["pi","startupError","",null]
["claude","startupError","Error: boom","boom"]
["claude","startupError","  error: lower case","lower case"]
["claude","startupError","x\nError: first\nError: second\r\n","second"]
["claude","startupError","Error: last\nError:  \n",null]
["claude","startupError","Error: a\u2028b","a"]
["claude","startupError","no error here",null]
["claude","startupError","warning: Error: inside a line",null]
["claude","startupError","\tError: tabbed  ","tabbed"]
["claude","startupError","\n\n  Error: after blank lines","after blank lines"]
["claude","startupError","Usage:\n  opencode [project]   start opencode tui\n",null]
["claude","startupError","opencode [project]\nstart opencode tui",null]
["claude","startupError","Error: x\r","x"]
["claude","startupError","",null]
["codex","startupError","Error: boom","boom"]
["codex","startupError","  error: lower case","lower case"]
["codex","startupError","x\nError: first\nError: second\r\n","second"]
["codex","startupError","Error: last\nError:  \n",null]
["codex","startupError","Error: a\u2028b","a"]
["codex","startupError","no error here",null]
["codex","startupError","warning: Error: inside a line",null]
["codex","startupError","\tError: tabbed  ","tabbed"]
["codex","startupError","\n\n  Error: after blank lines","after blank lines"]
["codex","startupError","Usage:\n  opencode [project]   start opencode tui\n",null]
["codex","startupError","opencode [project]\nstart opencode tui",null]
["codex","startupError","Error: x\r","x"]
["codex","startupError","",null]
["cursor","startupError","Error: boom","boom"]
["cursor","startupError","  error: lower case","lower case"]
["cursor","startupError","x\nError: first\nError: second\r\n","second"]
["cursor","startupError","Error: last\nError:  \n",null]
["cursor","startupError","Error: a\u2028b","a"]
["cursor","startupError","no error here",null]
["cursor","startupError","warning: Error: inside a line",null]
["cursor","startupError","\tError: tabbed  ","tabbed"]
["cursor","startupError","\n\n  Error: after blank lines","after blank lines"]
["cursor","startupError","Usage:\n  opencode [project]   start opencode tui\n",null]
["cursor","startupError","opencode [project]\nstart opencode tui",null]
["cursor","startupError","Error: x\r","x"]
["cursor","startupError","",null]
["agy","startupError","Error: boom","boom"]
["agy","startupError","  error: lower case","lower case"]
["agy","startupError","x\nError: first\nError: second\r\n","second"]
["agy","startupError","Error: last\nError:  \n",null]
["agy","startupError","Error: a\u2028b","a"]
["agy","startupError","no error here",null]
["agy","startupError","warning: Error: inside a line",null]
["agy","startupError","\tError: tabbed  ","tabbed"]
["agy","startupError","\n\n  Error: after blank lines","after blank lines"]
["agy","startupError","Usage:\n  opencode [project]   start opencode tui\n",null]
["agy","startupError","opencode [project]\nstart opencode tui",null]
["agy","startupError","Error: x\r","x"]
["agy","startupError","",null]
["opencode","startupError","Error: boom","boom"]
["opencode","startupError","  error: lower case","lower case"]
["opencode","startupError","x\nError: first\nError: second\r\n","second"]
["opencode","startupError","Error: last\nError:  \n",null]
["opencode","startupError","Error: a\u2028b","a"]
["opencode","startupError","no error here",null]
["opencode","startupError","warning: Error: inside a line",null]
["opencode","startupError","\tError: tabbed  ","tabbed"]
["opencode","startupError","\n\n  Error: after blank lines","after blank lines"]
["opencode","startupError","Usage:\n  opencode [project]   start opencode tui\n","The opencode that herdr starts is not OpenCode 2 (check `opencode --version`); the fleet's rules for it need version 2."]
["opencode","startupError","opencode [project]\nstart opencode tui","The opencode that herdr starts is not OpenCode 2 (check `opencode --version`); the fleet's rules for it need version 2."]
["opencode","startupError","Error: x\r","x"]
["opencode","startupError","",null]
["pi","turnError","",null]
["pi","turnError","working...\nError: 401 unauthorized\n","401 unauthorized"]
["pi","turnError","Error: first\nmore\nError: second","second"]
["pi","turnError","Error: test failed earlier\nHANDOFF\noutcome: fixed",null]
["pi","turnError","  error: lower\n",null]
["pi","turnError","Error: spaced   \r\n","spaced"]
["pi","turnError","API Error: 500 {\"type\":\"error\"}\nmore\nAPI Error:429 rate limited",null]
["pi","turnError","x API Error: in a line API Error: second",null]
["pi","turnError","API Error: ",null]
["pi","turnError","\u25a0 unexpected status 500",null]
["pi","turnError","  \u25a0   spaced reason  \nlater",null]
["pi","turnError","\u25a0\u00a0nbsp",null]
["pi","turnError","Error: a\u2028Error: b","b"]
["pi","turnError","\u26a0 Retrying in 3s \u00b7 attempt 1 \u00b7 Rate limit exceeded\nfor this key",null]
["pi","turnError","\u26a0 Retry due \u00b7 attempt 2 \u00b7 Overloaded\n\u2503  typing",null]
["pi","turnError","\u26a0 Retrying in 3s \u00b7 attempt 1 \u00b7 Busy\nbuild \u00b7 model \u00b7 2s",null]
["pi","turnError","Error: gave up\n\nbuild \u00b7 model \u00b7 595ms","gave up"]
["pi","turnError","Error: gave up\nbuild \u00b7 model \u00b7 1.5s","gave up"]
["pi","turnError","Error: tool output\nnext line","tool output"]
["pi","turnError","Error: gave up\n\n12ms\nHANDOFF",null]
["pi","turnError","Error: gave up\n","gave up"]
["pi","turnError","  Error: indented  \n  3ms  ","indented"]
["pi","turnError","\u25a0\nfoo",null]
["pi","turnError","\u25a0\n\u25a0 actual",null]
["pi","turnError","\u25a0 \nfoo",null]
["pi","turnError","\u25a0\n\n  wrapped reason  ",null]
["pi","turnError","\u25a0\r\nfoo",null]
["pi","turnError","\u25a0\u2028foo",null]
["pi","turnError","\u25a0",null]
["pi","turnError","\u25a0 ",null]
["pi","turnError","\u25a0  \n",null]
["pi","turnError","x\u25a0 y",null]
["pi","turnError","\n \n\u25a0 after blank lines",null]
["pi","turnError","Error: a  \r\n\r\n","a"]
["pi","turnError","API Error:\nnext line",null]
["claude","turnError","",null]
["claude","turnError","working...\nError: 401 unauthorized\n",null]
["claude","turnError","Error: first\nmore\nError: second",null]
["claude","turnError","Error: test failed earlier\nHANDOFF\noutcome: fixed",null]
["claude","turnError","  error: lower\n",null]
["claude","turnError","Error: spaced   \r\n",null]
["claude","turnError","API Error: 500 {\"type\":\"error\"}\nmore\nAPI Error:429 rate limited","429 rate limited"]
["claude","turnError","x API Error: in a line API Error: second","in a line API Error: second"]
["claude","turnError","API Error: ",null]
["claude","turnError","\u25a0 unexpected status 500",null]
["claude","turnError","  \u25a0   spaced reason  \nlater",null]
["claude","turnError","\u25a0\u00a0nbsp",null]
["claude","turnError","Error: a\u2028Error: b",null]
["claude","turnError","\u26a0 Retrying in 3s \u00b7 attempt 1 \u00b7 Rate limit exceeded\nfor this key",null]
["claude","turnError","\u26a0 Retry due \u00b7 attempt 2 \u00b7 Overloaded\n\u2503  typing",null]
["claude","turnError","\u26a0 Retrying in 3s \u00b7 attempt 1 \u00b7 Busy\nbuild \u00b7 model \u00b7 2s",null]
["claude","turnError","Error: gave up\n\nbuild \u00b7 model \u00b7 595ms",null]
["claude","turnError","Error: gave up\nbuild \u00b7 model \u00b7 1.5s",null]
["claude","turnError","Error: tool output\nnext line",null]
["claude","turnError","Error: gave up\n\n12ms\nHANDOFF",null]
["claude","turnError","Error: gave up\n",null]
["claude","turnError","  Error: indented  \n  3ms  ",null]
["claude","turnError","\u25a0\nfoo",null]
["claude","turnError","\u25a0\n\u25a0 actual",null]
["claude","turnError","\u25a0 \nfoo",null]
["claude","turnError","\u25a0\n\n  wrapped reason  ",null]
["claude","turnError","\u25a0\r\nfoo",null]
["claude","turnError","\u25a0\u2028foo",null]
["claude","turnError","\u25a0",null]
["claude","turnError","\u25a0 ",null]
["claude","turnError","\u25a0  \n",null]
["claude","turnError","x\u25a0 y",null]
["claude","turnError","\n \n\u25a0 after blank lines",null]
["claude","turnError","Error: a  \r\n\r\n",null]
["claude","turnError","API Error:\nnext line",null]
["codex","turnError","",null]
["codex","turnError","working...\nError: 401 unauthorized\n",null]
["codex","turnError","Error: first\nmore\nError: second",null]
["codex","turnError","Error: test failed earlier\nHANDOFF\noutcome: fixed",null]
["codex","turnError","  error: lower\n",null]
["codex","turnError","Error: spaced   \r\n",null]
["codex","turnError","API Error: 500 {\"type\":\"error\"}\nmore\nAPI Error:429 rate limited",null]
["codex","turnError","x API Error: in a line API Error: second",null]
["codex","turnError","API Error: ",null]
["codex","turnError","\u25a0 unexpected status 500","unexpected status 500"]
["codex","turnError","  \u25a0   spaced reason  \nlater","spaced reason"]
["codex","turnError","\u25a0\u00a0nbsp","nbsp"]
["codex","turnError","Error: a\u2028Error: b",null]
["codex","turnError","\u26a0 Retrying in 3s \u00b7 attempt 1 \u00b7 Rate limit exceeded\nfor this key",null]
["codex","turnError","\u26a0 Retry due \u00b7 attempt 2 \u00b7 Overloaded\n\u2503  typing",null]
["codex","turnError","\u26a0 Retrying in 3s \u00b7 attempt 1 \u00b7 Busy\nbuild \u00b7 model \u00b7 2s",null]
["codex","turnError","Error: gave up\n\nbuild \u00b7 model \u00b7 595ms",null]
["codex","turnError","Error: gave up\nbuild \u00b7 model \u00b7 1.5s",null]
["codex","turnError","Error: tool output\nnext line",null]
["codex","turnError","Error: gave up\n\n12ms\nHANDOFF",null]
["codex","turnError","Error: gave up\n",null]
["codex","turnError","  Error: indented  \n  3ms  ",null]
["codex","turnError","\u25a0\nfoo","foo"]
["codex","turnError","\u25a0\n\u25a0 actual","\u25a0 actual"]
["codex","turnError","\u25a0 \nfoo","foo"]
["codex","turnError","\u25a0\n\n  wrapped reason  ","wrapped reason"]
["codex","turnError","\u25a0\r\nfoo","foo"]
["codex","turnError","\u25a0\u2028foo","foo"]
["codex","turnError","\u25a0",null]
["codex","turnError","\u25a0 ",null]
["codex","turnError","\u25a0  \n",null]
["codex","turnError","x\u25a0 y",null]
["codex","turnError","\n \n\u25a0 after blank lines","after blank lines"]
["codex","turnError","Error: a  \r\n\r\n",null]
["codex","turnError","API Error:\nnext line",null]
["cursor","turnError","",null]
["cursor","turnError","working...\nError: 401 unauthorized\n","401 unauthorized"]
["cursor","turnError","Error: first\nmore\nError: second","second"]
["cursor","turnError","Error: test failed earlier\nHANDOFF\noutcome: fixed","test failed earlier"]
["cursor","turnError","  error: lower\n","lower"]
["cursor","turnError","Error: spaced   \r\n","spaced"]
["cursor","turnError","API Error: 500 {\"type\":\"error\"}\nmore\nAPI Error:429 rate limited",null]
["cursor","turnError","x API Error: in a line API Error: second",null]
["cursor","turnError","API Error: ",null]
["cursor","turnError","\u25a0 unexpected status 500",null]
["cursor","turnError","  \u25a0   spaced reason  \nlater",null]
["cursor","turnError","\u25a0\u00a0nbsp",null]
["cursor","turnError","Error: a\u2028Error: b","b"]
["cursor","turnError","\u26a0 Retrying in 3s \u00b7 attempt 1 \u00b7 Rate limit exceeded\nfor this key",null]
["cursor","turnError","\u26a0 Retry due \u00b7 attempt 2 \u00b7 Overloaded\n\u2503  typing",null]
["cursor","turnError","\u26a0 Retrying in 3s \u00b7 attempt 1 \u00b7 Busy\nbuild \u00b7 model \u00b7 2s",null]
["cursor","turnError","Error: gave up\n\nbuild \u00b7 model \u00b7 595ms","gave up"]
["cursor","turnError","Error: gave up\nbuild \u00b7 model \u00b7 1.5s","gave up"]
["cursor","turnError","Error: tool output\nnext line","tool output"]
["cursor","turnError","Error: gave up\n\n12ms\nHANDOFF","gave up"]
["cursor","turnError","Error: gave up\n","gave up"]
["cursor","turnError","  Error: indented  \n  3ms  ","indented"]
["cursor","turnError","\u25a0\nfoo",null]
["cursor","turnError","\u25a0\n\u25a0 actual",null]
["cursor","turnError","\u25a0 \nfoo",null]
["cursor","turnError","\u25a0\n\n  wrapped reason  ",null]
["cursor","turnError","\u25a0\r\nfoo",null]
["cursor","turnError","\u25a0\u2028foo",null]
["cursor","turnError","\u25a0",null]
["cursor","turnError","\u25a0 ",null]
["cursor","turnError","\u25a0  \n",null]
["cursor","turnError","x\u25a0 y",null]
["cursor","turnError","\n \n\u25a0 after blank lines",null]
["cursor","turnError","Error: a  \r\n\r\n","a"]
["cursor","turnError","API Error:\nnext line",null]
["agy","turnError","",null]
["agy","turnError","working...\nError: 401 unauthorized\n","401 unauthorized"]
["agy","turnError","Error: first\nmore\nError: second","second"]
["agy","turnError","Error: test failed earlier\nHANDOFF\noutcome: fixed","test failed earlier"]
["agy","turnError","  error: lower\n","lower"]
["agy","turnError","Error: spaced   \r\n","spaced"]
["agy","turnError","API Error: 500 {\"type\":\"error\"}\nmore\nAPI Error:429 rate limited",null]
["agy","turnError","x API Error: in a line API Error: second",null]
["agy","turnError","API Error: ",null]
["agy","turnError","\u25a0 unexpected status 500",null]
["agy","turnError","  \u25a0   spaced reason  \nlater",null]
["agy","turnError","\u25a0\u00a0nbsp",null]
["agy","turnError","Error: a\u2028Error: b","b"]
["agy","turnError","\u26a0 Retrying in 3s \u00b7 attempt 1 \u00b7 Rate limit exceeded\nfor this key",null]
["agy","turnError","\u26a0 Retry due \u00b7 attempt 2 \u00b7 Overloaded\n\u2503  typing",null]
["agy","turnError","\u26a0 Retrying in 3s \u00b7 attempt 1 \u00b7 Busy\nbuild \u00b7 model \u00b7 2s",null]
["agy","turnError","Error: gave up\n\nbuild \u00b7 model \u00b7 595ms","gave up"]
["agy","turnError","Error: gave up\nbuild \u00b7 model \u00b7 1.5s","gave up"]
["agy","turnError","Error: tool output\nnext line","tool output"]
["agy","turnError","Error: gave up\n\n12ms\nHANDOFF","gave up"]
["agy","turnError","Error: gave up\n","gave up"]
["agy","turnError","  Error: indented  \n  3ms  ","indented"]
["agy","turnError","\u25a0\nfoo",null]
["agy","turnError","\u25a0\n\u25a0 actual",null]
["agy","turnError","\u25a0 \nfoo",null]
["agy","turnError","\u25a0\n\n  wrapped reason  ",null]
["agy","turnError","\u25a0\r\nfoo",null]
["agy","turnError","\u25a0\u2028foo",null]
["agy","turnError","\u25a0",null]
["agy","turnError","\u25a0 ",null]
["agy","turnError","\u25a0  \n",null]
["agy","turnError","x\u25a0 y",null]
["agy","turnError","\n \n\u25a0 after blank lines",null]
["agy","turnError","Error: a  \r\n\r\n","a"]
["agy","turnError","API Error:\nnext line",null]
["opencode","turnError","",null]
["opencode","turnError","working...\nError: 401 unauthorized\n",null]
["opencode","turnError","Error: first\nmore\nError: second",null]
["opencode","turnError","Error: test failed earlier\nHANDOFF\noutcome: fixed",null]
["opencode","turnError","  error: lower\n",null]
["opencode","turnError","Error: spaced   \r\n",null]
["opencode","turnError","API Error: 500 {\"type\":\"error\"}\nmore\nAPI Error:429 rate limited",null]
["opencode","turnError","x API Error: in a line API Error: second",null]
["opencode","turnError","API Error: ",null]
["opencode","turnError","\u25a0 unexpected status 500",null]
["opencode","turnError","  \u25a0   spaced reason  \nlater",null]
["opencode","turnError","\u25a0\u00a0nbsp",null]
["opencode","turnError","Error: a\u2028Error: b",null]
["opencode","turnError","\u26a0 Retrying in 3s \u00b7 attempt 1 \u00b7 Rate limit exceeded\nfor this key","Rate limit exceeded for this key"]
["opencode","turnError","\u26a0 Retry due \u00b7 attempt 2 \u00b7 Overloaded\n\u2503  typing","Overloaded"]
["opencode","turnError","\u26a0 Retrying in 3s \u00b7 attempt 1 \u00b7 Busy\nbuild \u00b7 model \u00b7 2s","Busy"]
["opencode","turnError","Error: gave up\n\nbuild \u00b7 model \u00b7 595ms","gave up"]
["opencode","turnError","Error: gave up\nbuild \u00b7 model \u00b7 1.5s","gave up"]
["opencode","turnError","Error: tool output\nnext line",null]
["opencode","turnError","Error: gave up\n\n12ms\nHANDOFF",null]
["opencode","turnError","Error: gave up\n",null]
["opencode","turnError","  Error: indented  \n  3ms  ","indented"]
["opencode","turnError","\u25a0\nfoo",null]
["opencode","turnError","\u25a0\n\u25a0 actual",null]
["opencode","turnError","\u25a0 \nfoo",null]
["opencode","turnError","\u25a0\n\n  wrapped reason  ",null]
["opencode","turnError","\u25a0\r\nfoo",null]
["opencode","turnError","\u25a0\u2028foo",null]
["opencode","turnError","\u25a0",null]
["opencode","turnError","\u25a0 ",null]
["opencode","turnError","\u25a0  \n",null]
["opencode","turnError","x\u25a0 y",null]
["opencode","turnError","\n \n\u25a0 after blank lines",null]
["opencode","turnError","Error: a  \r\n\r\n",null]
["opencode","turnError","API Error:\nnext line",null]
["cursor","question","Do you trust the contents of this project?\n> ",null]
["cursor","question","> \nDo you trust the contents of this project?",null]
["cursor","question","You are currently not signed in\nRequesting permission for: shell",null]
["cursor","question","Requesting permission for: shell\n  >   \n",null]
["cursor","question","Allow access to this file?",null]
["cursor","question","Workspace Trust Required\nPlan, search, build anything",null]
["cursor","question","Plan, search, build anything\nWorkspace Trust Required","Cursor Agent asks whether to trust this folder."]
["cursor","question","\u25b3 Permission required\nAllow once  Always allow  Reject",null]
["cursor","question","\u001b[1m\u25b3 Permission\u001b[0m \u001b[2mAllow once\u001b[0m Reject",null]
["cursor","question","\u25b3 Permission\nAllow once",null]
["cursor","question","",null]
["agy","question","Do you trust the contents of this project?\n> ",null]
["agy","question","> \nDo you trust the contents of this project?","Antigravity CLI asks whether to trust this folder."]
["agy","question","You are currently not signed in\nRequesting permission for: shell","Antigravity CLI asks for permission to use a tool."]
["agy","question","Requesting permission for: shell\n  >   \n",null]
["agy","question","Allow access to this file?","Antigravity CLI asks to read a file outside its workspace."]
["agy","question","Workspace Trust Required\nPlan, search, build anything",null]
["agy","question","Plan, search, build anything\nWorkspace Trust Required",null]
["agy","question","\u25b3 Permission required\nAllow once  Always allow  Reject",null]
["agy","question","\u001b[1m\u25b3 Permission\u001b[0m \u001b[2mAllow once\u001b[0m Reject",null]
["agy","question","\u25b3 Permission\nAllow once",null]
["agy","question","",null]
["opencode","question","Do you trust the contents of this project?\n> ",null]
["opencode","question","> \nDo you trust the contents of this project?",null]
["opencode","question","You are currently not signed in\nRequesting permission for: shell",null]
["opencode","question","Requesting permission for: shell\n  >   \n",null]
["opencode","question","Allow access to this file?",null]
["opencode","question","Workspace Trust Required\nPlan, search, build anything",null]
["opencode","question","Plan, search, build anything\nWorkspace Trust Required",null]
["opencode","question","\u25b3 Permission required\nAllow once  Always allow  Reject","OpenCode asks for permission."]
["opencode","question","\u001b[1m\u25b3 Permission\u001b[0m \u001b[2mAllow once\u001b[0m Reject","OpenCode asks for permission."]
["opencode","question","\u25b3 Permission\nAllow once",null]
["opencode","question","",null]
["agy","readyError","warning: model no-such-model is not recognized as a known model","Unknown model no-such-model: Antigravity CLI would run its default model instead."]
["agy","readyError","--model gemini-x-low conflicts with --effort=max.\n","The model gemini-x-low does not take the level max: Antigravity CLI would run its default model instead."]
["agy","readyError","--model a.b conflicts with --effort=hi.gh.","The model a.b does not take the level hi: Antigravity CLI would run its default model instead."]
["agy","readyError","model  is not recognized as a known model",null]
["agy","readyError","nothing",null]
["cursor","inputReady",">\nauto \u00b7 gemini",false]
["cursor","inputReady","  >   Auto mode: edits & safe commands\nmodel auto \u00b7 x",false]
["cursor","inputReady","> typed\nauto \u00b7 x",false]
["cursor","inputReady",">\nxauto \u00b7 y",false]
["cursor","inputReady",">\n\u00e9auto \u00b7 y",false]
["cursor","inputReady",">\r\nauto \u00b7 x",false]
["cursor","inputReady","> Auto mode: on\u2028auto \u00b7 x",false]
["cursor","inputReady","Plan, search, build anything",true]
["cursor","inputReady","plan, search",false]
["cursor","inputReady","",false]
["cursor","inputReady","Do you trust the contents of this project?\n>\n\n  Auto mode: on\nauto \u00b7 x",false]
["cursor","inputReady","Requesting permission for: x\n \n  >\r\n",false]
["agy","inputReady",">\nauto \u00b7 gemini",true]
["agy","inputReady","  >   Auto mode: edits & safe commands\nmodel auto \u00b7 x",true]
["agy","inputReady","> typed\nauto \u00b7 x",false]
["agy","inputReady",">\nxauto \u00b7 y",false]
["agy","inputReady",">\n\u00e9auto \u00b7 y",true]
["agy","inputReady",">\r\nauto \u00b7 x",true]
["agy","inputReady","> Auto mode: on\u2028auto \u00b7 x",true]
["agy","inputReady","Plan, search, build anything",false]
["agy","inputReady","plan, search",false]
["agy","inputReady","",false]
["agy","inputReady","Do you trust the contents of this project?\n>\n\n  Auto mode: on\nauto \u00b7 x",true]
["agy","inputReady","Requesting permission for: x\n \n  >\r\n",false]
["pi","draft","\u2500\u2500\u2500\u2500\n\n\u2500\u2500\u2500\u2500",false]
["pi","draft","\u2500\u2500\u2500\u2500\nhello\n\u2500\u2500\u2500\u2500\nfooter",true]
["pi","draft","\u2500\u2500\u2500\u2500\n\u001b[7m \u001b[0m\n\u2500\u2500\u2500\u2500",false]
["pi","draft","\u2500\u2500\u2500\u2500\na\n\u2500\u2500\u2500\u2500\n\n\u2500\u2500\u2500\u2500",false]
["pi","draft","only one\n\u2500\u2500\u2500\u2500",false]
["pi","draft","  \u2500\u2500\u2500\u2500\u2500  \nx\n  \u2500\u2500\u2500\n",true]
["pi","draft","\u276f\u00a0hello",false]
["pi","draft","\u001b[0m\u276f\u00a0\u001b[2mTry \"fix lint\"\u001b[0m",false]
["pi","draft","\u001b[0m\u276f\u00a0\u001b[0m\u001b[0mtyped",false]
["pi","draft","\u276f\u00a0  ",false]
["pi","draft","\u276f not nbsp",false]
["pi","draft","\u276f\u00a0first\n\u276f\u00a0",false]
["pi","draft","\u001b[1;2m\u276f\u00a0x",false]
["pi","draft","\u2503  hello\n\u2503\n\u2503  build \u00b7 model\n\u2579\u2580\u2580\u2580\u2580",false]
["pi","draft","\u2503\n\u2503  Ask anything\u2026\n\u2503\n\u2503  build \u00b7 model\n\u2579\u2580\u2580\u2580",false]
["pi","draft","\u2579\u2580\u2580\u2580\n\u2503  first\nlast",false]
["pi","draft","\u2503     far toast\n\u2503\n\u2579\u2580",false]
["pi","draft","  \u2503  trimmed\n\u2503\n  \u2579\u2580\u2580  ",false]
["pi","draft","\u2503  a\r\n\u2503\n\u2579\u2580",false]
["pi","draft","\u2503  a\u2028b\n\u2503\n\u2579\u2580",false]
["pi","draft","no box",false]
["claude","draft","\u2500\u2500\u2500\u2500\n\n\u2500\u2500\u2500\u2500",false]
["claude","draft","\u2500\u2500\u2500\u2500\nhello\n\u2500\u2500\u2500\u2500\nfooter",false]
["claude","draft","\u2500\u2500\u2500\u2500\n\u001b[7m \u001b[0m\n\u2500\u2500\u2500\u2500",false]
["claude","draft","\u2500\u2500\u2500\u2500\na\n\u2500\u2500\u2500\u2500\n\n\u2500\u2500\u2500\u2500",false]
["claude","draft","only one\n\u2500\u2500\u2500\u2500",false]
["claude","draft","  \u2500\u2500\u2500\u2500\u2500  \nx\n  \u2500\u2500\u2500\n",false]
["claude","draft","\u276f\u00a0hello",true]
["claude","draft","\u001b[0m\u276f\u00a0\u001b[2mTry \"fix lint\"\u001b[0m",false]
["claude","draft","\u001b[0m\u276f\u00a0\u001b[0m\u001b[0mtyped",true]
["claude","draft","\u276f\u00a0  ",false]
["claude","draft","\u276f not nbsp",false]
["claude","draft","\u276f\u00a0first\n\u276f\u00a0",false]
["claude","draft","\u001b[1;2m\u276f\u00a0x",true]
["claude","draft","\u2503  hello\n\u2503\n\u2503  build \u00b7 model\n\u2579\u2580\u2580\u2580\u2580",false]
["claude","draft","\u2503\n\u2503  Ask anything\u2026\n\u2503\n\u2503  build \u00b7 model\n\u2579\u2580\u2580\u2580",false]
["claude","draft","\u2579\u2580\u2580\u2580\n\u2503  first\nlast",false]
["claude","draft","\u2503     far toast\n\u2503\n\u2579\u2580",false]
["claude","draft","  \u2503  trimmed\n\u2503\n  \u2579\u2580\u2580  ",false]
["claude","draft","\u2503  a\r\n\u2503\n\u2579\u2580",false]
["claude","draft","\u2503  a\u2028b\n\u2503\n\u2579\u2580",false]
["claude","draft","no box",false]
["opencode","draft","\u2500\u2500\u2500\u2500\n\n\u2500\u2500\u2500\u2500",false]
["opencode","draft","\u2500\u2500\u2500\u2500\nhello\n\u2500\u2500\u2500\u2500\nfooter",false]
["opencode","draft","\u2500\u2500\u2500\u2500\n\u001b[7m \u001b[0m\n\u2500\u2500\u2500\u2500",false]
["opencode","draft","\u2500\u2500\u2500\u2500\na\n\u2500\u2500\u2500\u2500\n\n\u2500\u2500\u2500\u2500",false]
["opencode","draft","only one\n\u2500\u2500\u2500\u2500",false]
["opencode","draft","  \u2500\u2500\u2500\u2500\u2500  \nx\n  \u2500\u2500\u2500\n",false]
["opencode","draft","\u276f\u00a0hello",false]
["opencode","draft","\u001b[0m\u276f\u00a0\u001b[2mTry \"fix lint\"\u001b[0m",false]
["opencode","draft","\u001b[0m\u276f\u00a0\u001b[0m\u001b[0mtyped",false]
["opencode","draft","\u276f\u00a0  ",false]
["opencode","draft","\u276f not nbsp",false]
["opencode","draft","\u276f\u00a0first\n\u276f\u00a0",false]
["opencode","draft","\u001b[1;2m\u276f\u00a0x",false]
["opencode","draft","\u2503  hello\n\u2503\n\u2503  build \u00b7 model\n\u2579\u2580\u2580\u2580\u2580",true]
["opencode","draft","\u2503\n\u2503  Ask anything\u2026\n\u2503\n\u2503  build \u00b7 model\n\u2579\u2580\u2580\u2580",false]
["opencode","draft","\u2579\u2580\u2580\u2580\n\u2503  first\nlast",true]
["opencode","draft","\u2503     far toast\n\u2503\n\u2579\u2580",false]
["opencode","draft","  \u2503  trimmed\n\u2503\n  \u2579\u2580\u2580  ",true]
["opencode","draft","\u2503  a\r\n\u2503\n\u2579\u2580",true]
["opencode","draft","\u2503  a\u2028b\n\u2503\n\u2579\u2580",false]
["opencode","draft","no box",false]
"##;

#[test]
fn answers_screens_as_typescripts_adapters_do() {
    let mut failures = Vec::new();
    let rows: Vec<&str> = RECORDED.lines().filter(|line| !line.is_empty()).collect();
    assert_eq!(rows.len(), 413);
    for row in rows {
        let (kind, look, screen, expected): (FleetAgentKind, String, String, Value) =
            serde_json::from_str(row).unwrap();
        let checks = screen_checks(kind);
        let text = |look: Option<fn(&str) -> Option<String>>| Value::from(look.unwrap()(&screen));
        let returned = match look.as_str() {
            "startupError" => Value::from((checks.startup_error)(&screen)),
            "turnError" => Value::from((checks.turn_error)(&screen)),
            "question" => text(checks.question),
            "readyError" => text(checks.ready_error),
            "inputReady" => Value::from(checks.input_ready.unwrap()(&screen)),
            "draft" => Value::from(checks.draft.unwrap()(&screen)),
            other => panic!("no look {other}"),
        };
        if returned != expected {
            failures.push(format!(
                "{kind:?} {look} {screen:?}: returned {returned}, expected {expected}"
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
