//! [`Slim`]: the lists of Java stubs. Most of a member's lists are empty (no type parameters,
//! no annotation arguments…); a `Vec` costs 24 bytes even then, a `Slim` 8 and no allocation —
//! a large share of the index's memory, as IDEA's stubs keep empty lists implicit too.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::ops::{Deref, DerefMut};

/// A list stored as `None` when empty (encoded like a `Vec`).
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
// The box keeps the list one pointer wide (a `Box<[T]>` is two); the extra allocation is only
// paid by the lists that are not empty.
#[allow(clippy::box_collection)]
pub struct Slim<T>(Option<Box<Vec<T>>>);

impl<T> Slim<T> {
    pub const fn new() -> Self {
        Slim(None)
    }

    pub fn push(&mut self, item: T) {
        self.0.get_or_insert_with(Default::default).push(item);
    }

    pub fn retain(&mut self, f: impl FnMut(&T) -> bool) {
        if let Some(v) = &mut self.0 {
            v.retain(f);
            if v.is_empty() {
                self.0 = None;
            }
        }
    }

    pub fn as_slice(&self) -> &[T] {
        self
    }

    pub fn into_vec(self) -> Vec<T> {
        self.0.map(|b| *b).unwrap_or_default()
    }
}

impl<T> Default for Slim<T> {
    fn default() -> Self {
        Slim(None)
    }
}

impl<T> Deref for Slim<T> {
    type Target = [T];
    fn deref(&self) -> &[T] {
        self.0.as_deref().map_or(&[], Vec::as_slice)
    }
}

impl<T> DerefMut for Slim<T> {
    fn deref_mut(&mut self) -> &mut [T] {
        self.0.as_deref_mut().map_or(&mut [], Vec::as_mut_slice)
    }
}

impl<T> From<Vec<T>> for Slim<T> {
    fn from(v: Vec<T>) -> Self {
        Slim((!v.is_empty()).then(|| Box::new(v)))
    }
}

impl<T> From<Slim<T>> for Vec<T> {
    fn from(s: Slim<T>) -> Self {
        s.into_vec()
    }
}

impl<T> FromIterator<T> for Slim<T> {
    fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
        Vec::from_iter(iter).into()
    }
}

impl<T> Extend<T> for Slim<T> {
    fn extend<I: IntoIterator<Item = T>>(&mut self, iter: I) {
        let mut v = std::mem::take(self).into_vec();
        v.extend(iter);
        *self = v.into();
    }
}

impl<'a, T> IntoIterator for &'a Slim<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

impl<T> IntoIterator for Slim<T> {
    type Item = T;
    type IntoIter = std::vec::IntoIter<T>;
    fn into_iter(self) -> Self::IntoIter {
        self.into_vec().into_iter()
    }
}

impl<T: std::fmt::Debug> std::fmt::Debug for Slim<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.iter()).finish()
    }
}

impl<T: PartialEq, U> PartialEq<Vec<U>> for Slim<T>
where
    T: PartialEq<U>,
{
    fn eq(&self, other: &Vec<U>) -> bool {
        self[..] == other[..]
    }
}

impl<T: PartialEq<U>, U, const N: usize> PartialEq<[U; N]> for Slim<T> {
    fn eq(&self, other: &[U; N]) -> bool {
        self[..] == other[..]
    }
}

impl<T: Serialize> Serialize for Slim<T> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.iter())
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Slim<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Vec::<T>::deserialize(d).map(Slim::from)
    }
}

#[cfg(test)]
mod tests {
    use super::Slim;

    #[test]
    fn slim_lists() {
        assert_eq!(std::mem::size_of::<Slim<String>>(), 8);
        let mut s: Slim<String> = Slim::new();
        assert!(s.is_empty() && s.iter().next().is_none());
        s.push("a".into());
        s.extend(["b".to_owned()]);
        assert_eq!(s, ["a", "b"]);
        assert_eq!(s.join(","), "a,b");
        // Encoded as a `Vec`: records written before decode the same.
        let v = vec!["a".to_owned(), "b".to_owned()];
        assert_eq!(postcard::to_allocvec(&s).unwrap(), postcard::to_allocvec(&v).unwrap());
        let back: Slim<String> = postcard::from_bytes(&postcard::to_allocvec(&v).unwrap()).unwrap();
        assert_eq!(back, v);
        s.retain(|x| x == "z");
        assert_eq!(s, Slim::new());
    }
}
