//! What `Transcripts::image` answers for a Codex local image that is not a plain regular file of at
//! most 8 MiB (Issue #225): a FIFO, a directory, a symlink and the size bound. The corpus cannot
//! hold these (a case is copied byte for byte, and a file past 8 MiB is too large to keep), so this
//! test makes them in its own temporary folder. Expected values: `server/codex-images.ts` opens
//! the path with `O_RDONLY | O_NONBLOCK`, which follows a symlink and does not wait for a FIFO's
//! writer, and answers null unless `fstat` says a regular file of at most 8 MiB.

// The test writes its files and makes a FIFO with `mkfifo` (std has none). clippy.toml forbids
// both in this crate; ADR 0110-workspace-and-ci allows them under tests/.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

use herdr_fleet_transcript::{CodexRollout, FileSource, Image, Transcripts};

/// `codex-` and the sha256 of `shot.png`, the local path the rollout names (worked out with
/// `printf 'shot.png' | sha256sum`).
const SHOT_REF: &str = "codex-8b0a4e3638b6270d28cc146e50ac6d1ff252fac122900f55e10c7d420abb5190";
const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

/// A temporary folder holding a rollout whose user attached `shot.png` by a path relative to the
/// pane's folder, which is this folder. It is removed when dropped.
struct Case(PathBuf);

impl Case {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("herdr-codex-images-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("home")).expect("create the case folder");
        fs::write(
            root.join("rollout.jsonl"),
            concat!(
                r#"{"type":"event_msg","timestamp":"2026-09-27T00:00:00Z","#,
                r#""payload":{"type":"user_message","message":"","local_images":["shot.png"]}}"#,
                "\n"
            ),
        )
        .expect("write the rollout");
        Self(root)
    }

    fn shot(&self) -> PathBuf {
        self.0.join("shot.png")
    }

    fn source(&self) -> FileSource {
        FileSource::Codex(CodexRollout {
            path: self.0.join("rollout.jsonl"),
            home: self.0.join("home"),
            cwd: self.0.clone(),
        })
    }

    /// The image `shot.png` answers, or a panic when the answer does not come within 2 seconds.
    fn image(&self) -> Option<Image> {
        let source = self.source();
        let (sender, receiver) = mpsc::channel();
        // A thread stuck in `open` cannot be stopped; the test process ends it.
        std::thread::spawn(move || {
            let image = Transcripts::new(Box::new(|_, _| None)).image(&source, SHOT_REF);
            let _ = sender.send(image);
        });
        receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("Transcripts::image answers within 2 seconds")
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn png_of(length: usize) -> Vec<u8> {
    let mut bytes = PNG_SIGNATURE.to_vec();
    bytes.resize(length, 0);
    bytes
}

fn mkfifo(path: &Path) {
    let status = Command::new("mkfifo")
        .arg(path)
        .status()
        .expect("run mkfifo");
    assert!(status.success(), "mkfifo {}: {status}", path.display());
}

#[test]
fn a_fifo_with_no_writer_answers_none_at_once() {
    let case = Case::new("fifo");
    mkfifo(&case.shot());
    assert_eq!(case.image(), None);
}

#[test]
fn a_directory_answers_none() {
    let case = Case::new("directory");
    fs::create_dir(case.shot()).expect("create the directory");
    assert_eq!(case.image(), None);
}

#[test]
fn a_symlink_to_an_image_answers_the_image() {
    let case = Case::new("symlink");
    fs::write(case.0.join("target.png"), png_of(68)).expect("write the image");
    std::os::unix::fs::symlink("target.png", case.shot()).expect("create the symlink");
    assert_eq!(
        case.image(),
        Some(Image {
            media_type: "image/png".to_owned(),
            bytes: png_of(68),
        })
    );
}

#[test]
fn a_symlink_to_a_fifo_answers_none_at_once() {
    let case = Case::new("symlink-fifo");
    mkfifo(&case.0.join("pipe"));
    std::os::unix::fs::symlink("pipe", case.shot()).expect("create the symlink");
    assert_eq!(case.image(), None);
}

#[test]
fn an_image_of_8_mib_is_read_and_one_byte_more_is_not() {
    let case = Case::new("size");
    fs::write(case.shot(), png_of(MAX_IMAGE_BYTES)).expect("write the image");
    let image = case.image().expect("an image of 8 MiB is read");
    assert_eq!(
        (image.media_type.as_str(), image.bytes.len()),
        ("image/png", MAX_IMAGE_BYTES)
    );
    fs::write(case.shot(), png_of(MAX_IMAGE_BYTES + 1)).expect("write the image");
    assert_eq!(case.image(), None);
}
