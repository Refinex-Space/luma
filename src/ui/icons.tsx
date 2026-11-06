/**
 * Icon set: JetBrains new-UI ("expui") icons from intellij-community / intellij-plugins
 * (Apache-2.0 / MIT, see THIRD_PARTY_LICENSES.md), vendored as-is under
 * `./expui/<group>/<name>.svg` with their `_dark` and `@20x20` variants. File types
 * whose JetBrains icons are not open source use Luma's own icons drawn in the same
 * style, under `./luma/<group>/<name>.svg` (paths prefixed `luma/`). Names are the
 * contract used by actions (`Action.icon`) and contributions (`ToolWindowContribution.icon`).
 *
 * Rendering: the SVG markup is bundled as raw strings and inlined, so there are no
 * extra requests and icons can be styled.
 * - Monochrome icons (only the standard greys #6C707E light / #CED0D6 dark) are
 *   rewritten to `currentColor` and drawn once. Colour = `var(--icon-color, currentColor)`:
 *   they inherit the caller's text colour (selected / disabled states keep working);
 *   a container can set `--icon-color` to get PyCharm's muted icon grey.
 * - Coloured icons (file types, symbol nodes, run/debug, status…) keep their own
 *   palette; both variants are inlined and CSS shows the one matching `data-theme`
 *   (`light` → light file, anything else → `_dark`).
 * - `size >= 18` picks the `@20x20` variant when one exists (tool window stripes).
 * - Element ids (clip paths) are made unique per instance: WebKit can't resolve
 *   references into `display: none` subtrees, so ids must never be shared.
 */
import { useId, useMemo, type CSSProperties } from "react";
import clsx from "clsx";
import styles from "./icons.module.css";

