//! libghostty-vt through its C API (`include/ghostty/vt/*.h` at the pinned
//! commit), with hand-written declarations for the few calls used here.

use std::ffi::{c_int, c_void};
use std::ptr;

use crate::Wraps;

type GhosttyResult = c_int;
const GHOSTTY_SUCCESS: GhosttyResult = 0;
/// `GHOSTTY_FORMATTER_FORMAT_PLAIN` in `GhosttyFormatterFormat` (an `int`-sized enum).
const GHOSTTY_FORMATTER_FORMAT_PLAIN: c_int = 0;

#[repr(C)]
struct TerminalImpl {
    _private: [u8; 0],
}
#[repr(C)]
struct FormatterImpl {
    _private: [u8; 0],
}
type GhosttyTerminal = *mut TerminalImpl;
type GhosttyFormatter = *mut FormatterImpl;

/// `GhosttyFormatterScreenExtra` (formatter.h).
#[repr(C)]
struct ScreenExtra {
    size: usize,
    cursor: bool,
    style: bool,
    hyperlink: bool,
    protection: bool,
    kitty_keyboard: bool,
    charsets: bool,
}

/// `GhosttyFormatterTerminalExtra` (formatter.h).
#[repr(C)]
struct TerminalExtra {
    size: usize,
    palette: bool,
    modes: bool,
    scrolling_region: bool,
    tabstops: bool,
    pwd: bool,
    keyboard: bool,
    screen: ScreenExtra,
}

/// `GhosttyFormatterTerminalOptions` (formatter.h).
#[repr(C)]
struct TerminalOptions {
    size: usize,
    emit: c_int,
    unwrap: bool,
    trim: bool,
    extra: TerminalExtra,
    /// `const GhosttySelection *`; null formats the whole screen.
    selection: *const c_void,
}

unsafe extern "C" {
    fn ghostty_terminal_new(
        allocator: *const c_void,
        terminal: *mut GhosttyTerminal,
        cols: u16,
        rows: u16,
    ) -> GhosttyResult;
    fn ghostty_terminal_free(terminal: GhosttyTerminal);
    fn ghostty_terminal_vt_write(terminal: GhosttyTerminal, data: *const u8, len: usize);
    fn ghostty_formatter_terminal_new(
        allocator: *const c_void,
        formatter: *mut GhosttyFormatter,
        terminal: GhosttyTerminal,
        options: TerminalOptions,
    ) -> GhosttyResult;
    fn ghostty_formatter_format_alloc(
        formatter: GhosttyFormatter,
        allocator: *const c_void,
        out_ptr: *mut *mut u8,
        out_len: *mut usize,
    ) -> GhosttyResult;
    fn ghostty_formatter_free(formatter: GhosttyFormatter);
    fn ghostty_free(allocator: *const c_void, ptr: *mut u8, len: usize);
    #[cfg(test)]
    fn ghostty_type_json() -> *const std::ffi::c_char;
}

/// Owns a `GhosttyTerminal` and frees it on drop.
struct Terminal(GhosttyTerminal);

impl Drop for Terminal {
    fn drop(&mut self) {
        // SAFETY: self.0 came from ghostty_terminal_new and is freed once.
        unsafe { ghostty_terminal_free(self.0) }
    }
}

/// Owns a `GhosttyFormatter` and frees it on drop.
struct Formatter(GhosttyFormatter);

impl Drop for Formatter {
    fn drop(&mut self) {
        // SAFETY: self.0 came from ghostty_formatter_terminal_new and is freed once.
        unsafe { ghostty_formatter_free(self.0) }
    }
}

