import { describe, expect, it } from "vitest";

import type { GatewayCore } from "../src/core/gateway-core.js";
import type { AdminPanel } from "../src/admin/service.js";
import type { OpenClawCliRegistrationOptions, OpenClawCliRegistrar } from "../src/admin/cli.js";

type ActionHandler = (...args: readonly unknown[]) => unknown;

type CommandNode = {
  readonly name: string;
  readonly children: CommandNode[];
  readonly options: string[];
  descriptionText?: string;
  actionHandler?: ActionHandler;
  command: (spec: string) => CommandNode;
  description: (value: string) => CommandNode;
  option: (flags: string, description?: string) => CommandNode;
  action: (handler: ActionHandler) => CommandNode;
};

const commandName = (spec: string): string => spec.trim().split(/\s+/u)[0] ?? spec;

const createCommand = (name: string): CommandNode => {
  const command: CommandNode = {
    name,
    children: [],
    options: [],
    command: (spec) => {
      const child = createCommand(commandName(spec));
      command.children.push(child);
      return child;
    },
    description: (value) => {
      command.descriptionText = value;
      return command;
    },
    option: (flags) => {
      command.options.push(flags);
      return command;
    },
    action: (handler) => {
      command.actionHandler = handler;
      return command;
    },
  };
  return command;
};

const findCommand = (root: CommandNode, names: readonly string[]): CommandNode | undefined => {
  let current: CommandNode | undefined = root;
  for (const name of names) current = current?.children.find((child) => child.name === name);
  return current;
};

const fakeCore = (writes: { count: number }): GatewayCore => ({
  openGatewayAccount: async (accountId) => {
    writes.count += 1;
    return { accountId, close: () => undefined } as never;
  },
  handle: async () => {
    throw new Error("not used by admin service");
  },
  runSharedVectors: () => {
    throw new Error("not used by admin service");
  },
});

const fakeOpenClawApi = (core: GatewayCore, hostVersion = "2026.7.1") => {
  const channels: unknown[] = [];
  const httpRoutes: unknown[] = [];
  const adminPanels: unknown[] = [];
  const cliRegistrars: OpenClawCliRegistrar[] = [];
  const cliOptions: Array<OpenClawCliRegistrationOptions | undefined> = [];
  const gatewayMethods: string[] = [];
  return {
    version: "plugin-1.0.0",
    hostVersion,
    gatewayCore: core,
    channels,
    httpRoutes,
    adminPanels,
    cliRegistrars,
    cliOptions,
    gatewayMethods,
    registerChannel: (registration: unknown): void => { channels.push(registration); },
    registerHttpRoute: (route: unknown): void => { httpRoutes.push(route); },
    registerAdminPanel: (panel: unknown): void => { adminPanels.push(panel); },
    registerGatewayMethod: (name: string): void => { gatewayMethods.push(name); },
    registerCli: (
      registrar: OpenClawCliRegistrar,
      options?: OpenClawCliRegistrationOptions,
    ): void => {
      cliRegistrars.push(registrar);
      cliOptions.push(options);
    },
  };
};

const registeredAdmin = async (version?: string) => {
  const { registerOpenAndroidIntelligenceGateway } = await import("../src/host/channel-adapter.js");
  const writes = { count: 0 };
  const api = fakeOpenClawApi(fakeCore(writes), version);
  registerOpenAndroidIntelligenceGateway(api);
  const program = createCommand("openclaw");
  const registrar = api.cliRegistrars[0];
  if (registrar === undefined) throw new Error("CLI registrar was not captured");
  await registrar({
    program,
    parentPath: [],
    config: {},
    workspaceDir: "/tmp/open-android-intelligence-test",
    logger: {},
  });
  const panel = api.adminPanels[0] as AdminPanel | undefined;
  if (panel === undefined) throw new Error("local admin panel was not captured");
  return { api, writes, panel, program };
};

