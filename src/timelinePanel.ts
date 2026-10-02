import * as vscode from 'vscode';

import { CStackEvent } from './protocol';
import { StackModel } from './stackModel';
import { formatRecord, prettyPath } from './util';

const REFRESH_INTERVAL_MS = 150;
const PLAY_INTERVAL_MS = 300;
const MAX_STACK_ROWS = 200;

export interface TimelineHost {
  showFrameById(frameId: number): void;
  requestExport(): void;
  requestImport(): void;
}

export interface TimelineLabels {
  source: string;
  binary: string;
}

interface StackRow {
  frameId: number;
  index: number;
  functionName: string;
  args: string;
  locals: string;
  location: string;
  status: 'top' | 'active' | 'returned' | 'exception';
}

interface EventRow {
  index: number;
  type: string;
  headline: string;
  detail: string;
}

/**
 * Everything the webview needs to draw one point in time.  It is small on
 * purpose: the panel is stateless and simply re-renders on every push.
 */
interface TimelineState {
  cursor: number;
  first: number;
  last: number;
  count: number;
  position: number;
  following: boolean;
  playing: boolean;
  ended: boolean;
  current?: EventRow;
  stack: StackRow[];
  hiddenFrames: number;
  exceptions: EventRow[];
  labels: TimelineLabels;
}

interface InboundMessage {
  type?: string;
  index?: number;
  delta?: number;
  frameId?: number;
}

function makeNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let index = 0; index < 32; index += 1) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
}

/**
 * Replay panel: a timeline slider plus step / jump / play controls over the
 * recorded events.  The panel owns no state - it renders whatever the model
 * reports for the current cursor.
 */
