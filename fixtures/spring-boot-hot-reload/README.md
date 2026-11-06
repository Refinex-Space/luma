# Spring Boot hot reload fixture

A one-controller Spring Boot app for trying **Run with Hot Reload** (Settings › Plugins ›
Hot Reload) and for `cargo test -p ide-tools --test hot_reload -- --ignored`.

Open the folder, start `DemoApplication` with **Run with Hot Reload**, open
<http://localhost:8080/hello>, then edit `GreetingController` (the text, a new field, a new
method, a new `@GetMapping`) or `application.properties` and save: the change is live
without a restart.
