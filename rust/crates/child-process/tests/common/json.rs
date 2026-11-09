//! A JSON reader for the security tables (`fixtures/security/child-process/*.json`).
//!
//! child-process has no JSON dependency (ADR 0244-phase-3-dependencies), and its manifest is not
//! this issue's to change (ADR 0242-phase-3-split, "Issue の分け方"); the tables hold only objects,
//! arrays and strings. This reads all of JSON (RFC 8259) but keeps a number as its text: no table
//! compares one.

use std::iter::Peekable;
use std::str::Chars;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// the number as written
    Number(String),
    String(String),
    Array(Vec<Json>),
    /// the fields in the order written
    Object(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, name: &str) -> Option<&Json> {
        match self {
            Json::Object(fields) => fields.iter().find(|(key, _)| key == name).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, Json)]> {
        match self {
            Json::Object(fields) => Some(fields),
            _ => None,
        }
    }
}

/// The value `text` holds, or what is wrong with it.
pub fn parse(text: &str) -> Result<Json, String> {
    let mut chars = text.chars().peekable();
    let value = value(&mut chars)?;
    skip_space(&mut chars);
    match chars.next() {
        None => Ok(value),
        Some(c) => Err(format!("unexpected {c:?} after the value")),
    }
}

fn skip_space(chars: &mut Peekable<Chars<'_>>) {
    while chars
        .next_if(|c| matches!(c, ' ' | '\t' | '\n' | '\r'))
        .is_some()
    {}
}

fn expect(chars: &mut Peekable<Chars<'_>>, word: &str) -> Result<(), String> {
    for wanted in word.chars() {
        if chars.next() != Some(wanted) {
            return Err(format!("expected {word:?}"));
        }
    }
    Ok(())
}

fn value(chars: &mut Peekable<Chars<'_>>) -> Result<Json, String> {
    skip_space(chars);
    match chars.peek().copied() {
        Some('{') => {
            chars.next();
            let mut fields = Vec::new();
            skip_space(chars);
            if chars.next_if_eq(&'}').is_some() {
                return Ok(Json::Object(fields));
            }
            loop {
                skip_space(chars);
                if chars.next() != Some('"') {
                    return Err("expected a field name".into());
                }
                let name = string(chars)?;
                skip_space(chars);
                if chars.next() != Some(':') {
                    return Err("expected ':'".into());
                }
                fields.push((name, value(chars)?));
                skip_space(chars);
                match chars.next() {
                    Some(',') => {}
                    Some('}') => return Ok(Json::Object(fields)),
                    _ => return Err("expected ',' or '}'".into()),
                }
            }
        }
        Some('[') => {
            chars.next();
            let mut items = Vec::new();
            skip_space(chars);
            if chars.next_if_eq(&']').is_some() {
                return Ok(Json::Array(items));
            }
            loop {
                items.push(value(chars)?);
                skip_space(chars);
                match chars.next() {
                    Some(',') => {}
                    Some(']') => return Ok(Json::Array(items)),
                    _ => return Err("expected ',' or ']'".into()),
                }
            }
        }
        Some('"') => {
            chars.next();
            string(chars).map(Json::String)
        }
        Some('t') => expect(chars, "true").map(|()| Json::Bool(true)),
        Some('f') => expect(chars, "false").map(|()| Json::Bool(false)),
        Some('n') => expect(chars, "null").map(|()| Json::Null),
        Some(c) if c == '-' || c.is_ascii_digit() => {
            let mut number = String::new();
            while let Some(c) =
                chars.next_if(|c| matches!(c, '0'..='9' | '-' | '+' | '.' | 'e' | 'E'))
            {
                number.push(c);
            }
            Ok(Json::Number(number))
        }
        other => Err(format!("unexpected {other:?}")),
    }
}

/// A string's text after its opening quote, through its closing one.
fn string(chars: &mut Peekable<Chars<'_>>) -> Result<String, String> {
    let mut text = String::new();
    loop {
        match chars.next() {
            None => return Err("unterminated string".into()),
            Some('"') => return Ok(text),
            Some('\\') => match chars.next() {
                Some('"') => text.push('"'),
                Some('\\') => text.push('\\'),
                Some('/') => text.push('/'),
                Some('b') => text.push('\u{8}'),
                Some('f') => text.push('\u{c}'),
                Some('n') => text.push('\n'),
                Some('r') => text.push('\r'),
                Some('t') => text.push('\t'),
                Some('u') => {
                    let first = hex4(chars)?;
                    let code = if (0xd800..0xdc00).contains(&first) {
                        expect(chars, "\\u")?;
                        let second = hex4(chars)?;
                        if !(0xdc00..0xe000).contains(&second) {
                            return Err("a high surrogate without its low one".into());
                        }
                        0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00)
                    } else {
                        first
                    };
                    text.push(char::from_u32(code).ok_or("a lone low surrogate")?);
                }
                other => return Err(format!("unknown escape {other:?}")),
            },
            Some(c) if c < ' ' => return Err("a control character in a string".into()),
            Some(c) => text.push(c),
        }
    }
}

fn hex4(chars: &mut Peekable<Chars<'_>>) -> Result<u32, String> {
    let mut code = 0;
    for _ in 0..4 {
        let digit = chars
            .next()
            .and_then(|c| c.to_digit(16))
            .ok_or("expected 4 hex digits")?;
        code = code * 16 + digit;
    }
    Ok(code)
}
