//! Property types as configuration metadata writes them (`java.util.Map<java.lang.String,
//! java.time.Duration>`), and the conversion rules of Spring Boot's binder for scalar values.

use serde::{Deserialize, Serialize};
use specta::Type;

/// A parsed property type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JavaType {
    Scalar(Scalar),
    /// `Map<K, V>` (and `Properties`).
    Map(Box<JavaType>, Box<JavaType>),
    /// `List<E>`, `Set<E>`, `Collection<E>`, arrays.
    List(Box<JavaType>),
    /// Any other class: an enum, a nested bean, or a value type the binder converts some
    /// other way. Which one needs the class (see [`crate::TypeOracle`]).
    Class(String),
}

/// Scalar types the binder converts from text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Scalar {
    String,
    Boolean,
    Integer,
    Long,
    Short,
    Byte,
    Double,
    Float,
    BigDecimal,
    BigInteger,
    Character,
    Duration,
    Period,
    DataSize,
    Charset,
    Locale,
    MimeType,
    Resource,
    Class,
    Object,
    /// Text the binder accepts in forms not checked here (`InetAddress`, `URI`, `Pattern`…).
    Text,
}

impl JavaType {
    /// Parses a metadata type; `None` for an empty string.
    pub fn parse(text: &str) -> Option<JavaType> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        let mut p = Parser { s: text.as_bytes(), i: 0, text };
        let t = p.ty()?;
        Some(t)
    }

    pub fn is_scalar(&self) -> bool {
        matches!(self, JavaType::Scalar(_))
    }

    /// Whether a value of this type is written as one text value (a scalar, an enum, a
    /// comma-separated list of scalars).
    pub fn is_value(&self, is_bean: impl Fn(&str) -> bool) -> bool {
        match self {
            JavaType::Scalar(_) => true,
            JavaType::List(e) => match &**e {
                JavaType::Scalar(_) => true,
                JavaType::Class(c) => !is_bean(c),
                _ => false,
            },
            JavaType::Map(..) => false,
            JavaType::Class(c) => !is_bean(c),
        }
    }

    /// The simple form shown in completion and documentation (`Map<String, Duration>`).
    pub fn display(&self) -> String {
        match self {
            JavaType::Scalar(s) => s.display().to_owned(),
            JavaType::Map(k, v) => format!("Map<{}, {}>", k.display(), v.display()),
            JavaType::List(e) => format!("List<{}>", e.display()),
            JavaType::Class(c) => simple(c).to_owned(),
        }
    }
}

/// The simple name of a qualified (possibly nested, `$`) class name.
pub fn simple(fqn: &str) -> &str {
    let base = fqn.split('<').next().unwrap_or(fqn);
    base.rsplit(['.', '$']).next().unwrap_or(base)
}

/// Simplifies every qualified name in a metadata type (`java.util.List<java.lang.String>` →
/// `List<String>`).
pub fn display_type(text: &str) -> String {
    match JavaType::parse(text) {
        Some(t) => t.display(),
        None => text.to_owned(),
    }
}

