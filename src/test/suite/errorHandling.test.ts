/**
 * Tests for B2 error mapping and safe diagnostics.
 *
 * @module test/suite/errorHandling
 */

import * as assert from "assert";
import { B2InsufficientCapabilityError, NetworkError, classifyError } from "@backblaze-labs/b2-sdk";
import {
  B2PartialFailureError,
  B2ResourceNotFoundError,
  formatB2DiagnosticMessage,
  formatB2DiagnosticStack,
  formatB2ToolUserMessage,
  formatB2UserMessage,
  redactSensitiveText,
} from "../../errors";

function b2Error(status: number, code: string, message: string, retryAfter?: number): Error {
  return classifyError(
    { status, code, message },
    { requestId: "req-123", ...(retryAfter !== undefined ? { retryAfter } : {}) },
  );
}

suite("B2 error handling", () => {
  test("defines user messages for common B2 failure modes", () => {
    const cases: Array<{ error: Error; expected: RegExp }> = [
      {
        error: b2Error(401, "bad_auth_token", "bad key"),
        expected: /application key ID or application key/i,
      },
      {
        error: b2Error(401, "expired_auth_token", "expired"),
        expected: /authorization expired.*SDK refreshes/i,
      },
      {
        error: new B2InsufficientCapabilityError(
          ["listFiles", "readFiles"],
          ["listBuckets"],
          ["listFiles", "readFiles"],
        ),
        expected: /missing permission.*listFiles, readFiles/i,
      },
      {
        error: b2Error(404, "no_such_file", "file missing"),
        expected: /bucket or object was not found/i,
      },
      {
        error: b2Error(429, "too_many_requests", "slow down", 7),
        expected: /rate limit.*7 seconds/i,
      },
      {
        error: new NetworkError("fetch failed"),
        expected: /network connection to B2 failed/i,
      },
      {
        error: b2Error(400, "bad_json", "malformed body"),
        expected: /could not parse/i,
      },
    ];

    for (const testCase of cases) {
      assert.match(formatB2UserMessage(testCase.error), testCase.expected);
    }
  });

  test("documents SDK retry/backoff delegation for transient failures", () => {
    const message = formatB2UserMessage(b2Error(503, "service_unavailable", "try later", 3));

    assert.match(message, /SDK retries transient failures with backoff/i);
    assert.match(message, /3 seconds/i);
  });

  test("pluralizes retry-after seconds in user messages", () => {
    assert.match(
      formatB2UserMessage(b2Error(429, "too_many_requests", "slow down", 1)),
      /1 second/i,
    );
    assert.match(
      formatB2UserMessage(b2Error(429, "too_many_requests", "slow down", 2)),
      /2 seconds/i,
    );
  });

  test("classifies typed 5xx errors before broad network text matches", () => {
    const message = formatB2UserMessage(
      b2Error(503, "service_unavailable", "temporary network edge failure", 3),
    );

    assert.match(message, /temporarily unavailable/i);
    assert.doesNotMatch(message, /Network connection to B2 failed/i);
  });

  test("uses generic user text for unexpected non-B2 errors", () => {
    const message = formatB2UserMessage(
      new TypeError("Cannot read properties of undefined applicationKey=secret"),
    );

    assert.match(message, /Unexpected error/i);
    assert.doesNotMatch(message, /Cannot read properties|secret/);
  });

  test("does not label empty-message non-B2 errors as B2 errors", () => {
    const message = formatB2UserMessage(new Error(""));

    assert.match(message, /Unexpected error/i);
    assert.doesNotMatch(message, /Unexpected B2 error/i);
  });

  test("preserves safe extension guidance for expected non-B2 errors", () => {
    const message = formatB2UserMessage(
      new Error("Not authenticated. Please run the B2: Authenticate command first."),
    );

    assert.equal(message, "Not authenticated. Please run the B2: Authenticate command first.");
  });

  test("preserves extension-originated not-found details", () => {
    const message = formatB2UserMessage(new B2ResourceNotFoundError('Bucket "b" not found.'));

    assert.equal(message, 'Bucket "b" not found.');
  });

  test("tool messages preserve safe local file errors", () => {
    const error = new Error(
      "ENOENT: no such file or directory, open '/tmp/missing.txt'",
    ) as Error & {
      code: string;
    };
    error.code = "ENOENT";

    const message = formatB2ToolUserMessage(error);

    assert.match(message, /ENOENT.*missing\.txt/);
  });

  test("keeps partial operation failures visible", () => {
    const message = formatB2UserMessage(
      new B2PartialFailureError(
        'Rename incomplete. Copied "old.txt" to "new.txt", but failed to delete the original. Both B2 objects may exist.',
      ),
    );

    assert.match(message, /Rename incomplete/i);
    assert.match(message, /Both B2 objects may exist/i);
  });

  test("diagnostics include B2 metadata without leaking tokens or keys", () => {
    const diagnostic = formatB2DiagnosticMessage(
      b2Error(
        429,
        "too_many_requests",
        "https://example.invalid/file.txt?Authorization=secret-token applicationKey=secret-key",
        5,
      ),
    );

    assert.match(diagnostic, /status=429/);
    assert.match(diagnostic, /code=too_many_requests/);
    assert.match(diagnostic, /requestId=req-123/);
    assert.match(diagnostic, /retryAfter=5/);
    assert.doesNotMatch(diagnostic, /secret-token|secret-key/);
  });

  test("diagnostics include the SDK retry note once for nested failures", () => {
    const diagnostic = formatB2DiagnosticMessage(
      new B2PartialFailureError(
        "delete incomplete",
        b2Error(503, "service_unavailable", "try later", 3),
      ),
    );

    assert.equal(
      diagnostic.match(/The B2 SDK retries retryable B2 errors with backoff/g)?.length,
      1,
    );
  });

  test("diagnostics omit the SDK retry note for non-B2 failures", () => {
    const diagnostic = formatB2DiagnosticMessage(new TypeError("local fs failure"));

    assert.doesNotMatch(diagnostic, /The B2 SDK retries retryable B2 errors with backoff/);
  });

  test("redacts secret-looking stack traces", () => {
    const error = new Error("failed applicationKey=secret-key");
    error.stack = `Error: failed applicationKey=secret-key
    at run (https://example.invalid/file.txt?authorizationToken=secret-token)`;

    const stack = formatB2DiagnosticStack(error);

    assert.ok(stack);
    assert.doesNotMatch(stack, /secret-key|secret-token/);
    assert.match(stack, /<redacted>/);
  });

  test("redacts secret-looking free text", () => {
    const text = redactSensitiveText(
      'B2_APPLICATION_KEY=abc123 {"authorizationToken":"tok123"} https://x.test?token=tok&X-Amz-Signature=sig&X-Amz-Credential=cred&X-Amz-Security-Token=session',
    );

    assert.doesNotMatch(text, /abc123|tok123|token=tok|sig|cred|session/);
    assert.match(text, /<redacted>/);
  });
});
