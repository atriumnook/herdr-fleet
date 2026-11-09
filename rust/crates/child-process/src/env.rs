//! What a child gets of the server's environment (`server/cli-child.ts`).

use std::collections::BTreeMap;
use std::ffi::OsString;

/// An environment: each variable's name and value, as the OS holds them.
pub type Env = BTreeMap<OsString, OsString>;

/// Which environment a child starts with. Every start names one: [`Command::new`] takes it, and
/// there is no default.
///
/// [`Command::new`]: crate::Command::new
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvPolicy {
    /// These variables and nothing else: a CLI the server starts on its own (a usage probe, a
    /// model list, `opencode api`), given [`child_env`] or [`claude_env`] of the server's
    /// environment.
    Only(Env),
    /// The server's whole environment, these variables laid over it: git, `gh` and the person's
    /// setup command, which need the person's own setup (ADR 0242-phase-3-split, "子プロセス").
    Inherit(Env),
}

/// What every such CLI keeps of the server's environment: what it needs to start and to find its
/// sign-in (`KEPT_ENV`, `server/cli-child.ts:10`).
const KEPT_ENV: [&str; 18] = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TMPDIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
];

/// The CLI's whole environment: the names of `KEPT_ENV`, the locale (`LC_*`), `XDG_*`, and the
/// names in `also_keep` (the CLI's own folder, like `CLAUDE_CONFIG_DIR`), taken from `source`.
/// Nothing else passes: an API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`)
/// would bill the API instead of the person's plan and answer for it, other provider settings
/// could send the CLI elsewhere, and `HERDR_*` points at the person's session. A name that is not
/// UTF-8 matches no rule; a kept value passes as it is.
pub fn child_env(source: &Env, also_keep: &[&str]) -> Env {
    source
        .iter()
        .filter(|(name, _)| {
            name.to_str().is_some_and(|name| {
                KEPT_ENV.contains(&name)
                    || also_keep.contains(&name)
                    || name.starts_with("LC_")
                    || name.starts_with("XDG_")
            })
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

/// claude's environment: [`child_env`] with its own folder (`CLAUDE_CONFIG_DIR`), and no
/// self-update while it runs (`DISABLE_AUTOUPDATER=1`).
pub fn claude_env(source: &Env) -> Env {
    let mut env = child_env(source, &["CLAUDE_CONFIG_DIR"]);
    env.insert("DISABLE_AUTOUPDATER".into(), "1".into());
    env
}