impl Scalar {
    pub fn display(self) -> &'static str {
        match self {
            Scalar::String => "String",
            Scalar::Boolean => "Boolean",
            Scalar::Integer => "Integer",
            Scalar::Long => "Long",
            Scalar::Short => "Short",
            Scalar::Byte => "Byte",
            Scalar::Double => "Double",
            Scalar::Float => "Float",
            Scalar::BigDecimal => "BigDecimal",
            Scalar::BigInteger => "BigInteger",
            Scalar::Character => "Character",
            Scalar::Duration => "Duration",
            Scalar::Period => "Period",
            Scalar::DataSize => "DataSize",
            Scalar::Charset => "Charset",
            Scalar::Locale => "Locale",
            Scalar::MimeType => "MimeType",
            Scalar::Resource => "Resource",
            Scalar::Class => "Class",
            Scalar::Object => "Object",
            Scalar::Text => "String",
        }
    }

    /// The qualified type named in messages (`java.lang.Integer`).
    pub fn qualified(self) -> &'static str {
        match self {
            Scalar::String | Scalar::Text => "java.lang.String",
            Scalar::Boolean => "java.lang.Boolean",
            Scalar::Integer => "java.lang.Integer",
            Scalar::Long => "java.lang.Long",
            Scalar::Short => "java.lang.Short",
            Scalar::Byte => "java.lang.Byte",
            Scalar::Double => "java.lang.Double",
            Scalar::Float => "java.lang.Float",
            Scalar::BigDecimal => "java.math.BigDecimal",
            Scalar::BigInteger => "java.math.BigInteger",
            Scalar::Character => "java.lang.Character",
            Scalar::Duration => "java.time.Duration",
            Scalar::Period => "java.time.Period",
            Scalar::DataSize => "org.springframework.util.unit.DataSize",
            Scalar::Charset => "java.nio.charset.Charset",
            Scalar::Locale => "java.util.Locale",
            Scalar::MimeType => "org.springframework.util.MimeType",
            Scalar::Resource => "org.springframework.core.io.Resource",
            Scalar::Class => "java.lang.Class",
            Scalar::Object => "java.lang.Object",
        }
    }

    /// Whether the binder converts `value` to this type. Values with placeholders are not
    /// asked (the caller skips them).
    pub fn accepts(self, value: &str) -> bool {
        let v = value.trim();
        match self {
            Scalar::String | Scalar::Text | Scalar::Object | Scalar::Resource => true,
            Scalar::Boolean => {
                matches!(v.to_ascii_lowercase().as_str(), "true" | "false" | "on" | "off" | "yes" | "no" | "1" | "0")
            }
            Scalar::Integer => integer(v).is_some_and(|n| i32::try_from(n).is_ok()),
            Scalar::Long => integer(v).is_some_and(|n| i64::try_from(n).is_ok()),
            Scalar::Short => integer(v).is_some_and(|n| i16::try_from(n).is_ok()),
            Scalar::Byte => integer(v).is_some_and(|n| i8::try_from(n).is_ok()),
            Scalar::BigInteger => integer(v).is_some() || (!v.is_empty() && big_digits(v)),
            Scalar::Double | Scalar::Float | Scalar::BigDecimal => decimal(v),
            Scalar::Character => v.chars().count() == 1 || value.chars().count() == 1,
            Scalar::Duration => duration(v),
            Scalar::Period => period(v),
            Scalar::DataSize => data_size(v),
            Scalar::Charset => {
                !v.is_empty()
                    && v.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
                    && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '+' | ':' | '.' | '_'))
            }
            Scalar::Locale => {
                v.is_empty()
                    || v.split(['_', '-'])
                        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '#'))
            }
            Scalar::MimeType => mime(v),
            Scalar::Class => {
                !v.is_empty()
                    && v.split('.').all(|p| {
                        !p.is_empty()
                            && p.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$')
                            && p.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
                    })
            }
        }
    }
}

/// Java's `Integer.decode`-style integers: decimal, `0x`/`#` hex, optional sign (what
/// `NumberUtils.parseNumber` takes).
fn integer(v: &str) -> Option<i128> {
    let (neg, digits) = match v.as_bytes().first() {
        Some(b'-') => (true, &v[1..]),
        Some(b'+') => (false, &v[1..]),
        _ => (false, v),
    };
    let n = if let Some(hex) =
        digits.strip_prefix("0x").or_else(|| digits.strip_prefix("0X")).or_else(|| digits.strip_prefix('#'))
    {
        i128::from_str_radix(hex, 16).ok()?
    } else {
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) || digits.len() > 38 {
            return None;
        }
        digits.parse::<i128>().ok()?
    };
    Some(if neg { -n } else { n })
}

fn big_digits(v: &str) -> bool {
    let d = v.strip_prefix(['-', '+']).unwrap_or(v);
    !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())
}

