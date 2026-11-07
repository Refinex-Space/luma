# Semantic Java usages and configuration navigation

Spring YAML / properties navigation is described in [CONFIGURATION.md](CONFIGURATION.md).

The app-owned OSGi command `luma.java.usages` returns `{location, kind, access}`.
`kind` retains field/getter/setter/unknown identity for compatibility. Optional
`access` is read/write/readWrite/unknown. Missing access metadata is unknown;
old servers and ordinary LSP locations remain visible under either filter.
An absent or failing extension command uses standard LSP references, without access
classification or toolbar controls. This includes errors during scope widening.
The Rust bridge logs the failure once per project session. Cancelled requests and
changed source documents remain cancelled and do not start a fallback search.
No global `includeAccessors` preference is changed.

## Search scope

An optional fifth argument of `luma.java.usages` selects the scope: `"project"` searches the
same targets in source folders only (Find Usages in Project Files), and only in the projects that
can reference the declaration: its own and those requiring it on their resolved classpath
(a library declaration: every project); anything else (or no argument, as older clients send) keeps JDT LS's own scope, libraries
included (All Places). Matches are taken as `ReferencesHandler` takes them: accurate, in
compilation units.

## Usage counts (`luma.java.usageCounts`)

Backs the "N usages" inlay. Arguments: the declaring file's URI and the targets
`[{line, character, files?}]`. Each target is resolved like `luma.java.usages` and searched with
the same plan (a field with its getter, setter, builder and explicit `@Accessors` methods), but
matches are only counted, per file, without access classification. Returns per target
`{resolved, files: {uri: count}}`.

- Without `files`, a target is counted over the source folders of every Java project
  (`IJavaSearchScope.SOURCES`): libraries cannot refer to project code, and leaving their jars
  out is what makes common names (`get`, `list`, `create`) cheap.
- With `files` (the files the caller found changed), only those are counted; each is refreshed
  from disk first unless open, and every requested file is answered, with 0 when unused.
- Targets whose search names are unique within the request are searched together in one OR
  pattern, so each candidate file is parsed and resolved once. A match is credited to the target
  its identifier names (the last identifier before an argument list); if any match cannot be
  credited, those targets are searched one by one instead. Equal names (overloads, a class and
  its constructors) are always searched one by one.

The Rust side (`ide-host` `ops::java::usages`) keeps the counts per referencing file and asks
only for files whose content or name dependencies changed.

## Search plan and access semantics

For source fields on the verified JDT LS implementation, a single plan merges
field, native getter/setter, native builder and explicit Lombok Accessors targets.
Targets are deduplicated by JDT element identity before search, retaining native
search scope and ranges. Builder results remain unknown. The optimized native
plan is guarded by SHA-256 of ReferencesHandler.class:
`31ff5a10c7d69d58c6a9b619ef17e3ec41b11b545751ba428618a76cc1341064`
(JDT LS 1.63.0.202610191322). Different implementations, non-field selections and
library/decompiled selections retain native discovery plus deduplicated category
searches. This conservative fallback preserves coverage when the server changes;
it does not promise the same speedup on unverified versions.

SearchEngine resolves exact targets. A query-local syntax AST per referenced source
file supplies expression context without another reference search: simple field
assignment is write, compound assignment/increment is readWrite, ordinary field
use is read. Writing an array element or a receiver's member reads the array or
receiver field. Getter/setter call expressions are read/write respectively.
Method references, declarations, unavailable/changed source, and unclassified
search targets remain unknown. No call text or get/set prefix classifies a usage.
Explicit `@Accessors` is resolved to JDT method signatures as in the prior bundle.

For larger result sets, a query-local AST range index avoids repeating NodeFinder
traversals. It indexes only requested exact AST ranges and verified invocation
selector-to-call-end spans; duplicate, recovered, malformed or uncontained ranges
fall back to NodeFinder. Method references do not get invocation aliases. Source
snapshot checks remain per result, and the index is discarded after the query.
There is no cross-request cache or binding-resolution shortcut.

Popup and Find share persisted read/write toolbar switches. Both initially show;
turning the last one off automatically enables the other. Unknown and readWrite
entries survive both single-access modes. Filtered-out selections are not previewed.
Exact original ranges and access metadata survive transfer to Find. Closing or
superseding a popup request prevents late responses from reopening it.

