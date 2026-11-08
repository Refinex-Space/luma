//! Configuration property names as Spring Boot binds them (`ConfigurationPropertyName`):
//! elements separated by `.`, indexed elements in `[..]`; ordinary elements compare
//! lowercase with `-` and `_` removed (relaxed binding), indexed elements (map keys, list
//! indexes) compare exactly.

/// One element of a written key, with its byte range in the key text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Element<'a> {
    /// As written, without the brackets (and quotes) of an indexed element.
    pub text: &'a str,
    pub indexed: bool,
    /// Byte range in the key, brackets included.
    pub from: usize,
    pub to: usize,
}

/// Splits `key` into its elements. `a.b[0].c` → `a`, `b`, `[0]`, `c`; `a[x.y]` keeps `x.y`.
/// An unclosed `[` ends the key with an indexed element running to the end.
pub fn elements(key: &str) -> Vec<Element<'_>> {
    let bytes = key.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    let mut start = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'.' => {
                if i > start {
                    out.push(Element { text: &key[start..i], indexed: false, from: start, to: i });
                }
                i += 1;
                start = i;
            }
            b'[' => {
                if i > start {
                    out.push(Element { text: &key[start..i], indexed: false, from: start, to: i });
                }
                let open = i;
                let close = key[i + 1..].find(']').map(|c| i + 1 + c);
                let end = close.unwrap_or(key.len());
                let mut text = &key[open + 1..end];
                if text.len() >= 2
                    && ((text.starts_with('"') && text.ends_with('"'))
                        || (text.starts_with('\'') && text.ends_with('\'')))
                {
                    text = &text[1..text.len() - 1];
                }
                let to = close.map_or(key.len(), |c| c + 1);
                out.push(Element { text, indexed: true, from: open, to });
                i = to;
                start = i;
            }
            _ => i += 1,
        }
    }
    if start < bytes.len() {
        out.push(Element { text: &key[start..], indexed: false, from: start, to: key.len() });
    }
    out
}

/// The relaxed form of an ordinary element: lowercase alphanumerics (`max-Pool_size` → `maxpoolsize`).
pub fn uniform(element: &str) -> String {
    element.chars().filter(|c| !matches!(c, '-' | '_')).flat_map(char::to_lowercase).collect()
}

/// The canonical form of a written key: elements in relaxed form joined with `.`, indexed
/// elements kept as `[text]`. Two keys bind the same property when their canonical forms
/// are equal.
pub fn canonical(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for e in elements(key) {
        push(&mut out, e.text, e.indexed);
    }
    out
}

pub(crate) fn push(out: &mut String, text: &str, indexed: bool) {
    if indexed {
        out.push('[');
        out.push_str(text);
        out.push(']');
    } else {
        if !out.is_empty() {
            out.push('.');
        }
        out.push_str(&uniform(text));
    }
}

/// Joins canonical `prefix` and canonical `rest` (`a.b` + `c` → `a.b.c`, `a` + `[0]` → `a[0]`).
pub fn join(prefix: &str, rest: &str) -> String {
    if prefix.is_empty() {
        return rest.to_owned();
    }
    if rest.is_empty() {
        return prefix.to_owned();
    }
    if rest.starts_with('[') { format!("{prefix}{rest}") } else { format!("{prefix}.{rest}") }
}

/// Whether canonical `name` lies under canonical `prefix` (`a.b.c` under `a.b`, `a[0]` under `a`).
pub fn is_under(name: &str, prefix: &str) -> bool {
    prefix.is_empty()
        || (name.len() > prefix.len()
            && name.starts_with(prefix)
            && matches!(name.as_bytes()[prefix.len()], b'.' | b'['))
}

/// The canonical remainder of `name` under `prefix` (`a.b.c` under `a` → `b.c`).
pub fn rest_under<'a>(name: &'a str, prefix: &str) -> &'a str {
    if prefix.is_empty() {
        return name;
    }
    let rest = &name[prefix.len()..];
    rest.strip_prefix('.').unwrap_or(rest)
}

/// `maxPoolSize` → `max-pool-size` (the annotation processor's naming of bean properties).
pub fn kebab(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    let chars: Vec<char> = name.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if c == '_' {
            out.push('-');
            continue;
        }
        if c.is_uppercase() {
            let prev_lower = i > 0 && (chars[i - 1].is_lowercase() || chars[i - 1].is_ascii_digit());
            let next_lower = chars.get(i + 1).is_some_and(|n| n.is_lowercase());
            let prev_upper = i > 0 && chars[i - 1].is_uppercase();
            if i > 0 && (prev_lower || (prev_upper && next_lower)) && !out.ends_with('-') {
                out.push('-');
            }
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Whether `prefix` is a valid `@ConfigurationProperties` prefix: lowercase kebab-case
/// elements (`ConfigurationPropertyName.isValid` for a prefix).
pub fn is_valid_prefix(prefix: &str) -> bool {
    !prefix.is_empty()
        && prefix.split('.').all(|e| {
            !e.is_empty()
                && e.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                && e.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
}

/// Edit distance (Levenshtein) of two short strings, stopping early above `limit`.
pub fn distance(a: &str, b: &str, limit: usize) -> Option<usize> {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > limit {
        return None;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        let mut best = cur[0];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
            best = best.min(cur[j]);
        }
        if best > limit {
            return None;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    (prev[b.len()] <= limit).then_some(prev[b.len()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_and_canonicalizes() {
        let e = elements("spring.datasource[0].Max_Pool-size");
        assert_eq!(
            e.iter().map(|e| (e.text, e.indexed)).collect::<Vec<_>>(),
            [("spring", false), ("datasource", false), ("0", true), ("Max_Pool-size", false)]
        );
        assert_eq!(canonical("spring.datasource[0].Max_Pool-size"), "spring.datasource[0].maxpoolsize");
        assert_eq!(canonical("logging.level[org.Foo]"), "logging.level[org.Foo]");
        assert_eq!(canonical("a[\"x.y\"].b"), "a[x.y].b");
        assert_eq!(canonical("a[unclosed"), "a[unclosed]");
        assert_eq!(canonical("server.servlet.context-path"), canonical("server.servlet.contextPath"));
    }

    #[test]
    fn prefixes() {
        assert!(is_under("a.b.c", "a.b"));
        assert!(is_under("a[0]", "a"));
        assert!(!is_under("a.bc", "a.b"));
        assert!(!is_under("a.b", "a.b"));
        assert_eq!(rest_under("a.b.c", "a"), "b.c");
        assert_eq!(rest_under("a[0].c", "a"), "[0].c");
        assert_eq!(join("a", "[0]"), "a[0]");
        assert_eq!(join("a", "b"), "a.b");
    }

    #[test]
    fn kebab_case() {
        assert_eq!(kebab("maxPoolSize"), "max-pool-size");
        assert_eq!(kebab("URLPrefix"), "url-prefix");
        assert_eq!(kebab("http2Enabled"), "http2-enabled");
        assert_eq!(kebab("enabled"), "enabled");
        assert!(is_valid_prefix("spring.ai.open-ai"));
        assert!(!is_valid_prefix("spring.ai.openAi"));
        assert!(!is_valid_prefix(""));
        assert!(!is_valid_prefix("a..b"));
    }

    #[test]
    fn edit_distance() {
        assert_eq!(distance("server.prot", "server.port", 2), Some(2));
        assert_eq!(distance("abc", "abc", 0), Some(0));
        assert_eq!(distance("abc", "xyz", 2), None);
    }
}
