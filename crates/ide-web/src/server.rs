use ide_core::settings::{BuiltInServerSettings, ReloadMode};
use ide_core::web_browsers::DEFAULT_SERVER_PORT;
use ide_core::{IdeError, IdeResult};
use parking_lot::{Mutex, RwLock};
use percent_encoding::{AsciiSet, CONTROLS, percent_decode_str, utf8_percent_encode};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

const MAX_HEAD: usize = 16 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Query parameter asking for the live reload script, with the page's [`ReloadMode`].
const RELOAD_PARAM: &str = "_lr";
/// The pages' reload channel (server-sent events).
const LIVE_PATH: &str = "/__luma_live";
const PING: Duration = Duration::from_secs(20);
/// A page without a connected tab is forgotten after this long.
const PAGE_TTL: Duration = Duration::from_secs(60);

/// Characters escaped in one URL path segment.
const SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

/// How the server listens: what binding it needs and whether unsigned requests pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Options {
    port: u16,
    external: bool,
    allow_unsigned: bool,
}

impl From<&BuiltInServerSettings> for Options {
    fn from(s: &BuiltInServerSettings) -> Self {
        Self { port: s.effective_port(), external: s.effective_external(), allow_unsigned: s.allow_unsigned_requests }
    }
}

impl Default for Options {
    fn default() -> Self {
        (&BuiltInServerSettings::default()).into()
    }
}

/// What a reload tells a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Msg {
    Reload,
    /// Only style sheets changed: swap them without reloading.
    Css,
}

/// A page opened with live reload, and the files it loaded.
struct Page {
    mode: ReloadMode,
    /// Requested paths and their resolved targets.
    files: HashSet<PathBuf>,
    /// URL paths of the resources it loaded (their own requests' referrer).
    resources: HashSet<String>,
    clients: Vec<mpsc::UnboundedSender<Msg>>,
    seen: Instant,
}

struct Shared {
    token: String,
    /// URL key (`/<token>/<key>/…`) → served directory.
    roots: RwLock<HashMap<String, PathBuf>>,
    options: RwLock<Options>,
    /// Live reload pages by key (`<mode>:<url path>`).
    pages: Mutex<HashMap<String, Page>>,
}

struct Running {
    port: u16,
    external: bool,
    accept: tokio::task::JoinHandle<()>,
}

/// The built-in web server; started on the first [`WebServer::url_for`] and restarted when its
/// port or binding changes ([`WebServer::configure`]).
pub struct WebServer {
    shared: Arc<Shared>,
    running: tokio::sync::Mutex<Option<Running>>,
}

impl Default for WebServer {
    fn default() -> Self {
        Self::new()
    }
}

