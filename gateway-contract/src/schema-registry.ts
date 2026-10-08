import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import canonicalize from "canonicalize";

import attachmentDocument from "../schemas/attachment.schema.json" with { type: "json" };
import commandCatalogDocument from "../schemas/command-catalog.schema.json" with { type: "json" };
import conversationDocument from "../schemas/conversation.schema.json" with { type: "json" };
import conversationSnapshotDocument from "../schemas/conversation-snapshot.schema.json" with { type: "json" };
import deviceRequestDocument from "../schemas/device-request.schema.json" with { type: "json" };
import envelopeDocument from "../schemas/envelope.schema.json" with { type: "json" };
import eventDocument from "../schemas/event.schema.json" with { type: "json" };
import negotiateDocument from "../schemas/negotiate.schema.json" with { type: "json" };
import sessionDocument from "../schemas/session.schema.json" with { type: "json" };

export type GatewaySchemaName =
  | "negotiate.request"
  | "negotiate.response"
  | "session.password"
  | "session.refresh"
  | "session.device"
  | "session.logout"
  | "session.unpair"
  | "session.pairing"
  | "session.pairingSummary"
  | "conversation.create"
  | "conversation.commandCatalog"
  | "conversation.generationCancel"
  | "conversation.mirrorSync"
  | "message.create"
  | "attachment.create"
  | "attachment.status"
  | "event"
  | "event.sessionRevokedPayload"
  | "event.pairingGrantChangedPayload"
  | "device.request"
  | "device.request.result"
  | "device.request.resultRequest"
  | "response.success"
  | "response.failure";

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

type SchemaObject = Record<string, unknown>;
type SchemaDocument = SchemaObject & {
  readonly $id: string;
  readonly $defs: Record<string, SchemaObject>;
};

const documentEntries = [
  ["envelope", envelopeDocument],
  ["negotiate", negotiateDocument],
  ["session", sessionDocument],
  ["conversation", conversationDocument],
  ["commandCatalog", commandCatalogDocument],
  ["conversationSnapshot", conversationSnapshotDocument],
  ["attachment", attachmentDocument],
  ["event", eventDocument],
  ["deviceRequest", deviceRequestDocument],
] as unknown as readonly (readonly [string, SchemaDocument])[];

const documents = documentEntries.map(([, document]) => document);

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;

const definitions: Record<GatewaySchemaName, readonly [SchemaDocument, string]> = {
  "negotiate.request": [negotiateDocument as SchemaDocument, "request"],
  "negotiate.response": [negotiateDocument as SchemaDocument, "response"],
  "session.password": [sessionDocument as SchemaDocument, "password"],
  "session.refresh": [sessionDocument as SchemaDocument, "refresh"],
  "session.device": [sessionDocument as SchemaDocument, "device"],
  "session.logout": [sessionDocument as SchemaDocument, "logout"],
  "session.unpair": [sessionDocument as SchemaDocument, "unpair"],
  "session.pairing": [sessionDocument as SchemaDocument, "pairing"],
  "session.pairingSummary": [sessionDocument as SchemaDocument, "pairingSummary"],
  "conversation.create": [conversationDocument as SchemaDocument, "create"],
  // The catalog and mirror-sync request shapes live in conversation.schema.json.
  // command-catalog.schema.json and conversation-snapshot.schema.json describe the
  // discovery response and the snapshot response, which are not GatewaySchemaName
  // targets here; mapping them by name made this registry reject the very vectors
  // the contract fixtures declare valid.
  "conversation.commandCatalog": [conversationDocument as SchemaDocument, "commandCatalog"],
  "conversation.generationCancel": [conversationDocument as SchemaDocument, "generationCancel"],
  "conversation.mirrorSync": [conversationDocument as SchemaDocument, "mirrorSync"],
  "message.create": [conversationDocument as SchemaDocument, "messageCreate"],
  "attachment.create": [attachmentDocument as SchemaDocument, "create"],
  "attachment.status": [attachmentDocument as SchemaDocument, "status"],
  event: [eventDocument as SchemaDocument, "event"],
  "event.sessionRevokedPayload": [eventDocument as SchemaDocument, "sessionRevokedPayload"],
  "event.pairingGrantChangedPayload": [
    eventDocument as SchemaDocument,
    "pairingGrantChangedPayload",
  ],
  "device.request": [deviceRequestDocument as SchemaDocument, "request"],
  "device.request.result": [deviceRequestDocument as SchemaDocument, "result"],
  "device.request.resultRequest": [deviceRequestDocument as SchemaDocument, "resultRequest"],
  "response.success": [envelopeDocument as SchemaDocument, "success"],
  "response.failure": [envelopeDocument as SchemaDocument, "failure"],
};

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
});
addFormats(ajv);
for (const document of documents) ajv.addSchema(document);