export class TimelinePanel implements vscode.Disposable {
  public static current: TimelinePanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private playTimer: NodeJS.Timeout | undefined;
  private playing = false;
  private disposed = false;
  private host: TimelineHost;
  private labels: TimelineLabels;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly model: StackModel,
    host: TimelineHost,
    labels: TimelineLabels
  ) {
    this.host = host;
    this.labels = labels;
    this.panel.webview.html = this.html(this.panel.webview);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: InboundMessage) => this.onMessage(message)),
      this.panel.onDidDispose(() => this.dispose())
    );
    this.refreshNow();
  }

  public static show(
    context: vscode.ExtensionContext,
    model: StackModel,
    host: TimelineHost,
    labels: TimelineLabels
  ): TimelinePanel {
    const existing = TimelinePanel.current;
    if (existing) {
      existing.host = host;
      existing.labels = labels;
      existing.panel.reveal(undefined, true);
      existing.refreshNow();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      'stackviz.timeline',
      'StackViz 回放',
      // Beside the editor, and without stealing the cursor from the tree.
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'stackviz.svg');
    TimelinePanel.current = new TimelinePanel(panel, model, host, labels);
    return TimelinePanel.current;
  }

  public setLabels(labels: TimelineLabels): void {
    this.labels = labels;
    this.refreshNow();
  }

  /** Throttled refresh, used while events keep streaming in. */
  public refresh(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.pushNow();
    }, REFRESH_INTERVAL_MS);
  }

  public refreshNow(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.pushNow();
  }

  public dispose(): void {
    this.disposed = true;
    if (TimelinePanel.current === this) {
      TimelinePanel.current = undefined;
    }
    this.stopPlay();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private onMessage(message: InboundMessage): void {
    switch (message.type) {
      case 'ready':
        this.refreshNow();
        break;
      case 'seek':
        if (typeof message.index === 'number') {
          this.seekTo(message.index);
        }
        break;
      case 'step':
        this.seekTo(this.model.cursor + (message.delta ?? 1));
        break;
      case 'first':
        this.seekTo(this.model.firstEventIndex - 1);
        break;
      case 'last':
      case 'follow':
        this.stopPlay();
        this.model.followLatest();
        this.refreshNow();
        break;
      case 'nextCall':
        this.jumpTo(['call'], true);
        break;
      case 'nextReturn':
        this.jumpTo(['return'], true);
        break;
      case 'nextException':
        this.jumpTo(['exception'], true);
        break;
      case 'previousCall':
        this.jumpTo(['call'], false);
        break;
      case 'previousReturn':
        this.jumpTo(['return'], false);
        break;
      case 'play':
        this.startPlay();
        break;
      case 'pause':
        this.stopPlay();
        this.refreshNow();
        break;
      case 'export':
        this.host.requestExport();
        break;
      case 'import':
        this.host.requestImport();
        break;
      case 'showFrame':
        if (typeof message.frameId === 'number') {
          this.host.showFrameById(message.frameId);
        }
        break;
      default:
        break;
    }
  }

  private seekTo(index: number): void {
    this.stopPlay();
    this.model.seek(index);
    this.refreshNow();
  }

  private jumpTo(kinds: readonly ('call' | 'return' | 'exception')[], forward: boolean): void {
    this.stopPlay();
    const index = this.model.findEvent(kinds, forward);
    if (index >= 0) {
      this.model.seek(index);
    }
    this.refreshNow();
  }

  private startPlay(): void {
    if (this.playing) {
      return;
    }
    if (this.model.cursor >= this.model.lastEventIndex) {
      this.model.seek(this.model.firstEventIndex - 1);
    }
    this.playing = true;
    this.playTimer = setInterval(() => {
      if (this.model.cursor >= this.model.lastEventIndex) {
        this.stopPlay();
        this.refreshNow();
        return;
      }
      this.model.stepBy(1);
      this.pushNow();
    }, PLAY_INTERVAL_MS);
    this.refreshNow();
  }

  private stopPlay(): void {
    this.playing = false;
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = undefined;
    }
  }

  private pushNow(): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage({ type: 'state', state: this.buildState() });
  }

  private buildState(): TimelineState {
    const model = this.model;
    const frames = model.liveFrames();
    const hiddenFrames = Math.max(0, frames.length - MAX_STACK_ROWS);
    const shown = hiddenFrames > 0 ? frames.slice(-MAX_STACK_ROWS) : frames;
    const offset = frames.length - shown.length;
    const topId = model.topFrameId();
    const ended = model.ended;

    const stack: StackRow[] = shown.map((frame, index) => {
      const live = !ended && model.isLive(frame.frameId);
      const isTop = !ended && topId === frame.frameId;
      const exceptions = model.exceptionNotes(frame.frameId);
      return {
        frameId: frame.frameId,
        index: offset + index,
        functionName: frame.functionName,
        args: formatRecord(frame.args),
        locals: formatRecord(frame.locals),
        location: `${prettyPath(frame.file)}:${frame.line}`,
        status: exceptions.length > 0 ? 'exception' : isTop ? 'top' : live ? 'active' : 'returned'
      };
    });

    const current = model.eventAt(model.cursor);
    const cursorPosition = model.cursor < model.firstEventIndex ? 0 : model.cursor - model.firstEventIndex + 1;

    return {
      cursor: model.cursor,
      first: model.firstEventIndex,
      last: model.lastEventIndex,
      count: model.retainedEvents,
      position: cursorPosition,
      following: model.isFollowing,
      playing: this.playing,
      ended,
      current: current ? this.describeEvent(current, model.cursor) : undefined,
      stack,
      hiddenFrames,
      exceptions: model.exceptions().map((mark) => ({
        index: mark.index,
        type: 'exception',
        headline: mark.message,
        detail: `${mark.functionName}  (frame #${mark.frameId})`
      })),
      labels: this.labels
    };
  }

  private describeEvent(event: CStackEvent, index: number): EventRow {
    const args = formatRecord(event.args);
    const locals = formatRecord(event.locals);
    const head = `${event.functionName}(${args})  ${prettyPath(event.file)}:${event.line}`;
    switch (event.type) {
      case 'call':
        return {
          index,
          type: 'call',
          headline: `call ${head}`,
          detail: `depth ${event.depth}${event.parentFrameId === undefined ? '' : `  parent #${event.parentFrameId}`}`
        };
      case 'return':
        return { index, type: 'return', headline: `return ${head}`, detail: `depth ${event.depth}` };
      case 'line':
        return {
          index,
          type: 'line',
          headline: `line ${head}`,
          detail: locals.length > 0 ? `locals: ${locals}` : ''
        };
      case 'exception':
        return { index, type: 'exception', headline: event.message ?? 'exception', detail: head };
      case 'exit':
        return { index, type: 'exit', headline: event.message ?? 'the program exited', detail: head };
      default:
        return { index, type: String(event.type), headline: head, detail: '' };
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>StackViz 回放</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 10px 14px 24px;
    margin: 0;
  }
  h1 { font-size: 1.05em; margin: 0 0 2px; font-weight: 600; }
  h2 { font-size: 0.95em; margin: 14px 0 6px; font-weight: 600; }
  .meta, .ticks, .detail { color: var(--vscode-descriptionForeground); }
  .meta { font-size: 0.85em; margin-bottom: 10px; }
  .timeline { position: relative; margin: 6px 0 10px; }
  input[type=range] { width: 100%; accent-color: var(--vscode-progressBar-background); }
  .markers { position: relative; height: 8px; margin-top: -4px; }
  .marker {
    position: absolute; width: 7px; height: 7px; border-radius: 50%;
    background: var(--vscode-editorWarning-foreground); cursor: pointer;
  }
  .ticks { display: flex; justify-content: space-between; font-size: 0.8em; }
  .controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 10px 0 4px; }
  button {
    font-family: inherit; font-size: 0.85em; cursor: pointer;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: none; border-radius: 3px; padding: 3px 8px;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button[disabled] { opacity: 0.5; cursor: default; }
  .sep { width: 1px; height: 18px; background: var(--vscode-panel-border); margin: 0 2px; }
  .current {
    border: 1px solid var(--vscode-panel-border);
    border-left: 3px solid var(--vscode-focusBorder);
    border-radius: 3px; padding: 6px 8px; margin: 8px 0 4px;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
  }
  .current.call { border-left-color: var(--vscode-charts-green); }
  .current.return { border-left-color: var(--vscode-charts-blue); }
  .current.exception, .current.exit { border-left-color: var(--vscode-editorError-foreground); }
  ol.stack { list-style: none; margin: 0; padding: 0; font-family: var(--vscode-editor-font-family); }
  ol.stack li {
    padding: 2px 4px; border-radius: 3px; cursor: pointer; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  ol.stack li:hover { background: var(--vscode-list-hoverBackground); }
  ol.stack li .status { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  ol.stack li.top { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  ol.stack li.exception { color: var(--vscode-editorError-foreground); }
  ul.exceptions { list-style: none; margin: 0; padding: 0; font-size: 0.9em; }
  ul.exceptions li { padding: 3px 4px; cursor: pointer; border-radius: 3px; }
  ul.exceptions li:hover { background: var(--vscode-list-hoverBackground); }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
</style>
</head>
<body>
  <h1>StackViz 回放</h1>
  <div class="meta" id="meta">还没有记录</div>

  <div class="timeline">
    <input id="slider" type="range" min="0" max="0" value="0" step="1">
    <div class="markers" id="markers"></div>
    <div class="ticks"><span id="indexLabel">-</span><span id="followLabel"></span></div>
  </div>

  <div class="controls">
    <button data-action="first" title="跳到第一条事件">&#9198;</button>
    <button data-action="step" data-delta="-1" title="上一步">&#9664;</button>
    <button data-action="step" data-delta="1" title="下一步">&#9654;</button>
    <button data-action="last" title="跳到最后一条事件">&#9197;</button>
    <span class="sep"></span>
    <button data-action="nextCall" title="跳到下一次函数调用">下次调用</button>
    <button data-action="nextReturn" title="跳到下一次函数返回">下次返回</button>
    <button data-action="nextException" title="跳到下一条异常">下次异常</button>
    <span class="sep"></span>
    <button data-action="play" id="playButton" class="primary">播放</button>
    <button data-action="follow" title="跳回最新的事件">跟随最新</button>
    <span class="sep"></span>
    <button data-action="export">导出</button>
    <button data-action="import">导入</button>
  </div>

  <div class="current" id="current"></div>

  <h2>当前调用栈 <span class="meta" id="stackCount"></span></h2>
  <ol class="stack" id="stackList"></ol>

  <h2>异常</h2>
  <ul class="exceptions" id="exceptions"></ul>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const slider = document.getElementById('slider');
  const markers = document.getElementById('markers');
  const indexLabel = document.getElementById('indexLabel');
  const followLabel = document.getElementById('followLabel');
  const meta = document.getElementById('meta');
  const currentBox = document.getElementById('current');
  const stackList = document.getElementById('stackList');
  const stackCount = document.getElementById('stackCount');
  const exceptionsList = document.getElementById('exceptions');
  const playButton = document.getElementById('playButton');

  let state = null;
  let dragging = false;
  let pendingSeek = null;
  let seekTimer = null;

  function post(message) {
    vscode.postMessage(message);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      if (character === '&') return '&amp;';
      if (character === '<') return '&lt;';
      if (character === '>') return '&gt;';
      if (character === '"') return '&quot;';
      return '&#39;';
    });
  }

  function scheduleSeek(index) {
    pendingSeek = index;
    if (seekTimer) return;
    seekTimer = setTimeout(function () {
      seekTimer = null;
      const next = pendingSeek;
      pendingSeek = null;
      if (next !== null) post({ type: 'seek', index: next });
    }, 16);
  }

  function render(next) {
    state = next;
    const empty = next.last < next.first;
    slider.disabled = empty;
    slider.min = String(empty ? 0 : next.first - 1);
    slider.max = String(empty ? 0 : next.last);
    if (!dragging) {
      slider.value = String(empty ? 0 : next.cursor);
    }
    meta.textContent = (next.labels.source || 'StackViz') + (empty ? '' : ' · 共 ' + next.count + ' 条事件');
    indexLabel.textContent = empty ? '还没有事件' : '第 ' + next.position + ' / ' + next.count + ' 条';
    followLabel.textContent = next.following ? (next.playing ? '正在自动播放' : '实时') : '回放中';
    playButton.textContent = next.playing ? '暂停' : '播放';

    const current = next.current;
    currentBox.className = 'current ' + (current ? current.type : '');
    currentBox.innerHTML = current
      ? '<div><span class="meta">[' + String(current.index).padStart(4, '0') + '] ' + escapeHtml(current.type) + '</span> ' +
        escapeHtml(current.headline) + '</div>' + (current.detail ? '<div class="detail">' + escapeHtml(current.detail) + '</div>' : '')
      : '<span class="empty">-</span>';

    stackCount.textContent = next.stack.length === 0
      ? ''
      : '（共 ' + next.stack.length + ' 帧' +
        (next.hiddenFrames > 0 ? '，省略 ' + next.hiddenFrames + ' 帧' : '') + '）';
    if (next.stack.length === 0) {
      stackList.innerHTML = '<li class="empty">这一刻调用栈是空的</li>';
    } else {
      stackList.innerHTML = next.stack.map(function (row) {
        const locals = row.locals ? '  {' + escapeHtml(row.locals) + '}' : '';
        const status = row.status === 'top' ? ' <span class="status">&lt;-- 栈顶</span>' : '';
        return '<li class="' + escapeHtml(row.status) + '" data-frame="' + row.frameId + '" title="点一下打印这一帧的详情，并跳到源码行">' +
          '&nbsp;'.repeat(row.index * 2) + '#' + row.index + ' ' + escapeHtml(row.functionName) +
          '(' + escapeHtml(row.args) + ')  ' + escapeHtml(row.location) + locals + status + '</li>';
      }).join('');
    }

    if (next.exceptions.length === 0) {
      exceptionsList.innerHTML = '<li class="empty">没有</li>';
    } else {
      exceptionsList.innerHTML = next.exceptions.map(function (mark) {
        return '<li data-index="' + mark.index + '"><span class="meta">[' + String(mark.index).padStart(4, '0') + ']</span> ' +
          escapeHtml(mark.headline) + ' <span class="meta">' + escapeHtml(mark.detail) + '</span></li>';
      }).join('');
    }

    markers.innerHTML = empty ? '' : next.exceptions.map(function (mark) {
      const ratio = (mark.index - (next.first - 1)) / Math.max(1, next.last - (next.first - 1));
      return '<div class="marker" style="left: calc(' + (ratio * 100).toFixed(3) + '% - 3px)" data-index="' + mark.index + '"></div>';
    }).join('');
  }

  window.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'state') {
      render(event.data.state);
    }
  });

  slider.addEventListener('input', function () {
    dragging = true;
    scheduleSeek(Number(slider.value));
    indexLabel.textContent = 'event ' + (Number(slider.value) - state.first + 1) + ' / ' + state.count;
  });
  slider.addEventListener('change', function () {
    dragging = false;
    scheduleSeek(Number(slider.value));
  });

  document.querySelector('.controls').addEventListener('click', function (event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const action = button.getAttribute('data-action');
    if (action === 'step') {
      post({ type: 'step', delta: Number(button.getAttribute('data-delta')) });
      return;
    }
    if (action === 'play') {
      post({ type: state && state.playing ? 'pause' : 'play' });
      return;
    }
    post({ type: action });
  });

  stackList.addEventListener('click', function (event) {
    const row = event.target.closest('li[data-frame]');
    if (row) {
      post({ type: 'showFrame', frameId: Number(row.getAttribute('data-frame')) });
    }
  });

  exceptionsList.addEventListener('click', function (event) {
    const row = event.target.closest('li[data-index]');
    if (row) {
      post({ type: 'seek', index: Number(row.getAttribute('data-index')) });
    }
  });

  markers.addEventListener('click', function (event) {
    const marker = event.target.closest('.marker');
    if (marker) {
      post({ type: 'seek', index: Number(marker.getAttribute('data-index')) });
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowLeft') {
      post({ type: 'step', delta: -1 });
    } else if (event.key === 'ArrowRight') {
      post({ type: 'step', delta: 1 });
    } else if (event.key === ' ') {
      event.preventDefault();
      post({ type: state && state.playing ? 'pause' : 'play' });
    }
  });

  post({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
