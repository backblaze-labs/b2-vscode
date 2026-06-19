import * as vscode from "vscode";

export function createMemorySecretStorage(
  initial: Record<string, string> = {},
): vscode.SecretStorage {
  const values = new Map(Object.entries(initial));
  const emitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();

  return {
    onDidChange: emitter.event,
    async get(key: string) {
      return values.get(key);
    },
    async store(key: string, value: string) {
      values.set(key, value);
      emitter.fire({ key });
    },
    async delete(key: string) {
      values.delete(key);
      emitter.fire({ key });
    },
  };
}

export function createNoopSecretStorage(): vscode.SecretStorage {
  return createMemorySecretStorage();
}
