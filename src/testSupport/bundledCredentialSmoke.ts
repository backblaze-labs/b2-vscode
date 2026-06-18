import { AuthService, type B2Credentials } from "../services/authService";
import { createNoopSecretStorage } from "./noopSecretStorage";

export type BundledCredentialSmokeResolver = (dbPath: string) => Promise<B2Credentials | null>;

export const resolveBundledCredentialSmoke: BundledCredentialSmokeResolver = async (dbPath) => {
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
