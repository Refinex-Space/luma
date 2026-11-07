//! Jar (zip) archives read the way a class path needs them: the central directory once, then
//! single entries by positional reads on a briefly opened file. Nothing stays open or mapped,
//! so hundreds of jars cost no file handles and a jar rewritten in place (`mvn install`) can't
//! fault the process. ZIP64 archives and archives with a prefix (executable jars with a launch
//! script) are read; encrypted entries are left out.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const EOCD: u32 = 0x0605_4b50;
const ZIP64_LOCATOR: u32 = 0x0706_4b50;
const ZIP64_EOCD: u32 = 0x0606_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const LOCAL: u32 = 0x0403_4b50;
/// Largest comment a zip may carry, plus the fixed EOCD record.
const EOCD_SEARCH: u64 = 0xFFFF + 22;

#[derive(Clone, Debug)]
pub struct Entry {
    pub name: Box<str>,
    /// Offset of the local header, adjusted for any prefix.
    local_header: u64,
    pub compressed_size: u64,
    pub size: u64,
    method: u16,
}

impl Entry {
    pub fn is_dir(&self) -> bool {
        self.name.ends_with('/')
    }
}

pub struct Archive {
    path: PathBuf,
    pub entries: Vec<Entry>,
}

fn bad(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

fn le16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn le32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn le64(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap_or_default())
}

/// Reads exactly `len` bytes at `offset`.
pub(crate) fn read_at(file: &File, offset: u64, len: usize) -> io::Result<Vec<u8>> {
    let mut buf = vec![0u8; len];
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_exact_at(&mut buf, offset)?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut done = 0;
        while done < len {
            let n = file.seek_read(&mut buf[done..], offset + done as u64)?;
            if n == 0 {
                return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
            }
            done += n;
        }
    }
    Ok(buf)
}

impl Archive {
    /// Reads the central directory of `path`.
    pub fn open(path: &Path) -> io::Result<Self> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        if len < 22 {
            return Err(bad("too small for a zip archive"));
        }
        let tail_len = len.min(EOCD_SEARCH);
        let tail = read_at(&file, len - tail_len, tail_len as usize)?;
        let at = (0..=tail.len() - 22)
            .rev()
            .find(|&i| le32(&tail, i) == EOCD)
            .ok_or_else(|| bad("no end of central directory"))?;
        let eocd_pos = len - tail_len + at as u64;
        let mut count = le16(&tail, at + 10) as u64;
        let mut cd_size = le32(&tail, at + 12) as u64;
        let mut cd_offset = le32(&tail, at + 16) as u64;
        let mut cd_end = eocd_pos;
        if count == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF {
            // ZIP64: the locator sits right before the EOCD record.
            if eocd_pos < 20 {
                return Err(bad("missing ZIP64 locator"));
            }
            let loc = read_at(&file, eocd_pos - 20, 20)?;
            if le32(&loc, 0) != ZIP64_LOCATOR {
                return Err(bad("missing ZIP64 locator"));
            }
            let rec_pos = le64(&loc, 8);
            let rec = read_at(&file, rec_pos, 56)?;
            if le32(&rec, 0) != ZIP64_EOCD {
                return Err(bad("bad ZIP64 end of central directory"));
            }
            count = le64(&rec, 32);
            cd_size = le64(&rec, 40);
            cd_offset = le64(&rec, 48);
            cd_end = rec_pos;
        }
        // Bytes before the archive (a launch script): offsets are relative to its start.
        let prefix = cd_end.checked_sub(cd_offset + cd_size).ok_or_else(|| bad("central directory out of range"))?;
        let cd = read_at(&file, cd_offset + prefix, cd_size as usize)?;
        let mut entries = Vec::with_capacity(count.min(1 << 20) as usize);
        let mut i = 0usize;
        while i + 46 <= cd.len() && le32(&cd, i) == CENTRAL {
            let flags = le16(&cd, i + 8);
            let method = le16(&cd, i + 10);
            let mut compressed_size = le32(&cd, i + 20) as u64;
            let mut size = le32(&cd, i + 24) as u64;
            let name_len = le16(&cd, i + 28) as usize;
            let extra_len = le16(&cd, i + 30) as usize;
            let comment_len = le16(&cd, i + 32) as usize;
            let mut local = le32(&cd, i + 42) as u64;
            let name_at = i + 46;
            let extra_at = name_at + name_len;
            let next = extra_at + extra_len + comment_len;
            if next > cd.len() {
                return Err(bad("truncated central directory"));
            }
            // ZIP64 extended information: present fields in order size, compressed, offset.
            let mut e = extra_at;
            while e + 4 <= extra_at + extra_len {
                let id = le16(&cd, e);
                let data_len = le16(&cd, e + 2) as usize;
                if id == 0x0001 {
                    let mut p = e + 4;
                    let end = (p + data_len).min(extra_at + extra_len);
                    for field in [&mut size, &mut compressed_size, &mut local] {
                        if *field == 0xFFFF_FFFF && p + 8 <= end {
                            *field = le64(&cd, p);
                            p += 8;
                        }
                    }
                }
                e += 4 + data_len;
            }
            if flags & 1 == 0 {
                let name = String::from_utf8_lossy(&cd[name_at..extra_at]).into_owned().into_boxed_str();
                entries.push(Entry { name, local_header: local + prefix, compressed_size, size, method });
            }
            i = next;
        }
        Ok(Self { path: path.to_owned(), entries })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The uncompressed content of `entry`.
    pub fn read(&self, entry: &Entry) -> io::Result<Vec<u8>> {
        let file = File::open(&self.path)?;
        read_entry(&file, entry)
    }