The interaction and primary-field/secondary-accessor design were checked against
[JetBrains IntelliJ Community e992ff4](https://github.com/JetBrains/intellij-community/tree/e992ff4750b4c36afe2caadfa8b191a8f36fb7a2):
`LombokFieldFindUsagesHandlerFactory`, `LombokReadWriteAccessDetector`,
`UsageFilteringRuleStateRWAware`, `ReadAccessFilteringRule`, and
`WriteAccessFilteringRule`. This implementation does not copy those sources and
is not a claim of full IntelliJ feature parity.

## Rebuild and delivery

The checked-in jar is embedded by ide-sdk `include_bytes!`, installed as
`java-usages-1.2.1.jar`, and added alongside existing initialization bundles.
Users need no compiler, Maven or Python. Manifest/install version must change
when replacing the bundle because OSGi caches bundles.

Build dependency: [JDT LS 1.63.0 build 202610191322](https://download.eclipse.org/jdtls/milestones/1.63.0/jdt-language-server-1.63.0-202610191322.tar.gz).
Use its shipped ECJ and plugin jars, with Java 25; emitted bytecode targets Java 21.
The build uses sorted inputs and fixed zip timestamps and does not resolve Maven
artifacts. Check the extracted distribution against `build-dependencies.sha256`
from its root (`sha256sum -c /path/to/build-dependencies.sha256`). Build twice
and compare SHA-256. The prior 1.1.1 output was
`1e569939cba22c7db6e2c9b53de2a4c10ccaabe762a51427119a04af3d974ae4`.
Version 1.2.0 adds the configuration command; its reproducible SHA-256 is
`9140f1d2ecf27eadfe66b40a17daa18a08a65927ebef79456ba55d486ce5eeba`.
Version 1.3.0 adds `luma.java.usageCounts`; it was built against the locally installed
JDT LS 1.62.0 (Homebrew), so its hash is not a reproducible-build reference.
Version 1.2.1 keeps the configuration snapshot across editor open/close, saves of
unrelated content and non-Java resource changes; its reproducible SHA-256 is
`cbae3e3a0bcf2818b4cc9d98998bd9b81f92e1ae7803dc757134485f9776a4e1`.
Rebuilding the 1.3.0 sources against JDT LS 1.63.0 reproduces the committed 1.3.0 jar
(`51bf637409125964743d58a7d0fd41854608b07cc1b8ff88e31aa16c03f71970`).
Version 1.4.0 adds `luma.spring.library` and `luma.spring.locate` (see below); its
reproducible SHA-256 (JDT LS 1.63.0, built twice) is
`ef6b616cd8f4105a9f54391a3de6cb7b34e65be136dc7ed2e136c7839204eed3`.
Version 1.5.0 adds `luma.spring.events` (see below); its reproducible SHA-256 (JDT LS
1.63.0, built twice) is
`b530630915b915e63cb5ab6bfc8c7f5f61d13ffccf13c2ed90b09d49dbc95a03`.
Version 1.6.0 adds `luma.spring.members` (see below); its reproducible SHA-256 (JDT LS
1.63.0, built twice) is
`99466cca1251c1f410b804aebaf402aa7959a168649c00105f1495d5b1782743`.

```sh
export PATH=/path/to/jdk25/bin:$PATH
python3 plugins/java-usages/build.py /path/to/jdtls
```

## Manual upgrades

Rebuilding on a JDT LS upgrade is manual. Updating JDT LS or compiling the app does
not rebuild this jar. A maintainer must:

1. Obtain the intended JDT LS distribution and verify its provenance and plugin hashes.
   Update `build-dependencies.sha256` for the reviewed distribution.
2. Review the internal APIs listed below. Check `ReferencesHandler.class` against
   the native-plan fingerprint; update the guarded plan only after reviewing changes.
3. Bump the bundle version in `MANIFEST.MF` and the installed filename in
   `crates/ide-sdk/src/java.rs` so OSGi does not reuse the old cached bundle.
4. Run `build.py` with that distribution and JDK 25 as shown above. Build twice and
   compare hashes, then run both real-server harnesses and the desktop checks below.
5. Commit the reviewed source, dependency inventory, version changes and rebuilt jar
   together. Test the current and newly supported JDT LS versions before release.

## Real server verification

```sh
python3 plugins/java-usages/tests/verify.py /path/to/jdtls /path/to/lombok.jar
python3 plugins/java-usages/tests/read-write.py /path/to/jdtls /path/to/lombok.jar > /tmp/read-write.json
LUMA_USAGES_INDEX_STRESS=1 python3 plugins/java-usages/tests/read-write.py /path/to/jdtls /path/to/lombok.jar > /tmp/read-write-indexed.json
```

The harnesses select the JDT LS configuration for the current platform. The first
verifies category coverage, standard-reference inclusion, boolean/fluent/prefix/chain
naming, overloads, inheritance and includeAccessors=false. The second checks
structural read/write cases, interface and inherited calls, nested same-line calls,
method references, receiver/array reads and a real cancellation response (`-32800`).

Use the actual desktop app to check read/write toggles, mutual toggle behavior,
Find transfer, persistence and unfiltered non-Java counts with the same fixture.

## Review and manual reproduction

See [the English reproduction guide](tests/REPRODUCE.md) for a small Java/Lombok
fixture, before/after behavior and desktop verification steps.

## Internal API compatibility

This is an app-owned JDT LS extension, not a standard LSP feature. It uses:

- `org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler` and the
  `org.eclipse.jdt.ls.core.delegateCommandHandler` extension point.
- `ReferencesHandler.findReferences` and `search`; the optimized plan also
  reflects its private `getBuilderName(IField)` on the fingerprinted version.
- `JavaLanguageServerPlugin.getPreferencesManager` and the returned preference
  objects (`isIncludeAccessors`).
- `JDTUtils.resolveTypeRoot`, `findElementAtSelection`.
- `org.eclipse.jdt.internal.corext.codemanipulation.GetterSetterUtil`.
- Public JDT model/DOM APIs for exact target identity and source-expression context.

The fingerprint protects native target discovery, not all binary compatibility.
A server update that breaks linkage or command execution falls back to standard
references in the Rust bridge. Results remain visible without classification.
Rebuild and run the real-server and desktop tests when changing the distribution.
The current read/write implementation was tested on JDT LS 1.63.0.202610191322
with Lombok 1.18.48 and Java 25. It is not certified for every milestone.

## Boundaries

- `lombok.config`-only naming, unusual generic spellings, custom capitalization or
  ambiguous annotations retain the prior limitations; no speculative mapping.
- Method references are conservatively unknown rather than asserted immediate reads/writes.
- Constructor initialization is outside this product change.
- Internal JDT APIs still require compatibility testing on updates; guarded native
  planning is intentionally limited to a verified implementation.
- Packaged desktop/macOS WebKit and the user's own project require separate testing.

## Spring library beans (`luma.spring.library`, `luma.spring.locate`)

Backs the library side of the Spring model (`crates/ide-index/src/java/spring/library.rs`).
`luma.spring.library [uri]` answers, for the Java project of `uri`:

- the auto-configurations its classpath registers (`META-INF/spring/…AutoConfiguration.imports`,
  the `EnableAutoConfiguration` key of `META-INF/spring.factories`), with the configurations
  they `@Import` and their nested `@Configuration` classes, which inherit the conditions of
  the class importing or enclosing them;
- each configuration's `@Bean` methods (names, erased return type and type arguments,
  `@Primary`, `autowireCandidate`, `defaultCandidate`, JDT handle) and the
  `@EnableConfigurationProperties` beans (named `prefix-FQN`, as Spring names them);
- `types`: the supertypes (FQNs) of every bean type;
- `web`: Boot's `WebApplicationType.deduceFromClasspath` (`servlet`, `reactive`, `none`).

Decided here, from JDT's classpath: `@ConditionalOnClass`, `@ConditionalOnMissingClass`,
`@ConditionalOnWebApplication`, `@ConditionalOnNotWebApplication`, and Boot's
`PooledDataSourceCondition` / `EmbeddedDatabaseCondition`. Other conditions are returned
(`kind` = simple annotation name, `attrs` = string values) for the client, which knows the
project's own beans. Answers are cached per project by the archive paths, sizes and
modification times of its classpath. `luma.spring.locate [handle]` returns the location of
a library element (class file contents, from the source attachment or decompiled).

`tests/spring-library.py` runs both against a real JDT LS with Spring Boot 4.1.2 and Spring
Framework 7.0.10 jars from the local Maven repository and prints cold and warm timings
(about 3 s cold, under 10 ms warm, for 47 configurations / 62 beans):

```sh
PATH=/path/to/jdk25/bin:$PATH python3 plugins/java-usages/tests/spring-library.py /path/to/jdtls
```

## Spring event publishers (`luma.spring.events`)

Backs the event markers of the Spring model (`crates/ide-index/src/java/spring/features.rs`):
`luma.spring.events [uri]` lists every `publishEvent(…)` call in the workspace's source
folders made on an `org.springframework.context.ApplicationEventPublisher` (an
`ApplicationContext` is one), found with the search engine's index. Each call has its
`uri`, 0-based `line` / `col` and `len` of `publishEvent`, the published object's erased
type (`event`), its supertypes (`supertypes`, `Object` aside) and the enclosing method
(`method`, `Outer.Inner.run()`). A file is parsed with bindings only when its contents
changed since the previous answer; unsaved editor contents (working copies) are what is read.
Calls whose argument does not resolve are left out.

`tests/spring-events.py` checks a call on a publisher and one on an `ApplicationContext`
inside a lambda of a nested class, their types and supertypes, and that an unsaved edit
adds a call (about 2.5 s cold, 15 ms warm):

```sh
PATH=/path/to/jdk25/bin:$PATH python3 plugins/java-usages/tests/spring-events.py /path/to/jdtls
```

## Type members for SpEL (`luma.spring.members`)

Backs completion and navigation in Spring Expression Language (`src/features/spring/spel`):
`luma.spring.members [uri, fqn]` answers, in the Java project of `uri`, the type `fqn` (source
or library, JDK included) with its JDT handle and the public methods and fields it declares
or inherits (overridden ones once, interfaces' members included): name, `static`, parameter
types (simple) and names, the erased qualified return or field type (resolved for source
types), the declaring type and the member's handle (opened with `luma.spring.locate`).
`null` when the type is unknown.

`tests/spring-members.py` checks a JDK type's static and instance members, a Spring
interface's, a source type's with inherited ones and an unknown type (about 3 s cold, under
10 ms warm):

```sh
PATH=/path/to/jdk25/bin:$PATH python3 plugins/java-usages/tests/spring-members.py /path/to/jdtls
```
