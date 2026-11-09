//! NDJSON framing: herdr writes one JSON value per line, and a line can arrive split across
//! reads, so the tail of a read waits for the next one (`makeLineReader` in
//! `server/herdr/client.ts`).

/// Splits a growing buffer into complete newline-terminated lines.
#[derive(Debug, Default)]
pub(crate) struct LineReader {
    buffer: Vec<u8>,
    /// How far `buffer` is known to hold no newline: a long line arriving in many reads is
    /// searched once, not from its start on every read.
    scanned: usize,
}

impl LineReader {
    /// Adds `chunk` and returns every line it completed, trimmed, without the empty ones.
    ///
    /// Bytes are kept until their line is complete, so a character split across two reads is
    /// decoded whole; invalid UTF-8 becomes U+FFFD, as `TextDecoder` does.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut start = 0;
        while let Some(offset) = self.buffer[self.scanned..].iter().position(|&b| b == b'\n') {
            let end = self.scanned + offset;
            let text = String::from_utf8_lossy(&self.buffer[start..end]);
            // JavaScript's trim also takes the byte order mark
            let text = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
            if !text.is_empty() {
                lines.push(text.to_owned());
            }
            start = end + 1;
            self.scanned = start;
        }
        self.buffer.drain(..start);
        self.scanned = self.buffer.len();
        lines
    }
}
