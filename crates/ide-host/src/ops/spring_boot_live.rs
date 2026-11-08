//! Spring Boot live data (IDEA's Actuator tab): a Java sidecar (`plugins/spring-boot-live`,
//! bundled) attaches to running applications through the Attach API and reads their Actuator
//! endpoints and Admin MBean over the local JMX connector — no port is opened. One sidecar
//! serves every window; it exits when nothing has used it for a while.

use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

const JAR: &[u8] = include_bytes!("../../../../plugins/spring-boot-live/luma-spring-boot-live.jar");
/// The sidecar exits after this long without requests and attachments.
const IDLE: Duration = Duration::from_secs(300);
const TIMEOUT: Duration = Duration::from_secs(30);

type Reply = Result<serde_json::Value, (String, String)>;

struct Sidecar {
    stdin: tokio::sync::Mutex<tokio::process::ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>,
    next: AtomicU64,
    child: Mutex<Option<tokio::process::Child>>,
    last_used: Mutex<Instant>,
    attached: Mutex<usize>,
}

static SIDECAR: LazyLock<tokio::sync::Mutex<Option<Arc<Sidecar>>>> = LazyLock::new(Default::default);

/// The bundled jar, written once per content into the app's data folder.
fn install(data_dir: &Path) -> IdeResult<PathBuf> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    JAR.hash(&mut h);
    let path = data_dir.join(format!("spring-boot-live-{:016x}.jar", h.finish()));
    if std::fs::read(&path).is_ok_and(|b| b == JAR) {
        return Ok(path);
    }
    std::fs::create_dir_all(data_dir)?;
    let tmp = data_dir.join(format!("spring-boot-live-{}.tmp", std::process::id()));
    std::fs::write(&tmp, JAR)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// The `java` the sidecar runs on: the project JDK (any JDK has `jdk.attach`), else the detected one.
fn java(host: &Host, window: &str) -> PathBuf {
    let exe = if cfg!(windows) { "java.exe" } else { "java" };
    if let Ok(project) = host.project(window) {
        let settings = project.settings.effective();
        let home = ide_sdk::apply::project_jdk(&project.root, &settings)
            .map(|j| j.home)
            .or_else(|| project.java_engine.detected_jdk(&project.root));
        if let Some(home) = home {
            let java = home.join("bin").join(exe);
            if java.is_file() {
                return java;
            }
        }
    }
    PathBuf::from(exe)
}

async fn sidecar(host: &Host, window: &str) -> IdeResult<Arc<Sidecar>> {
    let mut slot = SIDECAR.lock().await;
    if let Some(s) = slot.as_ref() {
        let alive = s.child.lock().as_mut().is_some_and(|c| c.try_wait().ok().flatten().is_none());
        if alive {
            return Ok(s.clone());
        }
    }
    let jar = install(&host.local_data_dir.join("spring-boot"))?;
    let mut child = tokio::process::Command::new(java(host, window))
        .arg("-Xmx64m")
        .arg("-XX:+UseSerialGC")
        .arg("-jar")
        .arg(&jar)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| IdeError::invalid(format!("attachFailed: cannot start Java for Spring Boot live data: {e}")))?;
    let stdin = child.stdin.take().ok_or_else(|| IdeError::internal("no stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| IdeError::internal("no stdout"))?;
    let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>> = Arc::default();
    let reader_pending = pending.clone();
    host.runtime.spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            let Some(id) = msg.get("id").and_then(serde_json::Value::as_u64) else { continue };
            let Some(tx) = reader_pending.lock().remove(&id) else { continue };
            let reply = match msg.get("error") {
                Some(e) => Err((
                    e.get("kind").and_then(|k| k.as_str()).unwrap_or("failed").to_owned(),
                    e.get("message").and_then(|k| k.as_str()).unwrap_or("").to_owned(),
                )),
                None => Ok(msg.get("result").cloned().unwrap_or(serde_json::Value::Null)),
            };
            let _ = tx.send(reply);
        }
        // The process ended: fail what is still waiting.
        for (_, tx) in reader_pending.lock().drain() {
            let _ = tx.send(Err(("failed".into(), "The Spring Boot live data process exited".into())));
        }
    });
    let s = Arc::new(Sidecar {
        stdin: tokio::sync::Mutex::new(stdin),
        pending,
        next: AtomicU64::new(1),
        child: Mutex::new(Some(child)),
        last_used: Mutex::new(Instant::now()),
        attached: Mutex::new(0),
    });
    // Idle shutdown.
    let weak = Arc::downgrade(&s);
    host.runtime.spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let Some(s) = weak.upgrade() else { return };
            if *s.attached.lock() == 0 && s.last_used.lock().elapsed() > IDLE {
                if let Some(mut c) = s.child.lock().take() {
                    let _ = c.start_kill();
                }
                return;
            }
        }
    });
    *slot = Some(s.clone());
    Ok(s)
}

