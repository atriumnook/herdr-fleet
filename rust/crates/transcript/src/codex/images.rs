//! The images a Codex user attached (`server/codex-images.ts`): a page names each by a hash of
//! the attachment as Codex recorded it (a local path or an inline `data:` URL), so neither base64
//! nor a filesystem path reaches a conversation response; the image is read when it is asked for.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use protocol::ImageRef;
use protocol::js::utf16_len;
use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::parser::{string, truthy};
use crate::Image;
use crate::format::Segment;
use crate::records::{Row, decode_base64_leniently, record};

static DATA_IMAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^data:(image/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$")
        .expect("DATA_IMAGE")
});
static SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?i)[a-z][a-z0-9+.-]*:").expect("SCHEME"));
static IMAGE_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^codex-[a-f0-9]{64}$").expect("IMAGE_REF"));

const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

/// The media type of a local image, by its extension.
fn type_of_extension(extension: &str) -> Option<&'static str> {
    match extension {
        ".png" => Some("image/png"),
        ".jpg" | ".jpeg" => Some("image/jpeg"),
        ".gif" => Some("image/gif"),
        ".webp" => Some("image/webp"),
        _ => None,
    }
}

/// `path.extname` of node (posix): the last `.` of the last name and what follows, "" when the
/// name has none or starts with its only dot.
fn extname(path: &str) -> &str {
    let bytes = path.as_bytes();
    let (mut start_dot, mut start_part, mut end) = (None, 0, None);
    let mut matched_slash = true;
    // 0: no dot before the last one seen yet; 1: one was; -1: a character other than a dot was
    let mut pre_dot_state = 0;
    for index in (0..bytes.len()).rev() {
        if bytes[index] == b'/' {
            if !matched_slash {
                start_part = index + 1;
                break;
            }
            continue;
        }
        if end.is_none() {
            matched_slash = false;
            end = Some(index + 1);
        }
        if bytes[index] == b'.' {
            if start_dot.is_none() {
                start_dot = Some(index);
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot.is_some() {
            pre_dot_state = -1;
        }
    }
    match (start_dot, end) {
        (Some(dot), Some(end))
            if pre_dot_state != 0
                && !(pre_dot_state == 1 && dot == end - 1 && dot == start_part + 1) =>
        {
            &path[dot..end]
        }
        _ => "",
    }
}

/// The attachments a record names. Only native user records name attachments; tool output and
/// remote URLs never do.
fn image_values(entry: &Row) -> Vec<&str> {
    let payload = record(entry.get("payload"));
    let kind = string(payload, "type");
    if string(entry, "type") == "event_msg" && kind == "user_message" {
        if truthy(payload.get("kind")) && string(payload, "kind") != "plain" {
            return Vec::new();
        }
        return ["local_images", "images"]
            .iter()
            .filter_map(|field| payload.get(*field).and_then(Value::as_array))
            .flatten()
            .filter_map(Value::as_str)
            .collect();
    }
    if string(entry, "type") != "response_item"
        || kind != "message"
        || string(payload, "role") != "user"
    {
        return Vec::new();
    }
    let Some(content) = payload.get("content").and_then(Value::as_array) else {
        return Vec::new();
    };
    content
        .iter()
        .filter_map(|value| {
            let part = record(Some(value));
            match string(part, "type") {
                "input_image" => part.get("image_url"),
                "local_image" => part.get("path"),
                _ => None,
            }
            .and_then(Value::as_str)
        })
        .collect()
}

/// The part a page shows for an attachment, or `None` for one it does not show (a remote URL, an
/// unknown type, a value too long to be an image of at most 8 MiB).
fn image_part(value: &str) -> Option<ImageRef> {
    if value.is_empty()
        || value.contains('\0')
        || utf16_len(value) as f64 > MAX_IMAGE_BYTES as f64 * 4.0 / 3.0 + 128.0
    {
        return None;
    }
    let inline = DATA_IMAGE.captures(value);
    if inline.is_none() && SCHEME.is_match(value) {
        return None;
    }
    let media_type = match &inline {
        Some(found) => found.get(1)?.as_str(),
        None => type_of_extension(&extname(value).to_lowercase())?,
    };
    let digest = Sha256::digest(value.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Some(ImageRef {
        media_type: media_type.to_owned(),
        reference: format!("codex-{hex}"),
    })
}

/// The images a user record attached, each once (`codexImageParts`).
pub(super) fn image_parts(entry: &Row) -> Vec<ImageRef> {
    let mut values: Vec<&str> = Vec::new();
    for value in image_values(entry) {
        if !values.contains(&value) {
            values.push(value);
        }
    }
    values.into_iter().filter_map(image_part).collect()
}

/// The type the bytes of an image say they are. The GIF and WebP signatures are compared as
/// `Buffer.toString("ascii")` reads bytes: each without its high bit.
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    let ascii = |range: std::ops::Range<usize>, text: &[u8]| {
        bytes.get(range).is_some_and(|found| {
            found.len() == text.len()
                && found
                    .iter()
                    .zip(text)
                    .all(|(byte, want)| byte & 0x7f == *want)
        })
    };
    if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        Some("image/png")
    } else if bytes.starts_with(&[255, 216, 255]) {
        Some("image/jpeg")
    } else if ascii(0..6, b"GIF87a") || ascii(0..6, b"GIF89a") {
        Some("image/gif")
    } else if ascii(0..4, b"RIFF") && ascii(8..12, b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

/// `path.resolve(cwd, value)`: `value` from `cwd`, its `.` and `..` resolved by name.
fn resolve(cwd: &Path, value: &str) -> PathBuf {
    let joined = std::path::absolute(cwd.join(value)).unwrap_or_else(|_| cwd.join(value));
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// O_NONBLOCK where its value is known without libc, which this crate does not depend on.
#[cfg(all(
    target_os = "linux",
    any(
        target_arch = "x86_64",
        target_arch = "x86",
        target_arch = "aarch64",
        target_arch = "arm",
        target_arch = "riscv64",
        target_arch = "powerpc64",
        target_arch = "s390x",
        target_arch = "loongarch64"
    )
))]
const NONBLOCK: Option<i32> = Some(0o4000);
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
const NONBLOCK: Option<i32> = Some(0x0004);
#[cfg(not(any(
    all(
        target_os = "linux",
        any(
            target_arch = "x86_64",
            target_arch = "x86",
            target_arch = "aarch64",
            target_arch = "arm",
            target_arch = "riscv64",
            target_arch = "powerpc64",
            target_arch = "s390x",
            target_arch = "loongarch64"
        )
    ),
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd"
)))]
const NONBLOCK: Option<i32> = None;

