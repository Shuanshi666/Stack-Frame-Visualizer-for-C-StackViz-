[![tests](https://github.com/Shuanshi666/Stack-Frame-Visualizer-for-C-StackViz-/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/Shuanshi666/Stack-Frame-Visualizer-for-C-StackViz-/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

This English README is a community effort: the extension UI and the main README.md are written in Chinese for beginners in China. If English is your first language, or you just write it better than I do, corrections and rewrites are welcome - open an issue or send a pull request.

## How to use

1. In the repository root, run `npm install`.
2. Open this folder with Remote-WSL and open `examples/factorial.c`.
3. Press `F5`. It runs `npm run compile`, then opens an Extension Development Host window with `examples/` loaded.
4. In that window press `Ctrl+Shift+P` and run `StackViz: Compile and Visualize Recursion`.
5. Pick "用插件自己编译" in the QuickPick. Setting `stackviz.compileMode` to `plugin` skips the question.
6. Open the output panel: `View → Output`, then choose `StackViz` in the dropdown.
7. A `StackViz 回放` tab appears in the editor area. The timeline slider, playback and `←` `→` stepping all live there; they are not in the sidebar.
8. The StackViz icon in the activity bar opens the call tree. Clicking a node prints that frame's variables and line and jumps to the source.
9. The first run also prints a short legend explaining `+ 调用`, `执行` and `- 返回`, why every frame number is different, and what the indentation means. It is printed once.

The extension is for people learning C who want to see what recursion does. You open a .c file and run one command by hand; it compiles with gcc -g -O0, drives gdb to single-step the program, rebuilds the call stack from the events, and shows the result in three places: a text stack in the output channel, a call tree in the activity bar, and a timeline panel in the editor area. It only handles C, single-threaded, local programs. No C++, no threads, no async, no signals, no DAP, no cpptools. It does not touch your build or debug configuration, and nothing runs unless you ask for it.

There are two separate UIs, and it is easy to find only one of them. The list in the left activity bar is the call tree; the timeline is not there, it lives in a tab in the editor area called StackViz 回放 (the panel title stays Chinese in this build). You can open it three ways: it opens by itself when a recording starts (beside the editor, without stealing focus), or through the command palette entry StackViz: Open Visualizer, or with the ▶ button on the far left of the call tree's title bar. The panel needs a recording to have anything in it; before that the slider is grey and reads "还没有事件".

You need WSL2 Ubuntu or a native Linux remote window, with the extension running on the Linux side (package.json declares extensionKind: workspace, so do not open the project from the Windows side). Install a compiler and a debugger; gdb has to be built with Python 3, which is what distribution packages are:

```bash
sudo apt update
sudo apt install -y build-essential gdb
# optional, makes gdb quieter when a step lands inside libc
sudo apt install -y libc6-dbg
```

If you want to check by hand, run gcc --version, gdb --version, and gdb -q -nx -batch -ex "python print('python 3 support: yes')". Inside the editor there is also StackViz: Check Environment, which prints the platform, whether the kernel is WSL2, the gcc and gdb versions, gdb's Python support, whether libc6-dbg is installed, and whether <workspace>/.stackviz/ is writable. When something is missing it offers a button that copies sudo apt update && sudo apt install -y build-essential gdb to the clipboard. Building the extension itself needs Node 18 or newer.

The output looks like this, taken from the factorial example with n = 4:

```
[0001] + 调用   帧#1  main()  examples/factorial.c:27   第 1 层
[0002]   执行   帧#1  main()  examples/factorial.c:27   {n = 32767, f = -10552, s = 32767}
[0003]   执行   帧#1  main()  examples/factorial.c:28   {n = 4, f = -10552, s = 32767}
[0004] + 调用   帧#2  factorial(n = 4)  examples/factorial.c:13   第 2 层   父帧 #1
          #0 main()  examples/factorial.c:28  {n = 4, ...}
          #1 factorial(n = 4)  examples/factorial.c:13   <-- 栈顶
...
===== 本次记录小结 =====
单步次数 : 31（程序每往前走一行算一步）
事件总数 : 49（调用 9、返回 8、执行 31、异常 0、结束 1）
最深栈深 : 5 层
耗时     : 0.03 秒
结束原因 : gdb 正常退出（退出码 0）
===== 记录结束 =====
```

A "frame" is one function call. Every call gets its own frame number, so the same recursive function appears as several distinct frames, which is what makes the recursion visible. Indentation is stack depth, and the row marked <-- 栈顶 is where the program is stopped right now. Clicking a node in the call tree, or a row in the panel's call stack, prints a plain-language description of that frame (which invocation it is, the line it is stopped on, its arguments, its locals, who called it, what it called, its depth, and whether it is running or already returned) and jumps to the source line.

There are thirteen commands. StackViz: Compile and Visualize Recursion compiles and records, asking for an existing binary instead if stackviz.compileMode says so, and StackViz: Visualize Existing Binary records without compiling, looking first at stackviz.binaryPath, then at .stackviz/a.out in the workspace, then opening a file dialog. StackViz: Stop ends the gdb session with SIGTERM and follows up with SIGKILL after 1.5 seconds; StackViz: Clear empties the output channel and the in-memory recording without stopping a run in progress; StackViz: Print Current Stack prints the stack at this moment, and still prints the last recording after the program has finished. The replay group is StackViz: Open Visualizer for the timeline panel, StackViz: Replay: Previous Event, Next Event, Next Call and Next Return for moving along the timeline, and StackViz: Replay: Follow Latest to jump back to the newest event; these only appear in the palette once a recording exists. Recordings can be written and read back: StackViz: Export Recording produces a .stackviz.jsonl with one event per line, which is the protocol itself with nothing wrapped around it, and StackViz: Import Recording reads it back, skipping blank lines, lines starting with # and lines it cannot parse, and reporting how many it skipped. The last two are StackViz: Check Environment for the self-check, and StackViz: Open Example, which copies a bundled example into <workspace>/.stackviz/examples/ and opens it without overwriting a file you have already edited.

The compile line is fixed; plugin mode only appends what you put in stackviz.extraCompilerArgs:

```bash
gcc -g -O0 -fno-omit-frame-pointer -fno-optimize-sibling-calls -o .stackviz/a.out <file.c>
```

There are eleven settings. stackviz.compileMode defaults to ask and also accepts plugin or user; stackviz.binaryPath is empty by default and is used in user mode; stackviz.extraCompilerArgs is an empty array; stackviz.gccPath and stackviz.gdbPath default to gcc and gdb; stackviz.maxSteps defaults to 5000 and stops the recording with a note when it is reached; stackviz.maxDepth defaults to 100 and truncates deeper frames from the bottom with a note; stackviz.recordLocals defaults to true and turns off reading arguments and locals when set to false; stackviz.maxArrayItems defaults to 10; stackviz.snapshot defaults to auto, and setting it to safe gives up the cheap snapshot path for a full stack walk on every step, several times slower but completely predictable; stackviz.traceLevel defaults to all, and events or off reduce the output channel to event lines only or to the opening and the final summary. Temporary files stay inside .stackviz/.

The extension listens on a random port on 127.0.0.1 and passes the port to gdb through the environment, along with the options and the absolute paths of your own sources:

```
STACKVIZ_PORT=<port>      port the extension listens on
STACKVIZ_OPTIONS=<json>   maxSteps / maxDepth / recordLocals / maxArrayItems / snapshot
STACKVIZ_SOURCES=<json>   absolute paths of your .c/.h files
```

One JSON object per line:

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
  message?: string;           // added by this project, used by exception / exit
};
```

Changes in the stack are derived by comparing two snapshots: the longest common prefix is considered unchanged, frames that appear emit call from the outside in, frames that disappear emit return from the inside out, and the current top frame always adds a line event. exception and exit are synthetic events the driver writes itself. One case is worth writing down because it changes the result: two calls of the same function on one source line, like return fib(n-1) + fib(n-2), can be entered inside a single gdb step, because the callee returns and its sibling is called before gdb reports a new source line. The snapshot then looks unchanged, and comparing prefixes alone would merge the two invocations into one node, so the call tree would stop branching. The driver therefore also records whether the current frame is stopped on the function's closing brace; if it is, that invocation is over, and the next snapshot is treated as a return followed by a call even when it looks identical. fibonacci is exactly that case and now records its 26 invocations correctly.

Variables are read only, and every read is wrapped so that a failure cannot break the recording. Basic types print directly, arrays show at most the first 10 elements (stackviz.maxArrayItems), strings are cut at 100 characters, pointers show the address and are never dereferenced, structs show at most the first 10 fields, at most 20 variables are read, and setting stackviz.recordLocals to false skips all of it. A local variable that has not been assigned yet shows the garbage that happens to be on the stack, which is what gdb reports at -O0 rather than a bug in the extension.

With libc6-dbg installed, gdb will happily step into printf, which produces hundreds of meaningless frames. The extension therefore sends the absolute paths of the .c and .h files it knows about, the driver only records frames from those files, and a step that lands inside a library is undone with finish so the frames in between never appear. When no source list is available, which happens when you visualize a binary whose sources are unknown, the driver falls back to guessing from paths: the file has to be an absolute path, outside the system directories, and it has to exist on this machine. The system directories are /usr, /lib, /lib64, /bin, /sbin, /etc, /var and /build, and the last one is where distributions record the build paths of packaged glibc, which used to be the source of a false positive here. If your sources moved, list their directories in stackviz.sourceRoots or STACKVIZ_SOURCE_ROOTS; those roots win over the system list, and STACKVIZ_SYSTEM_PREFIXES replaces the list entirely. While guessing, the output channel shows a line starting with [gdb] [stackviz] 没有拿到这个二进制的源码列表…, so you can tell which mode you are in.

Four examples ship with it. factorial.c is linear recursion, down one level at a time and back up; fibonacci.c is tree recursion whose call tree branches, and the replay panel makes that easiest to see; mutual_recursion.c alternates between is_even and is_odd; deep_recursion.c goes 42 frames deep and shows how the stack snapshot is elided and what maxDepth does.

The first version of the driver let gdb unwind the whole stack after every single step, which took 25.9 seconds for a 1000 frame recursion over 5000 steps. It now reads only the top frame, using the frame pointer and the closing-brace signal to decide whether it is looking at the same invocation, reads one more frame only when the stack actually changed, and re-walks everything every 250 steps as a safety net. The same recording finishes in 2.2 seconds, and the 5011 events take 34 ms on the extension side with a longest single iteration of 9.7 ms. The interactive path was cleaned up with the same numbers in mind: at 100k events one "next step" or one playback tick is 0.003 ms, where it used to replay the recording from the start and take 12.7 ms; a panel refresh reading the event count and the exception list is 0.015 ms, down from 1.56 ms; dragging back to the middle takes about 1.6 ms and is bounded by the 100k retention cap.

The repository ships a test suite that runs without a VS Code window by stubbing the vscode module and driving the real extension code. After npm install, npm test compiles and then runs unit and integration tests in about 10 seconds on a laptop, 22 and 32 of them. npm run test:slow is an optional budget check for 1000 frames and 5000 steps, about 2.4 seconds here. On a machine without gcc or gdb the integration tests skip with a printed reason instead of pretending to pass. The most important safety net is test/integration/differential.test.js: it runs the cheap path and the full walk over the same programs and requires the event streams to match event by event, together with the invocation counts, for example that fib(6) produces exactly 26 call events. The adversarial cases in that set include two calls of the same function on one line, a loop header sitting on the function's first line, and a backwards goto, all shapes that can push a clever shortcut off the rails. A unit test also asserts that the driver never contains set auto-load safe-path / again, since that would remove a gdb safety mechanism, and keeps set auto-load off. GitHub Actions runs the suite on Node 20 and 22 for every push and pull request. The badge at the top reflects the latest run of that workflow on the main branch; right after a push it can still show the previous result, because GitHub and browsers cache badge images for a few minutes, and a green check on a pull request does not turn main green until it lands there.

The known limitations are worth stating plainly. The visualisation is a text stack in the output channel, a native call tree and a single Webview panel; there is no animated timeline and no replay history, and only the last recording is kept in memory. Seeking replays from the start, which is milliseconds within the 100k cap but not a frame-by-frame scrub, and playback is fixed at 300 ms per event. Exports contain the retained window only, 100k events, with older ones dropped and reported in the summary. The driver needs a gdb with Python 3. The fast path relies on frame pointers, which the plugin always compiles with -fno-omit-frame-pointer; if you build with -O2 yourself, or the program contains hand-written assembly frames, setjmp or signal handling, the driver falls back to the full walk, which stays correct but slower, and you can also set stackviz.snapshot to safe to start there. Library frames are skipped entirely, so callbacks such as the comparator of qsort appear directly under their caller. return events carry the arguments last observed for that frame, not a real return value. Uninitialised locals show the garbage on the stack. Only C, single threaded, synchronous, local programs, always -O0.

When something goes wrong, these are the usual causes. If the output channel mentions that gdb could not be found, install it or point stackviz.gdbPath at it. If the log stops at "正在监听 127.0.0.1:…", gdb never connected back, so check that nothing blocks the loopback interface. Lines starting with [gcc] are your compiler complaining about your code, not the extension. Receiving only an exit event usually means the binary has no main symbol or was not built with -g, so recompile with the plugin. A stack with only main in it usually means the program did not execute more code, or stackviz.maxSteps is too small.

The extension only starts processes when you run one of its commands. It does not register a DebugAdapterTracker, does not edit launch.json, tasks.json or settings.json, does not touch your build or terminal, and writes temporary files only inside .stackviz/. Disable it and VS Code behaves exactly as it did before.

The license is MIT, Copyright (c) 2026 Shuanshi, with the full text in LICENSE. There are no runtime dependencies (typescript and @types are development only and never end up in the vsix), so there are no third-party license notices to carry along.
