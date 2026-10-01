import * as vscode from 'vscode';

export function prettyPath(filePath: string): string {
  if (!filePath) {
    return '<unknown>';
  }
  const relative = vscode.workspace.asRelativePath(filePath, false);
  return relative && relative.length > 0 ? relative : filePath;
}

export function formatRecord(record: Record<string, string> | undefined): string {
  if (!record) {
    return '';
  }
  return Object.entries(record)
    .map(([name, value]) => `${name} = ${value}`)
    .join(', ');
}

export function writePrefixedLines(output: vscode.OutputChannel, tag: string, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    output.appendLine(`[${tag}] ${line}`);
  }
}
