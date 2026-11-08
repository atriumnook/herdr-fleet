//! Codex's memory citations (`<oai-mem-citation>…</oai-mem-citation>`) are metadata of an answer:
//! the chat drops them, except where the answer quotes them in Markdown code (a code span or a
//! fenced block), which `withoutMemoryCitations` of `server/codex.ts` tells apart.
//!
//! Positions are byte offsets where TypeScript counts UTF-16 code units: every position compared
//! or cut at is the start of a line, a run of backticks, a fence marker or a tag, and every length
//! counted is of ASCII characters, so the two agree.

use protocol::js;

const OPENING: &str = "<oai-mem-citation>";
const CLOSING: &str = "</oai-mem-citation>";

/// One line's layout: its quote depth, its indent inside the quotes, and the content indent of
/// the list item it opens.
#[derive(Clone, Copy)]
struct Line {
    quote_depth: usize,
    indent: usize,
    list_indent: Option<usize>,
    blank: bool,
}

enum Kind {
    Line(Line),
    Fence {
        marker: String,
        info: String,
        line: Line,
    },
    Ticks(usize),
    Citation,
}

struct Token {
    index: usize,
    kind: Kind,
}

/// The lines of `text` as `/([^\r\n]*)(?:\r\n?|\n|$)/g` matches them: each line's start and
/// content, and an empty last line after the last terminator or a non-empty last line.
fn lines(text: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0;
    loop {
        let end = bytes[start..]
            .iter()
            .position(|byte| *byte == b'\r' || *byte == b'\n')
            .map_or(bytes.len(), |at| start + at);
        out.push((start, &text[start..end]));
        if end == bytes.len() {
            if end > start {
                out.push((end, ""));
            }
            return out;
        }
        start = if bytes[end] == b'\r' && bytes.get(end + 1) == Some(&b'\n') {
            end + 2
        } else {
            end + 1
        };
    }
}

/// The length of the run of `[ \t]` at the start of `text`.
fn blanks(text: &str) -> usize {
    text.bytes()
        .take_while(|byte| *byte == b' ' || *byte == b'\t')
        .count()
}

/// The quote markers `/[ \t]*>[ \t]?/y` takes from the start of a line: how many, and where the
/// rest starts.
fn quotes(source: &str) -> (usize, usize) {
    let bytes = source.as_bytes();
    let (mut depth, mut offset) = (0, 0);
    loop {
        let at = offset + blanks(&source[offset..]);
        if bytes.get(at) != Some(&b'>') {
            return (depth, offset);
        }
        offset = at + 1;
        if matches!(bytes.get(offset), Some(b' ' | b'\t')) {
            offset += 1;
        }
        depth += 1;
    }
}

/// A list item's marker and the blanks after it (`/^(?:[-+*]|\d+[.)])[ \t]+/`): its length.
fn list_marker(content: &str) -> Option<usize> {
    let bytes = content.as_bytes();
    let marker = match bytes.first()? {
        b'-' | b'+' | b'*' => 1,
        _ => {
            let digits = bytes
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            if digits == 0 || !matches!(bytes.get(digits), Some(b'.' | b')')) {
                return None;
            }
            digits + 1
        }
    };
    let gap = blanks(&content[marker..]);
    (gap > 0).then_some(marker + gap)
}

/// A fence marker at the start of `body` (`/^(`{3,}|~{3,})/`).
fn fence_marker(body: &str) -> Option<&str> {
    let first = *body.as_bytes().first()?;
    if first != b'`' && first != b'~' {
        return None;
    }
    let run = body.bytes().take_while(|byte| *byte == first).count();
    (run >= 3).then(|| &body[..run])
}

fn tokens(text: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    for (start, source) in lines(text) {
        let (quote_depth, offset) = quotes(source);
        let indent = blanks(&source[offset..]);
        let content = &source[offset + indent..];
        let list = list_marker(content);
        let line = Line {
            quote_depth,
            indent,
            list_indent: list.map(|length| indent + length),
            blank: js::trim(content).is_empty(),
        };
        tokens.push(Token {
            index: start,
            kind: Kind::Line(line),
        });
        let body = &content[list.unwrap_or(0)..];
        if let Some(marker) = fence_marker(body) {
            let info = &body[marker.len()..];
            // A backtick fence's info string cannot contain backticks.
            if !marker.starts_with('`') || !info.contains('`') {
                tokens.push(Token {
                    index: start + offset + indent + list.unwrap_or(0),
                    kind: Kind::Fence {
                        marker: marker.to_owned(),
                        info: info.to_owned(),
                        line,
                    },
                });
            }
        }
        let bytes = source.as_bytes();
        let mut at = 0;
        while at < bytes.len() {
            if bytes[at] == b'`' {
                let run = bytes[at..].iter().take_while(|byte| **byte == b'`').count();
                tokens.push(Token {
                    index: start + at,
                    kind: Kind::Ticks(run),
                });
                at += run;
            } else if source[at..].starts_with(OPENING) {
                tokens.push(Token {
                    index: start + at,
                    kind: Kind::Citation,
                });
                at += OPENING.len();
            } else {
                at += 1;
            }
        }
    }
    tokens
}