async fn request(host: &Host, window: &str, method: &str, params: serde_json::Value) -> IdeResult<serde_json::Value> {
    let s = sidecar(host, window).await?;
    *s.last_used.lock() = Instant::now();
    let id = s.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    s.pending.lock().insert(id, tx);
    let line = serde_json::json!({ "id": id, "method": method, "params": params }).to_string() + "\n";
    {
        let mut stdin = s.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await.map_err(|e| IdeError::internal(e.to_string()))?;
        stdin.flush().await.map_err(|e| IdeError::internal(e.to_string()))?;
    }
    match tokio::time::timeout(TIMEOUT, rx).await {
        Ok(Ok(Ok(v))) => Ok(v),
        // `kind: message`: the views tell the cases apart (actuatorMissing, endpointNotExposed…).
        Ok(Ok(Err((kind, message)))) => Err(IdeError::invalid(format!("{kind}: {message}"))),
        Ok(Err(_)) => Err(IdeError::internal("The Spring Boot live data process exited")),
        Err(_) => {
            s.pending.lock().remove(&id);
            Err(IdeError::invalid("timeout: The application did not answer"))
        }
    }
}

/// Attaches to the JVM started with `-Dluma.run.session=<marker>` (`hint`: its main class), or
/// to process `pid`. Returns a handle.
pub async fn spring_boot_live_attach(
    host: &Host,
    window: &str,
    marker: Option<String>,
    hint: Option<String>,
    pid: Option<String>,
) -> IdeResult<String> {
    host.require_trust(window)?;
    let v = request(host, window, "attach", serde_json::json!({ "marker": marker, "hint": hint, "pid": pid })).await?;
    let handle = v.get("handle").and_then(|h| h.as_str()).ok_or_else(|| IdeError::internal("no handle"))?.to_owned();
    if let Some(s) = SIDECAR.lock().await.as_ref() {
        *s.attached.lock() += 1;
    }
    Ok(handle)
}

/// The application's state: `{ready, port, contextPath, endpoints, …}` as JSON text.
pub async fn spring_boot_live_status(host: &Host, window: &str, handle: String) -> IdeResult<String> {
    Ok(request(host, window, "status", serde_json::json!({ "handle": handle })).await?.to_string())
}

/// An Actuator endpoint's data (`Beans`, `Health`, `Mappings`, `Env`, `Conditions`) as JSON text.
pub async fn spring_boot_live_endpoint(host: &Host, window: &str, handle: String, name: String) -> IdeResult<String> {
    Ok(request(host, window, "endpoint", serde_json::json!({ "handle": handle, "name": name })).await?.to_string())
}

pub async fn spring_boot_live_detach(host: &Host, window: &str, handle: String) -> IdeResult<()> {
    request(host, window, "detach", serde_json::json!({ "handle": handle })).await?;
    if let Some(s) = SIDECAR.lock().await.as_ref() {
        let mut n = s.attached.lock();
        *n = n.saturating_sub(1);
    }
    Ok(())
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("spring_boot_live_attach", |c| async move {
        spring_boot_live_attach(&c.host, &c.window, c.arg("marker")?, c.arg("hint")?, c.arg("pid")?).await
    });
    d.add(
        "spring_boot_live_status",
        |c| async move { spring_boot_live_status(&c.host, &c.window, c.arg("handle")?).await },
    );
    d.add("spring_boot_live_endpoint", |c| async move {
        spring_boot_live_endpoint(&c.host, &c.window, c.arg("handle")?, c.arg("name")?).await
    });
    d.add(
        "spring_boot_live_detach",
        |c| async move { spring_boot_live_detach(&c.host, &c.window, c.arg("handle")?).await },
    );
}
