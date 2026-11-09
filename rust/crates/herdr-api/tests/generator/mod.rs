//! The generator of `src/generated.rs`: Rust types for the whole of herdr's socket API schema
//! (`scripts/herdr-schema.json`). How each shape maps, and why:
//! docs/rust-migration/adr/0245-herdr-api-generation.md.
//!
//! - A definition name that repeats across the schema's sections is one type when every
//!   definition of it has the same shape, counting two `$ref`s as the same when they point at
//!   types of the same shape; otherwise each one is prefixed with its section, as
//!   `scripts/generate-protocol-types.ts` does.
//! - A string enum keeps a value it does not name (`open_enum!`); a `oneOf` told apart by a
//!   constant property keeps a shape it does not name (`tagged_union!`).
//! - A shape this generator cannot map becomes `serde_json::Value`, and the file's header lists it.
//! - The output is deterministic: types, properties, enum values and tags are sorted.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use serde_json::{Map, Value};

/// The prefix of a colliding name per section, as in `scripts/generate-protocol-types.ts`.
const SECTION_PREFIXES: [(&str, &str); 5] = [
    ("request", "Request"),
    ("success_response", "Response"),
    ("event", "Event"),
    ("subscription_event", "SubscriptionEvent"),
    ("error_response", "Error"),
];

/// The keywords that compose schemas; a node that uses one is not mapped.
const COMPOSITION: [&str; 10] = [
    "allOf",
    "not",
    "if",
    "then",
    "else",
    "dependentSchemas",
    "patternProperties",
    "prefixItems",
    "unevaluatedProperties",
    "$dynamicRef",
];

const KEYWORDS: [&str; 52] = [
    "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for",
    "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return",
    "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where",
    "while", "async", "await", "dyn", "abstract", "become", "box", "do", "final", "macro",
    "override", "priv", "typeof", "unsized", "virtual", "yield", "try", "gen",
];

/// Writes `generated` from `schema`, or, unless `update`, fails when it is not what the generator
/// makes.
pub fn check(schema: &Path, generated: &Path, update: bool) -> Result<(), String> {
    let text =
        fs::read_to_string(schema).map_err(|error| format!("{}: {error}", schema.display()))?;
    let schema_value: Value =
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", schema.display()))?;
    let expected = generate(&schema_value);
    if update {
        return fs::write(generated, expected)
            .map_err(|error| format!("{}: {error}", generated.display()));
    }
    let current = fs::read_to_string(generated).unwrap_or_default();
    if current == expected {
        return Ok(());
    }
    Err(format!(
        "{} is STALE relative to {}.\nRun: HERDR_API_UPDATE=1 cargo test -p herdr-fleet-herdr-api --test generated",
        generated.display(),
        schema.display(),
    ))
}

pub fn generate(schema: &Value) -> String {
    let mut generator = Generator::new(schema);
    generator.definitions();
    let methods = generator.methods();
    generator.box_cycles();
    generator.render(&methods)
}

#[derive(Clone, Debug, PartialEq)]
enum Ty {
    Named(String),
    Str,
    Bool,
    Int(&'static str),
    Float,
    Vec(Box<Ty>),
    Map(Box<Ty>),
    Option(Box<Ty>),
    Boxed(Box<Ty>),
    Value,
}

struct Field {
    json: String,
    ty: Ty,
    required: bool,
    doc: Option<String>,
}

enum Body {
    Struct(Vec<Field>),
    OpenEnum(Vec<String>),
    Tagged {
        key: String,
        units: Vec<(String, String)>,
        payloads: Vec<(String, String, String)>,
    },
    Untagged(Vec<(String, Ty, Option<String>)>),
    Alias(Ty),
}

struct Item {
    doc: Option<String>,
    body: Body,
}

struct Generator<'a> {
    schema: &'a Value,
    /// `section/definition` to its Rust name.
    names: HashMap<String, String>,
    items: BTreeMap<String, Item>,
    /// The fields and types mapped to `Value`, with why.
    values: BTreeSet<String>,
}

