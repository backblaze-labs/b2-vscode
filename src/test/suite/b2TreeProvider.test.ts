/**
 * Tests for tree provider B2 failure handling.
 *
 * @module test/suite/b2TreeProvider
 */

import * as assert from "assert";
import * as vscode from "vscode";
import type { B2Client } from "@backblaze-labs/b2-sdk";
import { classifyError } from "@backblaze-labs/b2-sdk";
import { B2TreeProvider, buildTreeErrorMessage } from "../../providers/b2TreeProvider";
import type { AuthService } from "../../services/authService";

function fakeAuthService(): AuthService {
  return {
    onAuthStateChanged: () => ({ dispose() {} }),
  } as unknown as AuthService;
}

async function withShowErrorMessageStub<T>(
  callback: () => Promise<T>,
): Promise<{ result: T; messages: string[] }> {
  const original = vscode.window.showErrorMessage;
  const messages: string[] = [];

  Object.defineProperty(vscode.window, "showErrorMessage", {
    configurable: true,
    value: ((message: string) => {
      messages.push(message);
      return Promise.resolve(undefined);
    }) as typeof vscode.window.showErrorMessage,
  });

  try {
    return { result: await callback(), messages };
  } finally {
    Object.defineProperty(vscode.window, "showErrorMessage", {
      configurable: true,
      value: original,
    });
  }
}

suite("B2 tree provider error handling", () => {
  test("builds a specific tree error message", () => {
    const message = buildTreeErrorMessage(
      classifyError({ status: 403, code: "access_denied", message: "missing cap" }),
    );

    assert.match(message, /Could not load bucket contents/i);
    assert.match(message, /missing permission/i);
  });

  test("returns an empty tree and shows a rate-limit message on list failure", async () => {
    const provider = new B2TreeProvider(fakeAuthService());
    provider.setClient({
      accountInfo: { getAccountId: () => "account-1" },
      async listBuckets() {
        throw classifyError(
          { status: 429, code: "too_many_requests", message: "slow down" },
          { retryAfter: 11 },
        );
      },
    } as unknown as B2Client);

    const { result, messages } = await withShowErrorMessageStub(() => provider.getChildren());

    assert.deepStrictEqual(result, []);
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /rate limit/i);
    assert.match(messages[0], /11 second/i);
  });
});
