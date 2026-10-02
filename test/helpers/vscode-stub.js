/*
 * Minimal stand-in for the `vscode` module so the real extension code can be
 * driven head-less from a Node test (the extension never talks to a real
 * window in these tests, it only calls the API surface below).
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ROOT } = require('./toolchain');

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

class MarkdownString {
  constructor() {
    this.value = '';
  }
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
}

class Range {
  constructor(startLine, startChar, endLine, endChar) {
    this.start = { line: startLine, character: startChar };
    this.end = { line: endLine, character: endChar };
  }
}

function uriOf(fsPath) {
  return { fsPath, scheme: 'file', path: fsPath };
}

function makeOutputChannel() {
  const lines = [];
  return {
    lines,
    text: () => lines.join('\n'),
    appendLine(line) {
      lines.push(line);
    },
    append(text) {
      lines.push(text);
    },
    show() {},
    clear() {
      lines.length = 0;
    },
    dispose() {},
  };
}

function createHarness(options = {}) {
  // A fresh workspace per harness, so tests never see leftovers of each other.
  const workspaceRoot = options.workspaceRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'stackviz-ws-'));
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const output = makeOutputChannel();
  const state = {
    commands: new Map(),
    panels: [],
    messages: [],
    executed: [],
    clipboard: '',
    dialogs: { open: undefined, save: undefined, quickPickFirst: true },
    settings: { gccPath: 'gcc', gdbPath: 'gdb', binaryPath: '', ...(options.settings || {}) },
    workspaceRoot,
    treeProvider: undefined,
    treeView: undefined,
    activeTextEditor: undefined,
  };

  const vscode = {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    MarkdownString,
    Range,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    Uri: {
      file: uriOf,
      joinPath: (base, ...parts) => uriOf(path.join(base.fsPath, ...parts)),
    },
    env: {
      clipboard: {
        writeText: async (text) => {
          state.clipboard = text;
        },
      },
    },
    workspace: {
      fs: {
        createDirectory: async (uri) => fs.mkdirSync(uri.fsPath, { recursive: true }),
        stat: async (uri) => fs.statSync(uri.fsPath),
        copy: async (from, to, copyOptions) => {
          if (copyOptions && copyOptions.overwrite === false && fs.existsSync(to.fsPath)) {
            const error = new Error('File exists');
            error.name = 'FileExists';
            throw error;
          }
          fs.copyFileSync(from.fsPath, to.fsPath);
        },
        readFile: async (uri) => fs.readFileSync(uri.fsPath),
        writeFile: async (uri, bytes) => fs.writeFileSync(uri.fsPath, Buffer.from(bytes)),
      },
      asRelativePath: (value) =>
        typeof value === 'string' && value.startsWith(ROOT + '/') ? value.slice(ROOT.length + 1) : value,
      getConfiguration: () => ({ get: (key, fallback) => (key in state.settings ? state.settings[key] : fallback) }),
      getWorkspaceFolder: () => undefined,
      workspaceFolders: [{ uri: uriOf(workspaceRoot), name: 'test', index: 0 }],
      findFiles: async () => options.findFiles || [],
      openTextDocument: async () => ({}),
    },
    window: {
      createOutputChannel: () => output,
      createTreeView: (id, viewOptions) => {
        state.treeProvider = viewOptions.treeDataProvider;
        state.treeView = {
          id,
          badge: undefined,
          dispose() {},
          reveal() {},
          onDidChangeSelection: () => ({ dispose() {} }),
        };
        return state.treeView;
      },
      createWebviewPanel: (id, title) => {
        const handlers = [];
        const panel = {
          id,
          title,
          posted: [],
          webview: {
            html: '',
            cspSource: 'vscode-resource:',
            postMessage: async (message) => {
              panel.posted.push(message);
              return true;
            },
            onDidReceiveMessage: (handler) => {
              handlers.push(handler);
              return { dispose() {} };
            },
            receive: (message) => handlers.forEach((handler) => handler(message)),
            lastState: () => {
              for (let index = panel.posted.length - 1; index >= 0; index -= 1) {
                if (panel.posted[index].type === 'state') return panel.posted[index].state;
              }
              return undefined;
            },
          },
          onDidDispose: () => ({ dispose() {} }),
          reveal() {},
          dispose() {},
          iconPath: undefined,
        };
        state.panels.push(panel);
        return panel;
      },
      showQuickPick: async (items) => (state.dialogs.quickPickFirst ? items[0] : undefined),
      showOpenDialog: async () => (state.dialogs.open ? [uriOf(state.dialogs.open)] : undefined),
      showSaveDialog: async () => (state.dialogs.save ? uriOf(state.dialogs.save) : undefined),
      showInputBox: async () => undefined,
      showInformationMessage: async (message, ...actions) => {
        state.messages.push({ kind: 'info', message, actions });
        return undefined;
      },
      showErrorMessage: async (message, ...actions) => {
        state.messages.push({ kind: 'error', message, actions });
        return actions[0];
      },
      showTextDocument: async () => ({}),
      get activeTextEditor() {
        return state.activeTextEditor;
      },
    },
    commands: {
      registerCommand: (id, handler) => {
        state.commands.set(id, handler);
        return { dispose() {} };
      },
      executeCommand: async (id, ...args) => {
        state.executed.push({ id, args });
        return undefined;
      },
    },
  };

  const originalLoad = Module._load;
  Module._load = function load(request) {
    if (request === 'vscode') return vscode;
    return originalLoad.apply(this, arguments);
  };

  return {
    vscode,
    state,
    output,
    activate() {
      // The extension module is cached by Node; drop it so every harness gets
      // its own instance bound to its own stub.
      const outDir = path.join(ROOT, 'out') + path.sep;
      for (const key of Object.keys(require.cache)) {
        if (key.startsWith(outDir)) delete require.cache[key];
      }
      const extension = require(path.join(ROOT, 'out', 'extension.js'));
      extension.activate({
        extensionPath: ROOT,
        extensionUri: uriOf(ROOT),
        globalStorageUri: uriOf(path.join(state.workspaceRoot, '.storage')),
        subscriptions: [],
      });
      return extension;
    },
    restore() {
      Module._load = originalLoad;
    },
  };
}

/** Waits until the run summary shows up in the output channel. */
async function waitForEndOfRun(output, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output.lines.some((line) => line.includes('记录结束'))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** Walks the whole call tree and returns every node. */
function allNodes(provider) {
  const result = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      result.push(node);
      walk(provider.getChildren(node));
    }
  };
  walk(provider.getChildren());
  return result;
}

module.exports = { createHarness, waitForEndOfRun, allNodes };