impl<'a> Generator<'a> {
    fn new(schema: &'a Value) -> Self {
        Self {
            schema,
            names: HashMap::new(),
            items: BTreeMap::new(),
            values: BTreeSet::new(),
        }
    }

    fn sections(&self) -> Vec<(&'a str, &'a Value)> {
        let mut sections: Vec<_> = self.schema["schemas"]
            .as_object()
            .map(|sections| {
                sections
                    .iter()
                    .map(|(name, section)| (name.as_str(), section))
                    .collect()
            })
            .unwrap_or_default();
        sections.sort_by_key(|(name, _)| *name);
        sections
    }

    /// Every definition of every section, and the envelope of each section that is an object
    /// (responses, errors and events) under its title, sorted by section, then name.
    fn all_definitions(&self) -> Vec<(String, String, Value)> {
        let mut found = Vec::new();
        for (section, body) in self.sections() {
            if let Some(defs) = body["$defs"].as_object() {
                for (name, def) in defs {
                    found.push((section.to_owned(), name.clone(), def.clone()));
                }
            }
            if let (Some(title), Some(object)) = (body["title"].as_str(), body.as_object())
                && object.contains_key("properties")
                && !object.contains_key("oneOf")
            {
                let mut root = object.clone();
                for meta in ["$defs", "$schema", "title"] {
                    root.remove(meta);
                }
                found.push((section.to_owned(), title.to_owned(), Value::Object(root)));
            }
        }
        found.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
        let mut seen = BTreeSet::new();
        for (section, name, _) in &found {
            assert!(
                seen.insert((section, name)),
                "{section} defines {name} twice"
            );
        }
        found
    }

    fn definitions(&mut self) {
        let definitions = self.all_definitions();
        self.names = resolve_names(&definitions);
        for (section, name, def) in &definitions {
            let rust = self.names[&key(section, name)].clone();
            if self.items.contains_key(&rust) {
                // the same shape in another section
                continue;
            }
            self.item(&rust, def);
        }
    }

    /// The methods of the request section: (marker, method, params type).
    fn methods(&mut self) -> Vec<(String, String, String)> {
        let mut methods = Vec::new();
        for (section, body) in self.sections() {
            let Some(variants) = body["oneOf"].as_array() else {
                continue;
            };
            if body["properties"].get("id").is_none() {
                continue;
            }
            for variant in variants {
                let name = variant["properties"]["method"]["const"].as_str();
                let params = &variant["properties"]["params"];
                let (Some(name), Some(reference)) = (name, params["$ref"].as_str()) else {
                    panic!(
                        "a request of {section} without a method name or a params $ref: {variant}"
                    );
                };
                let params = self.reference(reference);
                methods.push((pascal(name), name.to_owned(), params));
            }
        }
        methods.sort_by(|a, b| a.1.cmp(&b.1));
        let markers: BTreeSet<_> = methods.iter().map(|method| &method.0).collect();
        assert_eq!(
            markers.len(),
            methods.len(),
            "two methods have the same marker name"
        );
        methods
    }

    fn reference(&self, reference: &str) -> String {
        let (section, name) = parse_ref(reference);
        self.names
            .get(&key(section, name))
            .unwrap_or_else(|| panic!("unresolved $ref {reference}"))
            .clone()
    }

    fn insert(&mut self, name: &str, item: Item) {
        let previous = self.items.insert(name.to_owned(), item);
        assert!(previous.is_none(), "two types are named {name}");
    }

    fn item(&mut self, name: &str, def: &Value) {
        let doc = description(def);
        let body = self.body(name, def);
        self.insert(name, Item { doc, body });
    }

    fn body(&mut self, name: &str, def: &Value) -> Body {
        if composes(def) {
            return self.alias_value(name, "it composes schemas");
        }
        if let Some(values) = def["enum"].as_array() {
            return self.open_enum(name, values);
        }
        if let Some(variants) = union_variants(def)
            && nullable_pair(variants).is_none()
        {
            return self.union(name, variants);
        }
        if is_object(def) && def.get("additionalProperties").is_none() {
            return Body::Struct(self.fields(name, def, None));
        }
        Body::Alias(self.ty(def, name))
    }

