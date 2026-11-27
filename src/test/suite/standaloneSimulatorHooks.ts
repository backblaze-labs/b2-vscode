/**
 * Mocha `tdd` hooks for simulator-backed suites: one standalone B2 simulator
 * for the suite, reset before each test, stopped after the suite.
 *
 * @module test/suite/standaloneSimulatorHooks
 */

import {
  startStandaloneSimulator,
  type StandaloneSimulator,
} from "../../testSupport/standaloneSimulator";

/** Registers the hooks in the calling suite and returns an accessor for its server. */
export function useStandaloneSimulator(): () => StandaloneSimulator {
  let sim: StandaloneSimulator | undefined;
  suiteSetup(async function () {
    this.timeout(30_000);
    sim = await startStandaloneSimulator();
  });
  setup(async () => {
    await sim?.reset();
  });
  suiteTeardown(async () => {
    await sim?.stop();
    sim = undefined;
  });
  return () => {
    if (!sim) {
      throw new Error("The standalone simulator is not running; call this inside a test.");
    }
    return sim;
  };
}
