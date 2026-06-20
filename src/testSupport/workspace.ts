import * as vscode from "vscode";

export async function withWorkspaceFolders<T>(
  workspacePaths: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
  const mutableWorkspace = vscode.workspace as unknown as Record<string, unknown>;
  Object.defineProperty(vscode.workspace, "workspaceFolders", {
    configurable: true,
    value: workspacePaths.map((workspacePath, index) => ({
      uri: vscode.Uri.file(workspacePath),
      name: `workspace-${index}`,
      index,
    })),
  });

  try {
    return await run();
  } finally {
    if (descriptor) {
      Object.defineProperty(vscode.workspace, "workspaceFolders", descriptor);
    } else {
      delete mutableWorkspace.workspaceFolders;
    }
  }
}

export async function withWorkspaceFolder<T>(
  workspacePath: string,
  run: () => Promise<T>,
): Promise<T> {
  return withWorkspaceFolders([workspacePath], run);
}
