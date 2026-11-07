//! Low-level class file reading: a bounds-checked big-endian cursor, the constant pool and
//! modified UTF-8 (JVMS §4.4, §4.4.7).

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassFileError(pub String);

impl fmt::Display for ClassFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ClassFileError {}

pub type Result<T> = std::result::Result<T, ClassFileError>;

pub(crate) fn err<T>(msg: impl Into<String>) -> Result<T> {
    Err(ClassFileError(msg.into()))
}

pub(crate) struct Cursor<'a> {
    pub data: &'a [u8],
    pub pos: usize,
}

impl<'a> Cursor<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn bytes(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.data.len());
        match end {
            Some(end) => {
                let out = &self.data[self.pos..end];
                self.pos = end;
                Ok(out)
            }
            None => err(format!("truncated class file at {} (+{n})", self.pos)),
        }
    }

    pub fn u8(&mut self) -> Result<u8> {
        Ok(self.bytes(1)?[0])
    }

    pub fn u16(&mut self) -> Result<u16> {
        let b = self.bytes(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    pub fn u32(&mut self) -> Result<u32> {
        let b = self.bytes(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn skip(&mut self, n: usize) -> Result<()> {
        self.bytes(n).map(|_| ())
    }
}

/// Decodes modified UTF-8 (JVMS §4.4.7): `C0 80` for NUL, supplementary characters as
/// surrogate pairs of three-byte sequences. Malformed input is replaced, not rejected.
pub fn decode_mutf8(bytes: &[u8]) -> String {
    if bytes.is_ascii() {
        // SAFETY-free fast path: ASCII is valid UTF-8.
        return String::from_utf8(bytes.to_vec()).unwrap_or_default();
    }
    let mut units: Vec<u16> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b & 0x80 == 0 {
            units.push(b as u16);
            i += 1;
        } else if b & 0xE0 == 0xC0 && i + 1 < bytes.len() {
            units.push((((b & 0x1F) as u16) << 6) | (bytes[i + 1] & 0x3F) as u16);
            i += 2;
        } else if b & 0xF0 == 0xE0 && i + 2 < bytes.len() {
            units.push(
                (((b & 0x0F) as u16) << 12) | (((bytes[i + 1] & 0x3F) as u16) << 6) | (bytes[i + 2] & 0x3F) as u16,
            );
            i += 3;
        } else {
            units.push(0xFFFD);
            i += 1;
        }
    }
    String::from_utf16_lossy(&units)
}

/// What the stub builder reads from the constant pool.
#[derive(Clone, Debug)]
pub(crate) enum Constant {
    Unused,
    Utf8(Box<str>),
    Int(i32),
    Float(f32),
    Long(i64),
    Double(f64),
    /// Index of the name (Utf8).
    Class(u16),
    /// Index of the string (Utf8).
    Str(u16),
    Other,
}

pub(crate) struct ConstantPool {
    entries: Vec<Constant>,
}

impl ConstantPool {
    pub fn read(c: &mut Cursor) -> Result<Self> {
        let count = c.u16()? as usize;
        let mut entries = Vec::with_capacity(count);
        entries.push(Constant::Unused);
        let mut i = 1;
        while i < count {
            let tag = c.u8()?;
            let (entry, wide) = match tag {
                1 => {
                    let len = c.u16()? as usize;
                    (Constant::Utf8(decode_mutf8(c.bytes(len)?).into_boxed_str()), false)
                }
                3 => (Constant::Int(c.u32()? as i32), false),
                4 => (Constant::Float(f32::from_bits(c.u32()?)), false),
                5 => {
                    let hi = c.u32()? as u64;
                    let lo = c.u32()? as u64;
                    (Constant::Long(((hi << 32) | lo) as i64), true)
                }
                6 => {
                    let hi = c.u32()? as u64;
                    let lo = c.u32()? as u64;
                    (Constant::Double(f64::from_bits((hi << 32) | lo)), true)
                }
                7 => (Constant::Class(c.u16()?), false),
                8 => (Constant::Str(c.u16()?), false),
                // Field/Method/InterfaceMethod refs, NameAndType, Dynamic, InvokeDynamic.
                9 | 10 | 11 | 12 | 17 | 18 => {
                    c.skip(4)?;
                    (Constant::Other, false)
                }
                15 => {
                    c.skip(3)?;
                    (Constant::Other, false)
                }
                // MethodType, Module, Package.
                16 | 19 | 20 => {
                    c.skip(2)?;
                    (Constant::Other, false)
                }
                other => return err(format!("unknown constant pool tag {other} at entry {i}")),
            };
            entries.push(entry);
            i += 1;
            if wide {
                entries.push(Constant::Unused);
                i += 1;
            }
        }
        Ok(Self { entries })
    }

    pub fn get(&self, index: u16) -> Result<&Constant> {
        match self.entries.get(index as usize) {
            Some(Constant::Unused) | None => err(format!("bad constant pool index {index}")),
            Some(c) => Ok(c),
        }
    }

    pub fn utf8(&self, index: u16) -> Result<&str> {
        match self.get(index)? {
            Constant::Utf8(s) => Ok(s),
            other => err(format!("constant {index} is not Utf8: {other:?}")),
        }
    }

    /// The name of a `CONSTANT_Class` entry (`java/lang/Object`).
    pub fn class_name(&self, index: u16) -> Result<&str> {
        match self.get(index)? {
            Constant::Class(name) => self.utf8(*name),
            other => err(format!("constant {index} is not a class: {other:?}")),
        }
    }

    /// A class name, or `None` for index 0 (no super class, an outer class not recorded).
    pub fn opt_class_name(&self, index: u16) -> Result<Option<&str>> {
        if index == 0 { Ok(None) } else { self.class_name(index).map(Some) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modified_utf8() {
        assert_eq!(decode_mutf8(b"java/lang/Object"), "java/lang/Object");
        // NUL as C0 80, "é" as C3 A9, U+1F600 as a surrogate pair of 3-byte sequences.
        let bytes = [0x61, 0xC0, 0x80, 0xC3, 0xA9, 0xED, 0xA0, 0xBD, 0xED, 0xB8, 0x80];
        assert_eq!(decode_mutf8(&bytes), "a\u{0}é😀");
    }

    #[test]
    fn cursor_bounds() {
        let mut c = Cursor::new(&[0, 1, 2]);
        assert_eq!(c.u16().unwrap(), 1);
        assert!(c.u16().is_err());
    }
}
