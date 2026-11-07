//! The JDK's runtime image (`<jdk>/lib/modules`, the jimage format of `jdk.internal.jimage`),
//! which IDEA reads through its `JrtFileSystem`: the index (header, redirect and offset tables,
//! location attributes, strings) is read once; resource contents are read by position when a
//! class is needed. Resources compressed with the `zip` plugin are inflated; `compact-cp`
//! (string sharing, not used by JDK builds) is reported as unsupported.

use crate::archive::read_at;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const MAGIC: u32 = 0xCAFE_DADA;
const HEADER_SIZE: usize = 7 * 4;
const COMPRESSED_MAGIC: u32 = 0xCAFE_FAFA;
const COMPRESSED_HEADER_SIZE: usize = 4 + 8 + 8 + 4 + 4 + 1;
const HASH_MULTIPLIER: u32 = 0x0100_0193;

const ATTRIBUTE_MODULE: usize = 1;
const ATTRIBUTE_PARENT: usize = 2;
const ATTRIBUTE_BASE: usize = 3;
const ATTRIBUTE_EXTENSION: usize = 4;
const ATTRIBUTE_OFFSET: usize = 5;
const ATTRIBUTE_COMPRESSED: usize = 6;
const ATTRIBUTE_UNCOMPRESSED: usize = 7;
const ATTRIBUTE_COUNT: usize = 8;

