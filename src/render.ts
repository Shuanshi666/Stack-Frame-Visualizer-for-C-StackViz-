import { CStackEvent } from './protocol';
import { FrameInfo } from './stackModel';
import { formatRecord, prettyPath } from './util';

/** Frames printed per snapshot before the middle of the stack is elided. */
export const DEFAULT_MAX_PRINTED_FRAMES = 30;
const KEEP_BOTTOM_FRAMES = 6;

export function frameLine(frame: FrameInfo, index: number, isTop: boolean, indent = ''): string {
  const args = formatRecord(frame.args);
  const locals = formatRecord(frame.locals);
  const detail = locals.length > 0 ? `  {${locals}}` : '';
  const marker = isTop ? '   <-- top' : '';
  return `${indent}#${index} ${frame.functionName}(${args})  ${prettyPath(frame.file)}:${frame.line}${detail}${marker}`;
}

export interface StackRenderOptions {
  indent?: string;
  maxFrames?: number;
}

/**
 * Text rendering of one stack snapshot. Deep stacks are elided in the middle so
 * a 1000 frame recursion does not flood the output channel.
 */
export function stackLines(frames: FrameInfo[], options: StackRenderOptions = {}): string[] {
  const indent = options.indent ?? '';
  const maxFrames = Math.max(KEEP_BOTTOM_FRAMES + 1, options.maxFrames ?? DEFAULT_MAX_PRINTED_FRAMES);

  if (frames.length === 0) {
    return [`${indent}(call stack is empty)`];
  }
  if (frames.length <= maxFrames) {
    return frames.map((frame, index) => frameLine(frame, index, index === frames.length - 1, indent));
  }

  const hidden = frames.length - maxFrames;
  const bottom = frames.slice(0, KEEP_BOTTOM_FRAMES);
  const top = frames.slice(frames.length - (maxFrames - KEEP_BOTTOM_FRAMES));

  const lines = bottom.map((frame, index) => frameLine(frame, index, false, indent));
  lines.push(`${indent}  ... ${hidden} frame(s) hidden ...`);
  top.forEach((frame, index) => {
    const globalIndex = frames.length - top.length + index;
    lines.push(frameLine(frame, globalIndex, globalIndex === frames.length - 1, indent));
  });
  return lines;
}

/** One compact line per event, used as the scrolling trace of a run. */
export function eventLine(event: CStackEvent, sequence: number): string {
  const sequenceText = String(sequence).padStart(4, '0');
  const head = `${event.functionName}(${formatRecord(event.args)})  ${prettyPath(event.file)}:${event.line}`;

  switch (event.type) {
    case 'call': {
      const parent = event.parentFrameId === undefined ? '' : `  parent #${event.parentFrameId}`;
      return `[${sequenceText}] + call    #${event.frameId}  ${head}   depth ${event.depth}${parent}`;
    }
    case 'return':
      return `[${sequenceText}] - return  #${event.frameId}  ${head}   depth ${event.depth}`;
    case 'line': {
      const locals = formatRecord(event.locals);
      const detail = locals.length > 0 ? `   {${locals}}` : '';
      return `[${sequenceText}]   line    #${event.frameId}  ${head}${detail}`;
    }
    case 'exception':
      return `[${sequenceText}] ! exception  ${event.message ?? 'unknown problem'}`;
    case 'exit':
      return `[${sequenceText}] * exit    ${event.message ?? 'the program exited'}`;
    default:
      return `[${sequenceText}] ? ${String(event.type)}`;
  }
}
