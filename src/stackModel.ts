import { CStackEvent, CStackEventType } from './protocol';

export interface FrameInfo {
  frameId: number;
  parentFrameId?: number;
  functionName: string;
  file: string;
  line: number;
  depth: number;
  args?: Record<string, string>;
  locals?: Record<string, string>;
  returnValue?: string;
  lastEventType: CStackEventType;
}

export interface RecordingSummary {
  events: number;
  dropped: number;
  counts: Record<CStackEventType, number>;
  steps: number;
  maxDepth: number;
  durationMs: number;
}

export interface ExceptionMark {
  /** Global index of the exception event inside the recording. */
  index: number;
  frameId: number;
  functionName: string;
  message: string;
}

const MAX_RETAINED_EVENTS = 100_000;
const EVENT_TRIM_CHUNK = 10_000;
const MAX_TRACKED_FRAMES = 20_000;
const MAX_MESSAGES = 50;
const MAX_EXCEPTION_NOTES_PER_FRAME = 4;

function emptyCounts(): Record<CStackEventType, number> {
  return { call: 0, return: 0, line: 0, exception: 0, exit: 0 };
}

/**
 * Pure state machine.  It feeds on events and exposes the call stack and call
 * tree that result from them; it keeps no history of its own, so the replay
 * cursor can rebuild a fresh instance for any point of the recording.
 */
class ReplayState {
  private readonly frames = new Map<number, FrameInfo>();
  /** parent frameId -> child frameIds, in the order the calls happened. */
  private readonly children = new Map<number, number[]>();
  /** frameIds of every root of the call tree (normally just main). */
  private rootIds: number[] = [];
  /** frameIds from the bottom of the stack (main) to the top (current line). */
  private live: number[] = [];
  private readonly counters = emptyCounts();
  private observedMaxDepth = 0;
  private firstTimestamp: number | null = null;
  private lastTimestamp: number | null = null;
  private readonly exceptionFrames = new Map<number, string[]>();
  private messages: string[] = [];
  public ended = false;

  public apply(event: CStackEvent): void {
    this.counters[event.type] = (this.counters[event.type] ?? 0) + 1;
    if (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) {
      if (this.firstTimestamp === null) {
        this.firstTimestamp = event.timestamp;
      }
      this.lastTimestamp = event.timestamp;
    }

    switch (event.type) {
      case 'call':
        this.onCall(event);
        break;
      case 'line':
        this.onLine(event);
        break;
      case 'return':
        this.onReturn(event);
        break;
      case 'exception':
        this.onException(event);
        break;
      case 'exit':
        this.ended = true;
        this.addMessage(event.message ?? 'the program exited');
        break;
      default:
        break;
    }
    this.observedMaxDepth = Math.max(this.observedMaxDepth, this.live.length);
  }

  public liveFrames(): FrameInfo[] {
    return this.collect(this.live);
  }

  public topFrame(): FrameInfo | undefined {
    const frameId = this.topFrameId();
    return frameId === undefined ? undefined : this.frames.get(frameId);
  }

  public topFrameId(): number | undefined {
    return this.live.length > 0 ? this.live[this.live.length - 1] : undefined;
  }

  public frame(frameId: number): FrameInfo | undefined {
    return this.frames.get(frameId);
  }

  /** Roots of the call tree, normally just main(). */
  public rootFrames(): FrameInfo[] {
    return this.collect(this.rootIds);
  }

  /** Frames called by the given frame, in call order. */
  public childrenOf(frameId: number): FrameInfo[] {
    return this.collect(this.children.get(frameId) ?? []);
  }

  public isLive(frameId: number): boolean {
    return this.live.indexOf(frameId) >= 0;
  }

  public get trackedFrames(): number {
    return this.frames.size;
  }

  public counts(): Record<CStackEventType, number> {
    return { ...this.counters };
  }

  public get steps(): number {
    return this.counters.line;
  }

  public get maxDepth(): number {
    return this.observedMaxDepth;
  }

