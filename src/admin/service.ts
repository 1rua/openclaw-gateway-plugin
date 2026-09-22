import { createGatewayCore, type GatewayCore } from "../core/gateway-core.js";
import {
  isHostApiCompatible,
  OPENCLAW_HOST_API,
  type HostApiCompatibility,
} from "../http/routes.js";

export type CreateAccountInput = Readonly<{
  accountId: string;
  displayName?: string;
  /** Required: it is what makes the account usable for password login. */
  password?: string;
  localConfirmation?: boolean;
}>;

/**
 * One device pairing, the level *below* an account.
 *
 * `account.delete` removes the whole logical Gateway; `pairing.revoke` removes
 * one device's pairing from it (contract §13 解除配对). They are siblings, not
 * a hierarchy: the same flat shape and the same read-only gate, and — like
 * `account.delete` — a local confirmation this surface requires and the wire
 * endpoint must never accept.
 */
export type RevokePairingInput = Readonly<{
  accountId: string;
  deviceId: string;
  /**
   * Required on this local surface only. The wire endpoint never uses it: a
   * client could forge it, and the confirmation the user actually gives is the
   * local UI dialog (D1).
   */
  localConfirmation?: boolean;
}>;

export type AdminCommand =
  | Readonly<{ command: "account.create"; input: CreateAccountInput }>
  | Readonly<{ command: "admin.status" }>
  | Readonly<{ command: "account.delete"; accountId: string; localConfirmation?: boolean }>
  | Readonly<{ command: "pairing.revoke"; accountId: string; deviceId: string; localConfirmation?: boolean }>;

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

const validDeviceId = (deviceId: unknown): deviceId is string =>
  typeof deviceId === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(deviceId);

const errorCode = (error: unknown): string => error instanceof Error ? error.message : "INTERNAL_ERROR";

export class AdminService {
  readonly hostVersion: string | undefined;
  readonly hostApi: HostApiCompatibility;
  readonly readOnly: boolean;

  constructor(
    private readonly core: GatewayCore,
    options: Readonly<{ hostVersion: string | undefined; hostApi: HostApiCompatibility }>,
  ) {
    this.hostVersion = options.hostVersion;
    this.hostApi = options.hostApi;
    this.readOnly = !isHostApiCompatible(this.hostVersion, this.hostApi);
  }

  async createAccount(input: CreateAccountInput): Promise<AdminResult> {
    if (this.readOnly) return failure("account.create", true, "HOST_INCOMPATIBLE");
    if (input.localConfirmation !== true) return failure("account.create", false, "LOCAL_CONFIRMATION_REQUIRED");
    if (!validAccountId(input.accountId)) return failure("account.create", false, "SCHEMA_INVALID");
    // Contract §5.2: the phone presents the password once and only its digest is
    // kept, so an account created without one could never be logged into.
    if (typeof input.password !== "string" || input.password.length === 0) {
      return failure("account.create", false, "PASSWORD_REQUIRED");
    }
    try {
      const account = await this.core.openGatewayAccount(input.accountId);
      try {
        account.credentials.setPassword(input.password);
      } finally {
        account.close();
      }
      return success("account.create", false, { accountId: input.accountId });
    } catch (error) {
      return failure("account.create", false, errorCode(error));
    }
  }

  /** Resource-level deletion of one logical Gateway (contract §13). */
  async deleteAccount(input: Readonly<{
    accountId: string;
    localConfirmation?: boolean;
  }>): Promise<AdminResult> {
    if (this.readOnly) return failure("account.delete", true, "HOST_INCOMPATIBLE");
    if (input.localConfirmation !== true) return failure("account.delete", false, "LOCAL_CONFIRMATION_REQUIRED");
    if (!validAccountId(input.accountId)) return failure("account.delete", false, "SCHEMA_INVALID");
    try {
      if (!this.core.deleteGatewayAccount(input.accountId)) {
        return failure("account.delete", false, "ACCOUNT_NOT_FOUND");
      }
      return success("account.delete", false, { accountId: input.accountId, deleted: true });
    } catch (error) {
      return failure("account.delete", false, errorCode(error));
    }
  }