const RAW = import.meta.glob<string>(["./expui/**/*.svg", "./luma/**/*.svg"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const ICONS = {
  // Files & folders
  folder: "nodes/folder",
  "folder-open": "nodes/folder",
  "folder-source": "nodes/sourceRoot",
  "folder-test": "nodes/testRoot",
  "folder-resources": "nodes/resourcesRoot",
  "folder-test-resources": "luma/nodes/testResourcesRoot",
  "folder-excluded": "nodes/excludeRoot",
  "folder-library": "nodes/libraryFolder",
  "folder-github": "nodes/folderGithub",
  module: "nodes/module",
  "folder-generated-source": "nodes/generatedSource",
  "folder-generated-test": "nodes/generatedTestRoot",
  "folder-compiled": "nodes/compiledClassesFolder",
  "folder-javadoc": "nodes/javaDocFolder",
  "class-abstract": "nodes/classAbstract",
  record: "nodes/record",
  annotation: "nodes/annotation",
  exception: "nodes/exception",
  "jvm-test": "nodes/test",
  "runnable-mark": "nodes/runnableMark",
  "kotlin-object": "kotlin/objectKotlin",
  "spring-config": "luma/runConfigurations/springBoot",
  "gradle-project": "gradle/gradle",
  "gradle-module": "gradle/gradleSubproject",
  "spring-boot": "luma/runConfigurations/springBoot",
  file: "fileTypes/text",
  "file-unknown": "fileTypes/unknown",
  "file-code": "fileTypes/anyType",
  "file-text": "fileTypes/text",
  "file-json": "fileTypes/json",
  "file-md": "fileTypes/markdown",
  "file-image": "fileTypes/image",
  "file-config": "fileTypes/config",
  "file-python": "fileTypes/python",
  "file-jupyter": "fileTypes/jupyter",
  "file-requirements": "fileTypes/requirements",
  "file-pipenv": "fileTypes/pipenv",
  "file-pyproject": "fileTypes/pyprojectToml",
  "file-js": "fileTypes/javaScript",
  "file-jsx": "luma/fileTypes/jsx",
  "file-ts": "fileTypes/typeScript",
  "file-tsx": "luma/fileTypes/tsx",
  "file-npm": "luma/fileTypes/npm",
  "file-vue": "fileTypes/vue",
  "file-svelte": "luma/fileTypes/svelte",
  "file-jsp": "luma/fileTypes/jsp",
  "file-yaml": "fileTypes/yaml",
  "file-toml": "fileTypes/toml",
  "file-html": "fileTypes/html",
  "file-xhtml": "fileTypes/xhtml",
  "file-css": "fileTypes/css",
  "file-less": "luma/fileTypes/less",
  "file-sass": "luma/fileTypes/sass",
  "file-scss": "luma/fileTypes/scss",
  "file-xml": "fileTypes/xml",
  "file-xsd": "fileTypes/xsd",
  "file-shell": "fileTypes/shell",
  "file-powershell": "luma/fileTypes/powershell",
  "file-windows": "fileTypes/microsoftWindows",
  "file-sql": "fileTypes/sql",
  "file-graphql": "fileTypes/graphql",
  "file-proto": "fileTypes/protoFile",
  "file-csv": "fileTypes/csv",
  "file-properties": "fileTypes/properties",
  "file-ignored": "fileTypes/ignored",
  "file-git": "fileTypes/gitignore",
  "file-archive": "fileTypes/archive",
  "file-binary": "fileTypes/binaryData",
  "file-font": "fileTypes/font",
  "file-patch": "fileTypes/patch",
  "file-java": "fileTypes/java",
  "file-kotlin": "fileTypes/kotlin",
  "file-kotlin-script": "fileTypes/kotlinScript",
  "file-groovy": "fileTypes/groovy",
  "file-gradle": "fileTypes/gradle",
  "file-gradle-kts": "fileTypes/kotlinGradleScript",
  "file-maven": "fileTypes/maven",
  "file-scala": "language/scala",
  "file-php": "language/php",
  "file-perl": "fileTypes/perl",
  "file-c": "fileTypes/c",
  "file-cpp": "fileTypes/cpp",
  "file-h": "fileTypes/h",
  "file-objc": "luma/fileTypes/objectiveC",
  "file-objcpp": "luma/fileTypes/objectiveCpp",
  "file-csharp": "fileTypes/Csharp",
  "file-fsharp": "luma/fileTypes/fsharp",
  "file-swift": "fileTypes/swiftLang",
  "file-go": "luma/fileTypes/go",
  "file-gomod": "luma/fileTypes/goMod",
  "file-gowork": "luma/fileTypes/goWork",
  "file-rust": "fileTypes/rust",
  "file-cargo": "fileTypes/cargo",
  "file-cargo-lock": "fileTypes/cargoLock",
  "file-ruby": "luma/fileTypes/ruby",
  "file-lua": "luma/fileTypes/lua",
  "file-zig": "luma/fileTypes/zig",
  "file-gdscript": "luma/fileTypes/gdscript",
  "file-godot": "luma/fileTypes/godot",
  "file-gdshader": "luma/fileTypes/gdshader",
  "file-asciidoc": "luma/fileTypes/asciidoc",
  "file-d": "luma/fileTypes/d",
  "file-dart": "luma/fileTypes/dart",
  "file-elixir": "luma/fileTypes/elixir",
  "file-erlang": "luma/fileTypes/erlang",
  "file-haskell": "luma/fileTypes/haskell",
  "file-ocaml": "luma/fileTypes/ocaml",
  "file-clojure": "luma/fileTypes/clojure",
  "file-julia": "luma/fileTypes/julia",
  "file-r": "luma/fileTypes/r",
  "file-nix": "luma/fileTypes/nix",
  "file-latex": "luma/fileTypes/latex",
  "file-rst": "fileTypes/rst",
  "file-docker": "fileTypes/docker",
  "file-makefile": "fileTypes/makefile",
  "file-cmake": "luma/fileTypes/cmake",
  "file-bazel": "fileTypes/bazel",
  "file-jenkins": "fileTypes/jenkins",
  "file-terraform": "fileTypes/terraform",
  "file-hcl": "fileTypes/hashiCorp",
  "file-dotenv": "luma/fileTypes/dotenv",
  "file-lock": "luma/fileTypes/lock",
  "file-license": "luma/fileTypes/license",
  "file-readme": "luma/fileTypes/readme",
  "file-log": "luma/fileTypes/log",
  "file-http": "fileTypes/http",
  "file-regexp": "fileTypes/regexp",
  "file-manifest": "fileTypes/manifest",
  "file-idl": "fileTypes/idl",
  // Tool windows (each one distinct)
  "toolwindow-project": "toolwindows/project",
  "toolwindow-structure": "toolwindows/structure",
  "toolwindow-hierarchy": "toolwindows/hierarchy",
  "toolwindow-find": "toolwindows/find",
  "toolwindow-usages": "actions/findEntireFile",
  "toolwindow-bookmarks": "toolwindows/bookmarks",
  "toolwindow-commit": "toolwindows/commit",
  "toolwindow-git": "toolwindows/vcs",
  "toolwindow-terminal": "toolwindows/terminal",
  "toolwindow-run": "toolwindows/run",
  "toolwindow-debug": "toolwindows/debug",
  "toolwindow-problems": "toolwindows/problems",
  "toolwindow-todo": "toolwindows/todo",
  "toolwindow-notifications": "toolwindows/notifications",
  "toolwindow-services": "toolwindows/services",
  "toolwindow-pull-requests": "toolwindows/pullRequests",
  "toolwindow-inspection": "toolwindows/toolWindowInspection",
  "toolwindow-duplicates": "toolwindows/toolWindowDuplicates",
  "toolwindow-changes": "toolwindows/changes",
  "toolwindow-database": "luma/toolwindows/database",
  "toolwindow-agents": "luma/toolwindows/agents",
  "panel-left": "luma/general/panelLeft",
  "panel-bottom": "luma/general/panelBottom",
  "panel-right": "luma/general/panelRight",
  "screen-region": "luma/general/screenRegion",
  skill: "luma/general/skill",
  "panel-left-off": "luma/general/panelLeftOff",
  "panel-bottom-off": "luma/general/panelBottomOff",
  "panel-right-off": "luma/general/panelRightOff",
  // Coding agents (logos via Paseo)
  "agent-claude": "luma/agents/claude",
  "agent-codex": "luma/agents/codex",
  "agent-gemini": "luma/agents/gemini",
  "agent-copilot": "luma/agents/copilot",
  "agent-cursor": "luma/agents/cursor",
  "agent-opencode": "luma/agents/opencode",
  "agent-qwen": "luma/agents/qwen",
  "agent-kimi": "luma/agents/kimi",
  "agent-goose": "luma/agents/goose",
  "agent-auggie": "luma/agents/auggie",
  "agent-kiro": "luma/agents/kiro",
  "agent-vibe": "luma/agents/vibe",
  "agent-agoragentic-acp": "luma/agents/agoragentic-acp",
  "agent-amp-acp": "luma/agents/amp-acp",
  "agent-antigravity-acp": "luma/agents/antigravity-acp",
  "agent-autohand": "luma/agents/autohand",
  "agent-bob": "luma/agents/bob",
  "agent-claude-acp": "luma/agents/claude-acp",
  "agent-cline": "luma/agents/cline",
  "agent-codebuddy-code": "luma/agents/codebuddy-code",
  "agent-codex-acp": "luma/agents/codex-acp",
  "agent-cortex-code": "luma/agents/cortex-code",
  "agent-corust-agent": "luma/agents/corust-agent",
  "agent-crow-cli": "luma/agents/crow-cli",
  "agent-deepagents": "luma/agents/deepagents",
  "agent-devin": "luma/agents/devin",
  "agent-dimcode": "luma/agents/dimcode",
  "agent-dirac": "luma/agents/dirac",
  "agent-factory-droid": "luma/agents/factory-droid",
  "agent-fast-agent": "luma/agents/fast-agent",
  "agent-glm-acp-agent": "luma/agents/glm-acp-agent",
  "agent-grok-build": "luma/agents/grok-build",
  "agent-harn": "luma/agents/harn",
  "agent-junie": "luma/agents/junie",
  "agent-kilo": "luma/agents/kilo",
  "agent-kimchi": "luma/agents/kimchi",
  "agent-minimax-code": "luma/agents/minimax-code",
  "agent-minion-code": "luma/agents/minion-code",
  "agent-nova": "luma/agents/nova",
  "agent-pi-acp": "luma/agents/pi-acp",
  "agent-poolside": "luma/agents/poolside",
  "agent-qoder": "luma/agents/qoder",
  "agent-sigit": "luma/agents/sigit",
  "agent-stakpak": "luma/agents/stakpak",
  "agent-vtcode": "luma/agents/vtcode",
  "toolwindow-maven": "toolwindows/maven",
  "toolwindow-gradle": "toolwindows/gradle",
  "toolwindow-build": "toolwindows/build",
  // General UI
  "chevron-right": "general/chevronRight",
  "chevron-down": "general/chevronDown",
  "chevron-up": "general/chevronUp",
  "chevron-left": "general/chevronLeft",
  "page-first": "actions/playFirst",
  "page-last": "actions/playLast",
  close: "general/close",
  plus: "general/add",
  minus: "general/remove",
  check: "actions/checked",
  more: "general/moreVertical",
  "more-horizontal": "general/moreHorizontal",
  search: "general/search",
  replace: "actions/replace",
  regex: "inline/regex",
  case: "inline/matchCase",
  word: "inline/exactWords",
  "text-match": "luma/nodes/textMatch",
  "open-in-tool-window": "general/openInToolWindow",
  "preserve-case": "luma/inline/preserveCase",
  "new-line": "luma/inline/newLine",
  "search-history": "luma/inline/searchHistory",
  filter: "general/filter",
  refresh: "general/refresh",
  settings: "general/settings",
  layout: "general/layout",
  split: "general/splitVertically",
  "split-horizontal": "general/splitHorizontally",
  "editor-only": "general/editorOnly",
  "editor-preview": "general/editorPreview",
  "preview-only": "general/previewOnly",
  maximize: "image/fitContent",
  "zoom-in": "luma/general/zoomIn",
  "zoom-out": "luma/general/zoomOut",
  "actual-size": "luma/general/actualZoom",
  "fit-width": "luma/general/fitWidth",
  rotate: "luma/general/rotate",
  // Markdown editing (Luma's own, expui style)
  "md-bold": "luma/markdown/bold",
  "md-italic": "luma/markdown/italic",
  "md-strikethrough": "luma/markdown/strikethrough",
  "md-inline-code": "luma/markdown/inlineCode",
  "md-link": "luma/markdown/link",
  "md-text": "luma/markdown/text",
  "md-heading-1": "luma/markdown/heading1",
  "md-heading-2": "luma/markdown/heading2",
  "md-heading-3": "luma/markdown/heading3",
  "md-heading-4": "luma/markdown/heading4",
  "md-heading-5": "luma/markdown/heading5",
  "md-heading-6": "luma/markdown/heading6",
  "md-bullet-list": "luma/markdown/bulletList",
  "md-numbered-list": "luma/markdown/numberedList",
  "md-task-list": "luma/markdown/taskList",
  "md-quote": "luma/markdown/quote",
  "md-code-block": "luma/markdown/codeBlock",
  "md-table": "luma/markdown/table",
  "md-math": "luma/markdown/math",
  "md-diagram": "luma/markdown/diagram",
  "md-divider": "luma/markdown/divider",
  "md-image": "luma/markdown/image",
  "md-callout": "luma/markdown/callout",
  "md-footnote": "luma/markdown/footnote",
  "md-front-matter": "luma/markdown/frontMatter",
  "md-live-preview": "luma/markdown/livePreview",
  "md-source-code": "luma/markdown/sourceCode",
  "md-align-left": "luma/markdown/alignLeft",
  "md-align-center": "luma/markdown/alignCenter",
  "md-align-right": "luma/markdown/alignRight",
  "md-row-above": "luma/markdown/rowAbove",
  "md-row-below": "luma/markdown/rowBelow",
  "md-column-left": "luma/markdown/columnLeft",
  "md-column-right": "luma/markdown/columnRight",
  "md-outline": "luma/markdown/outline",
  minimap: "luma/general/minimap",
  "rainbow-brackets": "luma/general/rainbowBrackets",
  chessboard: "luma/general/chessboard",
  minimize: "general/openInToolWindow",
  "main-menu": "luma/general/mainMenu",
  "window-minimize": "luma/general/windowMinimize",
  "window-maximize": "luma/general/windowMaximize",
  "window-restore": "luma/general/windowRestore",
  "window-close": "luma/general/windowClose",
  hide: "general/hide",
  pin: "general/pin",
  eye: "general/show",
  "show-read-access": "actions/showReadAccess",
  "show-write-access": "actions/showWriteAccess",
  lock: "general/locked",
  unlock: "luma/general/unlocked",
  scratches: "fileTypes/scratches",
  "external-link": "ide/externalLink",
  "collapse-all": "general/collapseAll",
  "expand-all": "general/expandAll",
  locate: "general/locate",
  "autoscroll-to-source": "general/autoscrollToSource",
  "autoscroll-from-source": "general/autoscrollFromSource",
  sort: "objectBrowser/sortAlphabetically",
  copy: "general/copy",
  paste: "general/paste",
  cut: "general/cut",
  trash: "general/delete",
  edit: "general/edit",
  "arrow-left": "general/left",
  "arrow-right": "general/right",
  "arrow-up": "general/up",
  "arrow-down": "general/down",
  undo: "general/undo",
  redo: "general/redo",
  sun: "meetNewUi/lightTheme",
  moon: "meetNewUi/darkTheme",
  list: "general/listFiles",
  keyboard: "general/keyboard",
  bulb: "codeInsight/intentionBulb",
  "bulb-fix": "codeInsight/quickfixBulb",
  package: "nodes/package",
  plugin: "nodes/plugin",
  "soft-wrap": "general/softWrap",
  history: "general/history",
  clock: "general/history",
  bell: "toolwindows/notifications",
  database: "nodes/dataTables",
  "db-table": "luma/database/table",
  "db-view": "luma/database/view",
  "db-column": "luma/database/column",
  "db-columns": "luma/database/columns",
  "db-column-key": "luma/database/columnKey",
  "db-column-fk": "luma/database/columnForeignKey",
  "db-key": "luma/database/key",
  "db-foreign-key": "luma/database/foreignKey",
  "db-index": "luma/database/index",
  "db-schema": "luma/database/schema",
  "db-console": "luma/database/console",
  "db-matview": "luma/database/matview",
  "db-routine": "luma/database/routine",
  "db-trigger": "luma/database/trigger",
  "db-sequence": "luma/database/sequence",
  "db-plan": "luma/database/plan",
  "db-chart": "luma/database/chart",
  "db-sort": "luma/database/sort",
  "db-folder": "luma/database/folder",
  "db-add": "luma/database/addDropdown",
  "db-properties": "luma/database/dataSourceProperties",
  "db-disconnect": "luma/database/disconnect",
  "db-sqlite": "luma/database/sqlite",
  "db-postgres": "luma/database/postgres",
  "db-mysql": "luma/database/mysql",
  "db-redis": "luma/database/redis",
  "db-elasticsearch": "luma/database/elasticsearch",
  "db-sqlserver": "luma/database/sqlserver",
  "db-mariadb": "luma/database/mariadb",
  "db-aurora": "luma/database/aurora",
  "db-redshift": "luma/database/redshift",
  "db-cockroach": "luma/database/cockroach",
  "db-greenplum": "luma/database/greenplum",
  "db-neon": "luma/database/neon",
  "db-oceanbase": "luma/database/oceanbase",
  "db-singlestore": "luma/database/singlestore",
  "db-supabase": "luma/database/supabase",
  "db-tidb": "luma/database/tidb",
  "db-timescale": "luma/database/timescale",
  "db-yugabyte": "luma/database/yugabyte",
  export: "luma/general/export",
  web: "luma/general/web",
  "browser-chrome": "luma/browsers/chrome",
  "browser-chromium": "luma/browsers/chromium",
  "browser-firefox": "luma/browsers/firefox",
  "browser-safari": "luma/browsers/safari",
  "browser-edge": "luma/browsers/edge",
  "browser-brave": "luma/browsers/brave",
  // Tool-window-ish glyphs kept for actions and older callers
  structure: "toolwindows/structure",
  hierarchy: "toolwindows/hierarchy",
  terminal: "toolwindows/terminal",
  problems: "toolwindows/problems",
  todo: "toolwindows/todo",
  bookmark: "bookmarks/bookmark",
  // Status
  error: "status/error",
  warning: "status/warning",
  info: "status/info",
  success: "status/success",
  // Run / debug
  run: "run/run",
  debug: "run/debug",
  "run-coverage": "run/runWithCoverage",
  profile: "run/profile",
  "toolwindow-coverage": "toolwindows/coverage",
  "toolwindow-profiler": "toolwindows/profiler",
  "gutter-run": "gutter/run",
  "gutter-run-all": "actions/runAll",
  "gutter-run-passed": "gutter/runSuccess",
  "gutter-run-failed": "gutter/runError",
  "gutter-implemented": "gutter/implementedMethod",
  "gutter-implementing": "gutter/implementingMethod",
  "gutter-overridden": "gutter/overridenMethod",
  "gutter-overriding": "gutter/overridingMethod",
  stop: "run/stop",
  rerun: "run/rerun",
  "rerun-filled": "run/rerun_stroke",
  "restart-debug": "run/restartDebug",
  "restart-debug-filled": "run/restartDebug_stroke",
  "stop-filled": "run/stop_stroke",
  resume: "run/resume",
  pause: "run/pause",
  "step-over": "run/stepOver",
  "step-into": "run/stepInto",
  "step-out": "run/stepOut",
  "run-to-cursor": "run/runToCursor",
  "force-run-to-cursor": "run/forceRunToCursor",
  "force-step-into": "run/forceStepInto",
  "force-step-over": "run/forceStepOver",
  "smart-step-into": "run/smartStepInto",
  "show-execution-point": "run/showCurrentFrame",
  "reset-frame": "run/restartFrame",
  "attach-to-process": "run/attachToProcess",
  "evaluate-expression": "run/evaluateExpression",
  breakpoint: "breakpoints/breakpoint",
  "breakpoint-disabled": "breakpoints/breakpointDisabled",
  "breakpoint-muted": "breakpoints/breakpointMuted",
  "breakpoint-method": "breakpoints/breakpointMethod",
  "breakpoint-field": "breakpoints/breakpointField",
  "breakpoint-exception": "breakpoints/breakpointException",
  "mute-breakpoint": "run/muteBreakpoints",
  "view-breakpoints": "run/viewBreakpoints",
  // Build tools (Maven / Gradle tool windows)
  "maven-project": "maven/mavenProject",
  "maven-module": "maven/mavenModule",
  "maven-goal": "maven/mavenGoal",
  "maven-plugin": "maven/mavenPlugin",
  "maven-plugin-goal": "maven/mavenPluginGoal",
  "maven-profiles": "maven/mavenProfiles",
  "maven-load-changes": "maven/mavenLoadChanges",
  "gradle-load-changes": "build/gradleLoadChanges",
  "build-task": "externalSystem/task",
  "build-task-group": "build/taskGroup",
  "build-offline": "build/toggleOfflineMode",
  "build-dependencies": "build/dependencyAnalyzer",
  // Build menu (Build Project / Rebuild Project)
  "build-project": "build/build",
  "build-rebuild": "build/rebuild",
  "skip-tests": "run/showIgnored",
  "run-anything": "general/runAnything",
  library: "nodes/library",
  // VCS
  commit: "vcs/commit",
  branch: "general/vcs",
  "git-pull": "vcs/update",
  "git-push": "vcs/push",
  "git-fetch": "vcs/fetch",
  // Branch widget incoming / outgoing markers (dvcs-impl `icons/new`).
  "vcs-incoming": "vcs/changesUpdate@12x12",
  "vcs-outgoing": "vcs/changesPush@12x12",
  diff: "vcs/diff",
  revert: "vcs/revert",
  shelve: "vcs/shelve",
  unshelve: "vcs/unshelve",
  changelist: "vcs/changelist",
  stash: "luma/vcs/stash",
  star: "luma/vcs/favorite",
  "star-outline": "luma/vcs/notFavorite",
  tag: "luma/vcs/tag",
  "current-branch": "luma/vcs/currentBranch",
  // Code review / GitHub pull requests (collaboration-tools, GitHub plugin, DVCS)
  "branch-label": "vcs/branchLabel",
  "current-branch-label": "vcs/currentBranchLabel",
  "github-pr-open": "github/pullRequestOpen",
  "github-pr-closed": "github/pullRequestClosed",
  "github-pr-draft": "github/pullRequestDraft",
  "github-pr-merged": "github/pullRequestMerged",
  "github-review": "github/review",
  "github-review-accepted": "github/reviewAccepted",
  "github-review-rejected": "github/reviewRejected",
  "github-timeline": "github/timeline",
  "github-issue-open": "github/issueOpened",
  "github-issue-closed": "github/issueClosed",
  "github-local-branch": "github/localBranch",
  "github-warning": "github/githubWarning",
  "add-emoji": "github/addEmoji",
  "add-emoji-hovered": "github/addEmojiHovered",
  send: "github/send",
  "send-hovered": "github/sendHovered",
  "review-comment": "github/comment",
  "review-comment-unread": "github/review/commentUnread",
  "review-comment-hovered": "github/review/commentHovered",
  "review-comment-read-many": "github/review/commentReadMany",
  "review-comment-unread-many": "github/review/commentUnreadMany",
  "review-file-unread": "github/review/fileUnread",
  "review-default-avatar": "github/review/defaultAvatar",
  "review-non-mergeable": "github/review/nonMergeable",
  "review-branch-current": "github/review/branchCurrent",
  "inline-add": "inline/inlineAdd",
  "inline-add-hover": "inline/inlineAddHover",
  "edit-source": "actions/editSource",
  "green-checkmark": "general/greenCheckmark",
  // CI / code review status (`CIBuildStatusIcons`)
  "ci-pending": "run/testNotRunYet",
  "ci-failed": "run/testError",
  "ci-skipped": "run/testSkipped",
  "ci-failed-in-progress": "status/failedInProgress",
  // Symbols (also used by `symbol-<kind>`)
  class: "nodes/class",
  interface: "nodes/interface",
  enum: "nodes/enum",
  method: "nodes/method",
  function: "nodes/function",
  field: "nodes/field",
  variable: "nodes/variable",
} as const satisfies Record<string, string>;

type BaseName = keyof typeof ICONS;

// ---------------------------------------------------------------------------
// IDEA symbol kinds. Kinds with an expui node icon render it; the rest fall back
// to a letter badge ("k" for keywords…).

export type SymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "struct"
  | "trait"
  | "method"
  | "function"
  | "constructor"
  | "field"
  | "property"
  | "variable"
  | "constant"
  | "parameter"
  | "module"
  | "namespace"
  | "package"
  | "type"
  | "annotation"
  | "keyword"
  | "snippet"
  | "file"
  | "text";

const SYMBOL_ICONS: Partial<Record<SymbolKind, string>> = {
  class: "nodes/class",
  interface: "nodes/interface",
  enum: "nodes/enum",
  struct: "nodes/record",
  trait: "nodes/interface",
  method: "nodes/method",
  function: "nodes/function",
  constructor: "nodes/constructor",
  field: "nodes/field",
  property: "nodes/property",
  variable: "nodes/variable",
  constant: "nodes/constant",
  parameter: "nodes/parameter",
  module: "nodes/module",
  namespace: "nodes/package",
  package: "nodes/package",
  type: "nodes/type",
  annotation: "nodes/annotation",
  snippet: "nodes/template",
  file: "fileTypes/text",
  text: "fileTypes/text",
};

export type IconName = BaseName | `symbol-${SymbolKind}`;

export const ICON_NAMES = Object.keys(ICONS) as BaseName[];

function iconPath(name: string): string | undefined {
  if (name.startsWith("symbol-")) return SYMBOL_ICONS[name.slice(7) as SymbolKind];
  return (ICONS as Record<string, string>)[name];
}

// ---------------------------------------------------------------------------
// SVG processing

const MONO_LIGHT = "#6c707e";
const MONO_DARK = "#ced0d6";
const COLOR_RE = /#[0-9a-f]{3,8}\b/gi;

interface Variant {
  viewBox: string;
  body: string;
}

interface Prepared {
  viewBox: string;
  /** Markup; element ids carry an `__ID__` placeholder prefix when `hasIds`. */
  html: string;
  hasIds: boolean;
  mono: boolean;
}

function raw(path: string): string | undefined {
  return RAW[path.startsWith("luma/") ? `./${path}.svg` : `./expui/${path}.svg`];
}

/** Drawing attributes of the root `<svg>` that its children inherit; `build` draws them on a `<g>`. */
const INHERITED = /\s((?:fill|fill-rule|clip-rule|fill-opacity|stroke|stroke-[a-z]+))="([^"]*)"/g;

