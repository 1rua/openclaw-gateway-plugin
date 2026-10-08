import { Ajv2020, } from "ajv/dist/2020.js";
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
];
const documents = documentEntries.map(([, document]) => document);
const addFormats = addFormatsImport;
const definitions = {
    "negotiate.request": [negotiateDocument, "request"],
    "negotiate.response": [negotiateDocument, "response"],
    "session.password": [sessionDocument, "password"],
    "session.refresh": [sessionDocument, "refresh"],
    "session.device": [sessionDocument, "device"],
    "session.logout": [sessionDocument, "logout"],
    "session.unpair": [sessionDocument, "unpair"],
    "session.pairing": [sessionDocument, "pairing"],
    "session.pairingSummary": [sessionDocument, "pairingSummary"],
    "conversation.create": [conversationDocument, "create"],
    // The catalog and mirror-sync request shapes live in conversation.schema.json.
    // command-catalog.schema.json and conversation-snapshot.schema.json describe the
    // discovery response and the snapshot response, which are not GatewaySchemaName
    // targets here; mapping them by name made this registry reject the very vectors
    // the contract fixtures declare valid.
    "conversation.commandCatalog": [conversationDocument, "commandCatalog"],
    "conversation.generationCancel": [conversationDocument, "generationCancel"],
    "conversation.mirrorSync": [conversationDocument, "mirrorSync"],
    "message.create": [conversationDocument, "messageCreate"],
    "attachment.create": [attachmentDocument, "create"],
    "attachment.status": [attachmentDocument, "status"],
    event: [eventDocument, "event"],
    "event.sessionRevokedPayload": [eventDocument, "sessionRevokedPayload"],
    "event.pairingGrantChangedPayload": [
        eventDocument,
        "pairingGrantChangedPayload",
    ],
    "device.request": [deviceRequestDocument, "request"],
    "device.request.result": [deviceRequestDocument, "result"],
    "device.request.resultRequest": [deviceRequestDocument, "resultRequest"],
    "response.success": [envelopeDocument, "success"],
    "response.failure": [envelopeDocument, "failure"],
};
const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
});
addFormats(ajv);
for (const document of documents)
    ajv.addSchema(document);
const schemaRef = ([document, definition]) => `${document.$id}#/$defs/${definition}`;
const documentPrefixById = new Map(documentEntries.map(([prefix, document]) => [document.$id, prefix]));
const bundledDefinitionName = (documentId, definition) => {
    const prefix = documentPrefixById.get(documentId);
    if (prefix === undefined)
        throw new Error(`SCHEMA_DOCUMENT_NOT_REGISTERED:${documentId}`);
    return `${prefix}__${definition}`;
};
const localizeRef = (ref, currentDocument) => {
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
const localizeSchema = (value, currentDocument) => {
    if (Array.isArray(value))
        return value.map((item) => localizeSchema(item, currentDocument));
    if (typeof value !== "object" || value === null)
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
        key,
        key === "$ref" && typeof child === "string"
            ? localizeRef(child, currentDocument)
            : localizeSchema(child, currentDocument),
    ]));
};
const bundledDefinitions = Object.fromEntries(documentEntries.flatMap(([prefix, document]) => Object.entries(document.$defs).map(([definition, schema]) => [
    `${prefix}__${definition}`,
    localizeSchema(schema, document),
])));
const selfContainedSchema = ([document, definition]) => {
    const root = localizeSchema(document.$defs[definition], document);
    if (typeof root !== "object" || root === null || Array.isArray(root)) {
        throw new Error(`SCHEMA_NOT_REGISTERED:${document.$id}#/$defs/${definition}`);
    }
    return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...root,
        $defs: bundledDefinitions,
    };
};
const publicSchemas = new Map(Object.entries(definitions).map(([name, target]) => [name, selfContainedSchema(target)]));
const validators = new Map(Object.entries(definitions).map(([name, target]) => {
    const validate = ajv.getSchema(schemaRef(target));
    if (validate === undefined)
        throw new Error(`SCHEMA_NOT_REGISTERED:${name}`);
    return [name, validate];
}));
const normalizeAjvErrors = (errors) => {
    const diagnostics = new Set();
    for (const error of errors ?? []) {
        const params = canonicalize(error.params) ?? "null";
        diagnostics.add(`${error.instancePath}\t${error.schemaPath}\t${error.keyword}\t${params}`);
    }
    return Object.freeze([...diagnostics].sort((left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"))));
};
const registeredDefinition = (name) => {
    const schema = publicSchemas.get(name);
    if (schema === undefined)
        throw new Error(`SCHEMA_NOT_REGISTERED:${name}`);
    return schema;
};
export const schemaFor = (name) => structuredClone(registeredDefinition(name));
export const validateGatewayValue = (name, value) => {
    const validate = validators.get(name);
    if (validate === undefined)
        throw new Error(`SCHEMA_NOT_REGISTERED:${String(name)}`);
    return validate(value)
        ? Object.freeze({ ok: true })
        : Object.freeze({ ok: false, errors: normalizeAjvErrors(validate.errors) });
};