    /// Several entries with one open of the file.
    pub fn read_many<'a>(&self, entries: impl IntoIterator<Item = &'a Entry>) -> io::Result<Vec<io::Result<Vec<u8>>>> {
        let file = File::open(&self.path)?;
        Ok(entries.into_iter().map(|e| read_entry(&file, e)).collect())
    }
}

fn read_entry(file: &File, entry: &Entry) -> io::Result<Vec<u8>> {
    let header = read_at(file, entry.local_header, 30)?;
    if le32(&header, 0) != LOCAL {
        return Err(bad(format!("bad local header for {}", entry.name)));
    }
    let data_at = entry.local_header + 30 + le16(&header, 26) as u64 + le16(&header, 28) as u64;
    let raw = read_at(file, data_at, entry.compressed_size as usize)?;
    match entry.method {
        0 => Ok(raw),
        8 => {
            let mut out = Vec::with_capacity(entry.size as usize);
            flate2::read::DeflateDecoder::new(raw.as_slice()).read_to_end(&mut out)?;
            Ok(out)
        }
        m => Err(bad(format!("unsupported compression method {m} for {}", entry.name))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_zip(path: &Path, prefix: &[u8], files: &[(&str, &[u8], bool)]) {
        let mut buf = Vec::new();
        buf.extend_from_slice(prefix);
        {
            let mut cursor = io::Cursor::new(&mut buf);
            cursor.set_position(prefix.len() as u64);
            let mut zip = zip::ZipWriter::new(cursor);
            for (name, data, deflate) in files {
                let method = if *deflate { zip::CompressionMethod::Deflated } else { zip::CompressionMethod::Stored };
                let options = zip::write::SimpleFileOptions::default().compression_method(method);
                zip.start_file(*name, options).unwrap();
                zip.write_all(data).unwrap();
            }
            zip.finish().unwrap();
        }
        std::fs::write(path, buf).unwrap();
    }

    #[test]
    fn reads_stored_and_deflated_entries() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("a.jar");
        let big = b"class bytes ".repeat(1000);
        write_zip(&jar, b"", &[("a/A.class", b"stored", false), ("a/B.class", &big, true), ("META-INF/", b"", false)]);
        let archive = Archive::open(&jar).unwrap();
        let names: Vec<_> = archive.entries.iter().map(|e| &*e.name).collect();
        assert_eq!(names, ["a/A.class", "a/B.class", "META-INF/"]);
        assert_eq!(archive.read(&archive.entries[0]).unwrap(), b"stored");
        assert_eq!(archive.read(&archive.entries[1]).unwrap(), big);
        assert!(archive.entries[2].is_dir());
    }

    #[test]
    fn reads_archives_with_a_launch_script_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("app.jar");
        write_zip(&jar, b"#!/bin/sh\nexec java -jar \"$0\" \"$@\"\n", &[("x/Y.class", b"payload", true)]);
        let archive = Archive::open(&jar).unwrap();
        assert_eq!(archive.read(&archive.entries[0]).unwrap(), b"payload");
    }

    #[test]
    fn rejects_non_archives() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.jar");
        std::fs::write(&f, b"definitely not a zip archive at all").unwrap();
        assert!(Archive::open(&f).is_err());
    }
}