function parse(svg: string): Variant {
  const open = svg.indexOf("<svg");
  const start = svg.indexOf(">", open) + 1;
  const end = svg.lastIndexOf("</svg>");
  const tag = svg.slice(open, start);
  const w = /\bwidth="([\d.]+)"/.exec(tag)?.[1] ?? "16";
  const h = /\bheight="([\d.]+)"/.exec(tag)?.[1] ?? w;
  const viewBox = /\bviewBox="([^"]+)"/.exec(tag)?.[1] ?? `0 0 ${w} ${h}`;
  // The icon's own root is dropped, so a `fill="currentColor"` there would otherwise be lost.
  const inherited = [...tag.matchAll(INHERITED)].filter(([, name, value]) => !(name === "fill" && value === "none"));
  const content = svg
    .slice(start, end)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(title|metadata)\b[\s\S]*?<\/\1>/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\bid="([^"]+)"/g, 'id="__ID__$1"')
    .replace(/url\(#([^)]+)\)/g, "url(#__ID__$1)")
    .replace(/href="#([^"]+)"/g, 'href="#__ID__$1"')
    .trim();
  const body = inherited.length
    ? `<g${inherited.map(([, name, value]) => ` ${name}="${value}"`).join("")}>${content}</g>`
    : content;
  return { viewBox, body };
}