fn decimal(v: &str) -> bool {
    let lower = v.to_ascii_lowercase();
    if matches!(lower.trim_start_matches(['-', '+']), "nan" | "infinity") {
        return true;
    }
    let body = lower.strip_suffix(['d', 'f']).unwrap_or(&lower);
    !body.is_empty() && body.parse::<f64>().is_ok() || integer(v).is_some()
}

/// `DurationStyle.SIMPLE` (`30s`, `-5m`, `100`) or `DurationStyle.ISO8601` (`PT30S`).
fn duration(v: &str) -> bool {
    if v.is_empty() {
        return false;
    }
    let body = v.strip_prefix(['-', '+']).unwrap_or(v);
    if body.starts_with(['P', 'p']) {
        return iso_duration(body);
    }
    let digits = body.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return false;
    }
    matches!(body[digits..].to_ascii_lowercase().as_str(), "" | "ns" | "us" | "ms" | "s" | "m" | "h" | "d")
}

fn iso_duration(v: &str) -> bool {
    // PnDTnHnMn.nS, case-insensitive (java.time.Duration.parse).
    let u = v.to_ascii_uppercase();
    let Some(rest) = u.strip_prefix('P') else { return false };
    let (days, time) = match rest.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (rest, None),
    };
    let unit_list = |s: &str, units: &[char]| -> bool {
        let mut s = s;
        let mut last = 0usize;
        let mut any = false;
        while !s.is_empty() {
            let s2 = s.strip_prefix(['-', '+']).unwrap_or(s);
            let n = s2.bytes().take_while(|b| b.is_ascii_digit() || *b == b'.' || *b == b',').count();
            if n == 0 {
                return false;
            }
            let Some(unit) = s2[n..].chars().next() else { return false };
            let Some(pos) = units.iter().position(|u| *u == unit) else { return false };
            if pos < last || (any && pos == last) {
                return false;
            }
            last = pos;
            any = true;
            s = &s2[n + 1..];
        }
        any
    };
    let ok_days = days.is_empty() || unit_list(days, &['D']);
    let ok_time = match time {
        Some(t) => unit_list(t, &['H', 'M', 'S']),
        None => !days.is_empty(),
    };
    ok_days && ok_time
}

/// `PeriodStyle` (`1y2m3d`, `5d`, `P1Y2M`).
fn period(v: &str) -> bool {
    let body = v.strip_prefix(['-', '+']).unwrap_or(v);
    if body.starts_with(['P', 'p']) {
        let u = body[1..].to_ascii_uppercase();
        return !u.is_empty()
            && u.split_inclusive(['Y', 'M', 'W', 'D']).all(|p| {
                let n = p.trim_end_matches(['Y', 'M', 'W', 'D']);
                let n = n.strip_prefix('-').unwrap_or(n);
                !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && p.len() > n.len()
            });
    }
    if body.is_empty() {
        return false;
    }
    if body.bytes().all(|b| b.is_ascii_digit()) {
        return true;
    }
    let lower = body.to_ascii_lowercase();
    let mut s = lower.as_str();
    while !s.is_empty() {
        let s2 = s.strip_prefix('-').unwrap_or(s);
        let n = s2.bytes().take_while(u8::is_ascii_digit).count();
        if n == 0 || !s2[n..].starts_with(['y', 'm', 'w', 'd']) {
            return false;
        }
        s = &s2[n + 1..];
    }
    true
}

/// `DataSize.parse`: `10`, `10MB`, `-1KB`; units B, KB, MB, GB, TB.
fn data_size(v: &str) -> bool {
    let body = v.strip_prefix(['-', '+']).unwrap_or(v);
    let digits = body.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && matches!(body[digits..].to_ascii_uppercase().as_str(), "" | "B" | "KB" | "MB" | "GB" | "TB")
}

