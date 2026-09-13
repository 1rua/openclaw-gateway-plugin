import {
  createAdminService,
  type AdminCommand,
  type AdminResult,
  type AdminService,
} from "./service.js";

let boundAdminService: AdminService | undefined;

export const bindAdminService = (service: AdminService): void => {
  boundAdminService = service;
};

const invalidArguments = (service: AdminService): AdminResult => Object.freeze({
  ok: false,
  operation: "admin.cli",
  readOnly: service.readOnly,
  error: Object.freeze({ code: "ADMIN_ARGUMENTS_INVALID", message: "ADMIN_ARGUMENTS_INVALID" }),
});

type ParsedFlags = Readonly<{ confirmed: boolean; password: string | undefined }>;

/** The closed flag set of the account commands; undefined means invalid input. */
const parseFlags = (tokens: readonly string[]): ParsedFlags | undefined => {
  let confirmed = false;
  let password: string | undefined;
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

const createInput = (accountId: string, flags: ParsedFlags) => ({
  accountId,
  ...(flags.password === undefined ? {} : { password: flags.password }),
  ...(flags.confirmed ? { localConfirmation: true } : {}),
});

const parseCommand = (args: readonly string[], service: AdminService): AdminCommand | AdminResult => {
  const [first, second, third, ...rest] = args;
  if (first === "account" && second === "create" && third !== undefined) {
    const flags = parseFlags(rest);
    if (flags === undefined) return invalidArguments(service);
    return { command: "account.create", input: createInput(third, flags) };
  }
  if (first === "create-account" && second !== undefined) {
    const flags = parseFlags(rest);
    if (third !== undefined) return invalidArguments(service);
    if (flags === undefined) return invalidArguments(service);
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
    if (flags === undefined) return invalidArguments(service);
    return {
      command: "account.delete",
      accountId: third,
      ...(flags.confirmed ? { localConfirmation: true } : {}),
    };
  }
  return invalidArguments(service);
};

const executeAdminCommand = async (service: AdminService, args: readonly string[]): Promise<AdminResult> => {
  const command = parseCommand(args, service);
  if ("ok" in command) return command;
  return service.execute(command);
};

/** Stable local invocation entry shared with the registered CLI actions. */
export const runAdminCommand = async (args: readonly string[]): Promise<AdminResult> =>
  executeAdminCommand(boundAdminService ?? createAdminService(), args);

/** Structural subset of the pinned Commander `Command` used by the host. */
export type OpenClawCommand = {
  command: (spec: string) => OpenClawCommand;
  description: (value: string) => OpenClawCommand;
  option: (flags: string, description?: string) => OpenClawCommand;
  action: (handler: (...args: unknown[]) => unknown) => OpenClawCommand;
};

/** Mirrors the pinned OpenClawPluginCliContext field shape. */
export type OpenClawCliContext = Readonly<{
  program: OpenClawCommand;
  parentPath: readonly string[];
  config: unknown;
  workspaceDir?: string;
  logger: unknown;
}>;

export type OpenClawCliRegistrar = (context: OpenClawCliContext) => void | Promise<void>;

export type OpenClawCliCommandDescriptor = {
  name: string;
  description: string;
  hasSubcommands: boolean;
};

export type OpenClawCliRegistrationOptions = Readonly<{
  parentPath?: string[];
  commands?: string[];
  descriptors?: OpenClawCliCommandDescriptor[];
}>;

const confirmedOption = (value: unknown): boolean => (
  typeof value === "object"
  && value !== null
  && "confirmLocal" in value
  && (value as { confirmLocal?: unknown }).confirmLocal === true
);

const stringOption = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
};

const registerAdminCommands = (context: OpenClawCliContext, service: AdminService): void => {
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
        : ["--password", stringOption(options, "password")!]),
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
};

export const createAdminCliRegistrar = (service: AdminService): OpenClawCliRegistrar => async (context) => {
  registerAdminCommands(context, service);
};