const colours = (s: string) => new Set((s.match(COLOR_RE) ?? []).map((c) => c.toLowerCase()));
const only = (set: Set<string>, c: string) => set.size > 0 && [...set].every((x) => x === c);

const prepared = new Map<string, Prepared | null>();

function build(lightSrc: string, darkSrc: string | undefined, keepColours: boolean): Omit<Prepared, "hasIds"> {
  const light = parse(lightSrc);
  const dark = darkSrc ? parse(darkSrc) : undefined;
  const viewBox = light.viewBox;
  if (!keepColours && only(colours(light.body), MONO_LIGHT) && (!dark || only(colours(dark.body), MONO_DARK))) {
    return { viewBox, html: light.body.replace(COLOR_RE, "currentColor"), mono: true };
  }
  if (!dark) return { viewBox, html: light.body, mono: false };
  const html =
    `<g class="${styles.light}">${light.body.replace(/__ID__/g, "__ID__l")}</g>` +
    `<g class="${styles.dark}">${dark.body.replace(/__ID__/g, "__ID__d")}</g>`;
  return { viewBox, html, mono: false };
}

function prepare(path: string, large: boolean): Prepared | null {
  const key = `${path}|${large ? 20 : 16}`;
  let out = prepared.get(key);
  if (out !== undefined) return out;
  const base = large && raw(`${path}@20x20`) ? `${path}@20x20` : path;
  const lightSrc = raw(base);
  out = null;
  if (lightSrc) {
    const b = build(lightSrc, raw(`${base}_dark`), path.startsWith("breakpoints/"));
    out = { ...b, hasIds: b.html.includes("__ID__") };
  }
  prepared.set(key, out);
  return out;
}

