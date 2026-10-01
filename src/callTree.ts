import * as vscode from 'vscode';

import { CStackEvent } from './protocol';
import { FrameInfo, StackModel } from './stackModel';
import { formatRecord, prettyPath } from './util';

/** Refresh the tree at most this often while events keep streaming in. */
const REFRESH_INTERVAL_MS = 150;

export class FrameTreeNode {
  constructor(public readonly frame: FrameInfo, public readonly childCount: number) {}
}

/**
 * TreeView over the recorded call tree.
 *
 * The gdb driver gives every invocation a unique frameId and a parentFrameId,
 * so a recursive function shows up once per active/dead invocation - which is
 * exactly what makes recursion visible.
 */
export class CallTreeDataProvider implements vscode.TreeDataProvider<FrameTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<FrameTreeNode | undefined>();
  private pendingRefresh: NodeJS.Timeout | undefined;

  /** Called after every refresh, used to update the view badge. */
  public onAfterRefresh: (() => void) | undefined;

  public readonly onDidChangeTreeData: vscode.Event<FrameTreeNode | undefined> = this.emitter.event;

  constructor(private readonly model: StackModel) {}

  /** Cheap notification: bursts of events collapse into one refresh. */
  public notify(event?: CStackEvent): void {
    if (!event || event.type === 'exit' || event.type === 'exception') {
      this.refreshNow();
      return;
    }
    if (this.pendingRefresh) {
      return;
    }
    this.pendingRefresh = setTimeout(() => {
      this.pendingRefresh = undefined;
      this.refreshNow();
    }, REFRESH_INTERVAL_MS);
  }

  public refreshNow(): void {
    if (this.pendingRefresh) {
      clearTimeout(this.pendingRefresh);
      this.pendingRefresh = undefined;
    }
    this.emitter.fire(undefined);
    this.onAfterRefresh?.();
  }

  public dispose(): void {
    if (this.pendingRefresh) {
      clearTimeout(this.pendingRefresh);
      this.pendingRefresh = undefined;
    }
    this.emitter.dispose();
  }

  public getChildren(element?: FrameTreeNode): FrameTreeNode[] {
    const frames = element ? this.model.childrenOf(element.frame.frameId) : this.model.rootFrames();
    return frames.map((frame) => new FrameTreeNode(frame, this.model.childrenOf(frame.frameId).length));
  }

  public getParent(element: FrameTreeNode): FrameTreeNode | undefined {
    const parentId = element.frame.parentFrameId;
    if (parentId === undefined) {
      return undefined;
    }
    const parent = this.model.frame(parentId);
    return parent ? new FrameTreeNode(parent, this.model.childrenOf(parentId).length) : undefined;
  }

  public getTreeItem(element: FrameTreeNode): vscode.TreeItem {
    const frame = element.frame;
    const item = new vscode.TreeItem(
      `${frame.functionName}(${formatRecord(frame.args)})`,
      element.childCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    // Once the program has exited the whole recording is history, so nothing is
    // "active" any more - even the frame that used to be on top.
    const live = !this.model.ended && this.model.isLive(frame.frameId);
    const isTop = !this.model.ended && this.model.topFrameId() === frame.frameId;
    const exceptions = this.model.exceptionNotes(frame.frameId);
    item.id = `stackviz-frame-${frame.frameId}`;
    const status = exceptions.length > 0 ? 'exception' : live ? '' : 'returned';
    item.description = `${prettyPath(frame.file)}:${frame.line}${status ? `  (${status})` : ''}`;
    item.tooltip = this.tooltipFor(frame, live, isTop);
    item.iconPath = new vscode.ThemeIcon(
      exceptions.length > 0
        ? 'warning'
        : isTop
          ? 'debug-stackframe-focused'
          : live
            ? 'debug-stackframe'
            : 'circle-outline'
    );
    item.contextValue = exceptions.length > 0 ? 'stackvizExceptionFrame' : live ? 'stackvizLiveFrame' : 'stackvizReturnedFrame';
    item.command = {
      command: 'stackviz.showFrame',
      title: 'Show frame details',
      arguments: [element]
    };
    return item;
  }

  private tooltipFor(frame: FrameInfo, live: boolean, isTop: boolean): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${frame.functionName}(${formatRecord(frame.args)})**\n\n`);
    tooltip.appendMarkdown(`location: \`${prettyPath(frame.file)}:${frame.line}\`\n\n`);
    tooltip.appendMarkdown(
      `frame \`#${frame.frameId}\` · depth ${frame.depth} · parent ` +
        `${frame.parentFrameId === undefined ? '(none)' : '#' + frame.parentFrameId}\n\n`
    );
    tooltip.appendMarkdown(`status: ${isTop ? 'active - top of stack' : live ? 'active' : 'returned'}\n\n`);

    const locals = formatRecord(frame.locals);
    if (locals.length > 0) {
      tooltip.appendMarkdown(`locals: \`${locals}\`\n\n`);
    }
    for (const note of this.model.exceptionNotes(frame.frameId)) {
      tooltip.appendMarkdown(`exception: \`${note}\`\n\n`);
    }
    tooltip.appendMarkdown(`_click to print this frame in the StackViz output channel_`);
    return tooltip;
  }
}
