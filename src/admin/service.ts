import { createGatewayCore, type GatewayCore } from "../core/gateway-core.js";
import {
  isHostApiCompatible,
  OPENCLAW_HOST_API,
  type HostApiCompatibility,
} from "../http/routes.js";

export type CreateAccountInput = Readonly<{
  accountId: string;
  displayName?: string;
}>;

export type AdminCommand =
  | Readonly<{ command: "account.create"; input: CreateAccountInput }>
  | Readonly<{ command: "admin.status" }>
  | Readonly<{ command: "account.delete"; accountId: string; localConfirmation?: boolean }>;

export type AdminResult = Readonly<{
  ok: boolean;
  operation: string;
  readOnly: boolean;
  data?: Readonly<Record<string, unknown>>;
  error?: Readonly<{
    code: string;
    message: string;
  }>;
}>;

export type AdminServiceOptions = Readonly<{
  core?: GatewayCore;
  storageRoot?: string;
  hostVersion?: string;
  hostApi?: HostApiCompatibility;
}>;

const failure = (operation: string, readOnly: boolean, code: string): AdminResult => Object.freeze({
  ok: false,
  operation,
  readOnly,
  error: Object.freeze({ code, message: code }),
});

const success = (operation: string, readOnly: boolean, data: Readonly<Record<string, unknown>>): AdminResult => Object.freeze({
  ok: true,
  operation,
  readOnly,
  data: Object.freeze({ ...data }),
});

const validAccountId = (accountId: unknown): accountId is string =>
  typeof accountId === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(accountId);

const errorCode = (error: unknown): string => error instanceof Error ? error.message : "INTERNAL_ERROR";

export class AdminService {
  readonly hostVersion: string;
  readonly hostApi: HostApiCompatibility;
  readonly readOnly: boolean;

  constructor(
    private readonly core: GatewayCore,
    options: Readonly<{ hostVersion: string; hostApi: HostApiCompatibility }>,
  ) {
    this.hostVersion = options.hostVersion;
    this.hostApi = options.hostApi;
    this.readOnly = !isHostApiCompatible(this.hostVersion, this.hostApi);
  }

  async createAccount(input: CreateAccountInput): Promise<AdminResult> {
    if (this.readOnly) return failure("account.create", true, "HOST_INCOMPATIBLE");
    if (!validAccountId(input.accountId)) return failure("account.create", false, "SCHEMA_INVALID");
    try {
      const account = await this.core.openGatewayAccount(input.accountId);
      account.close();
      return success("account.create", false, { accountId: input.accountId });
    } catch (error) {
      return failure("account.create", false, errorCode(error));
    }
  }

  async status(): Promise<AdminResult> {
    return success("admin.status", this.readOnly, {
      hostVersion: this.hostVersion,
      minHostVersion: this.hostApi.minVersion,
      maxHostVersion: this.hostApi.maxVersion,
      verifiedHostCommit: this.hostApi.verifiedCommit,
      readOnly: this.readOnly,
    });
  }

  async execute(command: AdminCommand): Promise<AdminResult> {
    if (command.command === "account.create") return this.createAccount(command.input);
    if (command.command === "admin.status") return this.status();
    if (this.readOnly) return failure(command.command, true, "HOST_INCOMPATIBLE");
    if (command.localConfirmation !== true) return failure(command.command, false, "LOCAL_CONFIRMATION_REQUIRED");
    return failure(command.command, false, "ADMIN_OPERATION_NOT_IMPLEMENTED");
  }
}

export const createAdminService = (options: AdminServiceOptions = {}): AdminService => {
  const hostApi = options.hostApi ?? OPENCLAW_HOST_API;
  const hostVersion = options.hostVersion ?? hostApi.maxVersion;
  const core = options.core ?? createGatewayCore({ storageRoot: options.storageRoot });
  return new AdminService(core, { hostVersion, hostApi });
};

export type AdminPanel = Readonly<{
  id: "agent-life-gateway";
  localOnly: true;
  remotePort: null;
  readOnly: boolean;
  createAccount: (input: CreateAccountInput) => Promise<AdminResult>;
  status: () => Promise<AdminResult>;
  execute: (command: AdminCommand) => Promise<AdminResult>;
}>;

export const createAdminPanel = (service: AdminService): AdminPanel => Object.freeze({
  id: "agent-life-gateway" as const,
  localOnly: true as const,
  remotePort: null,
  readOnly: service.readOnly,
  createAccount: (input) => service.createAccount(input),
  status: () => service.status(),
  execute: (command) => service.execute(command),
});