impl WebServer {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                token: uuid::Uuid::new_v4().simple().to_string(),
                roots: RwLock::default(),
                options: RwLock::new(Options::default()),
                pages: Mutex::default(),
            }),
            running: tokio::sync::Mutex::new(None),
        }
    }

    /// Applies Settings › Tools › Web Browsers and Preview › Built-in Server. A new port or
    /// binding stops the listener; the next URL starts it again.
    pub async fn configure(&self, settings: &BuiltInServerSettings) {
        let next = Options::from(settings);
        *self.shared.options.write() = next;
        let mut running = self.running.lock().await;
        if running.as_ref().is_some_and(|r| r.port != next.port || r.external != next.external)
            && let Some(r) = running.take()
        {
            r.accept.abort();
            tracing::info!("built-in web server on port {} stopped", r.port);
        }
    }

    /// The URL serving `file`: under `root` (the project) when it contains the file, else under
    /// the file's directory. A reload mode other than `Disabled` asks for the live reload script.
    /// Starts the server if needed.
    pub async fn url_for(&self, root: Option<&Path>, file: &Path, reload: ReloadMode) -> IdeResult<String> {
        let base = match root {
            Some(r) if file.starts_with(r) && file != r => r,
            _ => file.parent().ok_or_else(|| IdeError::invalid(format!("no directory: {}", file.display())))?,
        };
        let rel = file.strip_prefix(base).map_err(|e| IdeError::internal(e.to_string()))?;
        let port = self.port().await?;
        let key = self.register(base);
        let mut url = format!("http://127.0.0.1:{port}/{}/{}", self.shared.token, enc(&key));
        for c in rel.components() {
            url.push('/');
            url.push_str(&enc(&c.as_os_str().to_string_lossy()));
        }
        if reload != ReloadMode::Disabled {
            url.push_str(&format!("?{RELOAD_PARAM}={}", mode_name(reload)));
        }
        Ok(url)
    }

    /// Files changed on disk: pages that loaded one of them reload (or swap their style sheets).
    pub fn files_changed<'a>(&self, paths: impl IntoIterator<Item = &'a Path>) {
        let changed: Vec<&Path> = paths.into_iter().collect();
        if changed.is_empty() {
            return;
        }
        let mut pages = self.shared.pages.lock();
        sweep(&mut pages);
        for page in pages.values_mut() {
            let hit: Vec<&&Path> = changed.iter().filter(|p| page.files.contains(**p)).collect();
            if hit.is_empty() {
                continue;
            }
            let msg = if hit.iter().all(|p| is_css(p)) { Msg::Css } else { Msg::Reload };
            page.clients.retain(|c| c.send(msg).is_ok());
        }
    }

    /// Whether a page reloading on change loaded `path`: its edits are saved as they are typed.
    pub fn tracked_on_change(&self, path: &Path) -> bool {
        let mut pages = self.shared.pages.lock();
        sweep(&mut pages);
        pages.values().any(|p| p.mode == ReloadMode::OnChange && p.files.contains(path))
    }

    /// The key `dir` is served under: its name, made unique.
    fn register(&self, dir: &Path) -> String {
        let mut roots = self.shared.roots.write();
        if let Some((k, _)) = roots.iter().find(|(_, d)| d.as_path() == dir) {
            return k.clone();
        }
        let name: String = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
            .chars()
            .map(|c| if c.is_alphanumeric() || "._-".contains(c) { c } else { '_' })
            .collect();
        let name = if name.is_empty() || name == "." || name == ".." || name.starts_with("__") {
            "root".to_string()
        } else {
            name
        };
        let key = (1..)
            .map(|i| if i == 1 { name.clone() } else { format!("{name}-{i}") })
            .find(|k| !roots.contains_key(k) && *k != self.shared.token)
            .expect("unbounded");
        roots.insert(key.clone(), dir.to_path_buf());
        key
    }

    async fn port(&self) -> IdeResult<u16> {
        let mut running = self.running.lock().await;
        if let Some(r) = running.as_ref()
            && !r.accept.is_finished()
        {
            return Ok(r.port);
        }
        let options = *self.shared.options.read();
        let host = if options.external { "0.0.0.0" } else { "127.0.0.1" };
        let listener = match TcpListener::bind((host, options.port)).await {
            Ok(l) => l,
            // The default port may be IDEA's own: any free port serves as well. A port the user
            // chose must be that one.
            Err(_) if options.port == DEFAULT_SERVER_PORT => {
                TcpListener::bind((host, 0)).await.map_err(|e| cannot_start(options.port, &e))?
            }
            Err(e) => return Err(cannot_start(options.port, &e)),
        };
        let port = listener.local_addr().map_err(|e| cannot_start(options.port, &e))?.port();
        let shared = self.shared.clone();
        let accept = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((sock, _)) => {
                        let shared = shared.clone();
                        tokio::spawn(async move {
                            if let Err(e) = serve(sock, &shared, port).await {
                                tracing::debug!("web server: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        tracing::warn!("web server accept: {e}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        });
        tracing::info!("built-in web server on {host}:{port}");
        *running = Some(Running { port, external: options.external, accept });
        Ok(port)
    }
}

fn cannot_start(port: u16, e: &std::io::Error) -> IdeError {
    IdeError::unavailable(format!(
        "Cannot start the built-in server on port {port} ({e}). Make sure the port is free, or choose another one in Settings › Tools › Web Browsers and Preview."
    ))
}

fn mode_name(mode: ReloadMode) -> &'static str {
    match mode {
        ReloadMode::Disabled => "disabled",
        ReloadMode::OnSave => "onSave",
        ReloadMode::OnChange => "onChange",
    }
}

fn parse_mode(s: &str) -> Option<ReloadMode> {
    match s {
        "onSave" => Some(ReloadMode::OnSave),
        "onChange" => Some(ReloadMode::OnChange),
        _ => None,
    }
}

fn is_css(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("css"))
}

/// Forgets pages no tab has listened to for a while.
fn sweep(pages: &mut HashMap<String, Page>) {
    pages.retain(|_, p| {
        p.clients.retain(|c| !c.is_closed());
        !p.clients.is_empty() || p.seen.elapsed() < PAGE_TTL
    });
}