const EMPTY: Prepared = { viewBox: "0 0 16 16", html: "", hasIds: false, mono: true };

const withIds = (p: Prepared, prefix: string) => (p.hasIds ? p.html.replace(/__ID__/g, prefix) : p.html);

// ---------------------------------------------------------------------------

export interface IconProps {
  /** Icon name; unknown names render the generic file icon. `symbol-<kind>` renders a symbol node icon. */
  name: IconName | (string & {});
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Accessible label; icons are decorative (aria-hidden) without one. */
  label?: string;
}

export function Icon({ name, size = 16, className, style, label }: IconProps) {
  const uid = useId();
  const path = iconPath(name);
  const p = (path && prepare(path, size >= 18)) || prepare(ICONS.file, size >= 18) || EMPTY;
  const html = useMemo(() => withIds(p, `i${uid.replace(/[^a-zA-Z0-9_-]/g, "")}-`), [p, uid]);
  if (!path && name.startsWith("symbol-")) {
    return <SymbolBadge kind={name.slice(7)} className={className} style={style} />;
  }
  return (
    <svg
      className={clsx(styles.icon, p.mono && styles.mono, className)}
      style={style}
      width={size}
      height={size}
      viewBox={p.viewBox}
      fill="none"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

let markupSeq = 0;

/** SVG markup for non-React (CodeMirror DOM) callers; `null` when the name is unknown. */
export function iconMarkup(name: string, size = 16, className?: string): string | null {
  const path = iconPath(name);
  const p = path && prepare(path, size >= 18);
  if (!p) return null;
  const cls = clsx(styles.icon, p.mono && styles.mono, className);
  const html = withIds(p, `m${++markupSeq}-`);
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="${p.viewBox}" fill="none" aria-hidden="true" focusable="false">${html}</svg>`;
}

/**
 * Gutter icon markup in the 14px gutter column. The plain play glyph fills its canvas, so it is
 * drawn smaller; the other gutter icons (run-all, status badges, inheritance arrows, file types)
 * carry padding or compose several shapes and need the full 14px to look the same size.
 */
export function gutterIconMarkup(name: string): string | null {
  return iconMarkup(name, name === "gutter-run" ? 12 : 14);
}

/**
 * Like `iconMarkup`, but never `null`: what `<Icon>` renders for unknown names
 * (a symbol letter badge, else the generic file icon). Plain strings, so
 * CodeMirror callers need no React renderer.
 */
export function iconMarkupOrFallback(name: string, size = 16): string {
  const html = iconMarkup(name, size);
  if (html !== null) return html;
  if (name.startsWith("symbol-")) {
    const kind = name.slice(7).replace(/[^\w-]/g, "");
    const letter = symbolLetter(kind).replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    return `<span class="${styles.symbol}" data-kind="${kind}" aria-hidden="true">${letter}</span>`;
  }
  return iconMarkup("file", size) ?? "";
}

export function hasIcon(name: string): boolean {
  return iconPath(name) !== undefined || name.startsWith("symbol-");
}

// ---------------------------------------------------------------------------
// Symbol kind badges

const SYMBOL_LETTERS: Record<SymbolKind, string> = {
  class: "C",
  interface: "I",
  enum: "E",
  struct: "S",
  trait: "T",
  method: "m",
  function: "ƒ",
  constructor: "c",
  field: "f",
  property: "p",
  variable: "v",
  constant: "K",
  parameter: "a",
  module: "M",
  namespace: "N",
  package: "P",
  type: "T",
  annotation: "@",
  keyword: "k",
  snippet: "~",
  file: "F",
  text: "t",
};

export function symbolLetter(kind: string): string {
  return SYMBOL_LETTERS[kind as SymbolKind] ?? kind.charAt(0) ?? "?";
}

/** Symbol kind icon (expui `nodes/*`), or a letter badge for kinds without one. */
export function SymbolBadge({
  kind,
  size = 16,
  className,
  style,
}: {
  kind: SymbolKind | (string & {});
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  if (SYMBOL_ICONS[kind as SymbolKind]) {
    return <Icon name={`symbol-${kind}`} size={size} className={className} style={style} />;
  }
  return (
    <span className={clsx(styles.symbol, className)} style={style} data-kind={kind} aria-hidden>
      {symbolLetter(kind)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// File type icons — the one place that maps file names to icons (project tree,
// editor tabs, Search Everywhere, recent files, VCS trees…). Lookup order: exact
// file name, name patterns, two-part extension (`gradle.kts`), extension.

/** `icon: "a b c"` → `{ a: icon, b: icon, c: icon }`. */
function table(groups: Partial<Record<IconName, string>>): Record<string, IconName> {
  const out: Record<string, IconName> = {};
  for (const [icon, keys] of Object.entries(groups) as [IconName, string][]) {
    for (const key of keys.split(/\s+/)) if (key) out[key] = icon;
  }
  return out;
}

/** Lower-case file names. */
const FILE_NAMES = table({
  "file-docker": "dockerfile containerfile",
  "file-makefile": "makefile gnumakefile bsdmakefile makefile.am makefile.in kbuild",
  "file-cmake": "cmakelists.txt cmakecache.txt",
  "file-perl": "makefile.pl build.pl cpanfile",
  "file-git": ".gitattributes .gitmodules .gitconfig .git-blame-ignore-revs .mailmap",
  "file-ignored":
    ".gitignore .gitignore_global .dockerignore .npmignore .prettierignore .eslintignore .stylelintignore .hgignore .ignore .rgignore " +
    ".fdignore .helmignore .vscodeignore .gcloudignore .slugignore .cfignore .bzrignore .containerignore",
  "file-config":
    ".editorconfig justfile procfile .npmrc .nvmrc .yarnrc .node-version .python-version .ruby-version " +
    ".tool-versions .browserslistrc .pypirc .flake8 .pylintrc pylintrc setup.cfg tox.ini pytest.ini mypy.ini " +
    ".coveragerc .hgrc hgrc credentials .jshintrc .gemrc .clang-format .clang-tidy .clangd .watchmanconfig .arcconfig",
  "file-npm": "package.json",
  "file-lock":
    "package-lock.json npm-shrinkwrap.json pnpm-lock.yaml bun.lockb deno.lock go.sum go.work.sum " + "package.resolved",
  "file-cargo": "cargo.toml",
  "file-cargo-lock": "cargo.lock",
  "file-gomod": "go.mod",
  "file-gowork": "go.work",
  "file-pyproject": "pyproject.toml",
  "file-pipenv": "pipfile",
  "file-python": "sconstruct sconscript",
  "file-ruby":
    "gemfile rakefile podfile vagrantfile brewfile guardfile fastfile appfile capfile dangerfile steepfile " +
    ".irbrc .pryrc",
  "file-shell":
    ".bashrc .bash_profile .bash_login .bash_logout .bash_aliases .profile .zshrc .zshenv .zprofile .zlogin " +
    ".zlogout .kshrc pkgbuild apkbuild .envrc",
  "file-dotenv": ".flaskenv",
  "file-gradle": "gradlew",
  "file-maven": "pom.xml mvnw",
  "file-jenkins": "jenkinsfile",
  "file-bazel": "build workspace .bazelrc .bazelversion",
  "file-terraform": ".terraformrc terraform.rc",
  "file-clojure": "deps.edn project.clj bb.edn",
  "file-erlang": "rebar.config sys.config",
  "file-r": ".rprofile",
  "file-lua": ".luacheckrc",
  "file-yaml": "citation.cff",
  "file-manifest": "manifest.mf",
  "file-readme": "readme readme.txt",
  "file-text": "authors notice codeowners contributors changelog",
});

/** Name patterns, tried in order (lower-case names). */
const NAME_PATTERNS: readonly (readonly [RegExp, IconName])[] = [
  [/^(dockerfile|containerfile)[.-]/, "file-docker"],
  [/^(docker-)?compose([.-][\w-]+)?\.ya?ml$/, "file-docker"],
  [/^\.env(\.|$)/, "file-dotenv"],
  [/^(licen[cs]e|copying)(-[\w.-]+|\.(md|txt|rst))?$/, "file-license"],
  [/^requirements([.-][\w.-]*)?\.(txt|in)$/, "file-requirements"],
  [/^(ts|js)config(\.[\w-]+)?\.json$/, "file-config"],
  [/\.config\.[cm]?[jt]s$/, "file-config"],
  [/^\.(eslintrc|prettierrc|stylelintrc|babelrc|swcrc|lintstagedrc|commitlintrc|markdownlintrc)(\.|$)/, "file-config"],
];

/** Lower-case extensions, including two-part ones (`gradle.kts`). */
const EXT_ICONS = table({
  "file-python": "py pyi pyw pyx pxd",
  "file-jupyter": "ipynb",
  "file-js": "js mjs cjs",
  "file-jsx": "jsx",
  "file-ts": "ts mts cts",
  "file-tsx": "tsx",
  "file-vue": "vue",
  "file-svelte": "svelte",
  "file-jsp": "jsp jspx jspf jsph tag tagf tagx",
  "file-json": "json jsonc json5 jsonl ndjson geojson topojson webmanifest har avsc code-workspace code-snippets map",
  "file-md": "md mdx markdown mdown mkd mkdn mdwn ronn workbook",
  "file-rst": "rst",
  "file-yaml": "yaml yml",
  "file-toml": "toml",
  "file-text": "txt text",
  "file-log": "log",
  "file-csv": "csv tsv",
  "file-html": "html htm shtml html.tmpl",
  "file-xhtml": "xhtml",
  "file-css": "css pcss postcss",
  "file-less": "less",
  "file-sass": "sass",
  "file-scss": "scss",
  "file-xml":
    "xml xsl xslt plist csproj fsproj vbproj props targets nuspec xaml axaml resx wsdl fxml iml jnlp rss atom " +
    "xliff xlf storyboard xib tld pom",
  "file-xsd": "xsd",
  "file-shell": "sh bash zsh ksh ash dash bats fish command",
  "file-powershell": "ps1 psm1 psd1 pssc psrc",
  "file-windows": "bat cmd exe",
  "file-sql": "sql ddl dml psql pgsql mysql",
  "db-redis": "redis",
  "db-elasticsearch": "es",
  "file-graphql": "graphql graphqls gql",
  "file-proto": "proto",
  "file-image": "png jpg jpeg gif svg webp ico icns bmp tif tiff avif",
  "file-archive": "zip tar gz tgz bz2 xz zst 7z rar jar war whl egg",
  "file-config": "ini cfg conf cnf inf reg url desktop service socket timer config",
  "file-dotenv": "env",
  "file-lock": "lock lockb",
  "file-ignored": "dockerignore gitignore",
  "file-properties": "properties prefs",
  "file-font": "ttf otf woff woff2",
  "file-patch": "patch diff rej",
  "file-java": "java",
  "file-kotlin": "kt",
  "file-kotlin-script": "kts",
  "file-groovy": "groovy gvy gy gsh",
  "file-gradle": "gradle",
  "file-gradle-kts": "gradle.kts",
  "file-scala": "scala sc sbt mill",
  "file-php": "php phtml php3 php4 php5 phps phpt",
  "file-perl": "pl pm pod psgi cgi",
  "file-c": "c",
  "file-h": "h hpp hh hxx h++",
  "file-cpp": "cpp cc cxx c++ ipp tpp inl ixx cppm",
  "file-objc": "m",
  "file-objcpp": "mm",
  "file-csharp": "cs csx",
  "file-fsharp": "fs fsi fsx",
  "file-swift": "swift swiftinterface",
  "file-go": "go",
  "file-rust": "rs",
  "file-ruby": "rb rake gemspec ru rbi jbuilder podspec erb rhtml",
  "file-lua": "lua luau rockspec",
  "file-zig": "zig zon",
  "file-gdscript": "gd",
  "file-godot": "tscn tres godot import",
  "file-gdshader": "gdshader gdshaderinc",
  "file-asciidoc": "adoc asciidoc",
  "file-d": "d di",
  "file-dart": "dart",
  "file-elixir": "ex exs",
  "file-erlang": "erl hrl escript app.src",
  "file-haskell": "hs lhs hs-boot hsig",
  "file-ocaml": "ml mli mll mly",
  "file-clojure": "clj cljs cljc cljd edn bb",
  "file-julia": "jl",
  "file-r": "r rprofile",
  "file-nix": "nix",
  "file-latex": "tex ltx sty cls dtx ins bbx cbx bib",
  "file-docker": "dockerfile containerfile",
  "file-makefile": "mk mak make",
  "file-cmake": "cmake",
  "file-bazel": "bazel bzl",
  "file-terraform": "tf tofu tfvars tftest.hcl",
  "file-hcl": "hcl nomad pkr.hcl",
  "file-http": "http rest",
  "file-regexp": "regexp",
  "file-idl": "idl",
  "file-binary": "class bin dat so dylib dll o a wasm pyc",
});

/** Source files for languages without a file-type icon. */
const CODE_EXT = new Set(["astro", "nim", "wit", "wat", "sol", "v", "sv"]);

let iconOverride: ((fileName: string) => IconName | null) | null = null;

/** Lets the user's file type associations (Settings › File Types) pick icons first. */
export function setFileIconOverride(resolve: ((fileName: string) => IconName | null) | null) {
  iconOverride = resolve;
}

/** Picks a file-type icon from a file name. */
export function fileIconName(fileName: string): IconName {
  const custom = iconOverride?.(fileName);
  if (custom) return custom;
  const lower = fileName.toLowerCase();
  const named = FILE_NAMES[lower] ?? NAME_PATTERNS.find(([re]) => re.test(lower))?.[1];
  if (named) return named;
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return "file-text";
  const ext = lower.slice(dot + 1);
  const prev = lower.lastIndexOf(".", dot - 1);
  const ext2 = prev > 0 ? lower.slice(prev + 1) : undefined;
  const icon = (ext2 && EXT_ICONS[ext2]) || EXT_ICONS[ext];
  if (icon) return icon;
  if (CODE_EXT.has(ext)) return "file-code";
  return "file-unknown";
}

export type FolderKind =
  | "plain"
  | "source"
  | "test"
  | "resources"
  | "testResources"
  | "excluded"
  | "library"
  | "github"
  | "module"
  | "package"
  | "generatedSource"
  | "generatedTest"
  | "compiled"
  | "javadoc";

/** Folder icon by role (expui has no separate "open" folder glyph). */
export function folderIconName(kind: FolderKind = "plain"): IconName {
  switch (kind) {
    case "source":
      return "folder-source";
    case "test":
      return "folder-test";
    case "resources":
      return "folder-resources";
    case "testResources":
      return "folder-test-resources";
    case "excluded":
      return "folder-excluded";
    case "library":
      return "folder-library";
    case "github":
      return "folder-github";
    case "module":
      return "module";
    case "package":
      return "package";
    case "generatedSource":
      return "folder-generated-source";
    case "generatedTest":
      return "folder-generated-test";
    case "compiled":
      return "folder-compiled";
    case "javadoc":
      return "folder-javadoc";
    default:
      return "folder";
  }
}
