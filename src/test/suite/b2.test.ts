/**
 * Tests for B2 client configuration safety.
 *
 * @module test/suite/b2
 */

import * as assert from "assert";
import * as vscode from "vscode";
import {
  buildCustomApiUrlWarningMessage,
  CONFIRM_CUSTOM_API_URL_LABEL,
  createB2Client,
  createConfiguredB2Client,
  DEFAULT_B2_API_URL,
  resolveB2ApiUrlFromInspection,
  type B2ApiUrlInspection,
} from "../../services/b2";
import type { B2Credentials } from "../../services/authService";

const CUSTOM_API_URL = "https://b2-compatible.example.com";
const ATTACKER_API_URL = "https://attacker.example.com";
const TEST_CREDENTIALS: B2Credentials = { keyId: "key-id", appKey: "app-key" };
const TEST_VERSION = "0.0.1";

interface WarningMessageCall {
  readonly message: string;
  readonly options: vscode.MessageOptions | undefined;
  readonly items: readonly string[];
}

// `realmUrl` is an internal B2Client field; these tests assert on it to confirm
// the realm option was threaded through. Update if the SDK renames it.
function getClientRealmUrl(client: ReturnType<typeof createB2Client>): string {
  const realmUrl = (client as unknown as { realmUrl?: unknown }).realmUrl;
  if (typeof realmUrl !== "string") {
    assert.fail("Expected the B2Client internal realmUrl field to be a string.");
  }

  return realmUrl;
}

function stubB2ApiUrlInspection(inspection: B2ApiUrlInspection): () => void {
  const mutableWorkspace = vscode.workspace as unknown as {
    getConfiguration: typeof vscode.workspace.getConfiguration;
  };
  const originalGetConfiguration = mutableWorkspace.getConfiguration;

  function get<T>(_section: string): T | undefined;
  function get<T>(_section: string, defaultValue: T): T;
  function get<T>(_section: string, defaultValue?: T): T | undefined {
    return defaultValue;
  }

  const configuration: vscode.WorkspaceConfiguration = {
    get,
    has: (_section: string) => false,
    inspect: <T>(_section: string) => ({
      key: "b2.apiUrl",
      defaultValue: inspection.defaultValue as T,
      globalValue: inspection.globalValue as T,
      workspaceValue: inspection.workspaceValue as T,
      workspaceFolderValue: inspection.workspaceFolderValue as T,
    }),
    update: () => Promise.resolve(),
  };

  mutableWorkspace.getConfiguration = () => configuration;

  return () => {
    mutableWorkspace.getConfiguration = originalGetConfiguration;
  };
}

function stubB2ApiUrlConfiguration(globalValue: unknown): () => void {
  return stubB2ApiUrlInspection({
    defaultValue: DEFAULT_B2_API_URL,
    globalValue,
  });
}

function stubWarningMessage(
  choice: string | undefined,
  onCall?: (call: WarningMessageCall) => void,
): () => void {
  const mutableWindow = vscode.window as unknown as {
    showWarningMessage: typeof vscode.window.showWarningMessage;
  };
  const originalShowWarningMessage = mutableWindow.showWarningMessage;

  mutableWindow.showWarningMessage = ((
    message: string,
    optionsOrFirstItem?: vscode.MessageOptions | string,
    ...restItems: string[]
  ) => {
    const hasOptions = typeof optionsOrFirstItem === "object" && optionsOrFirstItem !== null;
    const options = hasOptions ? optionsOrFirstItem : undefined;
    const items =
      !hasOptions && optionsOrFirstItem !== undefined
        ? [optionsOrFirstItem, ...restItems]
        : restItems;

    onCall?.({ message, options, items });

    return Promise.resolve(choice);
  }) as typeof vscode.window.showWarningMessage;

  return () => {
    mutableWindow.showWarningMessage = originalShowWarningMessage;
  };
}

