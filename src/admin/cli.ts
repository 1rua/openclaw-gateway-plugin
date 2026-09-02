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

const parseCommand = (args: readonly string[], service: AdminService): AdminCommand | AdminResult => {
  const [first, second, third, ...rest] = args;
  if (first === "account" && second === "create" && third !== undefined) {
    const localConfirmation = rest.length === 1 && rest[0] === "--confirm-local";
    if (rest.length > 1 || (rest.length === 1 && !localConfirmation)) return invalidArguments(service);
    return {
      command: "account.create",
      input: { accountId: third, ...(localConfirmation ? { localConfirmation: true } : {}) },
    };
  }
  if (first === "create-account" && second !== undefined) {
    const localConfirmation = third === "--confirm-local" && rest.length === 0;
    if (third !== undefined && !localConfirmation) return invalidArguments(service);
    return {
      command: "account.create",
      input: { accountId: second, ...(localConfirmation ? { localConfirmation: true } : {}) },
    };
  }
  if (first === "status" && second === undefined && third === undefined) {
    return { command: "admin.status" };
  }
  if (first === "account" && second === "status" && third === undefined && rest.length === 0) {
    return { command: "admin.status" };
  }
  if (first === "account" && second === "delete" && third !== undefined) {
    const localConfirmation = rest.length === 1 && rest[0] === "--confirm-local";
    if (rest.length > 1 || (rest.length === 1 && !localConfirmation)) return invalidArguments(service);
    return { command: "account.delete", accountId: third, ...(localConfirmation ? { localConfirmation: true } : {}) };
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
    .action((accountId, options) => executeAdminCommand(service, [
      "account",
      "create",
      String(accountId),
      ...(confirmedOption(options) ? ["--confirm-local"] : []),
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
