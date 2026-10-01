/**
 * Event protocol shared between the gdb driver (python/gdb_stackviz.py) and the
 * extension.
 *
 * The driver compares consecutive call-stack snapshots and derives the events:
 *   - the longest common prefix of the two snapshots does not change
 *   - frames that appear only in the new snapshot  -> "call"
 *   - frames that disappear from the new snapshot  -> "return"
 *   - the new top frame always emits "line"
 *
 * Every event is written as one JSON object per line (NDJSON) over the local
 * TCP connection, followed by a single "\n".
 */
export type CStackEventType = 'call' | 'return' | 'line' | 'exception' | 'exit';

export interface CStackEvent {
  type: CStackEventType;
  frameId: number;
  parentFrameId?: number;
  functionName: string;
  file: string;
  line: number;
  depth: number;
  /** Milliseconds since the unix epoch. */
  timestamp: number;
  args?: Record<string, string>;
  locals?: Record<string, string>;
  returnValue?: string;
  /**
   * StackViz extension of the protocol: human readable note attached to
   * "exception" / "exit" events (for example "reached maxSteps=5000").
   * The field is optional and ignored by consumers that do not know it.
   */
  message?: string;
}
