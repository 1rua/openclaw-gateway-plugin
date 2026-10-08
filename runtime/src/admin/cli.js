import { createAdminService, } from "./service.js";
let boundAdminService;
export const bindAdminService = (service) => {
    boundAdminService = service;
};
const invalidArguments = (service) => Object.freeze({
    ok: false,
    operation: "admin.cli",
    readOnly: service.readOnly,
    error: Object.freeze({ code: "ADMIN_ARGUMENTS_INVALID", message: "ADMIN_ARGUMENTS_INVALID" }),
});
/** The closed flag set of the account commands; undefined means invalid input. */
const parseFlags = (tokens) => {
    let confirmed = false;
    let password;
    let index = 0;
    while (index < tokens.length) {
        const token = tokens[index];
        if (token === "--confirm-local") {
            confirmed = true;
            index += 1;
            continue;
        }
        if (token === "--password" && index + 1 < tokens.length) {
            password = tokens[index + 1];
            index += 2;
            continue;
        }
        return undefined;
    }
    return { confirmed, password };
};
const createInput = (accountId, flags) => ({
    accountId,
    ...(flags.password === undefined ? {} : { password: flags.password }),
    ...(flags.confirmed ? { localConfirmation: true } : {}),
});
const parseCommand = (args, service) => {
    const [first, second, third, ...rest] = args;
    if (first === "pairing" && second === "invite" && third && rest.length === 2 && rest[1] === "--confirm-local")
        return { command: "pairing.invite", accountId: third, gatewayUrl: rest[0], localConfirmation: true };
    if (first === "account" && (second === "create" || second === "reset-password") && third !== undefined) {
        const flags = parseFlags(rest);
        if (flags === undefined)
            return invalidArguments(service);
        return { command: second === "create" ? "account.create" : "account.reset-password", input: createInput(third, flags) };
    }
    if (first === "create-account" && second !== undefined) {
        const flags = parseFlags(rest);
        if (third !== undefined)
            return invalidArguments(service);
        if (flags === undefined)
            return invalidArguments(service);
        return { command: "account.create", input: createInput(second, flags) };
    }
    if (first === "status" && second === undefined && third === undefined) {
        return { command: "admin.status" };
    }
    if (first === "account" && second === "status" && third === undefined && rest.length === 0) {
        return { command: "admin.status" };
    }
    if (first === "account" && second === "delete" && third !== undefined) {
        const flags = parseFlags(rest);
        if (flags === undefined)
            return invalidArguments(service);
        return {
            command: "account.delete",
            accountId: third,
            ...(flags.confirmed ? { localConfirmation: true } : {}),
        };
    }
    if (first === "pairing" && second === "revoke" && third !== undefined && rest[0] !== undefined) {
        const [deviceId, ...flagTokens] = rest;
        const flags = parseFlags(flagTokens);
        if (flags === undefined)
            return invalidArguments(service);
        return {
            command: "pairing.revoke",
            accountId: third,
            deviceId,
            ...(flags.confirmed ? { localConfirmation: true } : {}),
        };
    }
    if (first === "grant" && second === "bump" && third !== undefined && rest[0] !== undefined) {
        const [deviceId, ...flagTokens] = rest;
        const flags = parseFlags(flagTokens);
        if (flags === undefined)
            return invalidArguments(service);
        return {
            command: "grant.bump",
            accountId: third,
            deviceId,
            ...(flags.confirmed ? { localConfirmation: true } : {}),
        };
    }
    return invalidArguments(service);
};
const executeAdminCommand = async (service, args) => {
    const command = parseCommand(args, service);
    if ("ok" in command)
        return command;
    return service.execute(command);
};
/** Stable local invocation entry shared with the registered CLI actions. */
export const runAdminCommand = async (args) => executeAdminCommand(boundAdminService ?? createAdminService(), args);
const confirmedOption = (value) => (typeof value === "object"
    && value !== null
    && "confirmLocal" in value
    && value.confirmLocal === true);
const stringOption = (value, key) => {
    if (typeof value !== "object" || value === null || !(key in value))
        return undefined;
    const candidate = value[key];
    return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
};
const registerAdminCommands = (context, service) => {
    const root = context.program
        .command("open-android-intelligence")
        .description("Manage Open Android Intelligence Gateway accounts");
    const account = root
        .command("account")
        .description("Manage Open Android Intelligence Gateway accounts");
    account
        .command("create <accountId>")
        .description("Create a Gateway account")
        .option("--confirm-local", "Confirm this write on the local host")
        .option("--password <password>", "Account password; only its scrypt digest is stored")
        .action((accountId, options) => executeAdminCommand(service, [
        "account",
        "create",
        String(accountId),
        ...(confirmedOption(options) ? ["--confirm-local"] : []),
        ...(stringOption(options, "password") === undefined
            ? []
            : ["--password", stringOption(options, "password")]),
    ]));
    account
        .command("reset-password <accountId>")
        .description("Reset the password and revoke every account refresh credential; retain pairing keys")
        .option("--confirm-local", "Confirm this write on the local host")
        .option("--password <password>", "New account password")
        .action((accountId, options) => executeAdminCommand(service, [
        "account", "reset-password", String(accountId),
        ...(confirmedOption(options) ? ["--confirm-local"] : []),
        ...(stringOption(options, "password") === undefined ? [] : ["--password", stringOption(options, "password")]),
    ]));
    account
        .command("status")
        .description("Show Gateway account status")
        .action(() => executeAdminCommand(service, ["account", "status"]));
    account
        .command("delete <accountId>")
        .description("Delete a Gateway account")
        .option("--confirm-local", "Confirm this write on the local host")
        .action((accountId, options) => executeAdminCommand(service, [
        "account",
        "delete",
        String(accountId),
        ...(confirmedOption(options) ? ["--confirm-local"] : []),
    ]));
    const pairing = root
        .command("pairing")
        .description("Manage Open Android Intelligence Gateway device pairings");
    pairing
        .command("revoke <accountId> <deviceId>")
        .description("Revoke one device pairing and all of its sessions, grants and queued requests")
        .option("--confirm-local", "Confirm this write on the local host")
        .action((accountId, deviceId, options) => executeAdminCommand(service, [
        "pairing",
        "revoke",
        String(accountId),
        String(deviceId),
        ...(confirmedOption(options) ? ["--confirm-local"] : []),
    ]));
    const grant = root
        .command("grant")
        .description("Manage Open Android Intelligence Gateway pairing grants");
    grant
        .command("bump <accountId> <deviceId>")
        .description("Raise one pairing's grantRevision after the Android-local grant changed")
        .option("--confirm-local", "Confirm this write on the local host")
        .action((accountId, deviceId, options) => executeAdminCommand(service, [
        "grant",
        "bump",
        String(accountId),
        String(deviceId),
        ...(confirmedOption(options) ? ["--confirm-local"] : []),
    ]));
};
export const createAdminCliRegistrar = (service) => async (context) => {
    registerAdminCommands(context, service);
};
