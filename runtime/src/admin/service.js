import { PairingInvites } from "../core/pairing-invites.js";
import { createGatewayCore } from "../core/gateway-core.js";
import { isHostApiCompatible, OPENCLAW_HOST_API, } from "../http/routes.js";
const failure = (operation, readOnly, code) => Object.freeze({
    ok: false,
    operation,
    readOnly,
    error: Object.freeze({ code, message: code }),
});
const success = (operation, readOnly, data) => Object.freeze({
    ok: true,
    operation,
    readOnly,
    data: Object.freeze({ ...data }),
});
const validAccountId = (accountId) => typeof accountId === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(accountId);
const validDeviceId = (deviceId) => typeof deviceId === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(deviceId);
const errorCode = (error) => error instanceof Error ? error.message : "INTERNAL_ERROR";
export class AdminService {
    core;
    hostVersion;
    hostApi;
    readOnly;
    constructor(core, options) {
        this.core = core;
        this.hostVersion = options.hostVersion;
        this.hostApi = options.hostApi;
        this.readOnly = !isHostApiCompatible(this.hostVersion, this.hostApi);
    }
    async createAccount(input) {
        if (this.readOnly)
            return failure("account.create", true, "HOST_INCOMPATIBLE");
        if (input.localConfirmation !== true)
            return failure("account.create", false, "LOCAL_CONFIRMATION_REQUIRED");
        if (!validAccountId(input.accountId))
            return failure("account.create", false, "SCHEMA_INVALID");
        // Contract §5.2: the phone presents the password once and only its digest is
        // kept, so an account created without one could never be logged into.
        if (typeof input.password !== "string" || input.password.length === 0) {
            return failure("account.create", false, "PASSWORD_REQUIRED");
        }
        try {
            const account = await this.core.openGatewayAccount(input.accountId);
            try {
                account.credentials.createPassword(input.password);
            }
            finally {
                account.close();
            }
            return success("account.create", false, { accountId: input.accountId });
        }
        catch (error) {
            return failure("account.create", false, errorCode(error));
        }
    }
    async resetPassword(input) {
        const operation = "account.reset-password";
        if (this.readOnly)
            return failure(operation, true, "HOST_INCOMPATIBLE");
        if (input.localConfirmation !== true)
            return failure(operation, false, "LOCAL_CONFIRMATION_REQUIRED");
        if (!validAccountId(input.accountId))
            return failure(operation, false, "SCHEMA_INVALID");
        if (typeof input.password !== "string" || input.password.length === 0)
            return failure(operation, false, "PASSWORD_REQUIRED");
        if (!this.core.accountExists(input.accountId))
            return failure(operation, false, "ACCOUNT_NOT_FOUND");
        let account;
        try {
            account = await this.core.openGatewayAccount(input.accountId);
            if (!account.credentials.hasPassword())
                return failure(operation, false, "ACCOUNT_NOT_FOUND");
            account.credentials.setPassword(input.password);
            return success(operation, false, { accountId: input.accountId });
        }
        catch (error) {
            return failure(operation, false, errorCode(error));
        }
        finally {
            account?.close();
        }
    }
    /** Resource-level deletion of one logical Gateway (contract §13). */
    async deleteAccount(input) {
        if (this.readOnly)
            return failure("account.delete", true, "HOST_INCOMPATIBLE");
        if (input.localConfirmation !== true)
            return failure("account.delete", false, "LOCAL_CONFIRMATION_REQUIRED");
        if (!validAccountId(input.accountId))
            return failure("account.delete", false, "SCHEMA_INVALID");
        try {
            if (!this.core.deleteGatewayAccount(input.accountId)) {
                return failure("account.delete", false, "ACCOUNT_NOT_FOUND");
            }
            return success("account.delete", false, { accountId: input.accountId, deleted: true });
        }
        catch (error) {
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
    async revokePairing(input) {
        if (this.readOnly)
            return failure("pairing.revoke", true, "HOST_INCOMPATIBLE");
        if (input.localConfirmation !== true)
            return failure("pairing.revoke", false, "LOCAL_CONFIRMATION_REQUIRED");
        if (!validAccountId(input.accountId))
            return failure("pairing.revoke", false, "SCHEMA_INVALID");
        if (!validDeviceId(input.deviceId))
            return failure("pairing.revoke", false, "SCHEMA_INVALID");
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
                    correlationId: `admin.pairing.revoke.${input.accountId}`,
                });
                // The same seven fields the wire endpoint answers with, and nothing
                // else: the generation it moved to is in the audit trail.
                return success("pairing.revoke", false, outcome.receipt);
            }
            finally {
                account.close();
            }
        }
        catch (error) {
            return failure("pairing.revoke", false, errorCode(error));
        }
    }
    /**
     * Raises one pairing's `grantRevision` by one (contract §11): the
     * management-plane sibling of `pairing.revoke`. After the Android-local
     * grant has changed, the Gateway moves the device's revision so any request
     * still carrying the old one answers `GRANT_STALE`. The same
     * `HOST_INCOMPATIBLE` gate and local-confirmation rule apply — a grant
     * change is a device-local decision, and the Gateway only records the
     * revision that confirmation produced.
     */
    async grantBump(input) {
        if (this.readOnly)
            return failure("grant.bump", true, "HOST_INCOMPATIBLE");
        if (input.localConfirmation !== true)
            return failure("grant.bump", false, "LOCAL_CONFIRMATION_REQUIRED");
        if (!validAccountId(input.accountId))
            return failure("grant.bump", false, "SCHEMA_INVALID");
        if (!validDeviceId(input.deviceId))
            return failure("grant.bump", false, "SCHEMA_INVALID");
        try {
            // Unlike the wire route, this surface must not create a Gateway as a side
            // effect of asking for one, so a missing account is named instead.
            if (!this.core.accountExists(input.accountId)) {
                return failure("grant.bump", false, "ACCOUNT_NOT_FOUND");
            }
            const account = await this.core.openGatewayAccount(input.accountId);
            try {
                const outcome = account.pairings.bumpGrantRevision({
                    deviceId: input.deviceId,
                    correlationId: `admin.grant.bump.${input.accountId}`,
                });
                // The two fields the revision actually moved, and nothing else: the
                // event and the audit entry carry the same revision.
                return success("grant.bump", false, outcome);
            }
            finally {
                account.close();
            }
        }
        catch (error) {
            return failure("grant.bump", false, errorCode(error));
        }
    }
    async status() {
        return success("admin.status", this.readOnly, {
            hostVersion: this.hostVersion ?? null,
            minHostVersion: this.hostApi.minVersion,
            maxHostVersion: this.hostApi.maxVersion,
            verifiedHostCommit: this.hostApi.verifiedCommit,
            readOnly: this.readOnly,
        });
    }
    async createPairingInvite(input) {
        if (this.readOnly)
            return failure("pairing.invite", true, "HOST_INCOMPATIBLE");
        if (input.localConfirmation !== true)
            return failure("pairing.invite", false, "LOCAL_CONFIRMATION_REQUIRED");
        if (!this.core.accountExists(input.accountId))
            return failure("pairing.invite", false, "ACCOUNT_NOT_FOUND");
        const account = await this.core.openGatewayAccount(input.accountId);
        try {
            return success("pairing.invite", false, new PairingInvites(account.store, account.sessions, input.accountId).issue(input.gatewayUrl, 300, new Date(), this.core.gatewayIdentity?.() ?? {}));
        }
        catch (error) {
            return failure("pairing.invite", false, errorCode(error));
        }
        finally {
            account.close();
        }
    }
    async execute(command) {
        switch (command.command) {
            case "pairing.invite": return this.createPairingInvite(command);
            case "account.create":
                return this.createAccount(command.input);
            case "account.reset-password":
                return this.resetPassword(command.input);
            case "account.delete":
                return this.deleteAccount(command);
            case "pairing.revoke":
                return this.revokePairing(command);
            case "grant.bump":
                return this.grantBump(command);
            case "admin.status":
                return this.status();
            default: {
                // A command this build does not know still has to pass the read-only and
                // local-confirmation gates rather than being silently accepted.
                const unknown = command;
                if (this.readOnly)
                    return failure(unknown.command, true, "HOST_INCOMPATIBLE");
                if (unknown.localConfirmation !== true) {
                    return failure(unknown.command, false, "LOCAL_CONFIRMATION_REQUIRED");
                }
                return failure(unknown.command, false, "ADMIN_OPERATION_NOT_IMPLEMENTED");
            }
        }
    }
}
export const createAdminService = (options = {}) => {
    const hostApi = options.hostApi ?? OPENCLAW_HOST_API;
    const hostVersion = options.hostVersion;
    const core = options.core ?? createGatewayCore({ storageRoot: options.storageRoot });
    return new AdminService(core, { hostVersion, hostApi });
};
export const createAdminPanel = (service) => Object.freeze({
    id: "open-android-intelligence-gateway",
    localOnly: true,
    remotePort: null,
    readOnly: service.readOnly,
    createAccount: (input) => service.createAccount(input),
    resetPassword: (input) => service.resetPassword(input),
    deleteAccount: (input) => service.deleteAccount(input),
    revokePairing: (input) => service.revokePairing(input),
    grantBump: (input) => service.grantBump(input),
    status: () => service.status(),
    execute: (command) => service.execute(command),
});
