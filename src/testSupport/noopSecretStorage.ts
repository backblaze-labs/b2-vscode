import * as vscode from "vscode";

export function createNoopSecretStorage(): vscode.SecretStorage {
  const emitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  return {
    onDidChange: emitter.event,
    async get(_key: string) {
      return undefined;
    },
    async store(_key: string, _value: string) {},
    async delete(_key: string) {},
  };
}