/// Opens a local image for reading without waiting on a FIFO the path names: with `O_NONBLOCK`,
/// as `server/codex-images.ts` opens it, and the caller checks the open file is a regular one.
/// The flag lets a read return early; it opens nothing for writing, which is what the crate's ban
/// on `custom_flags` keeps out (ADR 0107-crate-split). Where its value is not known here, a path
/// that is not a regular file is refused before it is opened.
#[cfg(unix)]
#[allow(
    clippy::disallowed_methods,
    reason = "O_NONBLOCK on a read-only open: the file is still opened for reading only"
)]
fn open_image(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let Some(flag) = NONBLOCK else {
        return open_regular(path);
    };
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(flag)
        .open(path)
}

#[cfg(not(unix))]
fn open_image(path: &Path) -> std::io::Result<File> {
    open_regular(path)
}

/// Opens `path` once it is found to be a regular file. A FIFO put in its place between the two
/// still blocks the open.
fn open_regular(path: &Path) -> std::io::Result<File> {
    if !std::fs::metadata(path)?.is_file() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    File::open(path)
}

/// The bytes of an attachment: decoded when inline, else read from the file its path names from
/// `cwd`, a regular file of at most 8 MiB.
fn image_bytes(value: &str, cwd: &Path) -> Option<Vec<u8>> {
    if let Some(inline) = DATA_IMAGE.captures(value) {
        let bytes = decode_base64_leniently(inline.get(2)?.as_str());
        return (bytes.len() as u64 <= MAX_IMAGE_BYTES).then_some(bytes);
    }
    let file = open_image(&resolve(cwd, value)).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(meta.len()).read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

/// Whether `reference` is the form a Codex image part's ref takes.
pub(super) fn is_image_ref(reference: &str) -> bool {
    IMAGE_REF.is_match(reference)
}

/// The image `reference` names, decoded (`codexTranscriptImage`). Only the bound history is
/// scanned: the rollouts it continues, without the bytes a backtrack discarded. The first
/// attachment the ref names answers, or nothing does.
pub(super) fn transcript_image(segments: &[Segment], reference: &str, cwd: &Path) -> Option<Image> {
    if !is_image_ref(reference) {
        return None;
    }
    for segment in segments {
        if segment.end == 0 {
            continue;
        }
        let reader = BufReader::new(File::open(&segment.path).ok()?.take(segment.end));
        for line in reader.split(b'\n') {
            let line = line.ok()?;
            let Some(Value::Object(entry)) =
                crate::records::parse_line(&String::from_utf8_lossy(&line))
            else {
                continue;
            };
            for value in image_values(&entry) {
                if image_part(value).is_none_or(|part| part.reference != reference) {
                    continue;
                }
                let bytes = image_bytes(value, cwd)?;
                let media_type = image_type(&bytes)?;
                return Some(Image {
                    media_type: media_type.to_owned(),
                    bytes,
                });
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values: Bun 1.4.4 `path.posix.extname` and `path.resolve` of the same paths.
    #[test]
    fn finds_the_extension_as_node_does() {
        assert_eq!(extname("a/shot.PNG"), ".PNG");
        assert_eq!(extname("shot.tar.gz"), ".gz");
        assert_eq!(extname(".png"), "");
        assert_eq!(extname("a/.png"), "");
        assert_eq!(extname("a.png/"), ".png");
        assert_eq!(extname("a."), ".");
        assert_eq!(extname("..png"), ".png");
        assert_eq!(extname("noext"), "");
    }

    // `Buffer.toString("ascii")` drops each byte's high bit before the GIF and WebP signatures are
    // compared. Expected values: Bun 1.4.4 `/^GIF8[79]a$/.test(Buffer.from(bytes).toString("ascii"))`
    // and the same for "RIFF" and "WEBP".
    #[test]
    fn reads_the_signatures_as_ascii_text() {
        assert_eq!(
            image_type(&[199, 201, 198, 184, 185, 225]),
            Some("image/gif")
        );
        assert_eq!(
            image_type(&[0xd2, 0xc9, 0xc6, 0xc6, 0, 0, 0, 0, 0xd7, 0xc5, 0xc2, 0xd0]),
            Some("image/webp")
        );
        assert_eq!(image_type(&[0x89, b'X', b'N', b'G']), None);
    }

    #[test]
    fn resolves_a_path_by_name() {
        assert_eq!(
            resolve(Path::new("/w/case"), "assets/../shot.png"),
            PathBuf::from("/w/case/shot.png")
        );
        assert_eq!(
            resolve(Path::new("/w"), "/etc/x.png"),
            PathBuf::from("/etc/x.png")
        );
    }
}