    fn alias_value(&mut self, path: &str, why: &str) -> Body {
        self.values.insert(format!("`{path}`: {why}"));
        Body::Alias(Ty::Value)
    }

    fn open_enum(&mut self, name: &str, values: &[Value]) -> Body {
        let mut strings: Vec<String> = Vec::new();
        for value in values {
            let Some(text) = value.as_str() else {
                return self.alias_value(name, "an enum of values that are not strings");
            };
            strings.push(text.to_owned());
        }
        strings.sort();
        strings.dedup();
        let mut idents: Vec<String> = strings.iter().map(|value| pascal(value)).collect();
        idents.push("Other".to_owned());
        if !unique(&idents) {
            return self.alias_value(name, "two enum values have the same Rust name");
        }
        Body::OpenEnum(strings)
    }

    fn union(&mut self, name: &str, variants: &[Value]) -> Body {
        if let Some(key) = discriminator(variants) {
            return self.tagged(name, variants, &key);
        }
        let mut out = Vec::new();
        for (index, variant) in variants.iter().enumerate() {
            let doc = description(variant);
            if let Some(reference) = variant["$ref"].as_str() {
                let target = self.reference(reference);
                out.push((target.clone(), Ty::Named(target), doc));
            } else if is_object(variant) && variant.get("properties").is_some() {
                let fields: Vec<&str> = sorted_keys(&variant["properties"]);
                let ident = fields.iter().map(|field| pascal(field)).collect::<String>();
                let payload = format!("{name}{ident}");
                let body = Body::Struct(self.fields(&payload, variant, None));
                self.insert(
                    &payload,
                    Item {
                        doc: Some(format!("A shape of [`{name}`].")),
                        body,
                    },
                );
                out.push((ident, Ty::Named(payload), doc));
            } else {
                let ty = self.ty(variant, &format!("{name}[{index}]"));
                out.push((variant_name(&ty), ty, doc));
            }
        }
        let idents: Vec<String> = out.iter().map(|variant| variant.0.clone()).collect();
        if !unique(&idents) {
            return self.alias_value(name, "two variants of a union have the same Rust name");
        }
        Body::Untagged(out)
    }

    fn tagged(&mut self, name: &str, variants: &[Value], key: &str) -> Body {
        let mut units = Vec::new();
        let mut payloads = Vec::new();
        for variant in variants {
            let tag = variant["properties"][key]["const"]
                .as_str()
                .unwrap()
                .to_owned();
            let ident = pascal(&tag);
            let others = variant["properties"].as_object().unwrap().len() > 1;
            if others {
                let payload = format!("{name}{ident}");
                let fields = self.fields(&payload, variant, Some(key));
                let doc = Some(format!("The fields of [`{name}::{ident}`]."));
                self.insert(
                    &payload,
                    Item {
                        doc,
                        body: Body::Struct(fields),
                    },
                );
                payloads.push((ident, payload, tag));
            } else {
                units.push((ident, tag));
            }
        }
        units.sort_by(|a, b| a.1.cmp(&b.1));
        payloads.sort_by(|a, b| a.2.cmp(&b.2));
        let mut idents: Vec<String> = units.iter().map(|unit| unit.0.clone()).collect();
        idents.extend(payloads.iter().map(|payload| payload.0.clone()));
        idents.push("Other".to_owned());
        assert!(
            unique(&idents),
            "two tags of {name} have the same Rust name"
        );
        Body::Tagged {
            key: key.to_owned(),
            units,
            payloads,
        }
    }

