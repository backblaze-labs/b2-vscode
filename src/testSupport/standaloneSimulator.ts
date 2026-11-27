/**
 * Harness for the standalone B2 simulator (backblaze-labs/b2-simulator).
 *
 * Each simulator-backed test file starts one server in `suiteSetup`, resets it
 * before every test (`POST /reset` on the control port) and stops it in
 * `suiteTeardown`. The server runs from a local checkout named by
 * `B2_SIMULATOR_DIR` (see docs/development.md, "Standalone B2 simulator"). The mocha
 * hooks live in `src/test/suite/standaloneSimulatorHooks.ts`.
 *
 * @module testSupport/standaloneSimulator
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { FetchTransport, type HttpRequest, type HttpResponse } from "@backblaze-labs/b2-sdk";

export const SIMULATOR_DIR_ENV = "B2_SIMULATOR_DIR";

/**
 * Flags that make the server answer like the SDK's former in-process
 * simulator: control port on, the TypeScript SDK profile, any credentials
 * accepted, and a plain (non-Partner) v3 authorize.
 */
export const IN_PROCESS_COMPATIBLE_ARGS: readonly string[] = Object.freeze([
  "--control",
  "--profile",
  "ts-sdk",
  "--permissive-auth",
  "--no-partner-authorize",
]);

/**
 * Preloaded into the server: when the owning process exits for any reason,
 * the server's stdin closes and the server exits too, so no server outlives
 * its test run.
 */
const EXIT_WITH_OWNER =
  "data:text/javascript," +
  encodeURIComponent(
    'process.stdin.on("end",()=>process.exit(0));' +
      'process.stdin.on("error",()=>process.exit(0));' +
      "process.stdin.resume();",
  );

const READY_PATTERNS = {
  http: /^SIMULATOR-LISTENING (http:\/\/127\.0\.0\.1:\d+)$/m,
  https: /^SIMULATOR-LISTENING (https:\/\/127\.0\.0\.1:\d+)$/m,
  control: /^SIMULATOR-CONTROL (http:\/\/127\.0\.0\.1:\d+)$/m,
};

const SERVER_ENV_NAMES = [
  "PATH",
  "Path",
  "SystemRoot",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
];

/** An error the simulator's `POST /faults` accepts (docs/CONTRACT.md in the simulator). */
export interface SimulatorFault {
  readonly on: string;
  readonly status: number;
  readonly code: string;
  readonly message?: string;
  readonly count?: number;
  readonly skip?: number;
  readonly retryAfter?: number;
}

/** Engine settings `POST /reset` accepts until the next reset. */
export interface SimulatorConfig {
  readonly minimumPartSize?: number;
  readonly recommendedPartSize?: number;
  readonly [key: string]: unknown;
}

export interface StandaloneSimulator {
  readonly httpOrigin: string;
  readonly controlOrigin: string;
  /** A transport that sends every request to this server, whatever host the client asked for. */
  transport(): OriginRewritingTransport;
  /** Empties the server; `config` applies until the next reset. */
  reset(config?: SimulatorConfig): Promise<void>;
  /** Makes matching API calls fail as `fault` describes. */
  injectFailure(fault: SimulatorFault): Promise<void>;
  stop(): Promise<void>;
}

export function resolveSimulatorServeScript(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env[SIMULATOR_DIR_ENV]?.trim();
  if (!dir) {
    throw new Error(
      `${SIMULATOR_DIR_ENV} is not set. Simulator-backed tests need a local checkout of ` +
        `backblaze-labs/b2-simulator: clone it and set ${SIMULATOR_DIR_ENV}=/absolute/path/to/b2-simulator ` +
        '(see docs/development.md, "Standalone B2 simulator").',
    );
  }
  if (!isAbsolute(dir)) {
    throw new Error(`${SIMULATOR_DIR_ENV} must be an absolute path, got ${dir}.`);
  }
  const serveScript = join(dir, "bin", "simulator", "serve.mjs");
  if (!existsSync(serveScript)) {
    throw new Error(
      `${SIMULATOR_DIR_ENV}=${dir} has no bin/simulator/serve.mjs; point it at a ` +
        "backblaze-labs/b2-simulator checkout.",
    );
  }
  return serveScript;
}

