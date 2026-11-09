//! The private folder a CLI the server starts on its own runs in (`emptyWorkDir`,
//! `server/cli-child.ts:38`).

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Makes the folder (0700) or empties it, so what a run before left behind is not read by the
/// next. Never the shared temporary folder, where another user could leave a
/// `.claude/settings.json` or a `CLAUDE.md` for the CLI to read. One fixed folder per use, so
/// Claude Code keeps one entry for it under `~/.claude/projects`, not one per run; its users run
/// one at a time.
///
/// A link or a file in the folder's place is refused (`NotADirectory`) and left as it is: a link
/// would send the CLI elsewhere, also when its name is written with a `/` after it. What is
/// inside is removed without following links.
pub fn empty_work_dir(dir: &Path) -> io::Result<()> {
    // Without a `/` or `.` after the last name: the OS would look through a link named so. A name
    // that ends in `..` (or a root) names another folder than the one written, and is refused.
    if !matches!(dir.components().next_back(), Some(Component::Normal(_))) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} does not end in a folder's name", dir.display()),
        ));
    }
    let dir: PathBuf = dir.components().collect();
    let dir = dir.as_path();
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
    // an entry that cannot be removed keeps no other: the first error is returned at the end
    let mut first_error = None;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let removed = entry.file_type().and_then(|kind| {
            if kind.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            }
        });
        match removed {
            // gone since the folder was listed: nothing left to remove
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                first_error.get_or_insert(error);
            }
            _ => {}
        }
    }
    first_error.map_or(Ok(()), Err)
}