  public durationMs(): number {
    if (this.firstTimestamp === null || this.lastTimestamp === null) {
      return 0;
    }
    return Math.max(0, this.lastTimestamp - this.firstTimestamp);
  }

  public notes(): readonly string[] {
    return this.messages;
  }

  public exceptionNotes(frameId: number): readonly string[] {
    return this.exceptionFrames.get(frameId) ?? [];
  }

  private onCall(event: CStackEvent): void {
    const frame: FrameInfo = {
      frameId: event.frameId,
      parentFrameId: event.parentFrameId,
      functionName: event.functionName,
      file: event.file,
      line: event.line,
      depth: event.depth,
      args: event.args,
      locals: event.locals,
      lastEventType: 'call'
    };
    this.register(frame);

    const parentIndex = event.parentFrameId === undefined ? -1 : this.live.indexOf(event.parentFrameId);
    if (parentIndex >= 0) {
      this.live = this.live.slice(0, parentIndex + 1);
    } else {
      // New root, or a parent we never saw: restart the visible stack.
      this.live = [];
    }
    this.live.push(frame.frameId);
    this.trimFrames();
  }

  private onLine(event: CStackEvent): void {
    const frame = this.ensureFrame(event);
    frame.line = event.line;
    frame.depth = event.depth;
    frame.lastEventType = 'line';
    if (event.args) {
      frame.args = event.args;
    }
    if (event.locals) {
      frame.locals = event.locals;
    }

    const index = this.live.lastIndexOf(event.frameId);
    if (index >= 0) {
      this.live = this.live.slice(0, index + 1);
    } else {
      this.syncLiveFrom(event.frameId);
    }
  }

  private onReturn(event: CStackEvent): void {
    const frame = this.frames.get(event.frameId);
    if (frame) {
      frame.returnValue = event.returnValue;
      frame.lastEventType = 'return';
    }

    const index = this.live.lastIndexOf(event.frameId);
    if (index >= 0) {
      this.live = this.live.slice(0, index);
    } else {
      this.live = this.live.filter((frameId) => (this.frames.get(frameId)?.depth ?? 0) < event.depth);
    }
    this.trimFrames();
  }

  private onException(event: CStackEvent): void {
    const message = event.message ?? `exception in ${event.functionName}()`;
    this.addMessage(message);
    if (event.frameId > 0) {
      const notes = this.exceptionFrames.get(event.frameId);
      if (notes) {
        if (notes.length < MAX_EXCEPTION_NOTES_PER_FRAME) {
          notes.push(message);
        }
      } else {
        this.exceptionFrames.set(event.frameId, [message]);
      }
    }
  }

  private ensureFrame(event: CStackEvent): FrameInfo {
    const existing = this.frames.get(event.frameId);
    if (existing) {
      return existing;
    }
    const created: FrameInfo = {
      frameId: event.frameId,
      parentFrameId: event.parentFrameId,
      functionName: event.functionName,
      file: event.file,
      line: event.line,
      depth: event.depth,
      args: event.args,
      locals: event.locals,
      lastEventType: event.type
    };
    this.register(created);
    return created;
  }

  /**
   * Adds a frame to the map and to the call tree.  The gdb driver always emits a
   * parent before its children, so a frame whose parent is unknown (hand written
   * events, or a trimming race) simply becomes a root of its own subtree.
   */
  private register(frame: FrameInfo): void {
    if (this.frames.has(frame.frameId)) {
      return;
    }
    this.frames.set(frame.frameId, frame);

    const parentId = frame.parentFrameId;
    if (parentId === undefined || !this.frames.has(parentId)) {
      this.rootIds.push(frame.frameId);
      return;
    }
    const siblings = this.children.get(parentId);
    if (siblings) {
      siblings.push(frame.frameId);
    } else {
      this.children.set(parentId, [frame.frameId]);
    }
  }

  private collect(frameIds: readonly number[]): FrameInfo[] {
    const result: FrameInfo[] = [];
    for (const frameId of frameIds) {
      const frame = this.frames.get(frameId);
      if (frame) {
        result.push(frame);
      }
    }
    return result;
  }

