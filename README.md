[![tests](https://github.com/Shuanshi666/Stack-Frame-Visualizer-for-C-StackViz-/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/Shuanshi666/Stack-Frame-Visualizer-for-C-StackViz-/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

英文版在 [README_en.md](README_en.md)，那边还比较糙，欢迎英文母语的朋友帮忙改。

## 使用方法

1. 在仓库根目录跑 `npm install`。
2. 用 Remote-WSL 打开这个文件夹，打开 `examples/factorial.c`。
3. 按 `F5`。它会先跑 `npm run compile`，然后弹出一个 Extension Development Host 窗口并打开 `examples/`。
4. 在新窗口里按 `Ctrl+Shift+P`，运行 `StackViz: Compile and Visualize Recursion`。
5. QuickPick 里选「用插件自己编译」。把 `stackviz.compileMode` 设成 `plugin` 就不会再问。
6. 打开输出面板：`View → Output`，右上角选 `StackViz`。
7. 编辑器区域会多出一个 `StackViz 回放` 标签页，时间轴、播放、`←` `→` 单步都在那里；左栏里没有它。
8. 左栏的 StackViz 图标点开是调用树，点节点会打印这一帧的变量和行号，并跳到源码行。
9. 第一次运行时输出面板会先打一段说明，讲 `+ 调用`、`执行`、`- 返回` 三种行是什么意思，帧号为什么每次都不同，缩进代表什么。这段只打一次。

这个扩展是给学 C 的人看递归用的。打开一个 .c 文件，手动跑一条命令，它会用 gcc -g -O0 编译，然后让 gdb 单步执行，把每次函数进出和当时的调用栈记录下来，最后在三个地方给你看：输出面板里的文字栈，左侧活动栏里的调用树，编辑器区域里的时间轴面板。只做 C、单线程、本机程序，不碰 C++、多线程、异步和信号，不走 DAP，也不依赖 cpptools。它不会插手你的编译和调试配置，所有功能都要你自己触发。

界面上有两块地方，第一次用容易只看到其中一块。活动栏里那个从上到下的列表是调用树；时间轴不在这里，它在编辑器区域一个叫「StackViz 回放」的标签页里。把时间轴叫出来的办法有三个：开始记录的时候它自己会开（开在编辑器侧边，不会抢走你光标），或者在命令面板里找 StackViz: Open Visualizer，或者点调用树视图标题栏最左边那个 ▶ 按钮。面板要有记录才有内容，没跑过的时候滑块是灰的，写着「还没有事件」。

跑之前需要 WSL2 的 Ubuntu 或者原生 Linux 桌面上的 Remote 窗口，扩展运行在 Linux 那一侧（package.json 里写的是 extensionKind: workspace，所以目录别开成 Windows 侧的）。装好编译器和调试器就行，gdb 必须是带 Python 3 的那种，发行版自带的包默认就是：

```bash
sudo apt update
sudo apt install -y build-essential gdb
# 可选：装了它 gdb 进 libc 时会安静一些，不装也能跑
sudo apt install -y libc6-dbg
```

想自己确认一遍可以跑 gcc --version、gdb --version，以及 gdb -q -nx -batch -ex "python print('python 3 support: yes')"；插件里也有一条 StackViz: Check Environment，它会打印平台、内核是不是 WSL2、gcc 和 gdb 的版本、gdb 有没有 Python 3、libc6-dbg 在不在、<工作区>/.stackviz/ 能不能写。缺东西的时候会弹一个提示，按钮是把 sudo apt update && sudo apt install -y build-essential gdb 复制到剪贴板。编译扩展本身需要 Node 18 或更高版本。

输出面板里的东西长这样，下面这段是 factorial 例子里 n 等于 4 时的开头几行和最后的统计：

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

「帧」就是一次函数调用，帧号每次调用都不一样，所以同一个 factorial 出现在不同深度时是几帧不同的记录，这也是它能把递归的每一层分开的原因。缩进就是栈的深度，标了 <-- 栈顶 的那一行是程序正停着的地方。调用树里点一个节点，或者在回放面板里点调用栈里的某一行，输出面板会打印这一帧的白话说明：这是第几次调用、代码停在哪一行、参数、局部变量、谁调用了它、它调用了谁、在栈里第几层、现在是正在执行还是已经返回，同时编辑器跳到对应的源码行。

命令一共十三条，常用的是前面这些。编译并记录用 StackViz: Compile and Visualize Recursion，它会按 stackviz.compileMode 决定是自己编译还是问你要一个已有的可执行文件；已经有了二进制就换成 StackViz: Visualize Existing Binary，它不编译，候选顺序是设置里的 stackviz.binaryPath、工作区里的 .stackviz/a.out、再不行弹文件对话框。StackViz: Stop 结束当前 gdb 会话，先 SIGTERM，1.5 秒后还不退就 SIGKILL；StackViz: Clear 清空输出面板和内存里的记录，但不会打断正在跑的会话；StackViz: Print Current Stack 把此刻的调用栈打印出来，程序跑完之后也能打最后一份。回放相关的有 StackViz: Open Visualizer 打开时间轴面板，StackViz: Replay: Previous Event、Next Event、Next Call、Next Return 在时间轴上跳，StackViz: Replay: Follow Latest 回到最新事件重新跟随，这几条只在已经有记录时才会出现在命令面板里。记录可以存成文件：StackViz: Export Recording 写成一个 .stackviz.jsonl，一行一个事件，就是协议本身没有额外包装；StackViz: Import Recording 读回来，空行、以 # 开头的注释行和解析不了的行会跳过并在输出面板里说跳了几行。最后两条是新手相关的，StackViz: Check Environment 做环境自检，StackViz: Open Example 把内置示例拷到 <工作区>/.stackviz/examples/ 并打开，已经存在的文件不会被覆盖，你改过的版本留着。

编译选项是固定的，plugin 模式只会加你写在 stackviz.extraCompilerArgs 里的参数：

```bash
gcc -g -O0 -fno-omit-frame-pointer -fno-optimize-sibling-calls -o .stackviz/a.out <file.c>
```

设置项有十一个。stackviz.compileMode 默认 ask，可选 plugin 或 user；stackviz.binaryPath 默认空字符串，user 模式下用它；stackviz.extraCompilerArgs 默认空数组；stackviz.gccPath 和 stackviz.gdbPath 默认是 gcc 和 gdb；stackviz.maxSteps 默认 5000，超了就停下来并给一条提示；stackviz.maxDepth 默认 100，超过的部分从栈底往上截断并给提示；stackviz.recordLocals 默认 true，关掉就不读局部变量和参数；stackviz.maxArrayItems 默认 10；stackviz.snapshot 默认 auto，想放弃快速路径、每一步都完整走栈的话设成 safe，慢几倍但行为完全可预测；stackviz.traceLevel 默认 all，嫌输出面板太长可以设成 events（只留事件行）或者 off（只留开头和最后的小结）。临时文件只写在 .stackviz/ 目录里。

扩展在 127.0.0.1 上随便找一个端口监听，把端口号通过环境变量告诉 gdb，另外两个环境变量一个传选项，一个传你自己源码的绝对路径列表：

```
STACKVIZ_PORT=<端口>      扩展的 TCP 端口
STACKVIZ_OPTIONS=<json>   maxSteps / maxDepth / recordLocals / maxArrayItems / snapshot
STACKVIZ_SOURCES=<json>   你自己的 .c/.h 绝对路径数组
```

每行一个 JSON 对象，字段是这些：

```ts
type CStackEvent = {
  type: "call" | "return" | "line" | "exception" | "exit";
  frameId: number;
  parentFrameId?: number;
  functionName: string;
  file: string;
  line: number;
  depth: number;
  timestamp: number;          // 毫秒
  args?: Record<string, string>;
  locals?: Record<string, string>;
  returnValue?: string;
  message?: string;           // 这个字段是本项目加的，exception / exit 用它带说明
};
```

栈的变化是这样判断的：比较前后两次快照，最长的那段公共前缀算没变，新出现的帧发 call（从外往内），消失的帧发 return（从内往外），当前栈顶再补一条 line。exception 和 exit 是驱动自己造的合成事件。这里有个坑值得写下来：同一行里的两次同名调用，比如 return fib(n-1) + fib(n-2)，gdb 的某一次 step 可能把「被调用者返回」和「兄弟被调用」一次走完，这时快照看起来完全没变，光比前缀会把两次调用并成一个节点，调用树就不再分叉。所以驱动还记录了「当前是不是停在函数结尾的大括号上」，是的话说明这次调用已经结束，下一次快照哪怕长得一样也按先 return 再 call 处理。fibonacci 那个示例正是这种情况，现在能正确记出 26 次调用。

变量只读不写，而且读的时候都包在异常捕获里。基本类型直接给值，数组最多显示前 10 个元素（stackviz.maxArrayItems），字符串截断到 100 个字符，指针只给地址不做解引用，结构体最多显示前 10 个字段，一次最多读 20 个变量，把 stackviz.recordLocals 关掉就完全跳过。没赋过值的局部变量会显示栈上的垃圾值，这是 -O0 下 gdb 的真实读数，不是插件算错了。

装了 libc6-dbg 之后 gdb 会顺着 step 走进 printf，那种帧成百上千而且没有意义。所以插件把自己知道的 .c 和 .h 绝对路径传给驱动，驱动只记录这些文件里的帧，一旦单步落进库函数就用 finish 跑回用户代码，中间的帧吞掉。拿不到源码列表的时候（比如可视化一个源码不明的二进制）就按路径猜：绝对路径、不在系统目录、而且文件在本机确实存在，三条都满足才算你自己的代码。系统目录默认是 /usr、/lib、/lib64、/bin、/sbin、/etc、/var、/build，最后那个 /build 是发行版打包 glibc 时记录的构建路径，之前就是从这儿漏进来的。源码挪过位置的话，用 stackviz.sourceRoots 或者环境变量 STACKVIZ_SOURCE_ROOTS 把目录声明成「这里是我写的」，它优先于系统目录判断，整张系统目录表可以用 STACKVIZ_SYSTEM_PREFIXES 换掉。在猜的状态下，输出面板里会有一行 [gdb] [stackviz] 没有拿到这个二进制的源码列表…，看到它就知道当前是哪种模式。

内置示例有四个。factorial.c 是线性递归，看一层层进去再一层层出来；fibonacci.c 是树状递归，调用树会分叉，用回放面板按播放最直观；mutual_recursion.c 是互递归，is_even 和 is_odd 交替出现；deep_recursion.c 是 42 层的深栈，用来看栈快照的省略和 maxDepth 的行为。

性能这块踩过一个坑：最早的实现每一步都让 gdb 展开整条调用栈，1000 层递归、5000 步要 25.9 秒。现在驱动只读栈顶那一帧，靠帧指针和「结尾大括号」两个信号判断是不是同一个调用，只有栈真的变了才多读一帧，另外每 250 步做一次完整重扫兜底，同样的场景 2.2 秒跑完，5011 条事件在扩展这一侧处理完是 34 毫秒，单次最长 9.7 毫秒。交互路径也收拾过，10 万条事件的情况下，回放面板点一次「下一步」或者播放一跳是 0.003 毫秒（之前每次从头重放，12.7 毫秒），面板每次刷新取事件数和异常表是 0.015 毫秒（之前 1.56 毫秒），往回拖到记录中点大概 1.6 毫秒，而且被 10 万条的上限兜住了。

仓库里带着一套能直接跑的测试，不需要打开 VSCode 窗口，办法是把 vscode 模块替换成桩，直接驱动真实的扩展代码。npm install 之后跑 npm test，它会先编译再跑单元和集成，本机大约 10 秒，单元 22 条、集成 32 条；npm run test:slow 是可选的性能预算，1000 帧深、5000 步，本机约 2.4 秒。没装 gcc 或 gdb 的机器上，集成测试会跳过并写明原因，不会假装通过。最要紧的一张网是 test/integration/differential.test.js：它让「快速路径」和「每步完整走栈」两种模式跑同一批程序，逐事件比对必须完全一样，还要核对调用次数，比如 fib(6) 必须是 26 次调用。进这套用例的对抗程序包括同一行里的两次同名调用、循环头正好在函数首行、以及往回 goto，这三种都是容易把「聪明」的判断带偏的形状。单元测试里还有一条静态检查，驱动脚本里不允许再出现 set auto-load safe-path /，那会掀掉 gdb 的一层安全保护，必须保持 set auto-load off。GitHub Actions 在每次 push 和 PR 上用 Node 20 和 22 各跑一遍。README 顶上的测试徽章指的是 main 分支上这个工作流最近一次运行，刚推送的时候可能还停在上一次的结果（GitHub 和浏览器都会缓存徽章图片几分钟），PR 上显示绿勾也不等于 main 已经变绿，以 Actions 页面为准。

已知的限制一并写清楚。可视化只有输出面板的文字栈、原生调用树和一个 Webview 面板，没有动画时间轴，也没有回放历史，内存里只留最后一次记录。回放定位是从头重放，10 万条以内是毫秒级，拖滑块不是逐帧动画，播放速度固定 300 毫秒一条。导出的是保留窗口内的记录，上限 10 万条，更早的会被丢并在小结里说明。驱动需要带 Python 3 的 gdb。快速路径依赖帧指针，也就是插件固定用的 -fno-omit-frame-pointer；你要是自己用 -O2 编译、或者程序里有手写汇编帧、setjmp、信号处理，驱动会退回完整走栈，结果仍然对，只是慢一些，也可以直接把 stackviz.snapshot 设成 safe 让它一开始就走这条路。库函数帧被整体跳过，所以回调（比如 qsort 的比较函数）会直接挂在调用者下面。return 事件带的是这一帧最后一次观测到的参数，不是真正的返回值。没赋值的局部变量显示栈上的垃圾值。只支持 C、单线程、同步、本机程序，必须 -O0。

出问题时先看这几处。如果输出面板里有 gdb 找不到的字样，装 gdb 或者改 stackviz.gdbPath；如果停在「正在监听 127.0.0.1:…」不动，说明 gdb 没连回来，检查有没有东西挡住本机回环；如果看到 [gcc] 开头的报错，那是你的代码编译不过，不是插件的问题；如果只收到一条 exit，通常说明这个二进制没有 main 符号或者没带 -g，用插件编译模式重新编一遍；如果栈里只有 main 一层，先确认程序真的执行了更多代码，也可能是 maxSteps 设得太小。

插件只在显式执行命令时才启动进程，不注册 DebugAdapterTracker，不改 launch.json、tasks.json、settings.json，不碰你的构建和终端，临时文件只写 .stackviz/。禁用之后 VSCode 的行为和没装它一样。

许可协议是 MIT，Copyright (c) 2026 Shuanshi，全文见 LICENSE 文件。项目没有运行时的第三方依赖（typescript 和 @types 只是开发依赖，不会打进 vsix），所以没有额外的第三方许可声明要带。