fn enc(s: &str) -> String {
    utf8_percent_encode(s, SEGMENT).to_string()
}

struct Request {
    method: String,
    target: String,
    host: Option<String>,
    referer: Option<String>,
}

async fn read_head(sock: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut reader = BufReader::new(sock).take(MAX_HEAD as u64);
    let mut line = String::new();
    if reader.read_line(&mut line).await? == 0 {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else { return Ok(None) };
    let (method, target) = (method.to_string(), target.to_string());
    let (mut host, mut referer) = (None, None);
    loop {
        line.clear();
        if reader.read_line(&mut line).await? == 0 {
            return Ok(None);
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((name, value)) = l.split_once(':') {
            if name.eq_ignore_ascii_case("host") {
                host = Some(value.trim().to_ascii_lowercase());
            } else if name.eq_ignore_ascii_case("referer") {
                referer = Some(value.trim().to_string());
            }
        }
    }
    Ok(Some(Request { method, target, host, referer }))
}

enum Response {
    /// `path` is the resolved file to open; `mime` comes from the requested name.
    File {
        path: PathBuf,
        len: u64,
        mime: &'static str,
    },
    /// An HTML page with the live reload script.
    Page(Vec<u8>),
    Redirect(String),
    Error(u16, &'static str),
}

/// A request's path, its query parameters and the file it names (when it resolves to one).
struct Resolved {
    response: Response,
    /// The requested path (under the served root) and its target, for live reload.
    files: Vec<PathBuf>,
}

async fn serve(mut sock: TcpStream, shared: &Shared, port: u16) -> std::io::Result<()> {
    let Ok(head) = tokio::time::timeout(READ_TIMEOUT, read_head(&mut sock)).await else { return Ok(()) };
    let Some(req) = head? else { return Ok(()) };
    let head_only = req.method == "HEAD";
    let options = *shared.options.read();
    let (path, query) = split_target(&req.target);
    let response = if !matches!(req.method.as_str(), "GET" | "HEAD") {
        Response::Error(405, "Method Not Allowed")
    } else if !host_allowed(req.host.as_deref(), port, options.external) {
        Response::Error(403, "Forbidden")
    } else if path == LIVE_PATH {
        return live(sock, shared, query).await;
    } else {
        let resolved = resolve(shared, path, options.allow_unsigned).await;
        track(shared, path, query, req.referer.as_deref(), resolved).await
    };
    let mut out = String::new();
    match &response {
        Response::File { len, mime, .. } => {
            out.push_str("HTTP/1.1 200 OK\r\n");
            out.push_str(&format!("Content-Type: {mime}\r\nContent-Length: {len}\r\n"));
        }
        Response::Page(body) => {
            out.push_str("HTTP/1.1 200 OK\r\n");
            out.push_str(&format!("Content-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n", body.len()));
        }
        Response::Redirect(to) => {
            out.push_str(&format!("HTTP/1.1 301 Moved Permanently\r\nLocation: {to}\r\nContent-Length: 0\r\n"));
        }
        Response::Error(code, reason) => {
            out.push_str(&format!(
                "HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\n",
                reason.len()
            ));
        }
    }
    out.push_str("Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n");
    sock.write_all(out.as_bytes()).await?;
    if !head_only {
        match response {
            Response::File { path, .. } => {
                let mut file = tokio::fs::File::open(&path).await?;
                tokio::io::copy(&mut file, &mut sock).await?;
            }
            Response::Page(body) => sock.write_all(&body).await?,
            Response::Error(_, reason) => sock.write_all(reason.as_bytes()).await?,
            Response::Redirect(_) => {}
        }
    }
    sock.shutdown().await
}

fn split_target(target: &str) -> (&str, &str) {
    let target = target.split('#').next().unwrap_or("");
    target.split_once('?').unwrap_or((target, ""))
}

fn param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == name).then(|| dec(&v.replace('+', " "))).flatten()
    })
}

/// The path of a `Referer` URL, if it points at this server's pages.
fn referer_path(referer: &str) -> Option<&str> {
    let rest = referer.split_once("://")?.1;
    let path = &rest[rest.find('/')?..];
    Some(path.split(['?', '#']).next().unwrap_or(path))
}

