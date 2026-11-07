//! References in Javadoc comments (IDEA's `PsiDocMethodOrFieldRef`, `PsiDocTagValue`): the
//! program elements `{@link …}`, `{@linkplain …}`, `{@value …}`, `@see …`, `@throws …` and
//! `@exception …` name. IDEA's and JDT's usage searches count them; `{@code …}` and plain text
//! are not references.

/// One reference: `[pkg.]Type[.Nested][#member[(params)]]` or `#member[(params)]`. Offsets are
/// absolute byte offsets in the file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocRef {
    /// The type as written and the offset of its last name.
    pub ty: Option<(String, usize)>,
    /// The member name and its offset.
    pub member: Option<(String, usize)>,
    /// Parameter types as written, when a signature is given (`#m()` gives an empty list).
    pub params: Option<Vec<String>>,
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Parses the reference at the start of `s` (after a tag and spaces); `base` is the offset of
/// `s` in the file.
fn reference(s: &str, base: usize) -> Option<DocRef> {
    let end = s.find(|c: char| c.is_whitespace() || c == '}').unwrap_or(s.len());
    // Keep a signature's spaces: `#m(String, int)`.
    let end = match (s[..end].find('('), s.find(')')) {
        (Some(_), Some(close)) if close >= end => close + 1,
        _ => end,
    };
    let text = &s[..end];
    if text.is_empty() || text.starts_with('"') || text.starts_with('<') {
        return None;
    }
    let (ty_part, member_part) = match text.split_once('#') {
        Some((t, m)) => (t, Some(m)),
        None => (text, None),
    };
    let ty = (!ty_part.is_empty())
        .then(|| {
            let ty_part = ty_part.trim_end_matches(|c: char| !is_ident(c));
            if ty_part.is_empty() || !ty_part.chars().all(|c| is_ident(c) || c == '.') {
                return None;
            }
            let last = ty_part.rfind('.').map_or(0, |i| i + 1);
            Some((ty_part.to_owned(), base + last))
        })
        .flatten();
    let (member, params) = match member_part {
        Some(m) => {
            let name_end = m.find(|c: char| !is_ident(c)).unwrap_or(m.len());
            let name = &m[..name_end];
            if name.is_empty() {
                return None;
            }
            let offset = base + ty_part.len() + 1;
            let params = m[name_end..].strip_prefix('(').and_then(|p| p.strip_suffix(')')).map(|p| {
                p.split(',')
                    .map(|x| x.trim())
                    .filter(|x| !x.is_empty())
                    // `Map<K,V> m` / `String name`: the type only.
                    .map(|x| x.split_whitespace().next().unwrap_or(x).to_owned())
                    .collect::<Vec<_>>()
            });
            (Some((name.to_owned(), offset)), params)
        }
        None => (None, None),
    };
    if ty.is_none() && member.is_none() {
        return None;
    }
    Some(DocRef { ty, member, params })
}

/// The references of a doc comment (`/** … */`) starting at byte `base` of the file.
pub fn references(comment: &str, base: usize) -> Vec<DocRef> {
    let mut out = Vec::new();
    if !comment.starts_with("/**") {
        return out;
    }
    const INLINE: [&str; 3] = ["{@link ", "{@linkplain ", "{@value "];
    const BLOCK: [&str; 3] = ["@see ", "@throws ", "@exception "];
    let mut i = 0;
    while let Some(at) = comment[i..].find('@') {
        let start = i + at;
        i = start + 1;
        let rest = &comment[start..];
        let inline = start > 0 && comment.as_bytes()[start - 1] == b'{';
        let tag_len = if inline {
            INLINE.iter().find(|t| comment[start - 1..].starts_with(*t)).map(|t| t.len() - 1)
        } else {
            BLOCK.iter().find(|t| rest.starts_with(*t)).map(|t| t.len())
        };
        let Some(len) = tag_len else { continue };
        let after = &comment[start + len..];
        let skip = after.len() - after.trim_start().len();
        if let Some(r) = reference(after.trim_start(), base + start + len + skip) {
            out.push(r);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_links_see_and_throws_but_not_code() {
        let c = "/**\n * Uses {@link com.acme.Agent#resume(PauseState, java.util.Map)} and {@link #stop}.\n * {@linkplain Builder#name(String) the name} {@code agent.resume(x)}\n * @see Other\n * @throws IllegalStateException when\n * @param x not a reference\n */";
        let refs = references(c, 100);
        let names: Vec<(Option<&str>, Option<&str>)> = refs
            .iter()
            .map(|r| (r.ty.as_ref().map(|t| t.0.as_str()), r.member.as_ref().map(|m| m.0.as_str())))
            .collect();
        assert_eq!(
            names,
            [
                (Some("com.acme.Agent"), Some("resume")),
                (None, Some("stop")),
                (Some("Builder"), Some("name")),
                (Some("Other"), None),
                (Some("IllegalStateException"), None),
            ]
        );
        assert_eq!(refs[0].params.as_deref(), Some(&["PauseState".to_owned(), "java.util.Map".to_owned()][..]));
        assert_eq!(refs[1].params, None);
        // Offsets point at the names.
        let (name, at) = refs[0].member.clone().unwrap();
        assert_eq!(&c[at - 100..at - 100 + name.len()], "resume");
        let (ty, at) = refs[0].ty.clone().unwrap();
        assert_eq!(&c[at - 100..at - 100 + 5], "Agent");
        assert_eq!(ty, "com.acme.Agent");
        assert!(references("/* plain {@link X} */", 0).is_empty(), "only doc comments");
    }
}
