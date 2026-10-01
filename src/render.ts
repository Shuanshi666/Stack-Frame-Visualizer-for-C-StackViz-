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
  const marker = isTop ? '   <-- 栈顶' : '';
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
    return [`${indent}（调用栈是空的）`];
  }
  if (frames.length <= maxFrames) {
    return frames.map((frame, index) => frameLine(frame, index, index === frames.length - 1, indent));
  }

  const hidden = frames.length - maxFrames;
  const bottom = frames.slice(0, KEEP_BOTTOM_FRAMES);
  const top = frames.slice(frames.length - (maxFrames - KEEP_BOTTOM_FRAMES));

  const lines = bottom.map((frame, index) => frameLine(frame, index, false, indent));
  lines.push(`${indent}  ... 中间省略 ${hidden} 帧 ...`);
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
      const parent = event.parentFrameId === undefined ? '' : `   父帧 #${event.parentFrameId}`;
      return `[${sequenceText}] + 调用   帧#${event.frameId}  ${head}   第 ${event.depth + 1} 层${parent}`;
    }
    case 'return':
      return `[${sequenceText}] - 返回   帧#${event.frameId}  ${head}   第 ${event.depth + 1} 层`;
    case 'line': {
      const locals = formatRecord(event.locals);
      const detail = locals.length > 0 ? `   {${locals}}` : '';
      return `[${sequenceText}]   执行   帧#${event.frameId}  ${head}${detail}`;
    }
    case 'exception':
      return `[${sequenceText}] ! 异常   ${event.message ?? '未知问题'}`;
    case 'exit':
      return `[${sequenceText}] * 结束   ${event.message ?? '程序结束'}`;
    default:
      return `[${sequenceText}] ? ${String(event.type)}`;
  }
}