/// Records a page opened with live reload (and gives it the script), or a resource one loaded.
async fn track(shared: &Shared, path: &str, query: &str, referer: Option<&str>, r: Resolved) -> Response {
    if r.files.is_empty() {
        return r.response;
    }
    let mode = param(query, RELOAD_PARAM).as_deref().and_then(parse_mode);
    if let (Some(mode), Response::File { path: real, mime, .. }) = (mode, &r.response)
        && mime.starts_with("text/html")
    {
        let key = format!("{}:{path}", mode_name(mode));
        {
            let mut pages = shared.pages.lock();
            sweep(&mut pages);
            let page = pages.entry(key.clone()).or_insert_with(|| Page {
                mode,
                files: HashSet::new(),
                resources: HashSet::new(),
                clients: Vec::new(),
                seen: Instant::now(),
            });
            page.seen = Instant::now();
            page.files.extend(r.files.iter().cloned());
        }
        return match tokio::fs::read(real).await {
            Ok(html) => Response::Page(inject(&html, &key)),
            Err(_) => Response::Error(404, "Not Found"),
        };
    }
    // A resource: of the page that loaded it, or of a resource of one (a style sheet's fonts).
    if let Some(from) = referer.and_then(referer_path) {
        let mut pages = shared.pages.lock();
        for (key, page) in pages.iter_mut() {
            let page_path = key.split_once(':').map_or("", |(_, p)| p);
            if page_path == from || page.resources.contains(from) {
                page.files.extend(r.files.iter().cloned());
                page.resources.insert(path.to_owned());
            }
        }
    }
    r.response
}

/// The live reload script, before `</body>` (or at the end).
fn inject(html: &[u8], key: &str) -> Vec<u8> {
    let key = serde_json_str(key);
    let script = format!(
        "<script>(function(){{var es=new EventSource('{LIVE_PATH}?page='+encodeURIComponent({key}));\
es.onmessage=function(e){{if(e.data==='reload'){{location.reload();return;}}\
if(e.data==='css'){{var n=Date.now();document.querySelectorAll('link[rel~=\"stylesheet\"]').forEach(function(l){{\
var u=new URL(l.href);u.searchParams.set('_lr_v',n);var c=l.cloneNode();c.href=u.href;\
c.onload=function(){{l.remove();}};l.after(c);}});}}}};}})();</script>"
    );
    let lower = html.to_ascii_lowercase();
    let at = find_last(&lower, b"</body>").or_else(|| find_last(&lower, b"</html>")).unwrap_or(html.len());
    let mut out = Vec::with_capacity(html.len() + script.len());
    out.extend_from_slice(&html[..at]);
    out.extend_from_slice(script.as_bytes());
    out.extend_from_slice(&html[at..]);
    out
}

fn find_last(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).rposition(|w| w == needle)
}

