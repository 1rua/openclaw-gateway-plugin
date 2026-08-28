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
  if (first === "account" && second === "create" && third !== undefined && rest.length === 0) {
    return { command: "account.create", input: { accountId: third } };
  }
  if (first === "create-account" && second !== undefined && third === undefined) {
    return { command: "account.create", input: { accountId: second } };
  }
  if (first === "status" && second === undefined && third === undefined) {
    return { command: "admin.status" };
  }
  if (first === "account" && second === "status" && third === undefined) {
    return { command: "admin.status" };
  }
  if (first === "account" && second === "delete" && third !== undefined) {
    const localConfirmation = rest.length === 1 && rest[0] === "--confirm-local";
    if (rest.length > 1 || (rest.length === 1 && !localConfirmation)) return invalidArguments(service);
    return { command: "account.delete", accountId: third, ...(localConfirmation ? { localConfirmation: true } : {}) };
  }
  return invalidArguments(service);
};

export const runAdminCommand = async (args: readonly string[]): Promise<AdminResult> => {
  const service = boundAdminService ?? createAdminService();
  const command = parseCommand(args, service);
  if ("ok" in command) return command;
  return service.execute(command);
};

export type OpenClawCliContext = Readonly<{
  args?: readonly string[];
}>;

const isArgumentList = (value: OpenClawCliContext | readonly string[]): value is readonly string[] =>
  Array.isArray(value);

export const createAdminCliRegistrar = (service: AdminService) => async (
  context: OpenClawCliContext | readonly string[],
): Promise<AdminResult> => {
  const args = isArgumentList(context) ? context : context.args ?? [];
  const previous = boundAdminService;
  boundAdminService = service;
  try {
    return await runAdminCommand(args);
  } finally {
    boundAdminService = previous;
  }
};