const schemaRef = ([document, definition]: readonly [SchemaDocument, string]): string =>
  `${document.$id}#/$defs/${definition}`;

const documentPrefixById = new Map(
  documentEntries.map(([prefix, document]) => [document.$id, prefix]),
);

const bundledDefinitionName = (documentId: string, definition: string): string => {
  const prefix = documentPrefixById.get(documentId);
  if (prefix === undefined) throw new Error(`SCHEMA_DOCUMENT_NOT_REGISTERED:${documentId}`);
  return `${prefix}__${definition}`;
};

const localizeRef = (ref: string, currentDocument: SchemaDocument): string => {
  const localPrefix = "#/$defs/";
  if (ref.startsWith(localPrefix)) {
    return `#/$defs/${bundledDefinitionName(currentDocument.$id, ref.slice(localPrefix.length))}`;
  }
  for (const document of documents) {
    const externalPrefix = `${document.$id}#/$defs/`;
    if (ref.startsWith(externalPrefix)) {
      return `#/$defs/${bundledDefinitionName(document.$id, ref.slice(externalPrefix.length))}`;
    }
  }
  return ref;
};

const localizeSchema = (value: unknown, currentDocument: SchemaDocument): unknown => {
  if (Array.isArray(value)) return value.map((item) => localizeSchema(item, currentDocument));
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "$ref" && typeof child === "string"
        ? localizeRef(child, currentDocument)
        : localizeSchema(child, currentDocument),
    ]),
  );
};

const bundledDefinitions = Object.fromEntries(
  documentEntries.flatMap(([prefix, document]) =>
    Object.entries(document.$defs).map(([definition, schema]) => [
      `${prefix}__${definition}`,
      localizeSchema(schema, document),
    ]),
  ),
) as Record<string, SchemaObject>;

const selfContainedSchema = ([document, definition]: readonly [SchemaDocument, string]): SchemaObject => {
  const root = localizeSchema(document.$defs[definition], document);
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new Error(`SCHEMA_NOT_REGISTERED:${document.$id}#/$defs/${definition}`);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...(root as SchemaObject),
    $defs: bundledDefinitions,
  };
};

const publicSchemas = new Map<GatewaySchemaName, SchemaObject>(
  (Object.entries(definitions) as [GatewaySchemaName, readonly [SchemaDocument, string]][]).map(
    ([name, target]) => [name, selfContainedSchema(target)],
  ),
);

const validators = new Map<GatewaySchemaName, ValidateFunction>(
  (Object.entries(definitions) as [GatewaySchemaName, readonly [SchemaDocument, string]][]).map(
    ([name, target]) => {
      const validate = ajv.getSchema(schemaRef(target));
      if (validate === undefined) throw new Error(`SCHEMA_NOT_REGISTERED:${name}`);
      return [name, validate];
    },
  ),
);

const normalizeAjvErrors = (
  errors: readonly ErrorObject[] | null | undefined,
): readonly string[] => {
  const diagnostics = new Set<string>();
  for (const error of errors ?? []) {
    const params = canonicalize(error.params) ?? "null";
    diagnostics.add(
      `${error.instancePath}\t${error.schemaPath}\t${error.keyword}\t${params}`,
    );
  }
  return Object.freeze(
    [...diagnostics].sort((left, right) =>
      Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")),
    ),
  );
};

const registeredDefinition = (name: GatewaySchemaName): SchemaObject => {
  const schema = publicSchemas.get(name);
  if (schema === undefined) throw new Error(`SCHEMA_NOT_REGISTERED:${name}`);
  return schema;
};

export const schemaFor = (name: GatewaySchemaName): object =>
  structuredClone(registeredDefinition(name));

export const validateGatewayValue = (
  name: GatewaySchemaName,
  value: unknown,
): ValidationResult => {
  const validate = validators.get(name);
  if (validate === undefined) throw new Error(`SCHEMA_NOT_REGISTERED:${String(name)}`);
  return validate(value)
    ? Object.freeze({ ok: true })
    : Object.freeze({ ok: false, errors: normalizeAjvErrors(validate.errors) });
};