  private syncLiveFrom(frameId: number): void {
    const chain: number[] = [];
    let cursor: number | undefined = frameId;
    const guard = new Set<number>();
    while (cursor !== undefined && !guard.has(cursor)) {
      guard.add(cursor);
      const frame = this.frames.get(cursor);
      chain.push(cursor);
      cursor = frame?.parentFrameId;
    }
    chain.reverse();
    this.live = chain;
  }

  private addMessage(message: string): void {
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    }
  }

  /**
   * Frames that already returned are kept around (the call tree and the replay
   * need them), but the map may not grow without bound.
   */
  private trimFrames(): void {
    if (this.frames.size <= MAX_TRACKED_FRAMES) {
      return;
    }
    const live = new Set(this.live);
    for (const frameId of this.frames.keys()) {
      if (this.frames.size <= MAX_TRACKED_FRAMES) {
        break;
      }
      if (!live.has(frameId)) {
        this.frames.delete(frameId);
        this.children.delete(frameId);
      }
    }
    this.rootIds = this.rootIds.filter((frameId) => this.frames.has(frameId));
  }
}

/**
 * A recording plus the state at the current cursor position.
 *
 * While `following` is true the visible state tracks the newest event (a live
 * run).  Seeking moves the cursor into the past: the state is rebuilt from the
 * retained events, and events that arrive meanwhile are only appended, never
 * applied, until the cursor follows the end again.
 */
export class StackModel {
  private events: CStackEvent[] = [];
  /** Global index of events[0]; earlier events fell out of the retention window. */
  private firstIndex = 0;
  /** Global index of the event the state represents; -1 means "before the first". */
  private cursorIndex = -1;
  private following = true;
  private droppedEvents = 0;
  private state = new ReplayState();

  public get ended(): boolean {
    return this.state.ended;
  }

  public get eventCount(): number {
    return this.events.length + this.droppedEvents;
  }

  public get dropped(): number {
    return this.droppedEvents;
  }

  public get cursor(): number {
    return this.cursorIndex;
  }

  public get firstEventIndex(): number {
    return this.firstIndex;
  }

  public get lastEventIndex(): number {
    return this.firstIndex + this.events.length - 1;
  }

  public get isFollowing(): boolean {
    return this.following;
  }

  public get trackedFrames(): number {
    return this.state.trackedFrames;
  }

  public get notes(): readonly string[] {
    return this.state.notes();
  }

  public get steps(): number {
    return this.state.steps;
  }

  public get maxDepthObserved(): number {
    return this.state.maxDepth;
  }

  public reset(): void {
    this.events = [];
    this.firstIndex = 0;
    this.cursorIndex = -1;
    this.following = true;
    this.droppedEvents = 0;
    this.state = new ReplayState();
  }

  /** Appends one event; the visible state follows only in live mode. */
  public apply(event: CStackEvent): void {
    const index = this.lastEventIndex + 1;
    this.events.push(event);
    this.trimEvents();
    if (this.following) {
      this.state.apply(event);
      this.cursorIndex = index;
    }
  }

  /** Replaces the whole recording, used by "Import Recording". */
  public loadRecording(events: readonly CStackEvent[]): void {
    this.reset();
    this.events = events.slice(0, MAX_RETAINED_EVENTS);
    this.droppedEvents = Math.max(0, events.length - this.events.length);
    this.state = new ReplayState();
    this.cursorIndex = this.firstIndex - 1;
    this.seek(this.lastEventIndex);
  }

  /**
   * Moves the visible state to a global event index.  The index is clamped to
   * the retained window; `firstEventIndex - 1` means "nothing applied yet".
   */
  public seek(index: number): void {
    const clamped = Math.max(this.firstIndex - 1, Math.min(this.lastEventIndex, Math.trunc(index)));
    this.cursorIndex = clamped;
    this.following = clamped >= this.lastEventIndex;
    this.state = new ReplayState();
    for (let cursor = this.firstIndex; cursor <= clamped; cursor += 1) {
      const event = this.events[cursor - this.firstIndex];
      if (event) {
        this.state.apply(event);
      }
    }
  }

