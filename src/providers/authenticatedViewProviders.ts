/**
 * Coordinates view providers that mirror the authenticated B2 client.
 *
 * @module providers/authenticatedViewProviders
 */

import type { B2Client } from "@backblaze-labs/b2-sdk";

export interface AuthenticatedViewProvider {
  setClient(client: B2Client | null): void;
  refresh(): void;
}

export class AuthenticatedViewProviderCollection {
  constructor(private readonly providers: readonly AuthenticatedViewProvider[]) {}

  setClient(client: B2Client | null): void {
    for (const provider of this.providers) {
      provider.setClient(client);
    }
  }

  refresh(): void {
    for (const provider of this.providers) {
      provider.refresh();
    }
  }
}