const invoke = async (command: CommandNode, ...args: readonly unknown[]) => {
  if (command.actionHandler === undefined) throw new Error(`missing action for ${command.name}`);
  return command.actionHandler(...args);
};

describe("OpenClaw Open Android Intelligence admin surfaces", () => {
  it("registers Commander account subcommands and gives UI and CLI the same AdminService semantics", async () => {
    const { api, writes, panel, program } = await registeredAdmin();
    expect(api.gatewayMethods).toEqual([]);
    expect(api.cliOptions[0]).toEqual({
      parentPath: [],
      commands: ["open-android-intelligence"],
      descriptors: [{
        name: "open-android-intelligence",
        description: "Manage Open Android Intelligence Gateway accounts",
        hasSubcommands: true,
      }],
    });

    const openAndroidIntelligence = findCommand(program, ["open-android-intelligence"]);
    const account = findCommand(program, ["open-android-intelligence", "account"]);
    const create = findCommand(program, ["open-android-intelligence", "account", "create"]);
    const status = findCommand(program, ["open-android-intelligence", "account", "status"]);
    const deleteAccount = findCommand(program, ["open-android-intelligence", "account", "delete"]);
    expect(openAndroidIntelligence?.descriptionText).toBe("Manage Open Android Intelligence Gateway accounts");
    expect(account).toBeDefined();
    expect(create?.options).toContain("--confirm-local");
    expect(status).toBeDefined();
    expect(deleteAccount?.options).toContain("--confirm-local");

    const input = Object.freeze({ accountId: "account-a", localConfirmation: true });
    const uiCreate = await panel.createAccount(input);
    const cliCreate = await invoke(create!, "account-a", { confirmLocal: true });
    expect(cliCreate).toEqual(uiCreate);
    expect(writes.count).toBe(2);

    const uiStatus = await panel.status();
    const cliStatus = await invoke(status!);
    expect(cliStatus).toEqual(uiStatus);

    const { runAdminCommand } = await import("../src/admin/cli.js");
    await expect(runAdminCommand(["account", "status"])).resolves.toEqual(uiStatus);
  });

  it("rejects account writes from both registered surfaces before local confirmation", async () => {
    const { writes, panel, program } = await registeredAdmin();
    const create = findCommand(program, ["open-android-intelligence", "account", "create"]);
    const deleteAccount = findCommand(program, ["open-android-intelligence", "account", "delete"]);

    await expect(panel.createAccount({ accountId: "account-a" })).resolves.toMatchObject({
      ok: false,
      error: { code: "LOCAL_CONFIRMATION_REQUIRED" },
    });
    await expect(invoke(create!, "account-a", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "LOCAL_CONFIRMATION_REQUIRED" },
    });
    await expect(panel.execute({ command: "account.delete", accountId: "account-a" })).resolves.toMatchObject({
      ok: false,
      error: { code: "LOCAL_CONFIRMATION_REQUIRED" },
    });
    await expect(invoke(deleteAccount!, "account-a", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "LOCAL_CONFIRMATION_REQUIRED" },
    });
    expect(writes.count).toBe(0);
  });

  it("keeps the registered panel and CLI read-only for an incompatible host", async () => {
    const { writes, panel, program } = await registeredAdmin("2026.8.0");
    const create = findCommand(program, ["open-android-intelligence", "account", "create"]);
    const status = findCommand(program, ["open-android-intelligence", "account", "status"]);

    expect(panel.readOnly).toBe(true);
    await expect(panel.createAccount({ accountId: "account-a", localConfirmation: true })).resolves.toMatchObject({
      ok: false,
      error: { code: "HOST_INCOMPATIBLE" },
      readOnly: true,
    });
    await expect(invoke(create!, "account-a", { confirmLocal: true })).resolves.toMatchObject({
      ok: false,
      error: { code: "HOST_INCOMPATIBLE" },
      readOnly: true,
    });
    await expect(invoke(status!)).resolves.toMatchObject({ ok: true, readOnly: true });
    expect(writes.count).toBe(0);
  });
});
