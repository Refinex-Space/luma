# <img src="docs/media/luma-mark-64.png" alt="" width="36" height="36" /> Luma

面向日常开发的独立桌面 IDE。键位、工具窗口与 Search Everywhere 沿用 IntelliJ IDEA 的习惯，运行时是 Rust 与 Tauri 2 的原生应用。

代码自开源项目 [OpenIDEA](https://github.com/l0ng-ai/openidea) fork，并在本仓库以 Luma 继续演进。编辑器、代码洞察、调试器、Git、终端、数据库与 HTTP 客户端覆盖 60+ 语言，可在 macOS、Windows、Linux 上构建。

## 与上游的关系

本仓库由 [l0ng-ai/openidea](https://github.com/l0ng-ai/openidea) fork 而来，协议同为 Apache 2.0。上游版权与第三方声明见 [`NOTICE`](NOTICE)、[`LICENSE`](LICENSE)、[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md)。

合并上游时，优先对照其 `main`；Luma 侧的产品决策与品牌改动在本仓库独立推进。

## 本地开发

读完这一节，你应能在本机打开可调试的桌面窗口。

### 环境

| 依赖    | 版本基线                                                      | 说明                                                               |
| ------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| Rust    | `1.96`（见 `Cargo.toml` 的 `rust-version`）                   | 建议用 `rustup` 安装 stable，并带上 `clippy`、`rustfmt`            |
| Node.js | `22`（与 CI 一致）                                            |                                                                    |
| pnpm    | `11`（与 CI 一致）                                            |                                                                    |
| 系统库  | [Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/) | macOS 需要 Xcode Command Line Tools；Linux 需 WebKitGTK 等，见下方 |

Linux（Ubuntu 22.04 一类）可先装：

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libxdo-dev \
  libssl-dev \
  patchelf
```

### 启动桌面应用

```bash
git clone https://github.com/Refinex-Space/luma.git
cd luma
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` 会起 Vite 前端，再编译并拉起 Tauri 窗口。首次编译 Rust 工作区会较久；成功后应出现 IDE 窗口。同一 worktree 已有会话在跑时，脚本会提示已有进程，可用 `pnpm dev:status` 查看状态。

需要给前端挂上全局 Tauri 桥接时，用：

```bash
pnpm dev:app
```

只改界面、不跑原生壳时：

```bash
pnpm dev
```

打发布包：

```bash
pnpm tauri build
```

### 检查与测试

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build

cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo nextest run --workspace --no-fail-fast
```

端到端（需本机 Playwright 浏览器环境）：

```bash
pnpm e2e
```

Notebook 内核相关的忽略测试需两套装了 `ipykernel` 的 Python，按需再开：

```bash
LUMA_TEST_PYTHON=/first/env/bin/python \
LUMA_TEST_PYTHON_SECOND=/second/env/bin/python \
cargo test -p ide-notebook --test kernel_runtime -- --ignored --test-threads=1
```

## 文档

| 主题               | 路径                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| 主题与配色         | [`docs/themes.md`](docs/themes.md)                                                           |
| 插件（含主题插件） | [`plugins/README.md`](plugins/README.md)、[`docs/plugins/themes.md`](docs/plugins/themes.md) |
| 工作区与窗口组     | [`docs/workspaces-and-window-groups.md`](docs/workspaces-and-window-groups.md)               |
| Kotlin 调试        | [`docs/kotlin-debugging.md`](docs/kotlin-debugging.md)                                       |
| 外部对比压测       | [`perf/compare`](perf/compare)                                                               |

## 上游性能参考

以下数据来自 OpenIDEA 上游 README：在 Windows 11、32 核 AMD、62 GB 内存上，热缓存打开 [freqtrade](https://github.com/freqtrade/freqtrade)（Python，约 770 个文件），各跑 5 次取中位数。IDEA 对 Python 的分析更深，两边「就绪」的工作量不同；方法见 [`perf/compare`](perf/compare)。

|                       | OpenIDEA    | IntelliJ IDEA 2026.2.3 |
| --------------------- | ----------- | ---------------------- |
| 出现项目窗口          | **0.9 s**   | 3.1 s                  |
| 就绪（CPU 平稳）      | **1.1 s**   | 13.2 s                 |
| 内存（USS，全部进程） | **169 MB**  | 2011 MB                |
| 就绪前 CPU 时间       | **2.4 s**   | 47.9 s                 |
| 空闲 CPU              | **单核 4%** | 单核 7%                |
| 退出                  | **0.3 s**   | 5.9 s                  |

## 许可证

[Apache 2.0](LICENSE)。捆绑的第三方资源见 [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md)。

<sub>与 JetBrains 无隶属、背书或赞助关系。IntelliJ IDEA 是 JetBrains s.r.o. 的商标。</sub>