  /**
   * 解除配对 for one device (contract §13, D1): device key, refresh credential,
   * grants, queue, unconfirmed attachments and every access session of that
   * device, plus a `pairingGeneration` bump.
   *
   * This is the local management twin of `DELETE /pairings/current` — the same
   * account-scoped service, reached without a session because the operator is
   * already on the host.
   */
  async revokePairing(input: RevokePairingInput): Promise<AdminResult> {
    if (this.readOnly) return failure("pairing.revoke", true, "HOST_INCOMPATIBLE");
    if (input.localConfirmation !== true) return failure("pairing.revoke", false, "LOCAL_CONFIRMATION_REQUIRED");
    if (!validAccountId(input.accountId)) return failure("pairing.revoke", false, "SCHEMA_INVALID");
    if (!validDeviceId(input.deviceId)) return failure("pairing.revoke", false, "SCHEMA_INVALID");
    try {
      // Unlike the wire route, this surface must not create a Gateway as a side
      // effect of asking for one, so a missing account is named instead.
      if (!this.core.accountExists(input.accountId)) {
        return failure("pairing.revoke", false, "ACCOUNT_NOT_FOUND");
      }
      const account = await this.core.openGatewayAccount(input.accountId);
      try {
        if (!account.pairings.hasActivePairing(input.deviceId)) {
          return failure("pairing.revoke", false, "PAIRING_REQUIRED");
        }
        const outcome = account.pairings.revoke({
          deviceId: input.deviceId,
          correlationId: `admin:pairing.revoke:${input.accountId}`,
        });
        // The same seven fields the wire endpoint answers with, and nothing
        // else: the generation it moved to is in the audit trail.
        return success("pairing.revoke", false, outcome.receipt);
      } finally {
        account.close();
      }
    } catch (error) {
      return failure("pairing.revoke", false, errorCode(error));
    }
  }

  async status(): Promise<AdminResult> {
    return success("admin.status", this.readOnly, {
      hostVersion: this.hostVersion ?? null,
      minHostVersion: this.hostApi.minVersion,
      maxHostVersion: this.hostApi.maxVersion,
      verifiedHostCommit: this.hostApi.verifiedCommit,
      readOnly: this.readOnly,
    });
  }

  async execute(command: AdminCommand): Promise<AdminResult> {
    switch (command.command) {
      case "account.create":
        return this.createAccount(command.input);
      case "account.delete":
        return this.deleteAccount(command);
      case "pairing.revoke":
        return this.revokePairing(command);
      case "admin.status":
        return this.status();
      default: {
        // A command this build does not know still has to pass the read-only and
        // local-confirmation gates rather than being silently accepted.
        const unknown = command as unknown as { command: string; localConfirmation?: boolean };
        if (this.readOnly) return failure(unknown.command, true, "HOST_INCOMPATIBLE");
        if (unknown.localConfirmation !== true) {
          return failure(unknown.command, false, "LOCAL_CONFIRMATION_REQUIRED");
        }
        return failure(unknown.command, false, "ADMIN_OPERATION_NOT_IMPLEMENTED");
      }
    }
  }
}

export const createAdminService = (options: AdminServiceOptions = {}): AdminService => {
  const hostApi = options.hostApi ?? OPENCLAW_HOST_API;
  const hostVersion = options.hostVersion;
  const core = options.core ?? createGatewayCore({ storageRoot: options.storageRoot });
  return new AdminService(core, { hostVersion, hostApi });
};

export type AdminPanel = Readonly<{
  id: "open-android-intelligence-gateway";
  localOnly: true;
  remotePort: null;
  readOnly: boolean;
  createAccount: (input: CreateAccountInput) => Promise<AdminResult>;
  deleteAccount: (input: Readonly<{ accountId: string; localConfirmation?: boolean }>) => Promise<AdminResult>;
  revokePairing: (input: RevokePairingInput) => Promise<AdminResult>;
  status: () => Promise<AdminResult>;
  execute: (command: AdminCommand) => Promise<AdminResult>;
}>;

export const createAdminPanel = (service: AdminService): AdminPanel => Object.freeze({
  id: "open-android-intelligence-gateway" as const,
  localOnly: true as const,
  remotePort: null,
  readOnly: service.readOnly,
  createAccount: (input) => service.createAccount(input),
  deleteAccount: (input) => service.deleteAccount(input),
  revokePairing: (input) => service.revokePairing(input),
  status: () => service.status(),
  execute: (command) => service.execute(command),
});
