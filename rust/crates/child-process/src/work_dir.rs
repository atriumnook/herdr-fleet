//! The private folder a CLI the server starts on its own runs in (`emptyWorkDir`,
//! `server/cli-child.ts:38`).

use std::fs;
use std::io;
use std::path::Path;

/// Makes the folder (0700) or empties it, so what a run before left behind is not read by the
/// next. Never the shared temporary folder, where another user could leave a
/// `.claude/settings.json` or a `CLAUDE.md` for the CLI to read. One fixed folder per use, so
/// Claude Code keeps one entry for it under `~/.claude/projects`, not one per run; its users run
/// one at a time.
///
/// A link or a file in the folder's place is refused (`NotADirectory`) and left as it is: a link
/// would send the CLI elsewhere. What is inside is removed without following links.
pub fn empty_work_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    // Something already in its place (a folder, a link, a file) may fail the making; the check
    // below then decides, on the thing itself, not on what a link points at.
    if let Err(error) = builder.create(dir)
        && fs::symlink_metadata(dir).is_err()
    {
        return Err(error);
    }
    if !fs::symlink_metadata(dir)?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            format!("{} is not a folder", dir.display()),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let removed = if entry.file_type()?.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        match removed {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    Ok(())
}