/**
 * Environment for the server: enough to run Node, never a B2 credential. Inside
 * the VS Code test host `process.execPath` is Electron, so it is asked to run
 * as plain Node.
 */
function serverEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const name of SERVER_ENV_NAMES) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  return env;
}

function waitForReady(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ http: string; control: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString("utf8");
      const http = READY_PATTERNS.http.exec(stdout)?.[1];
      const https = READY_PATTERNS.https.exec(stdout)?.[1];
      const control = READY_PATTERNS.control.exec(stdout)?.[1];
      if (http && https && control) {
        cleanup();
        resolve({ http, control });
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString("utf8");
    };
    const fail = (reason: string): void => {
      cleanup();
      child.kill("SIGKILL");
      reject(new Error(`${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };
    const onExit = (code: number | null, signal: string | null): void =>
      fail(`simulator exited before listening (code ${code}, signal ${signal})`);
    const onError = (err: Error): void => fail(`simulator could not start: ${err.message}`);
    const timer = setTimeout(
      () => fail(`simulator did not print its listening lines within ${timeoutMs} ms`),
      timeoutMs,
    );
    function cleanup(): void {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    }
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function control(
  origin: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`simulator control ${method} ${path} answered ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Sends every request to `origin`, keeping path and query, and answers as if
 * the simulator lived at the origin the client asked for.
 *
 * The SDK's in-process simulator served any host and echoed the requested
 * origin in the URLs it returned (`apiUrl`, `downloadUrl`, upload URLs). The
 * standalone server returns its own loopback origin instead, so JSON answers
 * get it replaced by the requested one; file bodies and headers pass through
 * untouched. No request ever leaves the loopback server.
 */
export class OriginRewritingTransport {
  private readonly inner = new FetchTransport();

  constructor(private readonly origin: string) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const requested = new URL(request.url);
    const response = await this.inner.send({
      ...request,
      url: new URL(`${requested.pathname}${requested.search}`, this.origin).href,
    });
    const json = (response.headers.get("content-type") ?? "").includes("json");
    if (!json || request.method === "HEAD" || requested.origin === this.origin) {
      return response;
    }
    const text = (await response.text()).split(this.origin).join(requested.origin);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    const rewritten = new Response(text, { status: response.status, headers });
    return {
      status: rewritten.status,
      headers: rewritten.headers,
      body: rewritten.body,
      json: <T>() => rewritten.json() as Promise<T>,
      text: () => rewritten.text(),
      arrayBuffer: () => rewritten.arrayBuffer(),
    };
  }
}

export async function startStandaloneSimulator(
  options: { extraArgs?: readonly string[]; startTimeoutMs?: number } = {},
): Promise<StandaloneSimulator> {
  const serveScript = resolveSimulatorServeScript();
  const child = spawn(
    process.execPath,
    [
      "--import",
      EXIT_WITH_OWNER,
      serveScript,
      ...IN_PROCESS_COMPATIBLE_ARGS,
      ...(options.extraArgs ?? []),
    ],
    // stdin stays open: its end is the signal that this owner is gone.
    { env: serverEnv(), stdio: ["pipe", "pipe", "pipe"] },
  );
  const origins = await waitForReady(child, options.startTimeoutMs ?? 15_000);
  // Keep draining output so a chatty server never blocks on a full pipe.
  child.stdout?.resume();
  child.stderr?.resume();
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
    } else {
      child.once("exit", () => resolve());
    }
  });

  return {
    httpOrigin: origins.http,
    controlOrigin: origins.control,
    transport: () => new OriginRewritingTransport(origins.http),
    reset: async (config) => {
      await control(origins.control, "POST", "/reset", config ? { config } : {});
    },
    injectFailure: async (fault) => {
      await control(origins.control, "POST", "/faults", fault);
    },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        await exited;
        clearTimeout(timer);
      }
    },
  };
}
