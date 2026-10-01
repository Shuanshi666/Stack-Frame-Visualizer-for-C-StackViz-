import * as vscode from 'vscode';

export interface BuiltinExample {
  id: string;
  file: string;
  label: string;
  description: string;
}

/**
 * The examples that ship with the extension.  They are copied into
 * `<workspace>/.stackviz/examples/` so the learner can edit them (change the
 * recursion depth, add a base case, ...) and run them right away.
 */
export const BUILTIN_EXAMPLES: readonly BuiltinExample[] = [
  {
    id: 'factorial',
    file: 'factorial.c',
    label: 'factorial(n)',
    description: 'linear recursion: factorial and sum_to, the smallest possible demo'
  },
  {
    id: 'fibonacci',
    file: 'fibonacci.c',
    label: 'fib(n)',
    description: 'tree recursion: the call tree branches - best with "Open Visualizer"'
  },
  {
    id: 'mutual_recursion',
    file: 'mutual_recursion.c',
    label: 'is_even / is_odd',
    description: 'mutual recursion: two functions keep calling each other'
  },
  {
    id: 'deep_recursion',
    file: 'deep_recursion.c',
    label: 'down(40)',
    description: 'a deep stack: 42 frames, shows the stack view and the depth limit'
  }
];

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies one bundled example next to the workspace and returns its path.
 * An existing file is never overwritten: the learner may have edited it.
 */
export async function materializeExample(
  context: vscode.ExtensionContext,
  example: BuiltinExample,
  workspaceRoot: vscode.Uri | undefined
): Promise<vscode.Uri> {
  const source = vscode.Uri.joinPath(context.extensionUri, 'examples', example.file);
  const directory = workspaceRoot
    ? vscode.Uri.joinPath(workspaceRoot, '.stackviz', 'examples')
    : vscode.Uri.joinPath(context.globalStorageUri, 'examples');
  const target = vscode.Uri.joinPath(directory, example.file);

  await vscode.workspace.fs.createDirectory(directory);
  if (!(await exists(target))) {
    await vscode.workspace.fs.copy(source, target, { overwrite: false });
  }
  return target;
}
