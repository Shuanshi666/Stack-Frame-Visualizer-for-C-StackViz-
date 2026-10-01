import * as vscode from 'vscode';

import { CStackEvent, CStackEventType } from './protocol';

export const RECORDING_EXTENSION = '.stackviz.jsonl';

const EVENT_TYPES: readonly CStackEventType[] = ['call', 'return', 'line', 'exception', 'exit'];

export interface ParsedRecording {
  events: CStackEvent[];
  /** Lines that were empty, comments, or not a StackViz event. */
  skipped: number;
}

/** One JSON object per line, UTF-8, LF - the format described by the protocol. */
export function serializeRecording(events: readonly CStackEvent[]): string {
  if (events.length === 0) {
    return '';
  }
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

export function parseRecording(text: string): ParsedRecording {
  const events: CStackEvent[] = [];
  let skipped = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (isStackEvent(parsed)) {
      events.push(parsed);
    } else {
      skipped += 1;
    }
  }
  return { events, skipped };
}

function isStackEvent(value: unknown): value is CStackEvent {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<CStackEvent>;
  return (
    typeof candidate.type === 'string' &&
    (EVENT_TYPES as readonly string[]).includes(candidate.type) &&
    typeof candidate.frameId === 'number'
  );
}

export async function writeRecording(uri: vscode.Uri, events: readonly CStackEvent[]): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeRecording(events), 'utf8'));
}

export async function readRecording(uri: vscode.Uri): Promise<ParsedRecording> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return parseRecording(Buffer.from(bytes).toString('utf8'));
}

export function defaultRecordingName(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `stackviz-${stamp}${RECORDING_EXTENSION}`;
}
