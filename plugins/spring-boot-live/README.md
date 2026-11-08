# luma-spring-boot-live

The Spring Boot live data sidecar behind the Run tool window's Beans / Health / Mappings /
Environment views (IDEA's Actuator tab). Bundled into the app (`include_bytes!` in
`crates/ide-host/src/ops/spring_boot_live.rs`) and started on demand with the project JDK.

- Attaches to local JVMs with the Attach API (same user only) and starts their local JMX
  agent when needed — no TCP port is opened.
- Finds the application by the `-Dluma.run.session=<marker>` system property Luma's launch
  hook adds (or by PID), then reads Spring Boot's Admin MBean and Actuator endpoint MBeans.
- Protocol: one JSON request per stdin line, one JSON response per stdout line (see the
  header of `Main.java`). No dependencies.

Build (JDK 17+; the jar is checked in):

```sh
plugins/spring-boot-live/build.sh
```
