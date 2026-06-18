/**
 * Tests for B2 client configuration safety.
 *
 * @module test/suite/b2
 */

import * as assert from "assert";
import {
  buildCustomApiUrlWarningMessage,
  createB2Client,
  DEFAULT_B2_API_URL,
  resolveB2ApiUrlFromInspection,
  type B2ApiUrlInspection,
} from "../../services/b2";

function getClientRealmUrl(client: ReturnType<typeof createB2Client>): string {
  return (client as unknown as { realmUrl: string }).realmUrl;
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

  test("accepts a user-level HTTPS override", () => {
    const resolved = resolveB2ApiUrlFromInspection({
      defaultValue: DEFAULT_B2_API_URL,
      globalValue: "https://b2-compatible.example.com/",
    });

    assert.deepStrictEqual(resolved, {
      apiUrl: "https://b2-compatible.example.com",
      isDefault: false,
    });
  });

  test("rejects workspace-level API URL overrides", () => {
    assert.throws(
      () =>
        resolveB2ApiUrlFromInspection({
          defaultValue: DEFAULT_B2_API_URL,
          workspaceValue: "https://attacker.example.com",
        }),
      /user settings/,
    );
  });

  test("rejects workspace-folder API URL overrides", () => {
    assert.throws(
      () =>
        resolveB2ApiUrlFromInspection({
          defaultValue: DEFAULT_B2_API_URL,
          workspaceFolderValue: "https://attacker.example.com",
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

  test("configures the SDK client for the default B2 API URL", () => {
    const client = createB2Client({ keyId: "key-id", appKey: "app-key" }, "0.0.1");

    assert.strictEqual(getClientRealmUrl(client), DEFAULT_B2_API_URL);
  });

  test("configures the SDK client for a trusted custom API URL", () => {
    const client = createB2Client({ keyId: "key-id", appKey: "app-key" }, "0.0.1", {
      apiUrl: "https://b2-compatible.example.com/",
    });

    assert.strictEqual(getClientRealmUrl(client), "https://b2-compatible.example.com");
  });

  test("warns before credentials are sent to a non-default API URL", () => {
    const message = buildCustomApiUrlWarningMessage("https://b2-compatible.example.com");

    assert.match(message, /Custom API URL configured/);
    assert.match(message, /trust this endpoint/);
    assert.match(message, /application key will be sent there/);
    assert.match(message, /https:\/\/b2-compatible\.example\.com/);
    assert.doesNotMatch(message, /key-id|app-key|secret/i);
  });
});