    fn fields(&mut self, owner: &str, def: &Value, skip: Option<&str>) -> Vec<Field> {
        let required: BTreeSet<&str> = def["required"]
            .as_array()
            .map(|names| names.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let mut fields = Vec::new();
        for json in sorted_keys(&def["properties"]) {
            if Some(json) == skip {
                continue;
            }
            let property = &def["properties"][json];
            fields.push(Field {
                json: json.to_owned(),
                ty: self.ty(property, &format!("{owner}.{json}")),
                required: required.contains(json),
                doc: description(property),
            });
        }
        let idents: Vec<String> = fields
            .iter()
            .map(|field| field_ident(&field.json).0)
            .collect();
        assert!(
            unique(&idents),
            "two fields of {owner} have the same Rust name"
        );
        fields
    }

    /// The type of a schema node that is not a definition of its own.
    fn ty(&mut self, node: &Value, path: &str) -> Ty {
        if node == &Value::Bool(true) {
            self.values
                .insert(format!("`{path}`: the schema allows any value"));
            return Ty::Value;
        }
        if composes(node) {
            return self.value(path, "it composes schemas");
        }
        if let Some(reference) = node["$ref"].as_str() {
            return Ty::Named(self.reference(reference));
        }
        if let Some(variants) = union_variants(node) {
            return match nullable_pair(variants) {
                Some(inner) => Ty::Option(Box::new(self.ty(inner, path))),
                None => self.value(path, "a union that is not a definition of its own"),
            };
        }
        if node.get("enum").is_some() {
            return self.value(path, "an enum that is not a definition of its own");
        }
        if node["const"].is_string() {
            return Ty::Str;
        }
        let types: Vec<&str> = match &node["type"] {
            Value::String(kind) => vec![kind.as_str()],
            Value::Array(kinds) => kinds.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        let nullable = types.contains(&"null");
        let primary: Vec<&str> = types.into_iter().filter(|kind| *kind != "null").collect();
        let [kind] = primary.as_slice() else {
            return self.value(path, "it has no single type");
        };
        let ty = match *kind {
            "string" => Ty::Str,
            "boolean" => Ty::Bool,
            "number" => Ty::Float,
            "integer" => match integer(node["format"].as_str()) {
                Some(int) => Ty::Int(int),
                None => return self.value(path, "an integer of an unknown format"),
            },
            "array" => {
                let items = node.get("items").unwrap_or(&Value::Bool(true));
                Ty::Vec(Box::new(self.ty(items, &format!("{path}[]"))))
            }
            "object" if node.get("properties").is_some() => {
                return self.value(path, "an object that is not a definition of its own");
            }
            "object" => {
                let values = node
                    .get("additionalProperties")
                    .unwrap_or(&Value::Bool(true));
                if values == &Value::Bool(false) {
                    return self.value(path, "an object without properties");
                }
                Ty::Map(Box::new(self.ty(values, &format!("{path}{{}}"))))
            }
            _ => return self.value(path, "an unknown type"),
        };
        if nullable {
            Ty::Option(Box::new(ty))
        } else {
            ty
        }
    }

    fn value(&mut self, path: &str, why: &str) -> Ty {
        self.values.insert(format!("`{path}`: {why}"));
        Ty::Value
    }

    /// Boxes a field that holds, directly or through `Option`, a type that holds the field's own
    /// type again.
    fn box_cycles(&mut self) {
        let mut edges: HashMap<String, Vec<String>> = HashMap::new();
        for (name, item) in &self.items {
            let mut targets = Vec::new();
            match &item.body {
                Body::Struct(fields) => {
                    targets.extend(fields.iter().filter_map(|field| direct(&field.ty)));
                }
                Body::Tagged { payloads, .. } => {
                    targets.extend(payloads.iter().map(|payload| payload.1.clone()));
                }
                Body::Untagged(variants) => {
                    targets.extend(variants.iter().filter_map(|variant| direct(&variant.1)));
                }
                Body::Alias(ty) => targets.extend(direct(ty)),
                Body::OpenEnum(_) => {}
            }
            edges.insert(name.clone(), targets);
        }
        let reaches = |from: &str, to: &str| -> bool {
            let mut seen = BTreeSet::new();
            let mut stack = vec![from.to_owned()];
            while let Some(next) = stack.pop() {
                if next == to {
                    return true;
                }
                if seen.insert(next.clone()) {
                    stack.extend(edges.get(&next).into_iter().flatten().cloned());
                }
            }
            false
        };
        let mut boxed: Vec<(String, usize)> = Vec::new();
        for (name, item) in &self.items {
            if let Body::Struct(fields) = &item.body {
                for (index, field) in fields.iter().enumerate() {
                    if let Some(target) = direct(&field.ty)
                        && reaches(&target, name)
                    {
                        boxed.push((name.clone(), index));
                    }
                }
            }
        }
        for (name, index) in boxed {
            if let Some(Item {
                body: Body::Struct(fields),
                ..
            }) = self.items.get_mut(&name)
            {
                let ty = &mut fields[index].ty;
                *ty = boxed_ty(ty.clone());
            }
        }
    }

    fn render(&self, methods: &[(String, String, String)]) -> String {
        let mut out = String::new();
        let protocol = &self.schema["protocol"];
        let version = &self.schema["schema_version"];
        out.push_str("//! GENERATED FILE - DO NOT EDIT.\n//!\n");
        let _ = writeln!(
            out,
            "//! Source: herdr API schema `scripts/herdr-schema.json`, protocol {protocol}, schema_version {version}."
        );
        out.push_str(
            "//! Regenerate with: HERDR_API_UPDATE=1 cargo test -p herdr-fleet-herdr-api --test generated\n",
        );
        out.push_str(
            "//! How each shape is mapped: docs/rust-migration/adr/0245-herdr-api-generation.md\n",
        );
        out.push_str("//!\n//! Fields and types of any JSON value (`serde_json::Value`):\n");
        if self.values.is_empty() {
            out.push_str("//! - none\n");
        }
        for value in &self.values {
            let _ = writeln!(out, "//! - {value}");
        }
        out.push('\n');

        let mut uses = vec!["use serde::{Deserialize, Serialize};"];
        let source: Vec<&Ty> = self.all_types().collect();
        if source
            .iter()
            .any(|ty| uses_ty(ty, &|ty| matches!(ty, Ty::Value)))
        {
            uses.push("use serde_json::Value;");
        }
        if source
            .iter()
            .any(|ty| uses_ty(ty, &|ty| matches!(ty, Ty::Map(_))))
        {
            uses.push("use std::collections::BTreeMap;");
        }
        for line in uses {
            out.push_str(line);
            out.push('\n');
        }

        for (name, item) in &self.items {
            out.push('\n');
            render_item(&mut out, name, item);
        }

        if !methods.is_empty() {
            out.push_str("\nmethods! {\n");
            for (marker, name, params) in methods {
                let _ = writeln!(out, "    {marker} = {}, {params};", quote(name));
            }
            out.push_str("}\n");
        }
        out
    }

    fn all_types(&self) -> impl Iterator<Item = &Ty> {
        self.items.values().flat_map(|item| -> Vec<&Ty> {
            match &item.body {
                Body::Struct(fields) => fields.iter().map(|field| &field.ty).collect(),
                Body::Untagged(variants) => variants.iter().map(|variant| &variant.1).collect(),
                Body::Alias(ty) => vec![ty],
                Body::OpenEnum(_) | Body::Tagged { .. } => Vec::new(),
            }
        })
    }
}

fn render_item(out: &mut String, name: &str, item: &Item) {
    match &item.body {
        Body::Struct(fields) => {
            render_doc(out, "", item.doc.as_deref());
            out.push_str("#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]\n");
            if fields.is_empty() {
                let _ = writeln!(out, "pub struct {name} {{}}");
                return;
            }
            let _ = writeln!(out, "pub struct {name} {{");
            for field in fields {
                render_doc(out, "    ", field.doc.as_deref());
                let (ident, renamed) = field_ident(&field.json);
                let mut attributes = Vec::new();
                if renamed {
                    attributes.push(format!("rename = {}", quote(&field.json)));
                }
                let ty = if field.required {
                    field.ty.clone()
                } else {
                    attributes.push("default".to_owned());
                    attributes.push("skip_serializing_if = \"Option::is_none\"".to_owned());
                    match &field.ty {
                        Ty::Option(_) => field.ty.clone(),
                        other => Ty::Option(Box::new(other.clone())),
                    }
                };
                if !attributes.is_empty() {
                    let _ = writeln!(out, "    #[serde({})]", attributes.join(", "));
                }
                let _ = writeln!(out, "    pub {ident}: {},", rust(&ty));
            }
            out.push_str("}\n");
        }
        Body::OpenEnum(values) => {
            out.push_str("open_enum! {\n");
            render_doc(out, "    ", item.doc.as_deref());
            let _ = writeln!(out, "    {name} {{");
            for value in values {
                let _ = writeln!(out, "        {} = {},", pascal(value), quote(value));
            }
            out.push_str("    }\n}\n");
        }
        Body::Tagged {
            key,
            units,
            payloads,
        } => {
            out.push_str("tagged_union! {\n");
            render_doc(out, "    ", item.doc.as_deref());
            let _ = writeln!(out, "    {name}, {},", quote(key));
            out.push_str("    unit {\n");
            for (ident, tag) in units {
                let _ = writeln!(out, "        {ident} = {},", quote(tag));
            }
            out.push_str("    }\n    payload {\n");
            for (ident, payload, tag) in payloads {
                let _ = writeln!(out, "        {ident}({payload}) = {},", quote(tag));
            }
            out.push_str("    }\n}\n");
        }
        Body::Untagged(variants) => {
            render_doc(out, "", item.doc.as_deref());
            out.push_str("#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]\n");
            out.push_str("#[serde(untagged)]\n");
            let _ = writeln!(out, "pub enum {name} {{");
            for (ident, ty, doc) in variants {
                render_doc(out, "    ", doc.as_deref());
                let _ = writeln!(out, "    {ident}({}),", rust(ty));
            }
            out.push_str("}\n");
        }
        Body::Alias(ty) => {
            render_doc(out, "", item.doc.as_deref());
            let _ = writeln!(out, "pub type {name} = {};", rust(ty));
        }
    }
}

fn render_doc(out: &mut String, indent: &str, doc: Option<&str>) {
    let Some(doc) = doc else {
        return;
    };
    for line in doc.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            let _ = writeln!(out, "{indent}///");
        } else {
            let _ = writeln!(out, "{indent}/// {line}");
        }
    }
}