fn mime(v: &str) -> bool {
    let main = v.split(';').next().unwrap_or("").trim();
    let Some((t, s)) = main.split_once('/') else { return false };
    let token = |x: &str| !x.is_empty() && x.chars().all(|c| c.is_ascii_alphanumeric() || "!#$&-^_.+*".contains(c));
    token(t) && token(s)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    text: &'a str,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }

    fn name(&mut self) -> &str {
        self.ws();
        let start = self.i;
        while self.i < self.s.len() && !matches!(self.s[self.i], b'<' | b'>' | b',' | b'[' | b']') {
            self.i += 1;
        }
        self.text[start..self.i].trim()
    }

    fn ty(&mut self) -> Option<JavaType> {
        let name = self.name().to_owned();
        let name = name.trim_start_matches("? extends ").trim_start_matches("? super ").to_owned();
        let mut args = Vec::new();
        self.ws();
        if self.s.get(self.i) == Some(&b'<') {
            self.i += 1;
            loop {
                args.push(self.ty()?);
                self.ws();
                match self.s.get(self.i) {
                    Some(b',') => self.i += 1,
                    Some(b'>') => {
                        self.i += 1;
                        break;
                    }
                    _ => return None,
                }
            }
        }
        let mut t = classify(&name, args);
        self.ws();
        while self.s.get(self.i) == Some(&b'[') && self.s.get(self.i + 1) == Some(&b']') {
            self.i += 2;
            t = match t {
                JavaType::Scalar(Scalar::Byte) => JavaType::Scalar(Scalar::Text),
                JavaType::Scalar(Scalar::Character) => JavaType::Scalar(Scalar::String),
                t => JavaType::List(Box::new(t)),
            };
            self.ws();
        }
        Some(t)
    }
}

