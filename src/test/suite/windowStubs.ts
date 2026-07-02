/**
 * Shared VS Code window stubs for command-path tests.
 *
 * @module test/suite/windowStubs
 */

import * as vscode from "vscode";

export interface WarningMessageCall {
  readonly message: string;
  readonly options: vscode.MessageOptions | undefined;
  readonly items: readonly string[];
}

export interface QuickPickCall {
  readonly labels: readonly string[];
  readonly options: vscode.QuickPickOptions | undefined;
}

export interface WindowUiCalls {
  readonly inputs: readonly vscode.InputBoxOptions[];
  readonly quickPicks: readonly QuickPickCall[];
  readonly warnings: readonly WarningMessageCall[];
  readonly openDialogs: readonly vscode.OpenDialogOptions[];
  readonly progress: readonly vscode.ProgressOptions[];
  readonly progressReports: readonly { readonly message?: string; readonly increment?: number }[];
  readonly errors: readonly string[];
  readonly infos: readonly string[];
}

export interface WindowUiStubOptions {
  /**
   * Queued responses are consumed in call order for each VS Code UI primitive.
   * Tests should assert the recorded calls when prompt ordering matters.
   */
  readonly inputValues?: readonly (string | undefined)[];
  readonly quickPickLabels?: readonly (string | undefined)[];
  readonly warningValues?: readonly (string | undefined)[];
  readonly openDialogValues?: readonly (readonly vscode.Uri[] | undefined)[];
}

function labelForQuickPickItem(item: unknown): string {
  if (typeof item === "string") {
    return item;
  }
  if (typeof item === "object" && item !== null && "label" in item) {
    const label = (item as { label?: unknown }).label;
    return typeof label === "string" ? label : "";
  }
  return "";
}

function labelForWarningMessageItem(item: string | vscode.MessageItem): string {
  return typeof item === "string" ? item : item.title;
}

function isWarningMessageOptions(value: unknown): value is vscode.MessageOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    !("title" in value && typeof (value as { title?: unknown }).title === "string")
  );
}

function parseWarningMessageCall(
  message: string,
  optionsOrFirstItem?: vscode.MessageOptions | string | vscode.MessageItem,
  restItems: readonly (string | vscode.MessageItem)[] = [],
): WarningMessageCall {
  const hasOptions = isWarningMessageOptions(optionsOrFirstItem);
  const options = hasOptions ? optionsOrFirstItem : undefined;
  const rawItems =
    !hasOptions && optionsOrFirstItem !== undefined
      ? [optionsOrFirstItem, ...restItems]
      : restItems;
  const items = rawItems.map(labelForWarningMessageItem);

  return { message, options, items };
}

export function stubWarningMessage(
  choice: string | undefined,
  onCall?: (call: WarningMessageCall) => void,
): () => void {
  const mutableWindow = vscode.window as unknown as {
    showWarningMessage: typeof vscode.window.showWarningMessage;
  };
  const originalShowWarningMessage = mutableWindow.showWarningMessage;

  mutableWindow.showWarningMessage = ((
    message: string,
    optionsOrFirstItem?: vscode.MessageOptions | string | vscode.MessageItem,
    ...restItems: (string | vscode.MessageItem)[]
  ) => {
    onCall?.(parseWarningMessageCall(message, optionsOrFirstItem, restItems));

    return Promise.resolve(choice);
  }) as typeof vscode.window.showWarningMessage;

  return () => {
    mutableWindow.showWarningMessage = originalShowWarningMessage;
  };
}

