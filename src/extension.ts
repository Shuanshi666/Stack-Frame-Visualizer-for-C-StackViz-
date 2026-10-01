import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { CallTreeDataProvider, FrameTreeNode } from './callTree';
import { BUILTIN_EXAMPLES, materializeExample } from './examples';
import { compileCFile, readConfig, StackVizConfig, StackVizSession } from './gdbSession';
import { defaultRecordingName, readRecording, writeRecording } from './recording';
import { stackLines } from './render';
import { FrameInfo, StackModel } from './stackModel';
import { TimelineLabels, TimelinePanel } from './timelinePanel';
import { checkEnvironment, INSTALL_COMMAND, Toolchain, ToolchainError } from './toolchain';
import { formatRecord, prettyPath } from './util';

class StackVizController implements vscode.Disposable {
  private session: StackVizSession | undefined;
  private tree: CallTreeDataProvider | undefined;
  private timeline: TimelinePanel | undefined;
  private labels: TimelineLabels = { source: '', binary: '' };
  private hasRecordingContext = false;
  private printedLegend = false;
  private readonly toolchain = new Toolchain();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly model: StackModel
  ) {}

  public get isRunning(): boolean {
    return this.session !== undefined;
  }

  public attachTree(tree: CallTreeDataProvider): void {
    this.tree = tree;
  }

  /** Opens (or reveals) the replay panel: timeline slider, step/jump, export. */
  public openVisualizer(): void {
    this.timeline = TimelinePanel.show(this.context, this.model, this, this.labels);
  }

  /** Called from the replay panel toolbar. */
  public requestExport(): void {
    void this.exportRecording();
  }

  /** Called from the replay panel toolbar. */
  public requestImport(): void {
    void this.importRecording();
  }

  public replayStep(delta: number): void {
    this.model.stepBy(delta);
    this.afterReplay();
  }

  public replayJump(kinds: readonly ('call' | 'return' | 'exception')[], forward: boolean): void {
    const index = this.model.findEvent(kinds, forward);
    if (index >= 0) {
      this.model.seek(index);
    }
    this.afterReplay();
  }

  public replayFollowLatest(): void {
    this.model.followLatest();
    this.afterReplay();
  }

  public async exportRecording(): Promise<void> {
    const events = this.model.exportEvents();
    if (events.length === 0) {
      void vscode.window.showInformationMessage('StackViz: there is no recording to export yet.');
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const target = await vscode.window.showSaveDialog({
      title: 'StackViz: export recording',
      defaultUri: folder ? vscode.Uri.joinPath(folder.uri, defaultRecordingName()) : undefined,
      filters: { 'StackViz recording': ['jsonl'] },
      saveLabel: 'Export'
    });
    if (!target) {
      return;
    }
    await writeRecording(target, events);
    this.output.appendLine(`StackViz: exported ${events.length} event(s) to ${target.fsPath}`);
    void vscode.window.showInformationMessage(
      `StackViz: exported ${events.length} event(s) to ${path.basename(target.fsPath)}.`
    );
  }

  public async importRecording(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      title: 'StackViz: import a recording',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Import',
      filters: { 'StackViz recording': ['jsonl'] }
    });
    if (!picked || picked.length === 0) {
      return;
    }
    if (this.session) {
      this.output.appendLine('--- StackViz: stopping the live run before importing ---');
      this.session.stop();
      this.session = undefined;
    }
    const parsed = await readRecording(picked[0]);
    if (parsed.events.length === 0) {
      throw new Error(`No StackViz events found in ${path.basename(picked[0].fsPath)}.`);
    }
    this.model.loadRecording(parsed.events);
    this.labels = { source: path.basename(picked[0].fsPath), binary: '' };
    this.tree?.refreshNow();
    this.syncContext();
    this.openVisualizer();
    this.output.appendLine(
      `StackViz: imported ${parsed.events.length} event(s) from ${picked[0].fsPath}` +
        (parsed.skipped > 0 ? ` (${parsed.skipped} line(s) skipped)` : '')
    );
  }

  private afterReplay(): void {
    this.tree?.refreshNow();
    this.timeline?.refreshNow();
    this.syncContext();
  }

  /** Command palette entries only make sense once something was recorded. */
  private syncContext(): void {
    const hasRecording = this.model.eventCount > 0;
    if (hasRecording !== this.hasRecordingContext) {
      this.hasRecordingContext = hasRecording;
      void vscode.commands.executeCommand('setContext', 'stackviz.hasRecording', hasRecording);
    }
  }

  /** Fails early (with a fix) when gcc or gdb is missing. */
  private async ensureToolchain(config: StackVizConfig, needsGcc: boolean): Promise<void> {
    if (needsGcc) {
      const gcc = await this.toolchain.checkGcc(config.gccPath);
      if (!gcc.ok) {
        throw new ToolchainError(`${gcc.error ?? 'gcc is not available'}`, INSTALL_COMMAND);
      }
    }
    const gdb = await this.toolchain.checkGdb(config.gdbPath);
    if (!gdb.ok) {
      throw new ToolchainError(`${gdb.error ?? 'gdb is not available'}`, INSTALL_COMMAND);
    }
  }

  /** "StackViz: Check Environment" - what is installed, and what is missing. */
  public async checkEnvironment(): Promise<void> {
    const config = readConfig();
    const folders = vscode.workspace.workspaceFolders;
    const report = await checkEnvironment(
      this.toolchain,
      config.gccPath,
      config.gdbPath,
      folders && folders.length > 0 ? folders[0].uri.fsPath : undefined
    );
    this.output.show(true);
    this.output.appendLine('');
    for (const line of report.lines) {
      this.output.appendLine(line);
    }
    this.output.appendLine('');

    if (report.ok) {
      void vscode.window.showInformationMessage('StackViz: the environment looks good (see the StackViz output).');
      return;
    }
    await this.offerInstall('StackViz: something is missing - see the StackViz output for details.');
  }

  /** "StackViz: Open Example" - bundled programs, ready to run. */
  public async openExample(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      BUILTIN_EXAMPLES.map((example) => ({
        label: example.label,
        description: example.file,
        detail: example.description,
        example
      })),
      { title: 'StackViz: open a built-in example', placeHolder: 'the file is copied into .stackviz/examples/' }
    );
    if (!picked) {
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    const root = folders && folders.length > 0 ? folders[0].uri : undefined;
    const uri = await materializeExample(this.context, picked.example, root);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    this.output.appendLine(`StackViz: example opened at ${uri.fsPath}`);

    const action = await vscode.window.showInformationMessage(
      `StackViz: ${picked.example.file} is ready. Change the depth and run it!`,
      'Compile and Visualize Recursion'
    );
    if (action === 'Compile and Visualize Recursion') {
      await this.compileAndVisualize();
    }
  }

  private async offerInstall(message: string): Promise<void> {
    const action = await vscode.window.showErrorMessage(message, 'Copy Install Command');
    if (action === 'Copy Install Command') {
      await vscode.env.clipboard.writeText(INSTALL_COMMAND);
      void vscode.window.showInformationMessage(`StackViz: copied "${INSTALL_COMMAND}" to the clipboard.`);
    }
  }

  public async compileAndVisualize(): Promise<void> {
    try {
      if (this.session) {
        this.output.appendLine('--- StackViz: stopping the previous run ---');
        this.session.stop();
        this.session = undefined;
      }

      const sourceFile = await this.pickSourceFile();
      if (!sourceFile) {
        return;
      }

      const config = readConfig(vscode.Uri.file(sourceFile));
      const root = this.workspaceRootFor(sourceFile);
      const outputBinary = path.join(root, '.stackviz', 'a.out');

      await this.ensureToolchain(config, config.compileMode !== 'user');
      const binaryPath = await this.resolveBinary(sourceFile, root, outputBinary, config);
      if (!binaryPath) {
        return;
      }

      await this.startSession(binaryPath, root, sourceFile, await this.collectSourceFiles(sourceFile), config);
    } catch (error) {
      this.reportError(error);
    }
  }

  /**
   * "StackViz: Visualize Existing Binary" - same recording pipeline, but the
   * executable is picked by the user and nothing is compiled.
   */
  public async visualizeExistingBinary(): Promise<void> {
    try {
      if (this.session) {
        this.output.appendLine('--- StackViz: stopping the previous run ---');
        this.session.stop();
        this.session = undefined;
      }

      const config = readConfig();
      await this.ensureToolchain(config, false);
      const binaryPath = await this.pickExistingBinary(config);
      if (!binaryPath) {
        return;
      }

      const root = this.workspaceRootFor(binaryPath);
      const active = vscode.window.activeTextEditor?.document;
      const sourceFile =
        active && active.uri.scheme === 'file' && /\.c$/i.test(active.uri.path) ? active.uri.fsPath : undefined;

      await this.startSession(binaryPath, root, sourceFile, await this.collectSourceFiles(sourceFile), config);
    } catch (error) {
      this.reportError(error);
    }
  }

  public clear(): void {
    const running = this.session !== undefined;
    this.output.clear();
    this.model.reset();
    this.tree?.refreshNow();
    this.timeline?.refreshNow();
    this.syncContext();
    this.output.appendLine('StackViz: cleared the output channel and the recording.');
    if (running) {
      this.output.appendLine('StackViz: the current run is still active; the stack is rebuilt from the next events.');
    }
  }

  public stop(): void {
    if (!this.session) {
      this.output.appendLine('StackViz: nothing is running.');
      return;
    }
    this.session.stop();
    this.session = undefined;
  }

  public printCurrentStack(): void {
    this.output.show(true);
    this.output.appendLine('');
    this.output.appendLine(`===== current stack (${new Date().toISOString()}) =====`);
    const frames = this.model.liveFrames();
    if (frames.length === 0) {
      this.output.appendLine(this.session ? '(no frame recorded yet)' : '(no recording yet - run a StackViz command first)');
      return;
    }
    for (const line of stackLines(frames, { indent: '  ' })) {
      this.output.appendLine(line);
    }
    this.output.appendLine(
      `===== ${this.model.eventCount} event(s), ${this.model.steps} step(s), max depth ${this.model.maxDepthObserved} =====`
    );
    this.output.appendLine('');
  }

  /** Invoked when a node of the call tree is clicked (or from the command palette). */
  public async showFrame(node?: FrameTreeNode): Promise<void> {
    if (!node) {
      void vscode.window.showInformationMessage(
        'StackViz: click a frame in the "StackViz" call tree to see its variables and line.'
      );
      return;
    }
    await this.showFrameInfo(node.frame);
  }

  /** Same as showFrame(), but for a frameId coming from the replay panel. */
  public async showFrameById(frameId: number): Promise<void> {
    const frame = this.model.frame(frameId);
    if (frame) {
      await this.showFrameInfo(frame);
    }
  }

  private async showFrameInfo(frame: FrameInfo): Promise<void> {
    const live = this.model.isLive(frame.frameId);
    const isTop = this.model.topFrameId() === frame.frameId;
    const args = formatRecord(frame.args);
    const locals = formatRecord(frame.locals);
    const parent = frame.parentFrameId === undefined ? undefined : this.model.frame(frame.parentFrameId);
    const children = this.model.childrenOf(frame.frameId);
    const status = isTop
      ? '正在执行 —— 它就是栈顶，程序此刻停在这里'
      : live
        ? '还在调用栈上 —— 正在等它调用的函数返回'
        : '已经返回 —— 这次调用结束了，已经不在当前调用栈里';

    this.output.show(true);
    this.output.appendLine('');
    this.output.appendLine(`===== 帧 #${frame.frameId}：${frame.functionName}(${args}) =====`);
    this.output.appendLine(
      `这是第几次调用  ：第 ${frame.frameId} 次（函数每被调用一次就有一个新编号，递归的每一层都不一样）`
    );
    this.output.appendLine(`代码停在哪      ：${prettyPath(frame.file)} 第 ${frame.line} 行`);
    if (frame.file.length > 0) {
      this.output.appendLine(`  完整路径      ：${frame.file}`);
    }
    this.output.appendLine(`参数            ：${args.length > 0 ? args : '（这次调用没有参数）'}`);
    this.output.appendLine(`局部变量        ：${locals.length > 0 ? locals : '（没有，或还没执行到赋值那一步）'}`);
    this.output.appendLine(
      `谁调用了它      ：${
        parent
          ? `帧 #${parent.frameId}（${parent.functionName}，在 ${prettyPath(parent.file)} 第 ${parent.line} 行）`
          : '（没有，它是最底层那次调用，例如 main）'
      }`
    );
    this.output.appendLine(
      `它调用了谁      ：${
        children.length > 0
          ? `${children.length} 次，例如 ` +
            children
              .slice(0, 3)
              .map((child) => `帧 #${child.frameId}（${child.functionName}）`)
              .join('、')
          : '（它没有调用别的函数）'
      }`
    );
    this.output.appendLine(`它在栈里第几层  ：第 ${frame.depth + 1} 层（第 1 层是最底下的 main，数字越大套得越深）`);
    this.output.appendLine(`它现在的状态    ：${status}`);
    for (const note of this.model.exceptionNotes(frame.frameId)) {
      this.output.appendLine(`注意            ：这一帧上记录到一个异常：${note}`);
    }
    this.output.appendLine('');
    this.output.appendLine('（"帧"就是一次函数调用：左栏调用树上的每个节点、回放面板调用栈里的每一行，都是这样一帧。）');
    this.output.appendLine('');

    await this.revealFrame(frame);
  }

  public dispose(): void {
    this.session?.dispose();
    this.session = undefined;
  }

  private async startSession(
    binaryPath: string,
    root: string,
    sourceFile: string | undefined,
    sourceFiles: string[],
    config: StackVizConfig
  ): Promise<void> {
    this.model.reset();
    this.tree?.refreshNow();
    this.timeline?.refreshNow();
    this.syncContext();
    this.labels = {
      source: sourceFile ? prettyPath(sourceFile) : '(existing binary)',
      binary: prettyPath(binaryPath)
    };
    this.timeline?.setLabels(this.labels);
    this.output.show(true);
    this.output.appendLine('');
    this.output.appendLine(`===== StackViz run ${new Date().toISOString()} =====`);
    this.output.appendLine(`source : ${sourceFile ?? '(existing binary, nothing is compiled)'}`);
    this.output.appendLine(`binary : ${binaryPath}`);
    this.output.appendLine(`workdir: ${root}`);
    this.output.appendLine(
      `limits : maxSteps=${config.maxSteps} maxDepth=${config.maxDepth} ` +
        `recordLocals=${config.recordLocals} maxArrayItems=${config.maxArrayItems}`
    );
    this.output.appendLine(`sources: ${sourceFiles.length} C file(s) are treated as user code`);

    if (!this.printedLegend) {
      this.printedLegend = true;
      this.output.appendLine('');
      this.output.appendLine('===== 怎么读下面的输出（只提示这一次）=====');
      this.output.appendLine('+ call   #2  factorial(n = 4)  examples/factorial.c:12');
      this.output.appendLine('       —— 进入了一次函数调用；#2 是这一"帧"（这一次调用）的编号');
      this.output.appendLine('  line   #2  factorial(n = 4)  examples/factorial.c:16');
      this.output.appendLine('       —— 程序又往前执行了一行');
      this.output.appendLine('- return #2  factorial(n = 4)');
      this.output.appendLine('       —— 这次调用返回了，控制权交回给调用它的那一帧');
      this.output.appendLine('每个 call / return 下面那几行就是当时的完整调用栈：缩进越多 = 套得越深，');
      this.output.appendLine('<-- top 指的是最里面那一帧（程序正停在那里）。');
      this.output.appendLine('帧号（# 后面的数字）每次调用都不一样，所以递归的每一层都分得开。');
      this.output.appendLine('左栏 StackViz 图标 = 调用树（每次调用一个节点，点节点看这一帧的变量）；');
      this.output.appendLine('编辑器区域的 StackViz Replay 标签页 = 时间轴，可以拖回去逐步重看。');
      this.output.appendLine('============================================');
      this.output.appendLine('');
    }

    this.session = await StackVizSession.start({
      extensionPath: this.context.extensionPath,
      binaryPath,
      workdir: root,
      sourceFile,
      sourceFiles,
      config,
      output: this.output,
      model: this.model,
      onExit: () => {
        this.session = undefined;
        this.tree?.refreshNow();
        this.timeline?.refreshNow();
      },
      onEvent: (event) => {
        this.tree?.notify(event);
        this.timeline?.refresh();
        this.syncContext();
      }
    });

    // Make the timeline visible without hunting for it: open the panel on the
    // first run of the session, but never steal focus from an existing one.
    if (!TimelinePanel.current) {
      this.openVisualizer();
    }
  }

  private async revealFrame(frame: FrameInfo): Promise<void> {
    if (frame.line <= 0 || !frame.file || !path.isAbsolute(frame.file) || !fs.existsSync(frame.file)) {
      // Frames from libraries or from sources that moved are not revealed.
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(frame.file);
      const line = Math.max(0, frame.line - 1);
      await vscode.window.showTextDocument(document, {
        selection: new vscode.Range(line, 0, line, 0),
        preview: true,
        preserveFocus: false
      });
    } catch {
      // Rendering the frame details already succeeded; opening the file is a bonus.
    }
  }

  /**
   * The gdb driver hides frames that do not come from the user's own sources
   * (so that printf() and friends do not pollute the recording).  The compiled
   * file plus every C source and header of the workspace is passed along.
   */
  private async collectSourceFiles(preferred?: string): Promise<string[]> {
    const files = new Set<string>(preferred ? [preferred] : []);
    try {
      const found = await vscode.workspace.findFiles(
        '**/*.{c,h}',
        '**/{node_modules,.git,out,.stackviz,build,dist}/**',
        200
      );
      for (const uri of found) {
        files.add(uri.fsPath);
      }
    } catch {
      // A workspace without a folder is fine: only the compiled file is known.
    }
    return [...files].slice(0, 200);
  }

  private async resolveBinary(
    sourceFile: string,
    root: string,
    outputBinary: string,
    config: StackVizConfig
  ): Promise<string | undefined> {
    if (config.compileMode === 'plugin') {
      const result = await compileCFile(sourceFile, outputBinary, root, config, this.output);
      this.output.appendLine(`StackViz: compiled ${prettyPath(result.binaryPath)}`);
      return result.binaryPath;
    }
    if (config.compileMode === 'user') {
      return this.requireBinary(config.binaryPath, root);
    }

    const compileItem: vscode.QuickPickItem = {
      label: '$(tools) Compile with the plugin',
      description: `${config.gccPath} -g -O0 ... -o .stackviz/a.out`
    };
    const existingItem: vscode.QuickPickItem = {
      label: '$(file-binary) Use an existing executable',
      description: config.binaryPath.length > 0 ? config.binaryPath : 'stackviz.binaryPath is not set'
    };
    const picked = await vscode.window.showQuickPick([compileItem, existingItem], {
      title: 'StackViz: how should the executable be produced?',
      placeHolder: 'Compile with the plugin, or run a binary you built yourself'
    });
    if (!picked) {
      return undefined;
    }
    if (picked === compileItem) {
      const result = await compileCFile(sourceFile, outputBinary, root, config, this.output);
      this.output.appendLine(`StackViz: compiled ${prettyPath(result.binaryPath)}`);
      return result.binaryPath;
    }

    let candidate = config.binaryPath;
    if (candidate.length === 0) {
      const entered = await vscode.window.showInputBox({
        title: 'StackViz: path of the executable to run',
        value: path.join(root, '.stackviz', 'a.out'),
        prompt: 'POSIX path of a binary compiled with -g -O0'
      });
      if (!entered) {
        return undefined;
      }
      candidate = entered.trim();
    }
    return this.requireBinary(candidate, root);
  }

  private requireBinary(candidate: string, root: string): string {
    if (candidate.length === 0) {
      throw new Error('stackviz.binaryPath is empty. Set it, or use the "plugin" compile mode.');
    }
    const resolved = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
    if (!fs.existsSync(resolved)) {
      throw new Error(`The executable does not exist: ${resolved}`);
    }
    const stats = fs.statSync(resolved);
    if (stats.isDirectory()) {
      throw new Error(`That is a directory, not an executable: ${resolved}`);
    }
    if ((stats.mode & 0o111) === 0) {
      throw new Error(`The file is not executable: ${resolved} (try: chmod +x "${resolved}")`);
    }
    return resolved;
  }

  /**
   * "Visualize Existing Binary" always asks for a concrete file, so the choice
   * is visible in the output channel instead of being implied by a setting.
   */
  private async pickExistingBinary(config: StackVizConfig): Promise<string | undefined> {
    type Candidate = vscode.QuickPickItem & { fsPath?: string; browse?: boolean };
    const candidates: Candidate[] = [];

    if (config.binaryPath.length > 0) {
      candidates.push({
        label: '$(file-binary) stackviz.binaryPath',
        description: config.binaryPath,
        fsPath: config.binaryPath
      });
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const candidate = path.join(folder.uri.fsPath, '.stackviz', 'a.out');
      if (fs.existsSync(candidate)) {
        candidates.push({
          label: '$(file-binary) .stackviz/a.out',
          description: vscode.workspace.asRelativePath(candidate, false),
          fsPath: candidate
        });
      }
    }
    candidates.push({
      label: '$(folder-opened) Choose another executable...',
      description: 'open a file dialog',
      browse: true
    });

    const picked = await vscode.window.showQuickPick(candidates, {
      title: 'StackViz: which executable should be visualized?',
      placeHolder: 'The binary must be compiled with -g -O0; StackViz never compiles in this command'
    });
    if (!picked) {
      return undefined;
    }
    if (picked.browse || !picked.fsPath) {
      const chosen = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Visualize this executable',
        title: 'StackViz: choose an executable (built with -g -O0)'
      });
      if (!chosen || chosen.length === 0) {
        return undefined;
      }
      return this.requireBinary(chosen[0].fsPath, this.workspaceRootFor(chosen[0].fsPath));
    }
    return this.requireBinary(picked.fsPath, this.workspaceRootFor(picked.fsPath));
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`StackViz error: ${message}`);
    this.output.show(true);
    if (error instanceof ToolchainError) {
      void this.offerInstall(`StackViz: ${message}`);
      return;
    }
    void vscode.window.showErrorMessage(`StackViz: ${message}`);
  }

  private async pickSourceFile(): Promise<string | undefined> {
    const active = vscode.window.activeTextEditor?.document;
    if (active && active.uri.scheme === 'file' && /\.c$/i.test(active.uri.path)) {
      return active.uri.fsPath;
    }

    const found = await vscode.workspace.findFiles('**/*.c', '**/{node_modules,.git,out,.stackviz}/**', 50);
    if (found.length === 0) {
      void vscode.window.showErrorMessage('StackViz: no .c file found. Open a C file first.');
      return undefined;
    }
    if (found.length === 1) {
      return found[0].fsPath;
    }
    const picked = await vscode.window.showQuickPick(
      found.map((uri) => ({ label: vscode.workspace.asRelativePath(uri, false), uri })),
      { title: 'StackViz: choose the C file to visualize' }
    );
    return picked?.uri.fsPath;
  }

  private workspaceRootFor(sourceFile: string): string {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(sourceFile));
    return folder ? folder.uri.fsPath : path.dirname(sourceFile);
  }
}

let controller: StackVizController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('StackViz');
  const model = new StackModel();
  const instance = new StackVizController(context, output, model);
  controller = instance;

  const treeProvider = new CallTreeDataProvider(model);
  const treeView = vscode.window.createTreeView<FrameTreeNode>('stackviz.callTree', {
    treeDataProvider: treeProvider,
    showCollapseAll: true
  });
  treeProvider.onAfterRefresh = () => {
    const frames = model.trackedFrames;
    treeView.badge = frames > 0 ? { value: frames, tooltip: `${frames} frame(s) recorded` } : undefined;
  };
  instance.attachTree(treeProvider);

  context.subscriptions.push(
    output,
    instance,
    treeProvider,
    treeView,
    vscode.commands.registerCommand('stackviz.compileAndVisualize', () => instance.compileAndVisualize()),
    vscode.commands.registerCommand('stackviz.visualizeExistingBinary', () => instance.visualizeExistingBinary()),
    vscode.commands.registerCommand('stackviz.stop', () => instance.stop()),
    vscode.commands.registerCommand('stackviz.printCurrentStack', () => instance.printCurrentStack()),
    vscode.commands.registerCommand('stackviz.clear', () => instance.clear()),
    vscode.commands.registerCommand('stackviz.openVisualizer', () => instance.openVisualizer()),
    vscode.commands.registerCommand('stackviz.showFrame', (node?: FrameTreeNode) => instance.showFrame(node)),
    vscode.commands.registerCommand('stackviz.exportRecording', () => instance.exportRecording()),
    vscode.commands.registerCommand('stackviz.importRecording', () => instance.importRecording()),
    vscode.commands.registerCommand('stackviz.replayPrev', () => instance.replayStep(-1)),
    vscode.commands.registerCommand('stackviz.replayNext', () => instance.replayStep(1)),
    vscode.commands.registerCommand('stackviz.replayNextCall', () => instance.replayJump(['call'], true)),
    vscode.commands.registerCommand('stackviz.replayNextReturn', () => instance.replayJump(['return'], true)),
    vscode.commands.registerCommand('stackviz.replayFollow', () => instance.replayFollowLatest()),
    vscode.commands.registerCommand('stackviz.checkEnvironment', () => instance.checkEnvironment()),
    vscode.commands.registerCommand('stackviz.openExample', () => instance.openExample())
  );
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}
