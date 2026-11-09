//! The texts the fleet CLI prints as they are: its usage and the guide for an agent in a pane's
//! conversation, word for word as `bin/fleet.ts` writes them (`USAGE` and `GUIDE`).

/// `fleet --help`: the commands, their options and the exit statuses.
pub const USAGE: &str = r#"usage: fleet <command> [options]

  spawn --role <role> --task <text> [--name <name>] [--model <provider/model>] [--thinking <level>]
        [--cwd <dir>] [--worktree] [--interactive] [--direction right|down] [--wait] [--timeout <ms>]
        [--avoid <cli>]...               keep a CLI out (pi, claude, codex, cursor, agy, opencode), such as the writer's for a review
        an agent handing work on gives a brief instead of --task (--task then adds notes):
        --goal <one sentence> --write <path>... | --read-only --context <files, earlier results, or none>
        --done <checkable condition> --verify <commands, and the evidence to return> [--forbid <text>] [--timebox <text>]
  thread --title <title> --task <text> [--cwd <dir>]
                                   start a thread: a lead in a workspace of its own, on a worktree of its own in a repository
                                   (an agent gives a brief instead of --task, as for spawn)
  threads [--cwd <dir>]            the threads of this project: state, branch, HANDOFF status line and contract
  plan <file.json>                 a thread's lead hands its plan to the person, who answers it on the Fleet screen
                                   (- reads it from stdin); the answers come back as your next task
  project --task <text> [--cwd <dir>]
                                   talk to the project's coordinator, started at its main checkout if none runs
  guide                            how an agent in a pane's conversation hands work to the fleet (the fleet skill runs this)
  send <agent> <message...>        hand an agent its next task
  wait <agent> [--timeout <ms>]    until its turn settles; follows a re-spawn after a fallback
  read <agent> [--lines <n>]       its recent output
  list [--all]                     this fleet's agents (--all: every fleet)
  interrupt <agent>                press Esc in its pane
  focus <agent>                    bring its pane to front in herdr
  close-done                       close the panes of finished non-interactive agents
  roles [--cwd <dir>]              the roles that can be spawned
  usage [--refresh]                what each subscription has used, and which are cooling down
  usage clear [<key>]              end a cooldown: one account (agy:gemini), a CLI's (agy), or all
  report [--hours <n>] [--planned-label <regex>] [--cwd <dir>]
                                   this project's factory metrics: the person stepping in, standstills, failed starts per
                                   agent and per role version (the role file's hash), merged pull requests, issues found
                                   during the work (default: the last 24 hours)

  <agent> is a name, role, id or pane id. Add --json for machine-readable output.
  exit status: 0 settled, 1 failed or error, 2 usage, 4 blocked on a question, 124 wait timed out"#;

/// `fleet guide`: how an agent in a pane's conversation hands work to the fleet; the fleet skill
/// (`server/fleet/entrances.ts`) has the agent read it, so it matches this CLI.
pub const GUIDE: &str = r#"herdr-fleet runs a team of coding agents in herdr. Each repository has one coordinator: it talks with
the person on the Fleet screen and splits work into threads, each on a branch of its own.
Below, `fleet` is the command the skill named, with HERDR_FLEET_URL set as it shows.

To hand work on:  fleet project --cwd <the repository> --task "<the request>"
- This is a handoff: the repository's coordinator owns the work from here. Do not wait for it, and do not
  follow its threads up yourself.
- The coordinator has not seen this conversation. Write the request so that it stands alone: what to do and
  why, what this conversation found and decided, the files involved, and how to tell it is done.
- Then tell the person it was sent, and that the coordinator's reply and its threads are on the Fleet screen.

To check on it, when the person asks:  fleet threads --cwd <the repository>

If the command cannot reach the server, your sandbox may block the loopback: ask to run that one command
outside it. Do not change the sandbox's network settings."#;
