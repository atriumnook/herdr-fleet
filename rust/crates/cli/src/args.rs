//! The options of `fleet`, read as `parseArgs` of `node:util` reads them in Bun with
//! `{ strict: true, allowPositionals: true }` and the options `bin/fleet.ts` declares. The fleet
//! CLI contract compares the messages of its errors (ADR 0244-phase-3-dependencies chose to write
//! them here rather than take an argument parser crate), so they are Bun's word for word, quirks
//! included: an unknown option inside a group of short options (`-abc`) is named without its
//! dash, and the unknown-option message has no closing quote.

use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Text,
    Texts,
    Flag,
}

/// The options `bin/fleet.ts` gives `parseArgs`: every command takes all of them.
const OPTIONS: &[(&str, Kind)] = &[
    ("role", Kind::Text),
    ("task", Kind::Text),
    ("name", Kind::Text),
    ("model", Kind::Text),
    ("thinking", Kind::Text),
    ("cwd", Kind::Text),
    ("worktree", Kind::Flag),
    ("interactive", Kind::Flag),
    ("direction", Kind::Text),
    ("wait", Kind::Flag),
    ("timeout", Kind::Text),
    ("lines", Kind::Text),
    ("all", Kind::Flag),
    ("json", Kind::Flag),
    ("refresh", Kind::Flag),
    ("avoid", Kind::Texts),
    ("title", Kind::Text),
    ("goal", Kind::Text),
    ("write", Kind::Texts),
    ("read-only", Kind::Flag),
    ("context", Kind::Text),
    ("done", Kind::Text),
    ("verify", Kind::Text),
    ("forbid", Kind::Text),
    ("timebox", Kind::Text),
    ("hours", Kind::Text),
    ("planned-label", Kind::Text),
];

fn kind(name: &str) -> Option<Kind> {
    OPTIONS.iter().find(|(n, _)| *n == name).map(|(_, k)| *k)
}

/// What the arguments set: the options given and the positionals in order.
#[derive(Debug, Default)]
pub struct Parsed {
    texts: BTreeMap<String, String>,
    lists: BTreeMap<String, Vec<String>>,
    flags: BTreeSet<String>,
    pub positionals: Vec<String>,
}

impl Parsed {
    /// A string option: the last value given, if any.
    pub fn text(&self, name: &str) -> Option<&str> {
        self.texts.get(name).map(String::as_str)
    }

    /// A string option that may repeat: every value, if it was given at all.
    pub fn list(&self, name: &str) -> Option<&[String]> {
        self.lists.get(name).map(Vec::as_slice)
    }

    /// A boolean option: `Some(true)` when given, `None` (undefined) when not.
    pub fn flag(&self, name: &str) -> Option<bool> {
        self.flags.contains(name).then_some(true)
    }

    /// Whether any of the string or boolean options named was given.
    pub fn has(&self, name: &str) -> bool {
        self.texts.contains_key(name) || self.lists.contains_key(name) || self.flags.contains(name)
    }
}

fn unknown(name: &str) -> String {
    format!(
        "Unknown option '{name}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"{name}\""
    )
}

/// Reads `args` (what follows the command); the error is the message `parseArgs` throws.
pub fn parse(args: &[String]) -> Result<Parsed, String> {
    let mut parsed = Parsed::default();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        index += 1;
        if arg == "--" {
            parsed.positionals.extend(args[index..].iter().cloned());
            break;
        }
        // Bun measures and indexes the argument in UTF-16 code units, as a JavaScript string
        let units: Vec<u16> = arg.encode_utf16().collect();
        if arg.starts_with('-') && !arg.starts_with("--") && units.len() >= 2 {
            // no option of the fleet has a short name: a lone short option is unknown, and a
            // group of them is unknown at its first code unit, which is a lone surrogate
            // (written as U+FFFD) when the group starts with a character beyond the BMP
            if units.len() == 2 {
                return Err(unknown(arg));
            }
            return Err(unknown(&String::from_utf16_lossy(&units[1..2])));
        }
        if let Some(long) = arg.strip_prefix("--") {
            // `--name=value` split at the first `=`, unless that `=` starts the name: then the
            // whole argument is the name
            let (name, inline) = match long.find('=') {
                Some(at) if at > 0 => (&long[..at], Some(long[at + 1..].to_string())),
                _ => (long, None),
            };
            let raw = format!("--{name}");
            let Some(kind) = kind(name) else {
                return Err(unknown(&raw));
            };
            if kind == Kind::Flag {
                if inline.is_some() {
                    return Err(format!("Option '{raw}' does not take an argument"));
                }
                parsed.flags.insert(name.to_string());
                continue;
            }
            let value = match inline {
                Some(value) => value,
                None => {
                    let Some(next) = args.get(index) else {
                        return Err(format!("Option '{raw} <value>' argument missing"));
                    };
                    index += 1;
                    if next.chars().count() > 1 && next.starts_with('-') {
                        return Err(format!(
                            "Option '{raw}' argument is ambiguous.\nDid you forget to specify the option argument for '{raw}'?\nTo specify an option argument starting with a dash use '{raw}=-XYZ'."
                        ));
                    }
                    next.clone()
                }
            };
            if kind == Kind::Texts {
                parsed
                    .lists
                    .entry(name.to_string())
                    .or_default()
                    .push(value);
            } else {
                parsed.texts.insert(name.to_string(), value);
            }
            continue;
        }
        parsed.positionals.push(arg.clone());
    }
    Ok(parsed)
}
