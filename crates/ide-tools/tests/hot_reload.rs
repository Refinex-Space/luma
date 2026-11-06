//! Hot reload end to end: downloads JetBrains Runtime 21 and HotswapAgent the way the IDE
//! does, starts `fixtures/spring-boot-hot-reload` with the planned JVM options, then
//! changes the running application — a new field, method and `@GetMapping`, and a property
//! — and reads the changes over HTTP without a restart.
//!
//! `cargo test -p ide-tools --test hot_reload -- --ignored --nocapture`
//! Needs network (or a warm `LUMA_TEST_HOT_RELOAD_TOOLS` directory) and Maven with the
//! Spring Boot artifacts; `LUMA_TEST_SPRING_BOOT=4.1.2` tries another Spring Boot.
use ide_core::CancellationToken;
use ide_core::hot_reload::HotReloadSettings;
use ide_tools::hot_reload::{HotReloadLaunch, JbrRelease, LaunchInput, java_major, plan_launch};
use ide_tools::platform::Platform;
use ide_tools::{InstallEvent, Tools};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Kill(Child);
impl Drop for Kill {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type().unwrap().is_dir() {
            copy_dir(&src, &dst)
        } else {
            std::fs::copy(&src, &dst).map(|_| ()).unwrap()
        }
    }
}

fn get(port: u16, path: &str) -> Option<(u16, String)> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").ok()?;
    let mut out = String::new();
    s.read_to_string(&mut out).ok()?;
    let status = out.split_whitespace().nth(1)?.parse().ok()?;
    let body = out.split("\r\n\r\n").nth(1).unwrap_or("").to_owned();
    // Chunked bodies: the payload is the second line.
    let body = if out.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        body.lines().nth(1).unwrap_or("").to_owned()
    } else {
        body
    };
    Some((status, body))
}

