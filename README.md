# Stack Frame Visualizer for C（StackViz）— M4

[![tests](https://github.com/Shuanshi666/Stack-Frame-Visualizer-for-C-StackViz-/actions/workflows/test.yml/badge.svg)](https://github.com/Shuanshi666/Stack-Frame-Visualizer-for-C-StackViz-/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 英文版：[README_en.md](README_en.md)（欢迎英文母语的朋友帮忙补充改进）
>
> 注意：插件的**界面文字目前是中文**（面向国内新手）。如果你需要英文界面，
> 欢迎在 README_en.md 对应的 issue/PR 里提出来。

面向 C 语言初学者的递归可视化插件：打开一个 `.c` 文件，显式触发一条命令，
插件就会用 `gcc -g -O0` 编译、启动 `gdb` 自动单步、解析调用栈，并通过本地
TCP 把 NDJSON 事件送回来，在 OutputChannel 里打印可读的调用栈。

本仓库当前完成的是 **M4（稳定性与新手体验）**，也就是最初的完整目标：

- **M1** 终端文本栈 MVP（编译 → gdb 自动单步 → call/return/line → OutputChannel）
- **M2** TreeView 调用树（同名函数不同深度各成一个节点，点击看变量与行号）
- **M3** Webview 回放面板（时间轴滑块、上一步/下一步、跳到下次 call·return、
  导出导入 `.stackviz.jsonl`、异常帧标记）
- **M4** 环境自检与安装指引、内置示例、1000 层递归/5000 步的性能

> ### ⚠️ 界面有两块，时间轴不在左栏（很多人第一次都找错）
>
> | 你看到的 | 那是什么 |
> | --- | --- |
> | **左侧活动栏**里的一个自上而下的**列表** | **调用树（Call Tree）**：每次函数调用一个节点 |
> | **编辑器区域**里一个叫 **`StackViz Replay`** 的**标签页** | **时间轴 / 播放 / 跳转 / 导出**都在这里 |
>
> **怎么把时间轴调出来**（任选其一）：
>
> 1. 跑 `StackViz: Compile and Visualize Recursion` 时会**自动打开**（开在编辑器区域，
>    不抢焦点；被别的标签挡住就点 `StackViz Replay` 那个标签）；
> 2. `Ctrl+Shift+P` → **StackViz: Open Visualizer**；
> 3. **左栏视图标题栏最左边那个 ▶ 按钮**。
>
> 面板需要先有一次记录（编译运行 / 选已有二进制 / 导入 `.stackviz.jsonl`），
> 否则滑块是灰的、显示 `no events`。

## 目录结构

```
package.json                  插件清单（命令、配置、extensionKind: workspace）
tsconfig.json                 TypeScript 编译配置
src/extension.ts              命令注册 / 控制器 / OutputChannel 输出
src/gdbSession.ts             编译、启动 gdb、会话生命周期
src/tcpServer.ts              127.0.0.1 随机端口 NDJSON 服务器
src/stackModel.ts             call/return/line → 调用栈重建
src/render.ts                 文本栈渲染（事件行、栈快照、深层省略）
src/callTree.ts               TreeView 数据提供者（frameId/parentFrameId → 调用树）
src/timelinePanel.ts          Webview 回放面板（时间轴、播放、导出按钮）
src/recording.ts              .stackviz.jsonl 的序列化与解析
src/toolchain.ts              gcc/gdb 探测（含 gdb 的 Python 支持）与环境自检报告
src/examples.ts               内置示例清单与拷贝逻辑
src/protocol.ts               事件类型定义
media/stackviz.svg            活动栏图标
python/gdb_stackviz.py        在 gdb 内运行的驱动脚本（自动单步 + 发事件）
examples/factorial.c          内置示例：线性递归（factorial + sum_to）
examples/fibonacci.c          内置示例：树状递归（调用树会分叉）
examples/mutual_recursion.c   内置示例：互递归（is_even / is_odd 交替）
examples/deep_recursion.c     内置示例：40 层深栈
test/                         测试：fixtures（C 程序）、helpers（vscode stub / 驱动封装）、unit、integration、slow
LICENSE                       MIT（Copyright (c) 2026 Shuanshi）
.vscode/launch.json           F5 启动 Extension Development Host
.vscode/tasks.json            F5 前自动 `npm run compile`
.stackviz/                    运行期目录（a.out 等临时文件，已 gitignore）
```

## 环境要求

WSL2 Ubuntu 或原生 Linux 的 VSCode Remote 窗口（扩展宿主在 Linux 侧）：

```bash
sudo apt update
sudo apt install -y build-essential gdb
# 可选：让 gdb 在进入 libc 时更安静（没有它也能跑）
sudo apt install -y libc6-dbg
```

装完后可以自己确认一下（`gdb` 必须是带 Python 3 支持的那个，发行版的 `gdb`
包默认就是）：

```bash
gcc --version
gdb --version
gdb -q -nx -batch -ex "python print('python 3 support: yes')"
```

插件里也有同样的自检：`StackViz: Check Environment` 会把 gcc/gdb 版本、
gdb 的 Python 支持、`libc6-dbg` 是否存在、当前是不是 WSL2 内核、`.stackviz/`
是否可写全部打印到 StackViz 输出面板；缺东西时弹出提示，并提供
**Copy Install Command** 按钮（把上面那条 apt 命令放进剪贴板）。

> WSL2 注意：扩展运行在 **Linux 侧**（`extensionKind: workspace`），
> 请不要在 Windows 侧的 VSCode 里打开 `\\wsl$` 之外的本机目录；
> `gcc`/`gdb` 也请装在发行版里（`sudo apt install ...`），而不是 Windows 上。

还需要 Node.js 18+（含 `npm`）来编译扩展本身。不支持 Windows 原生 VSCode。

## 安装与运行（F5）

1. 在仓库根目录安装依赖（只需一次）：

   ```bash
   npm install
   ```

2. 用 VS Code / VS Code Remote-WSL **打开本文件夹**（`/home/swx09/SFVC`）。

3. 打开 `examples/factorial.c`。

4. 按 `F5`（Run and Debug → **Run StackViz Extension**）。
   会先执行 `npm run compile`，然后弹出 **Extension Development Host** 窗口并
   自动打开 `examples/` 文件夹。

5. 在新窗口里按 `Ctrl+Shift+P`，运行
   **StackViz: Compile and Visualize Recursion**。

6. 弹出 QuickPick 时选择 **Compile with the plugin**
   （即 `stackviz.compileMode: ask` 的默认交互；设为 `plugin` 可跳过这一步）。

7. 看 **StackViz** 输出面板（View → Output → 右上角下拉选 `StackViz`）。

8. **编辑器区域会自动多出一个 `StackViz Replay` 标签页**——这就是时间轴面板：
   拖滑块、点 `▶` 播放、`←` `→` 单步都在这里（没有自动出现就点左栏视图标题栏
   最左的 ▶ 按钮，或 `Ctrl+Shift+P` → `StackViz: Open Visualizer`）。

9. 点左侧活动栏的 **StackViz** 图标 → **Call Tree**，看调用树实时长出来；
   点树上的任意节点，会跳到对应源码行并把该帧的变量打印到输出面板。
   （**注意**：左栏这里只有树，时间轴不在这里。）

   第一次运行时，输出面板还会先打印一段**"怎么读下面的输出"**白话说说明
   （只提示一次），把 `+ call` / `line` / `- return`、帧号、缩进的含义都讲清楚。

### 预期输出

> 下面这段是 `examples/factorial.c` 里 `n = 4` 时的输出。示例文件的 `n` 是
> 给你随便改的（改成 `40` 就能看到 41 层递归），步数/事件数/最大栈深会随之变化。

```
===== StackViz run 2026-10-01T12:00:00.000Z =====
source : /home/.../examples/factorial.c
binary : /home/.../examples/.stackviz/a.out
workdir: /home/.../examples
limits : maxSteps=5000 maxDepth=100 recordLocals=true maxArrayItems=10
sources: 1 C file(s) are treated as user code
$ gcc -g -O0 -fno-omit-frame-pointer -fno-optimize-sibling-calls -o .../a.out /home/.../factorial.c
StackViz: compiled .stackviz/a.out
StackViz: listening on 127.0.0.1:43210 (waiting for gdb)
$ gdb -q -nx -batch -x /home/.../python/gdb_stackviz.py --args .../a.out
[0001] + call    #1  main()  examples/factorial.c:32   depth 0
          #0 main()  examples/factorial.c:32  {n = 32767, f = -10408, s = 32767}   <-- top
[0002]   line    #1  main()  examples/factorial.c:32   {n = 32767, f = -10408, s = 32767}
[0003]   line    #1  main()  examples/factorial.c:33   {n = 4, f = -10408, s = 32767}
[0004] + call    #2  factorial(n = 4)  examples/factorial.c:14   depth 1  parent #1
          #0 main()  examples/factorial.c:33  {n = 4, f = -10408, s = 32767}
          #1 factorial(n = 4)  examples/factorial.c:14   <-- top
[0005]   line    #2  factorial(n = 4)  examples/factorial.c:14
[0006]   line    #2  factorial(n = 4)  examples/factorial.c:18
[0007] + call    #3  factorial(n = 3)  examples/factorial.c:14   depth 2  parent #2
...
[0017] - return  #5  factorial(n = 1)  examples/factorial.c:19   depth 4
          #0 main()  examples/factorial.c:33  {n = 4, f = -10408, s = 32767}
          #1 factorial(n = 4)  examples/factorial.c:18
          #2 factorial(n = 3)  examples/factorial.c:18
          #3 factorial(n = 2)  examples/factorial.c:18   <-- top
...
[0049] * exit    the program exited with code 0
          #0 main()  examples/factorial.c:39  {n = 4, f = 24, s = 6}   <-- top

===== StackViz summary =====
steps    : 31
events   : 49 (call 9, return 8, line 31, exception 0, exit 1)
max depth: 5
duration : 0.03 s
ended    : gdb stopped with exit code 0
note     : the program exited with code 0
===== end of run =====
```

要点：

- `[nnnn]` 是事件序号，`+` 新增调用、`-` 返回、`line` 走到新的一行、`*` 程序结束。
- 同一次 `factorial` 递归的每一层都是**独立的 frameId**（`#2 #3 #4 #5`），
  参数分别是 `n = 4 / 3 / 2 / 1`；`return` 事件也会带上该帧最后的实参。
- 每个 `call` / `return` 后面都会打印一份完整的调用栈快照（缩进 = 栈深，`<-- top` 标记栈顶）。
- 结束时打印 `summary`：步数、事件分类计数、最大栈深、耗时、结束原因。
- `printf` 等库函数帧被隐藏（见下面的“库函数帧”一节）。
- `main` 的局部变量在赋值前会显示栈上的垃圾值（`-O0` 下这是 gdb 的真实读数）。

## 提供的命令（完整）

| 命令 | 说明 |
| --- | --- |
| `StackViz: Compile and Visualize Recursion` | 编译当前 `.c`（或选已有可执行文件）并开始记录 |
| `StackViz: Visualize Existing Binary` | 不编译，直接选一个已编译好的可执行文件开始记录 |
| `StackViz: Stop` | 结束当前 gdb 会话（SIGTERM，1.5s 后 SIGKILL） |
| `StackViz: Print Current Stack` | 随时把当前调用栈打印到输出面板（程序结束后仍可打印最后一次记录） |
| `StackViz: Clear` | 清空输出面板与内存中的记录（正在运行的会话不会被停止） |
| `StackViz: Open Visualizer` | 打开 StackViz Replay 回放面板（时间轴 + 跳转 + 播放 + 导出） |
| `StackViz: Export Recording` | 把当前记录写成 `<名字>.stackviz.jsonl`（一行一个事件） |
| `StackViz: Import Recording` | 读入 `.stackviz.jsonl` 并装载到调用树/回放面板 |
| `StackViz: Replay: Previous Event` / `Next Event` | 时间轴上前进/后退一个事件 |
| `StackViz: Replay: Next Call` / `Next Return` | 跳到下一次函数调用 / 返回 |
| `StackViz: Replay: Follow Latest` | 回到最新事件，重新跟随实时记录 |
| `StackViz: Check Environment` | 自检 gcc / gdb（含 Python 支持）/ `.stackviz` 可写性，缺东西时给出安装命令 |
| `StackViz: Open Example` | 内置示例选择器：把示例拷到 `<工作区>/.stackviz/examples/` 并打开 |

回放类命令只在已经有记录时出现在命令面板里（靠 `stackviz.hasRecording` 上下文键）。

`Visualize Existing Binary` 的选择顺序：`stackviz.binaryPath`（若已设置）→
工作区里的 `.stackviz/a.out` → “Choose another executable…” 打开文件对话框。
选中的文件必须是可执行的普通文件，否则会给出一条明确的错误提示。

## M2：调用树（TreeView）

活动栏左侧多了一个 StackViz 图标，点开是 **Call Tree** 视图，它和输出面板同步更新
（用节流刷新，事件再密也不会卡住界面）：

- 每个 `call` 事件生成一个节点：`factorial(n = 4)  examples/factorial.c:14`。
- 父节点就是 `parentFrameId`，子节点按调用顺序排列；**递归的每一层都是独立节点**，
  所以"同一个函数出现在不同深度"一眼就能看出来。
- 图标区分状态：`debug-stackframe-focused` = 当前栈顶，`debug-stackframe` = 仍在栈上，
  `circle-outline` = 已返回（节点右侧还会标注 `(returned)`）。
- 悬停 tooltip 显示：参数、行号、`frameId` / 深度 / 父帧、局部变量、状态。
- **点击节点**：把这一帧的详情打印到 StackViz 输出面板，并在编辑器里跳到对应源码行
  （库函数帧或源码已移走的帧只打印详情、不跳转）。输出是给初学者写的白话，不是字段表：

  ```
  ===== 帧 #42：down(n = 0) =====
  这是第几次调用  ：第 42 次（函数每被调用一次就有一个新编号，递归的每一层都不一样）
  代码停在哪      ：examples/deep_recursion.c 第 10 行
    完整路径      ：/home/.../examples/deep_recursion.c
  参数            ：n = 0
  局部变量        ：（没有，或还没执行到赋值那一步）
  谁调用了它      ：帧 #41（down，在 .../deep_recursion.c 第 10 行）
  它调用了谁      ：（它没有调用别的函数）
  它在栈里第几层  ：第 42 层（第 1 层是最底下的 main，数字越大套得越深）
  它现在的状态    ：已经返回 —— 这次调用结束了，已经不在当前调用栈里

  （"帧"就是一次函数调用：左栏调用树上的每个节点、回放面板调用栈里的每一行，都是这样一帧。）
  ```

  同一个面板里、回放面板里点调用栈的行，看到的都是这一份说明。
- 视图标题栏有 Stop / Clear / Print Current Stack 三个按钮；
  图标上的角标（badge）是当前记录的帧数。
- 没有任何记录时，视图显示欢迎页，可以直接点 "Compile and Visualize Recursion"。
- 命令 `StackViz: Open Visualizer` 打开的是回放面板（见下一节），调用树视图本身在活动栏里随时可点。

树里始终是**最后一次记录**：重新运行会重建，`Clear` 会连同输出面板一起清空。

## M3：回放与时间轴

**先分清两处界面**（很容易找错）：

> **再次强调：左栏只有调用树，时间轴/播放控件在编辑器区域的 `StackViz Replay` 标签页里。**

| 位置 | 是什么 | 怎么打开 |
| --- | --- | --- |
| 左侧活动栏的 StackViz 图标 | **Call Tree 调用树**（从上到下的列表） | 点活动栏图标 |
| **编辑器区域的一个标签页**，标题 **StackViz Replay** | 时间轴滑块 + 播放/跳转/导出（Webview） | `Ctrl+Shift+P` → `StackViz: Open Visualizer`；或左栏视图标题栏最左边的 ▶ 按钮；**开始记录时会自动打开一次** |

也就是说：**时间轴不在左栏**，它在编辑器区域，通常开在当前文件的旁边。没看到就是被别的标签挡住了，点一下 `StackViz Replay` 那个标签即可。面板需要先有一次记录（`Compile and Visualize Recursion` / `Visualize Existing Binary` / `Import Recording`），否则滑块是灰的。

面板和调用树、输出面板共享同一份状态，拖动滑块时三处一起变：

- **时间轴滑块**：拖到记录里的任意一点。轴上黄色的圆点是 `exception` 事件，
  点一下直接跳过去；左右两端显示 `event 42 / 211`，并且始终标注当前是 `live`
  还是 `replaying`。
- **上一步 / 下一步**：`◀ ▶`，也可以直接按 `←` `→`；`⏮ ⏭` 跳到首尾。
- **跳到下一次 call / return / exception**：三个按钮，命令面板里也有对应的命令
  （只有一个方向也可以很方便地"只看每次函数进出"）。
- **play / pause**：每 300ms 自动前进一个事件（空格键也行），递归展开与回退会像
  动画一样走一遍。
- **follow live**：回到记录尾部重新跟随正在运行的会话；回放期间新到的事件只追加、
  不打断你正在看的位置。
- **当前事件**卡片显示 `[序号] 类型 函数(参数) 文件:行号`；**调用栈**按深度缩进，
  栈顶高亮，点任意一行会打印该帧的变量并跳到源码行。
- **异常**：`exception`（例如"达到 maxSteps"或"栈深超过 maxDepth"）在时间轴上有
  标记、在面板下方列表里可点击跳转，对应的帧在调用树里用 ⚠ 标出，tooltip 里写明原因。

### 导出 / 导入

- `StackViz: Export Recording` → 另存为 `<名字>.stackviz.jsonl`，**一行一个 JSON 事件**
  （就是 §7 的协议本身，没有额外包装），方便 grep 或自己写脚本画图。
- `StackViz: Import Recording` → 读回同样的文件；空行、`#` 注释、不合法的行会被跳过
  并在输出面板报告跳过数量。导入后调用树与回放面板立即按这份记录重建，可以继续回放。
- 事件保存有上限（当前 100,000 条），超出后丢弃最旧的并在 summary 里提示，
  所以导出的永远是保留窗口内的完整记录。

## M4：新手体验与性能

### 内置示例

`StackViz: Open Example` 提供四个可以直接改、直接跑的示例：

| 示例 | 看什么 |
| --- | --- |
| `factorial.c` | 线性递归：一层层进去，再一层层出来 |
| `fibonacci.c` | 树状递归：调用树会分叉，用回放面板按 play 最直观 |
| `mutual_recursion.c` | 互递归：`is_even` / `is_odd` 交替出现 |
| `deep_recursion.c` | 42 层深栈：栈快照省略、树的深度、`maxDepth` 行为 |

示例会被拷到 `<工作区>/.stackviz/examples/`（**已存在就不覆盖**，你改过的版本会保留），
打开后直接改递归深度，再运行 `Compile and Visualize Recursion` 即可。

### 环境自检

`StackViz: Check Environment` 会打印：

- `platform` / 是否 WSL2 内核 / Node 版本
- `gcc --version` 首行，或 MISSING
- `gdb --version` 首行 + **是否支持 Python 3**（驱动脚本依赖它）
- `libc6-dbg` 是否存在（只影响 gdb 是否走进 libc；两种情况插件都会过滤库帧）
- `<工作区>/.stackviz/` 是否可写

每次开始录制前也会先探测一次（结果缓存），gcc/gdb 缺失时立刻报错，并弹出
**Copy Install Command** 按钮把 `sudo apt update && sudo apt install -y build-essential gdb`
放进剪贴板——不会跑到一半才失败。

### 性能：1000 层递归 / 5000 步

最早的实现每单步都让 gdb 展开整条调用栈，1000 层递归会退化到 ~26 秒。
现在驱动只读栈顶那一帧，用帧指针（rbp）判断"还是同一个调用"，
只有栈真的变化时才多读一帧，另外每 250 步做一次完整重扫兜底：

| 场景 | 优化前 | 现在 |
| --- | --- | --- |
| 1000 层递归 / 5000 步（5011 个事件） | 25.9 s | **2.2 s** |
| 扩展端处理这 5011 个事件（模型 + 调用树 + 面板状态） | — | **34 ms**，单次最长 9.7 ms |

交互路径同样清理过（10 万事件下实测）：

| 操作 | 之前 | 现在 |
| --- | --- | --- |
| 回放面板"下一步 / 播放"一次 | 12.7 ms（每次从头重放） | **0.003 ms**（只应用新增的那一条） |
| 面板每次刷新取事件数与异常表 | 1.56 ms（全量拷贝 + 全表扫描） | **0.015 ms**（O(1) 计数 + 增量异常索引） |
| 往回拖到记录中点 | 12.7 ms | 1.6 ms，且被 10 万条上限兜住 |

正确性不靠感觉：把 `STACKVIZ_SNAPSHOT=full` 塞进 `STACKVIZ_OPTIONS` 就能让驱动
退回"每步完整走栈"的实现；`npm test` 会把两种模式在 10 组场景下逐事件比对，
并核对调用事件数（例如 `fib(6)` 必须是 26 次调用：main + 25 次 `fib`）。
细节见下面的"测试与 CI"。

## 测试与 CI

仓库里带了一套可以直接跑的测试（不需要打开 VSCode 窗口：用 stub 替换掉 `vscode`
模块，直接驱动真实的扩展代码）：

```bash
npm install
npm test                 # 单元 + 集成，本机约 10 秒
npm run test:unit        # 纯 Node：记录文件往返、状态机/回放、文本渲染、驱动脚本的静态约束
npm run test:integration # 真跑 gcc + gdb（见下）
npm run test:slow        # 可选：1000 帧深 / 5000 步的性能预算（本机约 3.4 秒）
```

- `test:unit` 里有一条**防复发的静态检查**：驱动脚本中不允许再出现
  `set auto-load safe-path /`（那会掀掉 gdb 的一层安全保护），必须保持
  `set auto-load off`。
- `test:integration` 覆盖：四个内置示例与**对抗用例**（同一行两次同名调用、
  循环头就在函数首行、往回 `goto`）、变量预览规则、`maxDepth` 截断、库函数帧过滤、
  以及"调用树分叉 / 帧详情 / 回放滑块 / 导出导入 / 环境自检 / 内置示例"这些端到端行为。
- 最关键的一张安全网是 `test/integration/differential.test.js`：让"快速路径"和
  "每步完整走栈"（`snapshot: "full"`）跑同一批程序，**逐事件比对必须完全一致**，
  并核对调用次数。那些"聪明但冒险"的捷径一旦判断错人，这里会立刻变红。
- 没装 gcc / gdb 的机器上，集成测试会**跳过并打印原因**，不会假装通过。
- GitHub Actions（`.github/workflows/test.yml`）在每次 push / PR 上装好
  `build-essential` + `gdb`，跑一遍 `npm test`，结果就是 README 顶部那个徽章。

## 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `stackviz.compileMode` | `ask` | `plugin` / `user` / `ask` |
| `stackviz.binaryPath` | `""` | `user` 模式下的可执行文件路径（POSIX） |
| `stackviz.extraCompilerArgs` | `[]` | 追加到 gcc 命令后（如 `-lm`） |
| `stackviz.gccPath` | `gcc` | gcc 可执行文件 |
| `stackviz.gdbPath` | `gdb` | gdb 可执行文件 |
| `stackviz.maxSteps` | `5000` | 单次记录的最大步数 |
| `stackviz.maxDepth` | `100` | 记录并展示的最大栈深 |
| `stackviz.recordLocals` | `true` | 是否读取实参/局部变量 |
| `stackviz.maxArrayItems` | `10` | 数组预览元素个数 |
| `stackviz.snapshot` | `auto` | `auto` = 快速路径（异常自动回退到完整走栈）；`safe` = 每步完整走栈，慢几倍但完全可预测 |
| `stackviz.traceLevel` | `all` | 输出面板详细程度：`all`（事件行 + 栈快照）/ `events`（只有事件行）/ `off`（只有开头与小结） |

插件编译命令固定为：

```bash
gcc -g -O0 -fno-omit-frame-pointer -fno-optimize-sibling-calls -o .stackviz/a.out <file.c>
```

## 事件协议

扩展监听 `127.0.0.1` 的**随机端口**，通过环境变量把端口交给 gdb：

```
STACKVIZ_PORT=<port>      扩展的 TCP 端口
STACKVIZ_OPTIONS=<json>   maxSteps / maxDepth / recordLocals / maxArrayItems
STACKVIZ_SOURCES=<json>   用户自己的 .c/.h 绝对路径数组（用于隐藏库函数帧）
```

每行一个 JSON 对象（NDJSON）：

```ts
type CStackEvent = {
  type: "call" | "return" | "line" | "exception" | "exit";
  frameId: number;
  parentFrameId?: number;
  functionName: string;
  file: string;
  line: number;
  depth: number;
  timestamp: number;   // 毫秒时间戳
  args?: Record<string, string>;
  locals?: Record<string, string>;
  returnValue?: string;
  message?: string;    // StackViz 扩展字段：exception / exit 的说明文字
};
```

重建规则：比较前后两次栈快照，**最长公共前缀不变**；新增的帧发 `call`（由外到内），
消失的帧发 `return`（由内到外），当前栈顶再发一条 `line`。`exception` / `exit`
是驱动脚本产生的合成事件（`message` 只在后两者上使用，属于本实现新增的可选字段）。

这条规则有一个必须补的边界：同一行里的两次同名调用（`return fib(n-1) + fib(n-2);`）
可能被 gdb 的**一次** `step` 走完——被调用的那份返回、它的兄弟紧接着被调用——此时
快照看起来完全没变（同函数、同文件、同深度），单纯比对前缀会把两次调用并成一个
节点（树里就看不到分叉）。所以驱动额外记录"当前是否停在函数的结尾大括号上"：
如果是，说明这个调用已经结束，下一次快照即使长得一样也按"先 return 再 call"处理。
`fibonacci.c` 正是这个例子，现在会老老实实记出 26 次调用。

要手工验证协议（不经过 VS Code）：

```bash
cd /home/swx09/SFVC
gcc -g -O0 -fno-omit-frame-pointer -fno-optimize-sibling-calls \
    -o /tmp/stackviz-a.out examples/factorial.c

python3 - <<'EOF'
import json, os, socket, subprocess, threading
server = socket.socket(); server.bind(("127.0.0.1", 0)); server.listen(1)
port = server.getsockname()[1]
def serve():
    conn, _ = server.accept()
    buffer = b""
    while True:
        chunk = conn.recv(65536)
        if not chunk: break
        buffer += chunk
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            if line.strip(): print(line.decode())
threading.Thread(target=serve, daemon=True).start()
env = dict(os.environ,
           STACKVIZ_PORT=str(port),
           STACKVIZ_OPTIONS=json.dumps({"maxSteps": 5000, "maxDepth": 100,
                                        "recordLocals": True, "maxArrayItems": 10}),
           STACKVIZ_SOURCES=json.dumps([os.path.abspath("examples/factorial.c")]))
subprocess.run(["gdb", "-q", "-nx", "-batch", "-x", "python/gdb_stackviz.py",
                "--args", "/tmp/stackviz-a.out"], env=env)
EOF
```

## 变量预览规则（只读）

- 基本类型直接显示：`n = 4`、`ratio = 1.5`、`label = "hi"`。
- 数组最多显示前 10 个元素（`maxArrayItems`），超出用 `, ...` 标出。
- 字符串（`char[]`）截断到 100 字符。
- 指针只显示地址，例如 `ptr = 0x7fffffffd570`，**不自动解引用**。
- 结构体最多显示前 10 个字段，例如 `p = {x = 3, y = 4, label = "hi"}`。
- 每次读取都在 try/except 中，最多 20 个变量；`recordLocals: false` 可整体关闭。

## 库函数帧（重要）

如果系统装了 `libc6-dbg`，`gdb` 默认会 `step` 进 `printf` 内部，产生成百上千个
无用帧。因此扩展把自己知道的 `.c / .h` 绝对路径通过 `STACKVIZ_SOURCES` 传给驱动
脚本，脚本只记录**这些文件里**的帧；一旦单步落进库函数，就用 `finish` 跑回用户
代码（并吞掉中间帧）。

过滤有两种模式：

- **list 模式**：扩展传了 `STACKVIZ_SOURCES`，且 `main` 所在文件就在这份列表里
  （插件编译、或工作区源码与二进制一致）。只记录列表里的文件。
- **heuristic 模式**：没有列表（手工运行脚本），或 `main` 所在文件不在列表里
  （`Visualize Existing Binary` 选了一个源码未知的二进制）。此时按路径判断：
  源文件是**绝对路径且不在系统目录**（`/usr /lib /lib64 /bin /sbin /etc /var`）
  才算用户代码。gdb 把 glibc 报成 `./csu/../csu/libc-start.c` 这类相对路径，
  因此库帧依然被挡住；而用户自己的源码即使被移动过（绝对路径但文件不存在）
  仍然会显示。

两种模式下，单步落进库函数后都会用 `finish` 跑回用户代码，并吞掉中间帧。

启发式模式的规则（2026-10 收紧）：源文件必须是**绝对路径**、**不在系统目录**、
**且文件确实存在于本机**——三条都满足才算你的代码。系统目录默认是
`/usr /lib /lib64 /bin /sbin /etc /var /build`，其中 `/build` 正是发行版打包 glibc
时记录的构建路径（这是之前一个漏判来源）。源码被移动过的话，用设置
`stackviz.sourceRoots`（或环境变量 `STACKVIZ_SOURCE_ROOTS`）显式声明"这些目录是我写的"，
它优先于系统目录判断；整张系统目录表可以用 `STACKVIZ_SYSTEM_PREFIXES` 替换。
切到"猜"的模式时，输出面板会打印
`[gdb] [stackviz] 没有拿到这个二进制的源码列表…` 提醒你当前的状态。

## M1 自测清单

在 Extension Development Host 里按顺序做一遍，每一条都能立刻看出对错：

1. 打开 `examples/factorial.c` → `StackViz: Compile and Visualize Recursion` →
   `Compile with the plugin`。输出面板最后应有 `summary`：
   `call` 比 `return` 多 1（`main` 还没返回）、`exception 0`、`exit 1`。
2. 递归每一层编号不同，`n` 逐层递减；`- return` 行也带 `n`。
3. 程序结束后运行 `StackViz: Print Current Stack`，仍能看到最后一份栈快照与统计行。
4. 运行 `StackViz: Visualize Existing Binary`，选 `.stackviz/a.out`，
   得到与第 1 步相同的记录（没有任何编译输出）。
5. 运行 `StackViz: Clear`，输出面板被清空并重新开始记录。
6. 对 `examples/deep_recursion.c` 跑一次：栈快照超过 30 层后应出现
   `... N frame(s) hidden ...`，而不是把上千行刷满面板。
7. 运行中按 `StackViz: Stop`，输出面板应出现 `ended    : gdb stopped by signal SIGTERM`
   的 summary，进程不会残留（可用 `pgrep gdb` 确认）。

## M2 自测清单

1. 跑完任意一次记录后，点活动栏 StackViz → Call Tree：根节点是 `main()`，
   它的子节点按调用顺序排列。
2. 展开 `factorial(n = 40)`：下面是一条 40 层深的链，每层 `n` 递减 1，
   并且每层都是**不同节点**（这正是"递归同名不同深度"的验收点）。
3. 悬停任意节点：tooltip 里有参数、行号、frameId/深度/父帧、局部变量。
4. 点一个中间节点：输出面板出现 `===== frame #N =====` 的详情块，
   编辑器同时跳到对应源码行。
5. 记录过程中看树：仍在栈上的节点是实心 `debug-stackframe`，栈顶是
   `debug-stackframe-focused`；程序退出后全部变成空心并标注 `(returned)`
   （那时记录已经是一段历史，不再有"活动"帧）。
6. 视图图标角标显示的帧数与树的节点总数一致（`deep_recursion.c` 是 42）。
7. `StackViz: Open Visualizer` 打开回放面板；`StackViz: Clear` 清空树与面板。

## M3 自测清单

1. 跑一次 `examples/deep_recursion.c`（或先 `npm run compile` 后按 F5 跑 factorial）：
   记录开始时 **StackViz Replay 面板会自动在编辑器区域打开**（若没有，用
   `Ctrl+Shift+P` → `StackViz: Open Visualizer`，或左栏视图标题栏最左的 ▶ 按钮）。
   面板显示 211 个事件，滑块在最右端，状态是 `live`。
2. 把滑块拖到中间：调用栈列表立刻变成那一刻的栈，标题状态变 `replaying`。
3. 连点 `next call` 几次：每次停在 `call` 事件上，`depth` 逐次加深；再点 `next return`
   停在 `return` 上。
4. 点 `play`：事件自动前进，栈像动画一样长出来又缩回去；空格键可暂停。
5. 点 `follow live`：回到最右端，状态变回 `live`。
6. 点调用栈里的一行：输出面板打印 `===== frame #N =====`，编辑器跳到对应源码行。
7. `StackViz: Export Recording` 存成 `.stackviz.jsonl`，用 `wc -l` 数一下行数等于事件数；
   `StackViz: Import Recording` 再导回来，滑块与调用树照常工作。
8. 把 `stackviz.maxSteps` 改成 5 再跑一次：时间轴出现黄色异常标记，面板下方列出
   "reached maxSteps=5"，调用树里对应节点是 ⚠。

## M4 自测清单

1. `StackViz: Check Environment`：输出面板里 gcc/gdb 都是 OK，gdb 那行写着
   `python 3 support: yes`，`.stackviz` 可写，平台显示 WSL2。
2. 把 `stackviz.gdbPath` 改成 `no-such-gdb` 再自检：提示 MISSING 并弹出
   **Copy Install Command**，点一下剪贴板里就是 apt 命令；改回来后恢复正常。
3. `StackViz: Open Example` 选 `fib(n)`：文件出现在
   `<工作区>/.stackviz/examples/fibonacci.c` 并自动打开；再执行一次，
   你改过的内容不会被覆盖。
4. 对 `fibonacci.c` 跑一次并打开回放面板按 play：`call` 事件应为 26 个
   （main + 25 次 `fib`），调用树在 `fib(n-1) + fib(n-2)` 处**分成两支**
   而不是一条链；同一层的两个分支是不同的节点。
5. 把 `examples` 里的深栈示例拷出来，把深度改成 `1000`，
   `maxSteps` 调到 `5000`、`maxDepth` 调到 `1200` 跑一次：
   能在几秒内跑完（本机实测 2.2s），拖动时间轴、展开调用树都不卡。
6. 跑完后 `StackViz: Print Current Stack`、`Export Recording` 仍然正常
   （5011 个事件导出后 `wc -l` 应为 5011）。

## M1/M2/M3/M4 已知限制

- 可视化有三处：OutputChannel 文本栈、原生 TreeView 调用树、Webview 回放面板。
- 调用树只保留**最后一次记录**，没有历史对比/搜索/过滤；节点展开状态在刷新时
  由 `frameId` 维持，重新运行会重建整棵树。
- 回放定位是"从头重放事件"（O(事件数)），10 万事件量级仍是毫秒级，
  但拖动滑块不是逐帧动画；`play` 速度固定 300ms/事件，暂不可配置。
- 导出的是**保留窗口内**的事件（上限 100,000 条），更早的事件已经丢弃。
- 驱动脚本需要 `gdb` 带 Python 3；不带 Python 的 gdb 会在自检时报错。
- 快速路径依赖帧指针（插件固定用 `-fno-omit-frame-pointer` 编译）：
  换成 `-O2` 或自己去优化标志、或者手写汇编帧（如 `setjmp`/信号处理）时，
  驱动会回退到"完整走栈"的慢路径，结果依然正确。
- `recordLocals` 打开时每一步都会读一次栈顶帧的变量，深栈大程序会比关闭时慢
  一倍左右；追求最快可以关掉它。
- 输出量按事件线性增长：每个 `call` / `return` 都会打印一份栈快照，
  单文件超过 30 层的快照会省略中间部分（保留栈底 6 层 + 栈顶部分）。
- 栈深超过 `maxDepth` 时按**自底向上**截断，并给出一条 `exception` 说明。
- 步数超过 `maxSteps` 时停止记录（会发 `exception` 事件）。
- 库函数被整体跳过，因此回调（如 `qsort` 的比较函数）的调用关系会直接挂在
  调用者下面；M1/M2 不针对回调做特判。
- `return` 事件带的是该帧**最后一次被观测到**的实参，不是真正的返回值
  （真正的返回值捕获还没做）。
- `StackViz: Clear` 不会停止正在运行的会话，只清空输出与内存记录。
- 未初始化的局部变量会显示栈上的垃圾值（`-O0` 下这是 gdb 的真实值）。
- 只支持 C、单线程、同步、本机程序；必须 `-O0`；不依赖 `ms-vscode.cpptools`，
  不走 DAP。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `[gdb] spawn gdb ENOENT` | `sudo apt install -y gdb`，或设置 `stackviz.gdbPath` |
| 输出停在 `listening on 127.0.0.1:...` | gdb 没能连回来：确认没有防火墙/代理拦截本机回环 |
| `gcc` 报错 | 看输出面板里 `[gcc]` 开头的行；这是编译错误，不是插件错误 |
| 事件只有 `exit` | 二进制没有 `main` 符号或没带 `-g`，请用 plugin 模式重新编译 |
| 只显示 `main` 一层 | 检查 `.c` 文件是否真的在执行下一步（`maxSteps` 太小？） |
| 想在别的目录里生成 a.out | 插件总是写 `<工作区>/.stackviz/`，不会污染源码目录 |

## 关闭插件后

插件只在显式命令触发时启动进程；不注册 DebugAdapterTracker、不修改
`launch.json` / `tasks.json` / `settings.json`、不干预用户的编译与终端。
禁用插件后 VSCode 行为完全恢复默认。