fn classify(name: &str, mut args: Vec<JavaType>) -> JavaType {
    let name = name.replace('$', ".");
    let s = match name.as_str() {
        "java.lang.String" | "String" | "java.lang.CharSequence" => Scalar::String,
        "boolean" | "java.lang.Boolean" => Scalar::Boolean,
        "int" | "java.lang.Integer" => Scalar::Integer,
        "long" | "java.lang.Long" => Scalar::Long,
        "short" | "java.lang.Short" => Scalar::Short,
        "byte" | "java.lang.Byte" => Scalar::Byte,
        "double" | "java.lang.Double" => Scalar::Double,
        "float" | "java.lang.Float" => Scalar::Float,
        "char" | "java.lang.Character" => Scalar::Character,
        "java.math.BigDecimal" => Scalar::BigDecimal,
        "java.math.BigInteger" => Scalar::BigInteger,
        "java.lang.Number" => Scalar::BigDecimal,
        "java.time.Duration" => Scalar::Duration,
        "java.time.Period" => Scalar::Period,
        "org.springframework.util.unit.DataSize" => Scalar::DataSize,
        "java.nio.charset.Charset" => Scalar::Charset,
        "java.util.Locale" => Scalar::Locale,
        "org.springframework.util.MimeType" | "org.springframework.http.MediaType" => Scalar::MimeType,
        "org.springframework.core.io.Resource" => Scalar::Resource,
        "java.lang.Class" => Scalar::Class,
        "java.lang.Object" => Scalar::Object,
        "java.net.InetAddress"
        | "java.net.URI"
        | "java.net.URL"
        | "java.util.regex.Pattern"
        | "java.io.File"
        | "java.nio.file.Path"
        | "java.util.UUID"
        | "java.util.TimeZone"
        | "java.time.ZoneId"
        | "java.util.Currency"
        | "java.util.Date"
        | "java.time.LocalDate"
        | "java.time.LocalDateTime"
        | "java.time.LocalTime"
        | "java.time.Instant"
        | "java.time.OffsetDateTime"
        | "java.time.ZonedDateTime"
        | "java.time.temporal.ChronoUnit"
        | "java.util.concurrent.TimeUnit"
        | "org.springframework.util.unit.DataUnit" => Scalar::Text,
        "java.util.Map"
        | "java.util.HashMap"
        | "java.util.LinkedHashMap"
        | "java.util.TreeMap"
        | "java.util.SortedMap"
        | "java.util.concurrent.ConcurrentHashMap"
        | "java.util.concurrent.ConcurrentMap"
        | "org.springframework.util.MultiValueMap"
        | "org.springframework.util.LinkedMultiValueMap" => {
            let v = if args.len() >= 2 { args.pop() } else { None };
            let k = args.pop();
            return JavaType::Map(
                Box::new(k.unwrap_or(JavaType::Scalar(Scalar::String))),
                Box::new(v.unwrap_or(JavaType::Scalar(Scalar::Object))),
            );
        }
        "java.util.Properties" => {
            return JavaType::Map(
                Box::new(JavaType::Scalar(Scalar::String)),
                Box::new(JavaType::Scalar(Scalar::String)),
            );
        }
        "java.util.List"
        | "java.util.ArrayList"
        | "java.util.LinkedList"
        | "java.util.Set"
        | "java.util.HashSet"
        | "java.util.LinkedHashSet"
        | "java.util.SortedSet"
        | "java.util.TreeSet"
        | "java.util.Collection"
        | "java.lang.Iterable"
        | "java.util.EnumSet" => {
            return JavaType::List(Box::new(args.pop().unwrap_or(JavaType::Scalar(Scalar::Object))));
        }
        "java.util.Optional" => return args.pop().unwrap_or(JavaType::Scalar(Scalar::Object)),
        _ => return JavaType::Class(name),
    };
    JavaType::Scalar(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_generic_types() {
        assert_eq!(
            JavaType::parse("java.util.Map<java.lang.String,java.util.List<java.time.Duration>>").unwrap().display(),
            "Map<String, List<Duration>>"
        );
        assert_eq!(
            JavaType::parse("java.lang.String[]").unwrap(),
            JavaType::List(Box::new(JavaType::Scalar(Scalar::String)))
        );
        assert_eq!(JavaType::parse("char[]").unwrap(), JavaType::Scalar(Scalar::String));
        assert_eq!(JavaType::parse("a.b.Outer$Inner").unwrap(), JavaType::Class("a.b.Outer.Inner".into()));
        assert_eq!(JavaType::parse("java.util.Properties").unwrap().display(), "Map<String, String>");
        assert_eq!(display_type("java.util.List<java.lang.Class<?>>"), "List<Class>");
    }

    #[test]
    fn converts_values() {
        assert!(Scalar::Integer.accepts("10"));
        assert!(Scalar::Integer.accepts("0x1F"));
        assert!(!Scalar::Integer.accepts("ten"));
        assert!(!Scalar::Integer.accepts("3000000000"));
        assert!(Scalar::Long.accepts("3000000000"));
        assert!(Scalar::Boolean.accepts("TRUE"));
        assert!(Scalar::Boolean.accepts("on"));
        assert!(!Scalar::Boolean.accepts("maybe"));
        assert!(Scalar::Duration.accepts("30s"));
        assert!(Scalar::Duration.accepts("100"));
        assert!(Scalar::Duration.accepts("PT1H30M"));
        assert!(Scalar::Duration.accepts("P2DT3H"));
        assert!(!Scalar::Duration.accepts("30 seconds"));
        assert!(!Scalar::Duration.accepts("PT"));
        assert!(Scalar::DataSize.accepts("10MB"));
        assert!(Scalar::DataSize.accepts("10mb"));
        assert!(!Scalar::DataSize.accepts("10 MB"));
        assert!(Scalar::Period.accepts("1y2m"));
        assert!(Scalar::Period.accepts("P1Y2M3D"));
        assert!(Scalar::Double.accepts("1.5e3"));
        assert!(Scalar::MimeType.accepts("application/json;charset=UTF-8"));
        assert!(!Scalar::MimeType.accepts("json"));
        assert!(Scalar::Charset.accepts("UTF-8"));
        assert!(Scalar::Locale.accepts("zh_CN"));
        assert!(Scalar::Class.accepts("com.mysql.cj.jdbc.Driver"));
        assert!(!Scalar::Class.accepts("com..Driver"));
    }
}