fn rust(ty: &Ty) -> String {
    match ty {
        Ty::Named(name) => name.clone(),
        Ty::Str => "String".to_owned(),
        Ty::Bool => "bool".to_owned(),
        Ty::Int(int) => (*int).to_owned(),
        Ty::Float => "f64".to_owned(),
        Ty::Vec(inner) => format!("Vec<{}>", rust(inner)),
        Ty::Map(inner) => format!("BTreeMap<String, {}>", rust(inner)),
        Ty::Option(inner) => format!("Option<{}>", rust(inner)),
        Ty::Boxed(inner) => format!("Box<{}>", rust(inner)),
        Ty::Value => "Value".to_owned(),
    }
}

fn uses_ty(ty: &Ty, test: &dyn Fn(&Ty) -> bool) -> bool {
    if test(ty) {
        return true;
    }
    match ty {
        Ty::Vec(inner) | Ty::Map(inner) | Ty::Option(inner) | Ty::Boxed(inner) => {
            uses_ty(inner, test)
        }
        _ => false,
    }
}

/// The named type a field holds by value (directly or through `Option`).
fn direct(ty: &Ty) -> Option<String> {
    match ty {
        Ty::Named(name) => Some(name.clone()),
        Ty::Option(inner) => direct(inner),
        _ => None,
    }
}

