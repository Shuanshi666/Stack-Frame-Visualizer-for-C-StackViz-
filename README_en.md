# Stack Frame Visualizer for C (StackViz)

[![tests](https://github.com/Shuanshi666/Stack-Frame-Visualizer-for-C-StackViz-/actions/workflows/test.yml/badge.svg)](https://github.com/Shuanshi666/Stack-Frame-Visualizer-for-C-StackViz-/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **This English README is a community effort — the extension UI and the main
> `README.md` are written in Chinese for beginners in China. If English is your
> first language (or you simply write better English than I do), please help
> improve this file: fix the wording, add what is missing, translate the
> sections that are still thin. Issues and pull requests are very welcome.**

StackViz is a VS Code extension for people learning C. Open a `.c` file, run one
explicit command, and it compiles the program with `gcc -g -O0`, drives `gdb` to
single-step it, rebuilds the call stack, and shows it in three places: a text
stack in an output channel, a native TreeView call tree, and a Webview replay
panel with a timeline slider. Recursion becomes something you can watch instead
of something you have to imagine.

It is meant for WSL2 Ubuntu / native Linux remote extension hosts. It does not
use `ms-vscode.cpptools` and it does not go through DAP: the extension talks to
`gcc` and `gdb` directly.

## ⚠️ There are two different UIs (and the timeline is not in the sidebar)

| What you see | What it is |
| --- | --- |
| A **top-to-bottom list** in the **left activity bar** | the **call tree** — one node per function invocation |
| A **tab in the editor area** called **`StackViz 回放`** | the **timeline / play / jump / export** panel |

Ways to open the timeline (any of them):

1. it **opens automatically** when a recording starts (beside the editor, without
   stealing focus — click the `StackViz 回放` tab if it is hidden behind others);
2. `Ctrl+Shift+P` → **StackViz: Open Visualizer**;
3. the **▶ button** on the far left of the call tree's title bar.

The panel needs a recording first (compile & run / pick an existing binary /
import a `.stackviz.jsonl`), otherwise the slider is grey and shows `还没有事件`.

## Requirements

```bash
sudo apt update
sudo apt install -y build-essential gdb
# optional: makes gdb quieter when it walks into libc
sudo apt install -y libc6-dbg
```

`gdb` must be built with Python 3 (distribution packages are). You can verify:

```bash
gcc --version
gdb --version
gdb -q -nx -batch -ex "python print('python 3 support: yes')"
```

Inside VS Code, **`StackViz: Check Environment`** prints the same information
(platform, WSL2 detection, gcc/gdb versions, gdb's Python support, `libc6-dbg`,
whether `<workspace>/.stackviz/` is writable) and offers a **复制安装命令**
button that copies the apt command to the clipboard. Node.js 18+ is needed to
build the extension itself.

WSL2 note: the extension runs on the **Linux side** (`extensionKind: workspace`).
Install `gcc`/`gdb` inside the distribution, not on Windows.

## Run it (F5)

1. `npm install` (once, in the repository root).
2. Open this folder with VS Code / VS Code Remote-WSL.
3. Open `examples/factorial.c`.
4. Press `F5` (Run and Debug → **Run StackViz Extension**). It first runs
   `npm run compile`, then opens an **Extension Development Host** window with
   `examples/` loaded.
5. In the new window: `Ctrl+Shift+P` → **StackViz: Compile and Visualize
   Recursion** → pick **Compile with the plugin** in the QuickPick.
6. Watch the **StackViz** output channel (View → Output → `StackViz`).
7. A **`StackViz 回放`** tab appears in the editor area — that is the timeline:
   drag the slider, press **播放**, or use `←` `→` to step.
8. Click the **StackViz** icon in the activity bar → **调用树** to watch the call
   tree grow. Clicking a node prints that frame's details and reveals the source
   line. (The sidebar holds only the tree — the timeline is the editor tab.)

On the first run the output channel also prints a short **"how to read this"**
legend (once per window) explaining `+ call` / `line` / `- return`, frame
numbers and indentation.

## Commands

| Command | What it does |
| --- | --- |
| `StackViz: Compile and Visualize Recursion` | compile the current `.c` (or pick an existing binary) and start recording |
| `StackViz: Visualize Existing Binary` | no compiling: choose an executable (setting → `.stackviz/a.out` → file dialog) |
| `StackViz: Stop` | end the gdb session (SIGTERM, then SIGKILL after 1.5 s) |
| `StackViz: Print Current Stack` | print the current call stack to the output channel |
| `StackViz: Clear` | clear the output channel and the in-memory recording |
| `StackViz: Open Visualizer` | open the replay panel (timeline) |
| `StackViz: Export Recording` | write the recording to a `.stackviz.jsonl` (one JSON event per line) |
| `StackViz: Import Recording` | load such a file back and replay it |
| `StackViz: Replay: Previous Event` / `Next Event` | move the cursor one event |
| `StackViz: Replay: Next Call` / `Next Return` | jump to the next call / return |
| `StackViz: Replay: Follow Latest` | jump back to the newest event |
| `StackViz: Check Environment` | toolchain self-check with install instructions |
| `StackViz: Open Example` | copy a bundled example into `<workspace>/.stackviz/examples/` and open it |

The replay commands only show up in the palette once something was recorded.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `stackviz.compileMode` | `ask` | `plugin` / `user` / `ask` |
| `stackviz.binaryPath` | `""` | executable used in `user` mode |
| `stackviz.extraCompilerArgs` | `[]` | appended to the plugin gcc command |
| `stackviz.gccPath` | `gcc` | gcc executable |
| `stackviz.gdbPath` | `gdb` | gdb executable |
| `stackviz.maxSteps` | `5000` | maximum single steps per recording |
| `stackviz.maxDepth` | `100` | maximum stack depth that is tracked |
| `stackviz.recordLocals` | `true` | read arguments and local variables |
| `stackviz.maxArrayItems` | `10` | array elements shown in a preview |
| `stackviz.snapshot` | `auto` | `auto` = cheap path with exact fallbacks; `safe` = walk the whole stack every step (slower, fully predictable) |
| `stackviz.traceLevel` | `all` | output channel detail: `all` (event lines + stack snapshots) / `events` / `off` |

The plugin compile command is fixed:

```bash
gcc -g -O0 -fno-omit-frame-pointer -fno-optimize-sibling-calls -o .stackviz/a.out <file.c>
```

## Event protocol

The extension listens on a random port on `127.0.0.1` and hands it to gdb through
the environment:

```
STACKVIZ_PORT=<port>      port of the extension
STACKVIZ_OPTIONS=<json>   maxSteps / maxDepth / recordLocals / maxArrayItems / snapshot
STACKVIZ_SOURCES=<json>   absolute paths of the user's own .c/.h files
```

One JSON object per line (NDJSON):

```ts
type CStackEvent = {
  type: "call" | "return" | "line" | "exception" | "exit";
  frameId: number;
  parentFrameId?: number;
  functionName: string;
  file: string;
  line: number;
  depth: number;
  timestamp: number;          // milliseconds
  args?: Record<string, string>;
  locals?: Record<string, string>;
  returnValue?: string;
  message?: string;           // StackViz addition, used by exception/exit
};
```

Reconstruction rule: compare consecutive stack snapshots, **the longest common
prefix does not change**; frames that appear emit `call` (outermost first),
frames that disappear emit `return` (innermost first), and the new top frame
always emits `line`. `exception` / `exit` are synthetic events produced by the
driver.

There is one important edge case: two calls of the same function on one source
line (`return fib(n-1) + fib(n-2);`) can be entered inside a *single* gdb step —
the callee returns and its sibling is called before gdb reports a new line. The
snapshot then looks unchanged, which would merge both activations into one node.
The driver therefore also records whether the current frame sits on the
function's closing brace: if it does, that invocation is over and the next
snapshot is treated as "return, then call" even if it looks identical.
`fibonacci.c` is exactly this case and now records its 26 invocations correctly.

## Variable preview (read only)

- basic types print directly: `n = 4`, `ratio = 1.5`, `label = "hi"`;
- arrays show at most the first 10 elements (`stackviz.maxArrayItems`), then `, ...`;
- strings (`char[]`) are truncated to 100 characters;
- pointers show only the address (`ptr = 0x7fffffffd570`) — never dereferenced;
- structs show at most the first 10 fields: `p = {x = 3, y = 4, label = "hi"}`;
- every read is wrapped in try/except, at most 20 variables; `recordLocals: false`
  turns the whole thing off.

## Library frames, and why they are hidden

With `libc6-dbg` installed gdb happily steps into `printf`, which would produce
hundreds of useless frames. The extension therefore sends the absolute paths of
the `.c/.h` files it knows about, the driver only records frames from those
files, and whenever a step lands inside a library it runs back out with
`finish`. If no source list is available (`Visualize Existing Binary` with
unknown sources, or running the driver by hand) the driver falls back to a
path based rule: a frame counts as user code when its file is an absolute path
outside the system directories. Frames whose source moved are still kept.

That heuristic was tightened (2026-10): a frame counts as user code only when its
file is an **absolute path**, is **not under a system directory** (defaults:
`/usr /lib /lib64 /bin /sbin /etc /var /build` — `/build` is where Debian/Ubuntu
record the source paths of packaged libraries, which used to be a false positive),
and **exists on this machine**. If your sources moved, declare them with
`stackviz.sourceRoots` (or `STACKVIZ_SOURCE_ROOTS`): those roots win over the
system list, and `STACKVIZ_SYSTEM_PREFIXES` replaces it. While guessing, the
driver logs `[stackviz] 没有拿到这个二进制的源码列表…` so the mode is visible.

## Bundled examples

`StackViz: Open Example` copies one of these into
`<workspace>/.stackviz/examples/` (never overwriting an edited file) and opens it:

| Example | What to look at |
| --- | --- |
| `factorial.c` | linear recursion: down one level at a time, then back up |
| `fibonacci.c` | tree recursion: the call tree branches; press play in the replay panel |
| `mutual_recursion.c` | mutual recursion: `is_even` / `is_odd` alternating |
| `deep_recursion.c` | a 42 frame stack: stack elision, tree depth, `maxDepth` |

## Performance

The first implementation let gdb unwind the whole stack after every single step,
which degraded badly on deep recursion. The driver now reads only the top frame
(using the frame pointer and the closing-brace signal to tell one activation
from another) and only walks everything for the first snapshot, as a periodic
resync and when the stack changes in an unexpected way.

| Scenario | Before | Now |
| --- | --- | --- |
| 1000 frames deep / 5000 steps (5011 events) | 25.9 s | **2.2 s** |
| the extension side processing those 5011 events | — | **34 ms**, longest iteration 9.7 ms |

The interactive path was cleaned up with the same mindset (measured at 100k
events):

| Action | Before | Now |
| --- | --- | --- |
| one "next step" or "play" tick | 12.7 ms (full replay each time) | **0.003 ms** |
| panel refresh reading counts and exceptions | 1.56 ms (array copy + full scan) | **0.015 ms** |
| dragging back to the middle of the recording | 12.7 ms | 1.6 ms, bounded by the 100k cap |

Correctness is not taken on faith: setting `STACKVIZ_SNAPSHOT=full` in
`STACKVIZ_OPTIONS` makes the driver fall back to the exact walk. The test suite
runs both modes over nine scenarios (the four examples, a program that exercises
the variable preview, `recordLocals` on and off, a 1000 deep program, and two
`maxDepth` truncations), compares the event streams one by one, and checks the
invocation counts (for example `fib(6)` must be 26 call events: `main` plus 25
`fib`).

## Tests and CI

The repository ships a test suite that needs no VS Code window: it stubs the
`vscode` module and drives the real extension code head-less.

```bash
npm install
npm test                 # unit + integration, about 10 s on a laptop
npm run test:unit        # plain Node: recording round trip, state machine and replay, rendering, driver constraints
npm run test:integration # real gcc + gdb (see below)
npm run test:slow        # optional: the 1000 frames / 5000 steps budget (~3.4 s)
```

- `test:unit` contains a regression guard for the security fix: the driver must
  never contain `set auto-load safe-path /` again, and must keep
  `set auto-load off`.
- `test:integration` covers the four bundled examples plus adversarial programs
  (two calls of the same function on one line, a loop header on the function's
  first line, a backwards `goto`), the variable preview rules, `maxDepth`
  truncation, library frame filtering, and the end-to-end behaviour of the call
  tree, frame details, replay panel, export/import, environment check and
  example picker.
- The most important safety net is `test/integration/differential.test.js`: it
  runs the cheap path and the exact walk (`snapshot: "full"`) over the same
  programs and requires the event streams to be **identical**, event by event,
  together with the expected invocation counts. If one of the clever shortcuts
  ever mis-identifies a frame, this test turns red immediately.
- On a machine without gcc/gdb the integration tests **skip with a printed
  reason** instead of pretending to pass.
- GitHub Actions (`.github/workflows/test.yml`) installs `build-essential` and
  `gdb` on every push / pull request, runs `npm test`, and that is the badge at
  the top of this file.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Shuanshi.

## Known limitations

- The UI is text + a native TreeView + one Webview; there is no time-aligned
  animation and no history comparison, search or filtering.
- Only the last recording is kept; running again rebuilds the call tree, `Clear`
  empties everything.
- Seeking is a replay from the start of the recording (O(events), still
  milliseconds at 100k events); dragging the slider is not frame by frame, and
  playback is fixed at 300 ms per event.
- Exports contain the retained window only (currently 100,000 events).
- The driver needs a `gdb` with Python 3.
- The fast path relies on frame pointers (the plugin always compiles with
  `-fno-omit-frame-pointer`). With `-O2`, hand written assembly frames or
  `setjmp`/signals the driver falls back to the exact walk, so results stay
  correct but slower.
- Library frames are skipped, so callbacks (for example the comparator of
  `qsort`) appear directly under their caller.
- `return` events carry the arguments observed last for that frame, not a real
  return value.
- C only: single threaded, synchronous, local programs, always `-O0`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `[gdb] 没有找到 gdb` | `sudo apt install -y gdb`, or set `stackviz.gdbPath` |
| output stops at `正在监听 127.0.0.1:...` | gdb could not connect back: check that nothing blocks the loopback interface |
| `gcc` errors | look at the `[gcc]` lines in the output channel: that is your compiler error, not the extension |
| only an `exit` event | the binary has no `main` symbol or was not built with `-g`; recompile with the plugin |
| only one frame (`main`) | check that the program really executes more code (`maxSteps` too small?) |

## Turning it off

The extension only starts processes when you run one of its commands. It does
not register a DebugAdapterTracker, never edits `launch.json` / `tasks.json` /
`settings.json`, and never touches your build or terminal. Disable it and VS
Code behaves exactly as before.
