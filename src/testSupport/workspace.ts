import * as vscode from "vscode";

export async function withWorkspaceFolders<T>(
  workspacePaths: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  return withWorkspaceFolderUris(
    workspacePaths.map((workspacePath) => vscode.Uri.file(workspacePath)),
    run,
  );
}

export async function withWorkspaceFolderUris<T>(
  workspaceUris: readonly vscode.Uri[],
  run: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
  const mutableWorkspace = vscode.workspace as unknown as Record<string, unknown>;
  Object.defineProperty(vscode.workspace, "workspaceFolders", {
    configurable: true,
    value: workspaceUris.map((uri, index) => ({
      uri,
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

export async function withWorkspaceFolderUri<T>(
  workspaceUri: vscode.Uri,
  run: () => Promise<T>,
): Promise<T> {
  return withWorkspaceFolderUris([workspaceUri], run);
}

export async function withWorkspaceFolder<T>(
  workspacePath: string,
  run: () => Promise<T>,
): Promise<T> {
  return withWorkspaceFolders([workspacePath], run);
}