fn boxed_ty(ty: Ty) -> Ty {
    match ty {
        Ty::Option(inner) => Ty::Option(Box::new(boxed_ty(*inner))),
        named => Ty::Boxed(Box::new(named)),
    }
}

fn variant_name(ty: &Ty) -> String {
    match ty {
        Ty::Named(name) => name.clone(),
        Ty::Str => "String".to_owned(),
        Ty::Bool => "Bool".to_owned(),
        Ty::Int(_) => "Integer".to_owned(),
        Ty::Float => "Number".to_owned(),
        Ty::Vec(_) => "Array".to_owned(),
        Ty::Map(_) => "Object".to_owned(),
        Ty::Option(inner) | Ty::Boxed(inner) => variant_name(inner),
        Ty::Value => "Value".to_owned(),
    }
}

fn integer(format: Option<&str>) -> Option<&'static str> {
    Some(match format {
        None | Some("int64") | Some("int") => "i64",
        Some("int8") => "i8",
        Some("int16") => "i16",
        Some("int32") => "i32",
        Some("uint8") => "u8",
        Some("uint16") => "u16",
        Some("uint32") => "u32",
        Some("uint64") | Some("uint") => "u64",
        Some(_) => return None,
    })
}

fn key(section: &str, name: &str) -> String {
    format!("{section}/{name}")
}