/// `s` as a JavaScript string literal that cannot close the `<script>` element.
fn serde_json_str(s: &str) -> String {
    let mut out = String::from("'");
    for c in s.chars() {
        match c {
            '\'' | '\\' | '<' | '>' | '&' | '"' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// A page's reload channel: server-sent events until the tab goes away.
async fn live(mut sock: TcpStream, shared: &Shared, query: &str) -> std::io::Result<()> {
    let key = param(query, "page").unwrap_or_default();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let known = match shared.pages.lock().get_mut(&key) {
        Some(page) => {
            page.seen = Instant::now();
            page.clients.push(tx);
            true
        }
        None => false,
    };
    if !known {
        let body = "Not Found";
        let head = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(head.as_bytes()).await?;
        return sock.shutdown().await;
    }
    sock.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n: live\n\n",
    )
    .await?;
    let mut ping = tokio::time::interval(PING);
    ping.tick().await;
    loop {
        tokio::select! {
            msg = rx.recv() => {
                let Some(msg) = msg else { break };
                let data = match msg { Msg::Reload => "reload", Msg::Css => "css" };
                sock.write_all(format!("data: {data}\n\n").as_bytes()).await?;
            }
            _ = ping.tick() => sock.write_all(b": ping\n\n").await?,
        }
    }
    Ok(())
}

fn host_allowed(host: Option<&str>, port: u16, external: bool) -> bool {
    // Listening on every interface, the server answers to the machine's other names too.
    external || host.is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"))
}

async fn resolve(shared: &Shared, path: &str, allow_unsigned: bool) -> Resolved {
    const NOT_FOUND: Resolved = Resolved { response: Response::Error(404, "Not Found"), files: Vec::new() };
    let Some(rest) = path.strip_prefix('/') else { return NOT_FOUND };
    let mut segments = rest.split('/').peekable();
    // Signed: `/<token>/<key>/…`. Unsigned (when allowed): `/<key>/…`.
    if segments.peek() == Some(&shared.token.as_str()) {
        segments.next();
    } else if !allow_unsigned {
        return NOT_FOUND;
    }
    let Some(key) = segments.next().and_then(dec) else { return NOT_FOUND };
    let Some(root) = shared.roots.read().get(&key).cloned() else { return NOT_FOUND };
    let Ok(real_root) = tokio::fs::canonicalize(&root).await else { return NOT_FOUND };
    let mut file = root;
    // `/<token>/<key>` names a directory too: it redirects like any other.
    let trailing_slash = path.ends_with('/');
    for seg in segments {
        if seg.is_empty() {
            continue;
        }
        match dec(seg) {
            Some(s) if s != "." && s != ".." && !s.contains(['/', '\\', ':', '\0']) => file.push(s),
            _ => return NOT_FOUND,
        }
    }
    let Some(real) = confined(&real_root, &file).await else { return NOT_FOUND };
    let Ok(meta) = tokio::fs::metadata(&real).await else { return NOT_FOUND };
    if meta.is_dir() {
        // Relative URLs in an index page resolve against the directory.
        if !trailing_slash {
            return Resolved { response: Response::Redirect(format!("{path}/")), files: Vec::new() };
        }
        let index = file.join("index.html");
        let Some(real_index) = confined(&real_root, &index).await else { return NOT_FOUND };
        return match tokio::fs::metadata(&real_index).await {
            Ok(m) if m.is_file() => Resolved {
                response: Response::File { path: real_index.clone(), len: m.len(), mime: content_type(&index) },
                files: vec![index, real_index],
            },
            _ => NOT_FOUND,
        };
    }
    Resolved {
        response: Response::File { path: real.clone(), len: meta.len(), mime: content_type(&file) },
        files: vec![file, real],
    }
}

/// `path` with every symlink resolved, if it still lies inside `real_root` (already
/// canonical). Rejecting `..` segments is not enough: a project can commit symlinks
/// that point anywhere on disk.
async fn confined(real_root: &Path, path: &Path) -> Option<PathBuf> {
    let real = tokio::fs::canonicalize(path).await.ok()?;
    real.starts_with(real_root).then_some(real)
}

fn dec(s: &str) -> Option<String> {
    percent_decode_str(s).decode_utf8().ok().map(|s| s.into_owned())
}

fn content_type(path: &Path) -> &'static str {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" | "xhtml" | "shtml" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" | "webmanifest" => "application/json; charset=utf-8",
        "xml" | "xsl" | "xslt" | "xsd" | "rss" | "atom" => "application/xml; charset=utf-8",
        "txt" | "md" | "csv" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn request(url: &str, host: Option<&str>, referer: Option<&str>) -> String {
        let rest = url.strip_prefix("http://").unwrap();
        let (authority, path) = rest.split_at(rest.find('/').unwrap());
        let mut sock = TcpStream::connect(authority).await.unwrap();
        let host = host.unwrap_or(authority);
        let referer = referer.map(|r| format!("Referer: {r}\r\n")).unwrap_or_default();
        sock.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{referer}\r\n").as_bytes()).await.unwrap();
        let mut out = String::new();
        sock.read_to_string(&mut out).await.unwrap();
        out
    }

    async fn get(url: &str, host: Option<&str>) -> String {
        request(url, host, None).await
    }

    /// A server on a free port, so tests run side by side (and beside a running IDE).
    async fn server(unsigned: bool) -> WebServer {
        let server = WebServer::new();
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        server
            .configure(&BuiltInServerSettings {
                port: free,
                available_externally: false,
                allow_unsigned_requests: unsigned,
            })
            .await;
        server
    }

    #[tokio::test]
    async fn serves_project_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("my app");
        std::fs::create_dir_all(root.join("web/sub")).unwrap();
        std::fs::write(root.join("web/index.html"), "<h1>hi</h1>").unwrap();
        std::fs::write(root.join("web/sub/a b.js"), "export {}").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "no").unwrap();

        let server = server(false).await;
        let url = server.url_for(Some(&root), &root.join("web/index.html"), ReloadMode::Disabled).await.unwrap();
        assert!(url.ends_with("/my_app/web/index.html"), "{url}");
        let page = get(&url, None).await;
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        assert!(page.contains("text/html") && page.ends_with("<h1>hi</h1>"));

        let base = url.trim_end_matches("/web/index.html");
        assert!(get(&format!("{base}/web/sub/a%20b.js"), None).await.contains("text/javascript"));
        assert!(get(&format!("{base}/web"), None).await.contains("Location: /"));
        // The served root itself, so relative URLs of its index page resolve inside it.
        let page = get(base, None).await;
        let root_path = base.trim_start_matches("http://").split_once('/').unwrap().1;
        assert!(page.starts_with("HTTP/1.1 301") && page.contains(&format!("Location: /{root_path}/\r\n")), "{page}");
        assert!(get(&format!("{base}/web/"), None).await.ends_with("<h1>hi</h1>"));
        assert!(get(&format!("{base}/../secret.txt"), None).await.starts_with("HTTP/1.1 404"));
        assert!(get(&format!("{base}/%2e%2e/secret.txt"), None).await.starts_with("HTTP/1.1 404"));
        assert!(get(&format!("{base}/web/..%2f..%2fsecret.txt"), None).await.starts_with("HTTP/1.1 404"));
        // Wrong token, foreign Host (DNS rebinding).
        let other = url.replacen(&server.shared.token, "0123", 1);
        assert!(get(&other, None).await.starts_with("HTTP/1.1 404"));
        assert!(get(&url, Some("evil.example:80")).await.starts_with("HTTP/1.1 403"));
        // Without the token: only when unsigned requests are allowed.
        let unsigned = url.replacen(&format!("/{}", server.shared.token), "", 1);
        assert!(get(&unsigned, None).await.starts_with("HTTP/1.1 404"));
        let settings = BuiltInServerSettings {
            port: url.split(':').nth(2).unwrap().split('/').next().unwrap().parse().unwrap(),
            available_externally: false,
            allow_unsigned_requests: true,
        };
        server.configure(&settings).await;
        assert!(get(&unsigned, None).await.ends_with("<h1>hi</h1>"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_cannot_escape_the_served_root() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("site/escape")).unwrap();
        std::fs::create_dir_all(root.join("site/assets")).unwrap();
        std::fs::write(root.join("site/index.html"), "<h1>hi</h1>").unwrap();
        std::fs::write(root.join("site/assets/app.js"), "export {}").unwrap();
        std::fs::write(root.join("site/raw"), "<p>raw</p>").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "outside").unwrap();
        symlink("index.html", root.join("site/inside.html")).unwrap();
        symlink("assets", root.join("site/lib")).unwrap();
        symlink("raw", root.join("site/raw.html")).unwrap();
        symlink("../../secret.txt", root.join("site/leak.txt")).unwrap();
        symlink("../..", root.join("site/up")).unwrap();
        symlink("/", root.join("site/fsroot")).unwrap();
        symlink("../../../secret.txt", root.join("site/escape/index.html")).unwrap();

        let server = server(false).await;
        let url = server.url_for(Some(&root), &root.join("site/index.html"), ReloadMode::Disabled).await.unwrap();
        let base = url.trim_end_matches("index.html");
        let page = get(&format!("{base}inside.html"), None).await;
        assert!(page.starts_with("HTTP/1.1 200") && page.ends_with("<h1>hi</h1>"), "{page}");
        let page = get(&format!("{base}lib/app.js"), None).await;
        assert!(page.starts_with("HTTP/1.1 200") && page.contains("text/javascript"), "{page}");
        // The type follows the requested name, not the link target.
        let page = get(&format!("{base}raw.html"), None).await;
        assert!(page.contains("text/html") && page.ends_with("<p>raw</p>"), "{page}");

        let secret = dir.path().join("secret.txt");
        let via_fsroot = format!("fsroot{}", secret.display());
        for escape in ["leak.txt", "up/secret.txt", via_fsroot.as_str(), "escape/"] {
            let page = get(&format!("{base}{escape}"), None).await;
            assert!(page.starts_with("HTTP/1.1 404"), "{escape}: {page}");
        }
    }

    #[tokio::test]
    async fn files_outside_the_project_get_their_own_root() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("x/site"), dir.path().join("y/site"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let server = server(false).await;
        let off = ReloadMode::Disabled;
        let ua = server.url_for(None, &a.join("p.html"), off).await.unwrap();
        let ub = server.url_for(Some(&a), &b.join("p.html"), off).await.unwrap();
        assert!(ua.ends_with("/site/p.html") && ub.ends_with("/site-2/p.html"), "{ua} {ub}");
        assert_eq!(server.url_for(None, &a.join("q.html"), off).await.unwrap(), ua.replace("p.html", "q.html"));
    }

    #[tokio::test]
    async fn a_new_port_restarts_the_server() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("p.html"), "<p>x</p>").unwrap();
        let server = server(false).await;
        let off = ReloadMode::Disabled;
        let first = server.url_for(None, &dir.path().join("p.html"), off).await.unwrap();
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        server.configure(&BuiltInServerSettings { port: free, ..Default::default() }).await;
        let second = server.url_for(None, &dir.path().join("p.html"), off).await.unwrap();
        assert!(second.starts_with(&format!("http://127.0.0.1:{free}/")), "{second}");
        assert_ne!(first, second);
        assert!(get(&second, None).await.ends_with("<p>x</p>"));
        // A port in use that the user chose is an error, not another port.
        let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let taken = busy.local_addr().unwrap().port();
        server.configure(&BuiltInServerSettings { port: taken, ..Default::default() }).await;
        let err = server.url_for(None, &dir.path().join("p.html"), off).await.unwrap_err();
        assert!(err.to_string().contains(&taken.to_string()), "{err}");
    }

    #[tokio::test]
    async fn live_reload_follows_the_files_a_page_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("site");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("index.html"), "<html><body><h1>hi</h1></body></html>").unwrap();
        std::fs::write(root.join("app.css"), "h1{}").unwrap();
        std::fs::write(root.join("app.js"), "1").unwrap();
        std::fs::write(root.join("other.js"), "2").unwrap();
        let server = server(false).await;
        let url = server.url_for(Some(&root), &root.join("index.html"), ReloadMode::OnSave).await.unwrap();
        assert!(url.ends_with("/index.html?_lr=onSave"), "{url}");
        let page = get(&url, None).await;
        assert!(page.contains("<script>") && page.contains("</script></body>"), "{page}");
        let len: usize = page.lines().find_map(|l| l.strip_prefix("Content-Length: ")).unwrap().trim().parse().unwrap();
        assert_eq!(len, page.split_once("\r\n\r\n").unwrap().1.len());
        // Without the parameter, the page is served as it is.
        let plain = get(url.split('?').next().unwrap(), None).await;
        assert!(!plain.contains("<script>"));

        let base = url.split('?').next().unwrap().trim_end_matches("index.html").to_owned();
        request(&format!("{base}app.css"), None, Some(&url)).await;
        request(&format!("{base}app.js"), None, Some(&url)).await;

        // A tab listening for reloads.
        let (authority, path) = url.trim_start_matches("http://").split_once('/').unwrap();
        let key = format!("onSave:/{}", path.split('?').next().unwrap());
        let mut sock = TcpStream::connect(authority).await.unwrap();
        let q = utf8_percent_encode(&key, percent_encoding::NON_ALPHANUMERIC);
        sock.write_all(format!("GET {LIVE_PATH}?page={q} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut reader = BufReader::new(sock);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert!(line.starts_with("HTTP/1.1 200"), "{line}");
        loop {
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            if line.starts_with(": live") {
                break;
            }
        }
        let next = async |reader: &mut BufReader<TcpStream>| {
            let mut l = String::new();
            loop {
                l.clear();
                reader.read_line(&mut l).await.unwrap();
                if let Some(d) = l.strip_prefix("data: ") {
                    return d.trim().to_owned();
                }
            }
        };

        let canon = |p: &str| root.join(p);
        server.files_changed([canon("other.js").as_path()]);
        server.files_changed([canon("app.css").as_path()]);
        assert_eq!(next(&mut reader).await, "css");
        server.files_changed([canon("app.js").as_path(), canon("app.css").as_path()]);
        assert_eq!(next(&mut reader).await, "reload");
        assert!(!server.tracked_on_change(&canon("app.js")));
    }

    #[test]
    fn injects_before_the_body_end() {
        let out = String::from_utf8(inject(b"<p>a</p></BODY></html>", "k'</script>")).unwrap();
        assert!(out.starts_with("<p>a</p><script>") && out.ends_with("</script></BODY></html>"), "{out}");
        assert!(!out.contains("k'</script>"));
        assert!(String::from_utf8(inject(b"<p>a</p>", "k")).unwrap().ends_with("</script>"));
    }
}