fn bad(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

/// One resource: `/java.base/java/util/Map$Entry.class` is module `java.base`, parent
/// `java/util`, base `Map$Entry`, extension `class`.
#[derive(Clone, Debug)]
pub struct Resource {
    pub module: Box<str>,
    pub parent: Box<str>,
    pub base: Box<str>,
    pub extension: Box<str>,
    offset: u64,
    compressed: u64,
    size: u64,
}

pub struct JImage {
    path: PathBuf,
    little_endian: bool,
    table_length: usize,
    /// Header through strings.
    index: Vec<u8>,
    redirect_at: usize,
    offsets_at: usize,
    locations_at: usize,
    strings_at: usize,
}

impl JImage {
    /// `<jdk>/lib/modules`, when the JDK has a runtime image (JDK 9+).
    pub fn of_jdk(home: &Path) -> Option<PathBuf> {
        let p = home.join("lib").join("modules");
        p.is_file().then_some(p)
    }

    pub fn open(path: &Path) -> io::Result<Self> {
        let file = File::open(path)?;
        let head = read_at(&file, 0, HEADER_SIZE)?;
        let little_endian = match u32::from_le_bytes([head[0], head[1], head[2], head[3]]) {
            MAGIC => true,
            _ if u32::from_be_bytes([head[0], head[1], head[2], head[3]]) == MAGIC => false,
            _ => return Err(bad("not a jimage file")),
        };
        let word = |i: usize| {
            let b = [head[i * 4], head[i * 4 + 1], head[i * 4 + 2], head[i * 4 + 3]];
            if little_endian { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) }
        };
        let version = word(1);
        if version >> 16 != 1 {
            return Err(bad(format!("unsupported jimage version {}.{}", version >> 16, version & 0xFFFF)));
        }
        let table_length = word(4) as usize;
        let locations_size = word(5) as usize;
        let strings_size = word(6) as usize;
        let redirect_at = HEADER_SIZE;
        let offsets_at = redirect_at + table_length * 4;
        let locations_at = offsets_at + table_length * 4;
        let strings_at = locations_at + locations_size;
        let index_size = strings_at + strings_size;
        let index = read_at(&file, 0, index_size)?;
        Ok(Self {
            path: path.to_owned(),
            little_endian,
            table_length,
            index,
            redirect_at,
            offsets_at,
            locations_at,
            strings_at,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn u32_at(&self, at: usize) -> u32 {
        let b = [self.index[at], self.index[at + 1], self.index[at + 2], self.index[at + 3]];
        if self.little_endian { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) }
    }

    fn string(&self, offset: u64) -> Option<&str> {
        let start = self.strings_at.checked_add(offset as usize)?;
        let rest = self.index.get(start..)?;
        let end = rest.iter().position(|&b| b == 0)?;
        // Module, package and class names are ASCII or valid UTF-8 in JDK images.
        std::str::from_utf8(&rest[..end]).ok()
    }

    /// The attributes of the location at `offset` in the locations table.
    fn attributes(&self, offset: usize) -> Option<[u64; ATTRIBUTE_COUNT]> {
        let mut out = [0u64; ATTRIBUTE_COUNT];
        let mut i = self.locations_at.checked_add(offset)?;
        loop {
            let byte = *self.index.get(i)?;
            i += 1;
            if byte <= 0x7 {
                return Some(out);
            }
            let kind = (byte >> 3) as usize;
            let len = (byte & 0x7) as usize + 1;
            let mut value = 0u64;
            for _ in 0..len {
                value = (value << 8) | *self.index.get(i)? as u64;
                i += 1;
            }
            if kind < ATTRIBUTE_COUNT {
                out[kind] = value;
            }
        }
    }

    fn resource(&self, attrs: &[u64; ATTRIBUTE_COUNT]) -> Option<Resource> {
        Some(Resource {
            module: self.string(attrs[ATTRIBUTE_MODULE])?.into(),
            parent: self.string(attrs[ATTRIBUTE_PARENT])?.into(),
            base: self.string(attrs[ATTRIBUTE_BASE])?.into(),
            extension: self.string(attrs[ATTRIBUTE_EXTENSION])?.into(),
            offset: attrs[ATTRIBUTE_OFFSET],
            compressed: attrs[ATTRIBUTE_COMPRESSED],
            size: attrs[ATTRIBUTE_UNCOMPRESSED],
        })
    }

    /// Every resource of the image (the `/packages` and `/modules` directory entries included).
    pub fn resources(&self) -> impl Iterator<Item = Resource> + '_ {
        (0..self.table_length).filter_map(move |i| {
            let offset = self.u32_at(self.offsets_at + i * 4) as usize;
            self.resource(&self.attributes(offset)?)
        })
    }

    /// `ImageStringsReader.hashCode`: FNV-1 style over the UTF-8 bytes, kept positive.
    fn hash(name: &str, seed: u32) -> u32 {
        let mut h = seed;
        for &b in name.as_bytes() {
            h = h.wrapping_mul(HASH_MULTIPLIER) ^ b as u32;
        }
        h & 0x7FFF_FFFF
    }

    /// The resource named `/module/parent/base.extension`.
    pub fn find(&self, name: &str) -> Option<Resource> {
        if self.table_length == 0 {
            return None;
        }
        let slot = Self::hash(name, HASH_MULTIPLIER) as usize % self.table_length;
        let redirect = self.u32_at(self.redirect_at + slot * 4) as i32;
        let index = match redirect {
            r if r < 0 => (-1 - r) as usize,
            r if r > 0 => Self::hash(name, r as u32) as usize % self.table_length,
            _ => return None,
        };
        let offset = self.u32_at(self.offsets_at + index * 4) as usize;
        let r = self.resource(&self.attributes(offset)?)?;
        (r.full_name() == name).then_some(r)
    }

    pub fn read(&self, r: &Resource) -> io::Result<Vec<u8>> {
        let file = File::open(&self.path)?;
        let start = self.index.len() as u64 + r.offset;
        if r.compressed == 0 {
            return read_at(&file, start, r.size as usize);
        }
        let mut data = read_at(&file, start, r.compressed as usize)?;
        // Plugins may be stacked: each layer starts with its own header.
        while data.len() >= COMPRESSED_HEADER_SIZE && self.word(&data, 0) == COMPRESSED_MAGIC {
            let uncompressed = self.long(&data, 12) as usize;
            let decompressor = self.word(&data, 20) as u64;
            let name = self.string(decompressor).unwrap_or_default().to_owned();
            let payload = &data[COMPRESSED_HEADER_SIZE..];
            data = match name.as_str() {
                "zip" => {
                    let mut out = Vec::with_capacity(uncompressed);
                    flate2::read::ZlibDecoder::new(payload).read_to_end(&mut out)?;
                    out
                }
                other => return Err(bad(format!("unsupported jimage compression `{other}`"))),
            };
        }
        Ok(data)
    }

    fn word(&self, b: &[u8], at: usize) -> u32 {
        let w = [b[at], b[at + 1], b[at + 2], b[at + 3]];
        if self.little_endian { u32::from_le_bytes(w) } else { u32::from_be_bytes(w) }
    }

    fn long(&self, b: &[u8], at: usize) -> u64 {
        let w: [u8; 8] = b[at..at + 8].try_into().unwrap_or_default();
        if self.little_endian { u64::from_le_bytes(w) } else { u64::from_be_bytes(w) }
    }
}

impl Resource {
    pub fn full_name(&self) -> String {
        let mut s = String::with_capacity(self.module.len() + self.parent.len() + self.base.len() + 12);
        if !self.module.is_empty() {
            s.push('/');
            s.push_str(&self.module);
            s.push('/');
        }
        if !self.parent.is_empty() {
            s.push_str(&self.parent);
            s.push('/');
        }
        s.push_str(&self.base);
        if !self.extension.is_empty() {
            s.push('.');
            s.push_str(&self.extension);
        }
        s
    }

    /// A class of a module (not `module-info`, not the `/packages` / `/modules` directories).
    pub fn is_class(&self) -> bool {
        &*self.extension == "class"
            && &*self.base != "module-info"
            && !matches!(&*self.module, "" | "packages" | "modules")
    }
}