/// For each run of backticks, the run that closes its code span, if any. Index matching runs
/// once: unmatched delimiters must not repeatedly scan the tail.
fn code_spans(text: &str, tokens: &[Token]) -> Vec<Option<usize>> {
    let bytes = text.as_bytes();
    let mut pairs = vec![None; tokens.len()];
    // by run length, the nearest run after this one on the same line
    let mut closes: Vec<(usize, usize)> = Vec::new();
    for (i, token) in tokens.iter().enumerate().rev() {
        let size = match token.kind {
            Kind::Ticks(size) => size,
            Kind::Line(_) => {
                closes.clear();
                continue;
            }
            _ => continue,
        };
        let backslashes = bytes[..token.index]
            .iter()
            .rev()
            .take_while(|byte| **byte == b'\\')
            .count();
        let length = size - backslashes % 2;
        if length > 0 {
            pairs[i] = closes
                .iter()
                .find(|(run, _)| *run == length)
                .map(|(_, at)| *at);
        }
        // Inside a code span a backslash does not escape its closing backticks.
        match closes.iter_mut().find(|(run, _)| *run == size) {
            Some(close) => close.1 = i,
            None => closes.push((size, i)),
        }
    }
    pairs
}

/// `text` without its memory citations, except those inside Markdown code, its end trimmed.
pub(crate) fn without_memory_citations(text: &str) -> String {
    if !text.contains(OPENING) {
        return js::trim_end(text).to_owned();
    }
    let tokens = tokens(text);
    let pairs = code_spans(text, &tokens);
    let mut out = String::new();
    let mut list_indents: Vec<usize> = Vec::new();
    let mut quote_depth = 0;
    let mut kept = 0;
    let mut i = 0;
    while i < tokens.len() {
        let token = &tokens[i];
        match &token.kind {
            Kind::Line(line) => {
                if line.quote_depth != quote_depth {
                    list_indents.clear();
                    quote_depth = line.quote_depth;
                }
                if !line.blank {
                    while list_indents.last().is_some_and(|last| *last > line.indent) {
                        list_indents.pop();
                    }
                    if let Some(list_indent) = line.list_indent {
                        list_indents.push(list_indent);
                    }
                }
            }
            Kind::Fence { marker, line, .. } => {
                let within = line
                    .list_indent
                    .or_else(|| list_indents.last().copied())
                    .unwrap_or(0);
                let indent = match line.list_indent {
                    None => line.indent as isize - within as isize,
                    Some(_) => 0,
                };
                if (0..=3).contains(&indent) {
                    i = fence_end(&tokens, i, marker, line, within);
                }
            }
            Kind::Ticks(_) | Kind::Citation => {
                if let Some(pair) = pairs[i] {
                    i = pair;
                } else if matches!(token.kind, Kind::Citation) {
                    if token.index > kept {
                        out.push_str(&text[kept..token.index]);
                    }
                    kept = text[token.index + OPENING.len()..]
                        .find(CLOSING)
                        .map_or(text.len(), |at| {
                            token.index + OPENING.len() + at + CLOSING.len()
                        });
                    // Metadata contents cannot open code spans or fences in the surrounding answer.
                    while tokens.get(i + 1).is_some_and(|next| next.index < kept) {
                        i += 1;
                    }
                }
            }
        }
        i += 1;
    }
    if kept < text.len() {
        out.push_str(&text[kept..]);
    }
    js::trim_end(&out).to_owned()
}

/// The last token of the fenced block opened at `open`: its closing line's last token, the token
/// before the line that ends its container, or the last token of all. An unfinished fence remains
/// code until its quote/list container ends.
fn fence_end(tokens: &[Token], open: usize, marker: &str, line: &Line, within: usize) -> usize {
    let mut i = open + 1;
    while i < tokens.len() {
        match &tokens[i].kind {
            Kind::Line(end)
                if end.quote_depth < line.quote_depth
                    || (within > 0
                        && end.quote_depth == line.quote_depth
                        && !end.blank
                        && end.indent < within) =>
            {
                return i - 1;
            }
            Kind::Fence {
                marker: closing,
                info,
                line: end,
            } if end.quote_depth == line.quote_depth
                && closing.as_bytes()[0] == marker.as_bytes()[0]
                && closing.len() >= marker.len()
                && info.bytes().all(|byte| byte == b' ' || byte == b'\t') =>
            {
                // Skip the closing line's raw backtick/citation tokens too.
                while tokens
                    .get(i + 1)
                    .is_some_and(|next| !matches!(next.kind, Kind::Line(_)))
                {
                    i += 1;
                }
                return i;
            }
            _ => {}
        }
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values: the TypeScript `parseCodexTranscript` of an agent_message holding each text
    // (Bun 1.4.4), which runs `withoutMemoryCitations`.
    #[test]
    fn drops_citations_outside_code() {
        assert_eq!(
            without_memory_citations("Done.<oai-mem-citation>a</oai-mem-citation>\n"),
            "Done."
        );
        assert_eq!(
            without_memory_citations("Use `<oai-mem-citation>x</oai-mem-citation>` here"),
            "Use `<oai-mem-citation>x</oai-mem-citation>` here"
        );
        assert_eq!(
            without_memory_citations("```\n<oai-mem-citation>x</oai-mem-citation>\n```\nok"),
            "```\n<oai-mem-citation>x</oai-mem-citation>\n```\nok"
        );
        assert_eq!(
            without_memory_citations("a <oai-mem-citation>unclosed"),
            "a"
        );
    }

    #[test]
    fn splits_lines_as_the_global_match_does() {
        let starts = |text: &str| {
            lines(text)
                .into_iter()
                .map(|(at, _)| at)
                .collect::<Vec<_>>()
        };
        assert_eq!(starts(""), [0]);
        assert_eq!(starts("a\nb"), [0, 2, 3]);
        assert_eq!(starts("a\n"), [0, 2]);
        assert_eq!(starts("a\r\nb\rc"), [0, 3, 5, 6]);
    }
}