fn wait_for(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    panic!("timed out waiting for {what}");
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

#[test]
#[ignore = "downloads JetBrains Runtime (~230 MB) and HotswapAgent; needs Maven and Spring Boot artifacts"]
fn spring_boot_reloads_without_a_restart() {
    if Command::new("mvn").arg("-v").output().is_err() {
        eprintln!("SKIP: Maven is not on PATH");
        return;
    }
    let keep = std::env::var_os("LUMA_TEST_HOT_RELOAD_TOOLS").map(PathBuf::from);
    let tmp = tempfile::tempdir().unwrap();
    let tools_dir = keep.unwrap_or_else(|| tmp.path().join("tools"));
    let tools = Tools::with_paths(tools_dir, std::env::var_os("PATH").unwrap_or_default(), Platform::current());
    let cancel = CancellationToken::new();
    let emit = |e: InstallEvent| {
        if let InstallEvent::Line { text } = e {
            eprintln!("  {text}");
        }
    };
    let agent = tools.install_hotswap_agent(&cancel, &emit).expect("HotswapAgent");
    let jbr = tools.install_jbr(21, &cancel, &emit).expect("JetBrains Runtime 21");
    assert_eq!(java_major(&jbr), Some(21));
    // Installed: found again without downloading.
    assert!(tools.hot_reload_runtimes().iter().any(|r| r.major == 21 && r.home.is_some()));

    let app = tmp.path().join("app");
    copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/spring-boot-hot-reload"), &app);
    if let Ok(v) = std::env::var("LUMA_TEST_SPRING_BOOT") {
        let pom = app.join("pom.xml");
        let text = std::fs::read_to_string(&pom)
            .unwrap()
            .replace("<version>3.5.16</version>", &format!("<version>{v}</version>"));
        std::fs::write(&pom, text).unwrap();
    }
    let mvn = Command::new("mvn")
        .args(["-q", "-o", "compile", "dependency:build-classpath", "-Dmdep.outputFile=cp.txt"])
        .current_dir(&app)
        .env("JAVA_HOME", &jbr)
        .status()
        .unwrap();
    assert!(mvn.success(), "mvn compile (offline) failed: are the Spring Boot artifacts in ~/.m2?");
    let classes = app.join("target/classes");
    let sep = if cfg!(windows) { ";" } else { ":" };
    let cp = format!("{}{sep}{}", classes.display(), std::fs::read_to_string(app.join("cp.txt")).unwrap().trim());

    let settings = HotReloadSettings { enabled: true, ..Default::default() };
    let props = tmp.path().join("hot-reload/app.properties");
    let home = |r: &JbrRelease| tools.jbr_home(r);
    let (plan, text) = plan_launch(&LaunchInput {
        settings: &settings,
        project_major: Some(21),
        debug: false,
        agent: Some(agent),
        runtime_home: &home,
        properties_file: &props,
        class_dirs: &[],
        platform: Platform::current(),
    });
    let HotReloadLaunch::Ready { java_exec, vm_args, .. } = plan else { panic!("{plan:?}") };
    std::fs::create_dir_all(props.parent().unwrap()).unwrap();
    std::fs::write(&props, text.unwrap()).unwrap();

    let port = free_port();
    let log = std::fs::File::create(tmp.path().join("app.log")).unwrap();
    let child = Command::new(java_exec.unwrap())
        .args(&vm_args)
        .args(["-cp", &cp, "com.example.demo.DemoApplication", &format!("--server.port={port}")])
        .current_dir(&app)
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .unwrap();
    let _app = Kill(child);
    let logs = || std::fs::read_to_string(tmp.path().join("app.log")).unwrap_or_default();
    wait_for("the application to start", 90, || get(port, "/hello").is_some_and(|(s, _)| s == 200));
    assert_eq!(get(port, "/hello").unwrap().1, "Hello, v1");
    assert!(logs().contains("HOTSWAP AGENT"), "the agent did not load:\n{}", logs());

    // A new field with an initializer, a new method and a new endpoint, compiled the way jdtls does.
    let src = app.join("src/main/java/com/example/demo/GreetingController.java");
    let code = std::fs::read_to_string(&src).unwrap();
    let code = code
        .replace("    private String greeting;", "    private String greeting;\n\n    private String tag = \"reloaded\";")
        .replace("greeting + \", v1\"", "greeting + \", v2 \" + suffix()")
        .replace(
            "        return greeting + \", v2 \" + suffix();\n    }",
            "        return greeting + \", v2 \" + suffix();\n    }\n\n    private String suffix() {\n        return \"(\" + tag + \")\";\n    }\n\n    @GetMapping(\"/added\")\n    public String added() {\n        return \"added \" + tag;\n    }",
        );
    std::fs::write(&src, code).unwrap();
    let javac = jbr.join("bin").join(if cfg!(windows) { "javac.exe" } else { "javac" });
    let ok = Command::new(javac).args(["-d", &classes.to_string_lossy(), "-cp", &cp]).arg(&src).status().unwrap();
    assert!(ok.success());
    let compiled = Instant::now();
    let reloaded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wait_for("the new endpoint", 90, || get(port, "/added").is_some_and(|(s, b)| s == 200 && b == "added reloaded"))
    }));
    eprintln!("class change live {} ms after compiling", compiled.elapsed().as_millis());
    if reloaded.is_err() {
        let agent_lines: Vec<_> = logs().lines().filter(|l| l.contains("HOTSWAP AGENT")).map(str::to_owned).collect();
        panic!("the new endpoint did not appear; /hello = {:?}\n{}", get(port, "/hello"), agent_lines.join("\n"));
    }
    assert_eq!(get(port, "/hello").unwrap().1, "Hello, v2 (reloaded)", "\n{}", logs());

    // A property, as jdtls copies resources into the output folder. HotswapAgent 2.0.4 doesn't
    // watch Spring Boot 4's property sources: the IDE asks for a restart there instead.
    let boot = std::env::var("LUMA_TEST_SPRING_BOOT").unwrap_or_else(|_| "3.5.16".into());
    if boot.starts_with('3') || boot.starts_with('2') {
        std::fs::write(classes.join("application.properties"), "app.greeting=Bonjour\nserver.port=8080\n").unwrap();
        let written = Instant::now();
        wait_for("the new property", 30, || get(port, "/hello").is_some_and(|(_, b)| b.starts_with("Bonjour")));
        eprintln!("property change live {} ms after writing", written.elapsed().as_millis());
    } else {
        eprintln!("Spring Boot {boot}: property reload not checked (not supported by HotswapAgent yet)");
    }
    let log_text = logs();
    assert!(log_text.contains("Reloading classes"), "{log_text}");
    eprintln!("{}", log_text.lines().filter(|l| l.contains("HOTSWAP AGENT")).collect::<Vec<_>>().join("\n"));
}
