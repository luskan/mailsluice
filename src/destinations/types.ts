export type ProbeResult =
  | { ok: true; email: string }
  | { ok: false; error: string };

export interface Destination {
  readonly type: string;
  ensureTag(name: string): Promise<string>;
  importMessage(raw: Buffer, tagId: string, originalDate: Date): Promise<string>;
  probe(): Promise<ProbeResult>;
  dispose?(): void | Promise<void>;
}

export interface AuthStarter {
  readonly type: string;
  authUrl(state: string): string;
  handleCallback(params: URLSearchParams): Promise<{
    userCredentials: unknown;
    accountIdentifier: string;
  }>;
}

export interface DestinationFactory {
  readonly type: string;
  createAuthStarter(args: {
    adminConfig: unknown;
    redirectUri: string;
  }): AuthStarter;
  createDestination(args: {
    adminConfig: unknown;
    userCredentials: unknown;
    onCredentialsRefreshed?: (newCreds: unknown) => void;
  }): Destination;
}