export async function withWindowUiStubs(
  options: WindowUiStubOptions,
  callback: () => Promise<void>,
): Promise<WindowUiCalls> {
  const mutableWindow = vscode.window as unknown as {
    showInputBox: typeof vscode.window.showInputBox;
    showQuickPick: typeof vscode.window.showQuickPick;
    showWarningMessage: typeof vscode.window.showWarningMessage;
    showOpenDialog: typeof vscode.window.showOpenDialog;
    showErrorMessage: typeof vscode.window.showErrorMessage;
    showInformationMessage: typeof vscode.window.showInformationMessage;
    withProgress: typeof vscode.window.withProgress;
  };
  const originalShowInputBox = mutableWindow.showInputBox;
  const originalShowQuickPick = mutableWindow.showQuickPick;
  const originalShowWarningMessage = mutableWindow.showWarningMessage;
  const originalShowOpenDialog = mutableWindow.showOpenDialog;
  const originalShowErrorMessage = mutableWindow.showErrorMessage;
  const originalShowInformationMessage = mutableWindow.showInformationMessage;
  const originalWithProgress = mutableWindow.withProgress;
  const inputValues = [...(options.inputValues ?? [])];
  const quickPickLabels = [...(options.quickPickLabels ?? [])];
  const warningValues = [...(options.warningValues ?? [])];
  const openDialogValues = [...(options.openDialogValues ?? [])];
  const inputs: vscode.InputBoxOptions[] = [];
  const quickPicks: QuickPickCall[] = [];
  const warnings: WarningMessageCall[] = [];
  const openDialogs: vscode.OpenDialogOptions[] = [];
  const progress: vscode.ProgressOptions[] = [];
  const progressReports: Array<{ readonly message?: string; readonly increment?: number }> = [];
  const errors: string[] = [];
  const infos: string[] = [];

  mutableWindow.showInputBox = ((inputOptions?: vscode.InputBoxOptions) => {
    inputs.push(inputOptions ?? {});
    return Promise.resolve(inputValues.shift());
  }) as typeof vscode.window.showInputBox;

  mutableWindow.showQuickPick = (async (
    items: readonly unknown[] | Thenable<readonly unknown[]>,
    quickPickOptions?: vscode.QuickPickOptions,
  ) => {
    const itemArray = Array.isArray(items) ? items : await items;
    const selectedLabel = quickPickLabels.shift();
    quickPicks.push({
      labels: itemArray.map(labelForQuickPickItem),
      options: quickPickOptions,
    });
    return selectedLabel === undefined
      ? undefined
      : itemArray.find((item) => labelForQuickPickItem(item) === selectedLabel);
  }) as typeof vscode.window.showQuickPick;

  mutableWindow.showWarningMessage = ((
    message: string,
    optionsOrFirstItem?: vscode.MessageOptions | string | vscode.MessageItem,
    ...restItems: (string | vscode.MessageItem)[]
  ) => {
    warnings.push(parseWarningMessageCall(message, optionsOrFirstItem, restItems));
    return Promise.resolve(warningValues.shift());
  }) as typeof vscode.window.showWarningMessage;

  mutableWindow.showOpenDialog = ((openDialogOptions?: vscode.OpenDialogOptions) => {
    openDialogs.push(openDialogOptions ?? {});
    return Promise.resolve(openDialogValues.shift());
  }) as typeof vscode.window.showOpenDialog;

  mutableWindow.showErrorMessage = ((message: string) => {
    errors.push(message);
    return Promise.resolve(undefined);
  }) as typeof vscode.window.showErrorMessage;

  mutableWindow.showInformationMessage = ((message: string) => {
    infos.push(message);
    return Promise.resolve(undefined);
  }) as typeof vscode.window.showInformationMessage;

  mutableWindow.withProgress = (async (
    progressOptions: vscode.ProgressOptions,
    task: (
      progress: vscode.Progress<{ message?: string; increment?: number }>,
      token: vscode.CancellationToken,
    ) => Thenable<unknown>,
  ) => {
    progress.push(progressOptions);
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      return await task({ report: (report) => progressReports.push(report) }, tokenSource.token);
    } finally {
      tokenSource.dispose();
    }
  }) as typeof vscode.window.withProgress;

  try {
    await callback();
    return { inputs, quickPicks, warnings, openDialogs, progress, progressReports, errors, infos };
  } finally {
    mutableWindow.withProgress = originalWithProgress;
    mutableWindow.showInformationMessage = originalShowInformationMessage;
    mutableWindow.showErrorMessage = originalShowErrorMessage;
    mutableWindow.showOpenDialog = originalShowOpenDialog;
    mutableWindow.showWarningMessage = originalShowWarningMessage;
    mutableWindow.showQuickPick = originalShowQuickPick;
    mutableWindow.showInputBox = originalShowInputBox;
  }
}
