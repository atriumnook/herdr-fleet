//! A tool call's output as a page carries it (`server/tool-output.ts`).

use protocol::ToolPart;
use protocol::js::{cut_utf16, utf16_len};

/// Past this a tool's output is cut in the page; the rest is fetched on request (`tool_output`).
const TOOL_OUTPUT_CHARS: usize = 4000;

/// Codex's goal calls answer with the goal as JSON the chat reads, its objective alone up to 4000
/// characters: cut at the usual length, a finished goal's answer lost its status.
const WHOLE_OUTPUT_TOOLS: [&str; 3] = ["create_goal", "update_goal", "get_goal"];
const WHOLE_OUTPUT_CHARS: usize = 16_000;

/// Sets a tool part's output, cut to what a page carries, keeping what it takes to fetch the rest.
/// Lengths are in UTF-16 code units, as `output_size` is.
pub(crate) fn trim_output(tool: &mut ToolPart, output: &str, reference: &str) {
    let limit = if WHOLE_OUTPUT_TOOLS.contains(&tool.name.as_str()) {
        WHOLE_OUTPUT_CHARS
    } else {
        TOOL_OUTPUT_CHARS
    };
    let size = utf16_len(output);
    if size <= limit {
        tool.output = output.to_owned();
        return;
    }
    tool.output = format!("{}\n… trimmed", cut_utf16(output, limit));
    tool.output_ref = Some(reference.to_owned());
    tool.output_size = Some(size as u64);
}