suite("B2 API URL configuration", () => {
  test("uses the default B2 API URL", () => {
    const resolved = resolveB2ApiUrlFromInspection({
      defaultValue: DEFAULT_B2_API_URL,
    });

    assert.deepStrictEqual(resolved, {
      apiUrl: DEFAULT_B2_API_URL,
      isDefault: true,
    });
  });

  test("falls back to the built-in default when configuration is absent", () => {
    const resolved = resolveB2ApiUrlFromInspection(undefined);

    assert.deepStrictEqual(resolved, {
      apiUrl: DEFAULT_B2_API_URL,
      isDefault: true,
    });
  });

  test("falls back to the built-in default when inspection has no values", () => {
    const resolved = resolveB2ApiUrlFromInspection({
      defaultValue: undefined,
      globalValue: undefined,
    });

    assert.deepStrictEqual(resolved, {
      apiUrl: DEFAULT_B2_API_URL,
      isDefault: true,
    });
  });

  test("accepts a user-level HTTPS override", () => {
    const resolved = resolveB2ApiUrlFromInspection({
      defaultValue: DEFAULT_B2_API_URL,
      globalValue: `${CUSTOM_API_URL}/`,
    });

    assert.deepStrictEqual(resolved, {
      apiUrl: CUSTOM_API_URL,
      isDefault: false,
    });
  });

  test("rejects workspace-level API URL overrides", () => {
    assert.throws(
      () =>
        resolveB2ApiUrlFromInspection({
          defaultValue: DEFAULT_B2_API_URL,
          workspaceValue: ATTACKER_API_URL,
        }),
      /user settings/,
    );
  });

  test("rejects workspace overrides before accepting a user-level API URL", () => {
    assert.throws(
      () =>
        resolveB2ApiUrlFromInspection({
          defaultValue: DEFAULT_B2_API_URL,
          globalValue: `${CUSTOM_API_URL}/`,
          workspaceValue: ATTACKER_API_URL,
        }),
      /user settings/,
    );
  });

  test("rejects workspace-folder API URL overrides", () => {
    assert.throws(
      () =>
        resolveB2ApiUrlFromInspection({
          defaultValue: DEFAULT_B2_API_URL,
          workspaceFolderValue: ATTACKER_API_URL,
        }),
      /user settings/,
    );
  });

  test("rejects invalid, credential-bearing, or non-string user API URLs", () => {
    const invalidValues = [
      "not a url",
      "http://b2-compatible.example.com",
      "https://key:secret@b2-compatible.example.com",
      "https://b2-compatible.example.com?token=value",
      "https://b2-compatible.example.com#fragment",
      "",
      null,
      42,
    ];

    for (const globalValue of invalidValues) {
      const inspection: B2ApiUrlInspection = {
        defaultValue: DEFAULT_B2_API_URL,
        globalValue,
      };

      assert.throws(() => resolveB2ApiUrlFromInspection(inspection), /b2\.apiUrl/);
    }
  });

  test("creates the SDK client for the default B2 API URL", () => {
    const client = createB2Client(TEST_CREDENTIALS, TEST_VERSION);

    assert.strictEqual(typeof client.authorize, "function");
  });

  test("configures the SDK client for a trusted custom API URL", () => {
    const client = createB2Client(TEST_CREDENTIALS, TEST_VERSION, {
      apiUrl: `${CUSTOM_API_URL}/`,
    });

    assert.strictEqual(getClientRealmUrl(client), CUSTOM_API_URL);
  });

  test("rejects an invalid custom API URL at client construction", () => {
    assert.throws(
      () =>
        createB2Client(TEST_CREDENTIALS, TEST_VERSION, {
          apiUrl: "http://b2-compatible.example.com",
        }),
      /HTTPS/,
    );
  });

  test("warns before credentials are sent to a non-default API URL", () => {
    const message = buildCustomApiUrlWarningMessage(CUSTOM_API_URL);

    assert.match(message, /Custom API URL configured/);
    assert.match(message, /trust this endpoint/);
    assert.match(message, /application key will be sent there/);
    assert.match(message, /https:\/\/b2-compatible\.example\.com/);
    assert.doesNotMatch(message, /key-id|app-key|secret/i);
  });

  test("rejects authentication when the custom API URL warning is dismissed", async () => {
    const restoreConfiguration = stubB2ApiUrlConfiguration(CUSTOM_API_URL);
    const restoreWarningMessage = stubWarningMessage(undefined);

    try {
      await assert.rejects(
        () => createConfiguredB2Client(TEST_CREDENTIALS, TEST_VERSION),
        /authentication canceled/,
      );
    } finally {
      restoreWarningMessage();
      restoreConfiguration();
    }
  });

  test("rejects authentication when the custom API URL warning returns another choice", async () => {
    const restoreConfiguration = stubB2ApiUrlConfiguration(CUSTOM_API_URL);
    const restoreWarningMessage = stubWarningMessage("Some Other Button");

    try {
      await assert.rejects(
        () => createConfiguredB2Client(TEST_CREDENTIALS, TEST_VERSION),
        /authentication canceled/,
      );
    } finally {
      restoreWarningMessage();
      restoreConfiguration();
    }
  });

  test("propagates API URL configuration errors without showing a warning", async () => {
    const restoreConfiguration = stubB2ApiUrlInspection({
      defaultValue: DEFAULT_B2_API_URL,
      workspaceValue: ATTACKER_API_URL,
    });
    let warningWasShown = false;
    const restoreWarningMessage = stubWarningMessage(undefined, () => {
      warningWasShown = true;
    });

    try {
      await assert.rejects(
        () => createConfiguredB2Client(TEST_CREDENTIALS, TEST_VERSION),
        /user settings/,
      );
      assert.strictEqual(warningWasShown, false);
    } finally {
      restoreWarningMessage();
      restoreConfiguration();
    }
  });

  test("creates a default client without showing a custom API URL warning", async () => {
    const restoreConfiguration = stubB2ApiUrlConfiguration(undefined);
    let warningWasShown = false;
    const restoreWarningMessage = stubWarningMessage(undefined, () => {
      warningWasShown = true;
    });

    try {
      const client = await createConfiguredB2Client(TEST_CREDENTIALS, TEST_VERSION);

      assert.strictEqual(warningWasShown, false);
      assert.strictEqual(typeof client.authorize, "function");
    } finally {
      restoreWarningMessage();
      restoreConfiguration();
    }
  });

  test("creates a client after showing a modal custom API URL warning", async () => {
    const restoreConfiguration = stubB2ApiUrlConfiguration(CUSTOM_API_URL);
    let warningCall: WarningMessageCall | undefined;
    const restoreWarningMessage = stubWarningMessage(CONFIRM_CUSTOM_API_URL_LABEL, (call) => {
      warningCall = call;
    });

    try {
      const client = await createConfiguredB2Client(TEST_CREDENTIALS, TEST_VERSION);

      assert.ok(warningCall);
      assert.strictEqual(warningCall.options?.modal, true);
      assert.deepStrictEqual(warningCall.items, [CONFIRM_CUSTOM_API_URL_LABEL]);
      assert.match(warningCall.message, /Custom API URL configured/);
      assert.strictEqual(getClientRealmUrl(client), CUSTOM_API_URL);
    } finally {
      restoreWarningMessage();
      restoreConfiguration();
    }
  });
});
