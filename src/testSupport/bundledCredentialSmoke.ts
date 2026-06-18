import { AuthService, type B2Credentials } from "../services/authService";
import { createNoopSecretStorage } from "./noopSecretStorage";

export const BUNDLED_CREDENTIAL_SMOKE_ENV = "B2_VSCODE_ENABLE_BUNDLED_CREDENTIAL_SMOKE";
export type BundledCredentialSmokeResolver = (dbPath: string) => Promise<B2Credentials | null>;

export const resolveBundledCredentialSmoke: BundledCredentialSmokeResolver = async (dbPath) => {
  if (process.env[BUNDLED_CREDENTIAL_SMOKE_ENV] !== "1") {
    return null;
  }

  const authService = new AuthService(createNoopSecretStorage(), {
    environment: {},
    b2CliDatabasePaths: [dbPath],
  });

  try {
    return await authService.resolveCredentials();
  } finally {
    authService.dispose();
  }
};
