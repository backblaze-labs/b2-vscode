import * as vscode from "vscode";

export function createNoopSecretStorage(): vscode.SecretStorage {
  const emitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  return {
    onDidChange: emitter.event,
    async get() {
      return undefined;
    },
    async store() {},
    async delete() {},
  };
}