/// `#/schemas/<section>/$defs/<name>`
fn parse_ref(reference: &str) -> (&str, &str) {
    let parts: Vec<&str> = reference.split('/').collect();
    match parts.as_slice() {
        ["#", "schemas", section, "$defs", name] => (section, name),
        _ => panic!("unsupported $ref: {reference}"),
    }
}

fn description(node: &Value) -> Option<String> {
    node["description"].as_str().map(str::to_owned)
}

fn composes(node: &Value) -> bool {
    node.as_object().is_some_and(|object| {
        COMPOSITION
            .iter()
            .any(|keyword| object.contains_key(*keyword))
    })
}

fn is_object(node: &Value) -> bool {
    node["type"] == "object"
}

fn union_variants(node: &Value) -> Option<&[Value]> {
    node["oneOf"]
        .as_array()
        .or_else(|| node["anyOf"].as_array())
        .map(Vec::as_slice)
}

/// The other variant of `[T, {"type": "null"}]`.
fn nullable_pair(variants: &[Value]) -> Option<&Value> {
    let is_null = |variant: &Value| {
        variant["type"] == "null" && variant.as_object().is_some_and(|o| o.len() == 1)
    };
    match variants {
        [inner, null] | [null, inner] if is_null(null) && !is_null(inner) => Some(inner),
        _ => None,
    }
}

/// The property whose value is a distinct string constant, required, in every variant.
fn discriminator(variants: &[Value]) -> Option<String> {
    let first = variants.first()?;
    let candidates = sorted_keys(&first["properties"]);
    candidates.into_iter().find_map(|candidate| {
        let mut tags = BTreeSet::new();
        for variant in variants {
            if !is_object(variant) {
                return None;
            }
            let tag = variant["properties"][candidate]["const"].as_str()?;
            let required = variant["required"]
                .as_array()
                .is_some_and(|names| names.iter().any(|name| name == candidate));
            if !required || !tags.insert(tag) {
                return None;
            }
        }
        Some(candidate.to_owned())
    })
}

fn sorted_keys(node: &Value) -> Vec<&str> {
    let mut keys: Vec<&str> = node
        .as_object()
        .map(|object| object.keys().map(String::as_str).collect())
        .unwrap_or_default();
    keys.sort();
    keys
}

fn unique(names: &[String]) -> bool {
    names.iter().collect::<BTreeSet<_>>().len() == names.len()
}

/// `pane.agent_status_changed` -> `PaneAgentStatusChanged`.
fn pascal(text: &str) -> String {
    let mut out = String::new();
    for part in text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
    {
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            out.push(first.to_ascii_uppercase());
            out.extend(chars);
        }
    }
    if out.is_empty() || out.starts_with(|c: char| c.is_ascii_digit()) {
        out.insert(0, 'V');
    }
    out
}

