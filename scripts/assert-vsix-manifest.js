#!/usr/bin/env node

/**
 * Validate Marketplace-facing contribution metadata from a packaged VSIX
 * manifest. Asset-byte checks live in assert-vsix-assets.js.
 */

const assert = require("assert");
const { contributesSha256, manifestContract } = require("./release-contract");

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}`,
    );
  }
}

function assertObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function assertString(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  return value;
}

function assertExactArray(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch {
    throw new Error(`${label} must exactly match the release contract.`);
  }
}

function assertArrayOfObjects(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }

  return value.map((item, index) => assertObject(item, `${label}[${index}]`));
}

function assertAbsent(manifest, fieldName) {
  if (Object.prototype.hasOwnProperty.call(manifest, fieldName)) {
    throw new Error(`package manifest must not declare ${fieldName}.`);
  }
}

function assertContributionManifest(manifest) {
  assertEqual(manifest.name, manifestContract.packageName, "package name");
  assertEqual(manifest.publisher, manifestContract.publisher, "package publisher");
  assertEqual(manifest.main, manifestContract.versionedMain, "package main");
  assertEqual(manifest.icon, manifestContract.icon, "package icon");
  assertExactArray(
    manifest.activationEvents ?? [],
    manifestContract.activationEvents,
    "package activationEvents",
  );

  for (const fieldName of manifestContract.forbiddenTopLevelFields) {
    assertAbsent(manifest, fieldName);
  }

  const repository = assertObject(manifest.repository, "package repository");
  assertEqual(repository.type, manifestContract.repository.type, "package repository type");
  assertEqual(repository.url, manifestContract.repository.url, "package repository URL");

  const contributes = assertObject(manifest.contributes, "package contributes");
  const commands = assertArrayOfObjects(contributes.commands, "package contributes.commands");
  assertExactArray(
    commands.map((command, index) =>
      assertString(command.command, `package contributes.commands[${index}].command`),
    ),
    manifestContract.commandIds,
    "package contributes.commands",
  );

  const languageModelTools = assertArrayOfObjects(
    contributes.languageModelTools,
    "package contributes.languageModelTools",
  );
  assertExactArray(
    languageModelTools.map((tool, index) =>
      assertString(tool.name, `package contributes.languageModelTools[${index}].name`),
    ),
    manifestContract.languageModelToolNames,
    "package contributes.languageModelTools",
  );

  const actualContributesSha256 = contributesSha256(contributes);
  assertEqual(
    actualContributesSha256,
    manifestContract.contributesSha256,
    "package contributes SHA-256",
  );
}

module.exports = {
  assertContributionManifest,
};