/// Feeds `bytes` to a new `cols` x `rows` libghostty-vt terminal and returns
/// its screen text with the options Ghostty's `write_screen_file:…,plain`
/// uses (`trim = false`, the whole screen, no extras, and `unwrap = true`
/// for [`Wraps::Join`]).
pub fn screen_text(cols: u16, rows: u16, bytes: &[u8], wraps: Wraps) -> Vec<u8> {
    let mut raw: GhosttyTerminal = ptr::null_mut();
    // SAFETY: a null allocator selects the default one; raw is a valid out pointer.
    let rc = unsafe { ghostty_terminal_new(ptr::null(), &mut raw, cols, rows) };
    assert_eq!(rc, GHOSTTY_SUCCESS, "ghostty_terminal_new");
    let terminal = Terminal(raw);

    // SAFETY: terminal.0 is live; bytes is valid for bytes.len() bytes.
    unsafe { ghostty_terminal_vt_write(terminal.0, bytes.as_ptr(), bytes.len()) };

    let options = TerminalOptions {
        size: size_of::<TerminalOptions>(),
        emit: GHOSTTY_FORMATTER_FORMAT_PLAIN,
        unwrap: wraps == Wraps::Join,
        trim: false,
        extra: TerminalExtra {
            size: size_of::<TerminalExtra>(),
            palette: false,
            modes: false,
            scrolling_region: false,
            tabstops: false,
            pwd: false,
            keyboard: false,
            screen: ScreenExtra {
                size: size_of::<ScreenExtra>(),
                cursor: false,
                style: false,
                hyperlink: false,
                protection: false,
                kitty_keyboard: false,
                charsets: false,
            },
        },
        selection: ptr::null(),
    };
    let mut raw: GhosttyFormatter = ptr::null_mut();
    // SAFETY: terminal.0 is live and outlives the formatter (dropped first below).
    let rc = unsafe { ghostty_formatter_terminal_new(ptr::null(), &mut raw, terminal.0, options) };
    assert_eq!(rc, GHOSTTY_SUCCESS, "ghostty_formatter_terminal_new");
    let formatter = Formatter(raw);

    let mut out: *mut u8 = ptr::null_mut();
    let mut len = 0usize;
    // SAFETY: formatter.0 is live; out and len are valid out pointers.
    let rc =
        unsafe { ghostty_formatter_format_alloc(formatter.0, ptr::null(), &mut out, &mut len) };
    assert_eq!(rc, GHOSTTY_SUCCESS, "ghostty_formatter_format_alloc");
    let text = if out.is_null() {
        Vec::new()
    } else {
        // SAFETY: the library returned len initialized bytes at out.
        let text = unsafe { std::slice::from_raw_parts(out, len) }.to_vec();
        // SAFETY: out and len came from ghostty_formatter_format_alloc with the default allocator.
        unsafe { ghostty_free(ptr::null(), out, len) };
        text
    };
    drop(formatter);
    drop(terminal);
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::offset_of;

    /// The library describes its own C types (`ghostty_type_json`); every
    /// hand-written struct must have the same size and field offsets.
    #[test]
    fn structs_match_the_library_manifest() {
        // SAFETY: returns a static, null-terminated JSON string.
        let json = unsafe { std::ffi::CStr::from_ptr(ghostty_type_json()) };
        let manifest: serde_json::Value = serde_json::from_slice(json.to_bytes()).unwrap();
        let check = |name: &str, size: usize, fields: &[(&str, usize)]| {
            let ty = &manifest["types"][name];
            assert_eq!(ty["size"], size, "{name} size");
            let declared = ty["fields"].as_object().unwrap();
            assert_eq!(declared.len(), fields.len(), "{name} field count");
            for (field, offset) in fields {
                assert_eq!(declared[*field]["offset"], *offset, "{name}.{field} offset");
            }
        };
        check(
            "GhosttyFormatterScreenExtra",
            size_of::<ScreenExtra>(),
            &[
                ("size", offset_of!(ScreenExtra, size)),
                ("cursor", offset_of!(ScreenExtra, cursor)),
                ("style", offset_of!(ScreenExtra, style)),
                ("hyperlink", offset_of!(ScreenExtra, hyperlink)),
                ("protection", offset_of!(ScreenExtra, protection)),
                ("kitty_keyboard", offset_of!(ScreenExtra, kitty_keyboard)),
                ("charsets", offset_of!(ScreenExtra, charsets)),
            ],
        );
        check(
            "GhosttyFormatterTerminalExtra",
            size_of::<TerminalExtra>(),
            &[
                ("size", offset_of!(TerminalExtra, size)),
                ("palette", offset_of!(TerminalExtra, palette)),
                ("modes", offset_of!(TerminalExtra, modes)),
                (
                    "scrolling_region",
                    offset_of!(TerminalExtra, scrolling_region),
                ),
                ("tabstops", offset_of!(TerminalExtra, tabstops)),
                ("pwd", offset_of!(TerminalExtra, pwd)),
                ("keyboard", offset_of!(TerminalExtra, keyboard)),
                ("screen", offset_of!(TerminalExtra, screen)),
            ],
        );
        check(
            "GhosttyFormatterTerminalOptions",
            size_of::<TerminalOptions>(),
            &[
                ("size", offset_of!(TerminalOptions, size)),
                ("emit", offset_of!(TerminalOptions, emit)),
                ("unwrap", offset_of!(TerminalOptions, unwrap)),
                ("trim", offset_of!(TerminalOptions, trim)),
                ("extra", offset_of!(TerminalOptions, extra)),
                ("selection", offset_of!(TerminalOptions, selection)),
            ],
        );
        let format = &manifest["types"]["GhosttyFormatterFormat"];
        assert_eq!(format["size"], size_of::<c_int>());
        assert_eq!(format["values"]["PLAIN"], GHOSTTY_FORMATTER_FORMAT_PLAIN);
    }

    #[test]
    fn formats_plain_text() {
        let text = screen_text(10, 3, b"hello\r\n\x1b[1mworld\x1b[0m", Wraps::Join);
        assert_eq!(text, b"hello\nworld");
    }

    #[test]
    fn keeps_or_joins_wrapped_rows() {
        assert_eq!(screen_text(4, 3, b"abcdef", Wraps::Join), b"abcdef");
        assert_eq!(screen_text(4, 3, b"abcdef", Wraps::Keep), b"abcd\nef");
    }
}