/// The Rust name of a property, and whether it needs `#[serde(rename)]`.
fn field_ident(json: &str) -> (String, bool) {
    let plain = json.starts_with(|c: char| c.is_ascii_lowercase() || c == '_')
        && json
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && json != "_";
    if plain && !KEYWORDS.contains(&json) {
        return (json.to_owned(), false);
    }
    if plain && !["self", "super", "crate"].contains(&json) {
        return (format!("r#{json}"), false);
    }
    let mut ident: String = json
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    if !ident.starts_with(|c: char| c.is_ascii_lowercase() || c == '_')
        || KEYWORDS.contains(&ident.as_str())
    {
        ident.insert_str(0, "field_");
    }
    (ident, true)
}

fn quote(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

/// The Rust name of every definition: its own name, unless definitions of that name in different
/// sections have different shapes, in which case each gets its section's prefix.
///
/// Two definitions have the same shape when their JSON is equal once each `$ref` is replaced by
/// the class of the definition it points at. Classes start as the names and are split until no
/// class changes (the coarsest partition that the shapes respect), so a `$ref` that differs only
/// in its section does not make two shapes differ.
fn resolve_names(definitions: &[(String, String, Value)]) -> HashMap<String, String> {
    let mut class: HashMap<String, usize> = HashMap::new();
    let mut by_name: BTreeMap<&String, usize> = BTreeMap::new();
    for (section, name, _) in definitions {
        let next = by_name.len();
        let id = *by_name.entry(name).or_insert(next);
        class.insert(key(section, name), id);
    }
    loop {
        let mut signatures: BTreeMap<(usize, String), usize> = BTreeMap::new();
        let mut next_class = HashMap::new();
        for (section, name, def) in definitions {
            let id = key(section, name);
            let signature = canonical(def, &class);
            let count = signatures.len();
            let new = *signatures.entry((class[&id], signature)).or_insert(count);
            next_class.insert(id, new);
        }
        let before = class.values().collect::<BTreeSet<_>>().len();
        let after = signatures.len();
        class = next_class;
        if after == before {
            break;
        }
    }
    let mut classes_of_name: BTreeMap<&String, BTreeSet<usize>> = BTreeMap::new();
    for (section, name, _) in definitions {
        classes_of_name
            .entry(name)
            .or_default()
            .insert(class[&key(section, name)]);
    }
    let mut names = HashMap::new();
    for (section, name, _) in definitions {
        let ambiguous = classes_of_name[name].len() > 1;
        let rust = if ambiguous {
            let prefix = SECTION_PREFIXES
                .iter()
                .find(|(known, _)| known == section)
                .map(|(_, prefix)| (*prefix).to_owned())
                .unwrap_or_else(|| pascal(section));
            format!("{prefix}{name}")
        } else {
            name.clone()
        };
        names.insert(key(section, name), rust);
    }
    names
}

/// The JSON of a node with sorted keys and each `$ref` replaced by its target's class.
fn canonical(node: &Value, class: &HashMap<String, usize>) -> String {
    fn walk(node: &Value, class: &HashMap<String, usize>) -> Value {
        match node {
            Value::Object(object) => {
                let mut keys: Vec<&String> = object.keys().collect();
                keys.sort();
                let mut out = Map::new();
                for key_name in keys {
                    let value = &object[key_name];
                    if key_name == "$ref"
                        && let Some(reference) = value.as_str()
                    {
                        let (section, name) = parse_ref(reference);
                        let target = class
                            .get(&key(section, name))
                            .unwrap_or_else(|| panic!("unresolved $ref {reference}"));
                        out.insert(key_name.clone(), Value::from(*target));
                        continue;
                    }
                    out.insert(key_name.clone(), walk(value, class));
                }
                Value::Object(out)
            }
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| walk(item, class)).collect())
            }
            other => other.clone(),
        }
    }
    walk(node, class).to_string()
}