  public followLatest(): void {
    if (this.cursorIndex !== this.lastEventIndex) {
      this.seek(this.lastEventIndex);
    }
  }

  public stepBy(delta: number): void {
    this.seek(this.cursorIndex + delta);
  }

  /**
   * Global index of the next event of the given kinds, searched from the cursor.
   * Returns -1 when there is none.
   */
  public findEvent(kinds: readonly CStackEventType[], forward: boolean): number {
    if (this.events.length === 0) {
      return -1;
    }
    const wanted = new Set<string>(kinds);
    if (forward) {
      const start = Math.max(this.cursorIndex + 1, this.firstIndex);
      for (let index = start; index <= this.lastEventIndex; index += 1) {
        const event = this.events[index - this.firstIndex];
        if (event && wanted.has(event.type)) {
          return index;
        }
      }
      return -1;
    }
    const start = Math.min(this.cursorIndex - 1, this.lastEventIndex);
    for (let index = start; index >= this.firstIndex; index -= 1) {
      const event = this.events[index - this.firstIndex];
      if (event && wanted.has(event.type)) {
        return index;
      }
    }
    return -1;
  }

  public eventAt(index: number): CStackEvent | undefined {
    return this.events[index - this.firstIndex];
  }

  /** Every exception of the recording, together with its event index. */
  public exceptions(): ExceptionMark[] {
    const marks: ExceptionMark[] = [];
    this.events.forEach((event, offset) => {
      if (event.type === 'exception') {
        marks.push({
          index: this.firstIndex + offset,
          frameId: event.frameId,
          functionName: event.functionName,
          message: event.message ?? 'exception'
        });
      }
    });
    return marks;
  }

  public exportEvents(): CStackEvent[] {
    return this.events.slice();
  }

  /** Totals for the whole recording, independent of the cursor. */
  public summary(): RecordingSummary {
    const scratch = new ReplayState();
    for (const event of this.events) {
      scratch.apply(event);
    }
    return {
      events: this.events.length,
      dropped: this.droppedEvents,
      counts: scratch.counts(),
      steps: scratch.steps,
      maxDepth: scratch.maxDepth,
      durationMs: scratch.durationMs()
    };
  }

  public counts(): Record<CStackEventType, number> {
    return this.state.counts();
  }

  public durationMs(): number {
    return this.state.durationMs();
  }

  public liveFrames(): FrameInfo[] {
    return this.state.liveFrames();
  }

  public topFrame(): FrameInfo | undefined {
    return this.state.topFrame();
  }

  public topFrameId(): number | undefined {
    return this.state.topFrameId();
  }

  public frame(frameId: number): FrameInfo | undefined {
    return this.state.frame(frameId);
  }

  public rootFrames(): FrameInfo[] {
    return this.state.rootFrames();
  }

  public childrenOf(frameId: number): FrameInfo[] {
    return this.state.childrenOf(frameId);
  }

  public isLive(frameId: number): boolean {
    return this.state.isLive(frameId);
  }

  public hasException(frameId: number): boolean {
    return this.state.exceptionNotes(frameId).length > 0;
  }

  public exceptionNotes(frameId: number): readonly string[] {
    return this.state.exceptionNotes(frameId);
  }

  private trimEvents(): void {
    if (this.events.length <= MAX_RETAINED_EVENTS) {
      return;
    }
    const drop = Math.min(EVENT_TRIM_CHUNK, this.events.length - MAX_RETAINED_EVENTS);
    this.events.splice(0, drop);
    this.firstIndex += drop;
    this.droppedEvents += drop;
    if (this.cursorIndex < this.firstIndex) {
      // The cursor pointed at events that are no longer retained.
      this.cursorIndex = this.firstIndex - 1;
      this.following = false;
      this.state = new ReplayState();
    }
  }
}
