export type ProbeResult =
  | { ok: true; email: string }
  | { ok: false; error: string };

export type ImportOptions = {
  alreadySeen?: boolean;
};

export interface Destination {
  readonly type: string;
  ensureTag(name: string): Promise<string>;
  importMessage(
    raw: Buffer,
    tagId: string,
    originalDate: Date,
    options?: ImportOptions,
  ): Promise<string>;
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
