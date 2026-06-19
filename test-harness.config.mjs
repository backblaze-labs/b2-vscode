export const sourceTestRoot = "src/test/suite";
export const compiledTestRoot = "out/src/test/suite";
export const sourceTestFilesGlob = `${sourceTestRoot}/**/*.test.ts`;
export const compiledTestFilesGlob = `${compiledTestRoot}/**/*.test.js`;

export const mochaOptions = {
  ui: "tdd",
  timeout: 20000,
  failZero: true,
  forbidOnly: true,
  forbidPending: true,
};
