import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { Ajv2020, } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { validateGatewayValue, } from "./schema-registry.js";
const addFormats = addFormatsImport;
const schemaDigestPattern = /^sha256:[0-9a-f]{64}$/;
const forbiddenSchemaKeywords = new Set([
    "additionalItems",
    "contains",
    "contentSchema",
    "dependencies",
    "dependentSchemas",
    "if",
    "not",
    "patternProperties",
    "prefixItems",
    "propertyNames",
    "then",
    "else",
    "unevaluatedItems",
    "unevaluatedProperties",
    "$dynamicAnchor",
    "$dynamicRef",
    "$recursiveAnchor",
    "$recursiveRef",
]);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};
const exactKeys = (value, expected) => {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return (actual.length === sortedExpected.length &&
        actual.every((key, index) => key === sortedExpected[index]));
};
const requireNonEmptyString = (value, label) => {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`INVALID_${label}`);
    }
    return value;
};
const requireSchemaDigest = (value) => {
    if (typeof value !== "string" || !schemaDigestPattern.test(value)) {
        throw new Error("INVALID_SCHEMA_DIGEST");
    }
    return value;
};
const requireInteger = (value, label) => {
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`INVALID_${label}`);
    }
    return value;
};
const cloneForConstruction = (value) => {
    try {
        return structuredClone(value);
    }
    catch {
        throw new Error("INVALID_CONSTRUCTOR_INPUT");
    }
};
const deepFreeze = (value, seen = new WeakSet()) => {
    if (typeof value !== "object" || value === null)
        return value;
    const object = value;
    if (seen.has(object))
        return value;
    seen.add(object);
    for (const child of Object.values(value)) {
        deepFreeze(child, seen);
    }
    return Object.freeze(value);
};
const canonicalJson = (value) => {
    let result;
    try {
        result = canonicalize(value);
    }
    catch {
        throw new Error("JCS_CANONICALIZATION_FAILED");
    }
    if (result === undefined)
        throw new Error("JCS_CANONICALIZATION_FAILED");
    return result;
};
export const gatewaySubschemaSha256 = (schema) => {
    if (!isRecord(schema))
        throw new Error("SCHEMA_NOT_OBJECT");
    const bytes = Buffer.from(canonicalJson(schema), "utf8");
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
};
const logicalKeyString = (key) => canonicalJson(key);
const fullKeyString = (key, schemaSha256) => canonicalJson({ ...key, schemaSha256 });
const decodeJsonPointerToken = (token) => {
    if (/~(?![01])/.test(token))
        throw new Error("UNSUPPORTED_SCHEMA_REF");
    return token.replaceAll("~1", "/").replaceAll("~0", "~");
};
const resolveLocalSchemaRef = (root, ref) => {
    if (typeof ref !== "string" || !ref.startsWith("#/$defs/") || ref.length <= "#/$defs/".length) {
        throw new Error("UNSUPPORTED_SCHEMA_REF");
    }
    let current = root;
    for (const rawToken of ref.slice(2).split("/")) {
        const token = decodeJsonPointerToken(rawToken);
        if (!isRecord(current) || !hasOwn(current, token)) {
            throw new Error("UNRESOLVED_SCHEMA_REF");
        }
        current = current[token];
    }
    if (!isRecord(current))
        throw new Error("UNRESOLVED_SCHEMA_REF");
    return current;
};
const validateSchemaSubset = (root) => {
    if (hasOwn(root, "$ref") ||
        root.type !== "object" ||
        root.additionalProperties !== false) {
        throw new Error("INVALID_SCHEMA_ROOT");
    }
    const visited = new WeakSet();
    const visit = (node) => {
        if (!isRecord(node))
            throw new Error("INVALID_SCHEMA_NODE");
        if (visited.has(node))
            return;
        visited.add(node);
        for (const keyword of forbiddenSchemaKeywords) {
            if (hasOwn(node, keyword))
                throw new Error(`UNSUPPORTED_SCHEMA_KEYWORD:${keyword}`);
        }
        if (hasOwn(node, "$ref")) {
            visit(resolveLocalSchemaRef(root, node.$ref));
        }
        if (node.type === "object" || hasOwn(node, "properties")) {
            if (node.type !== "object" || node.additionalProperties !== false) {
                throw new Error("NON_CLOSED_SCHEMA_OBJECT");
            }
        }
        if (hasOwn(node, "additionalProperties") &&
            node.additionalProperties !== false &&
            typeof node.additionalProperties === "object" &&
            node.additionalProperties !== null) {
            throw new Error("UNSUPPORTED_SCHEMA_KEYWORD:additionalProperties");
        }
        if (hasOwn(node, "$defs")) {
            if (!isRecord(node.$defs))
                throw new Error("INVALID_SCHEMA_DEFS");
            for (const child of Object.values(node.$defs))
                visit(child);
        }
        if (hasOwn(node, "properties")) {
            if (!isRecord(node.properties))
                throw new Error("INVALID_SCHEMA_PROPERTIES");
            for (const child of Object.values(node.properties))
                visit(child);
        }
        if (hasOwn(node, "items")) {
            if (!isRecord(node.items))
                throw new Error("UNSUPPORTED_SCHEMA_ITEMS");
            visit(node.items);
        }
        for (const keyword of ["allOf", "anyOf", "oneOf"]) {
            if (!hasOwn(node, keyword))
                continue;
            if (!Array.isArray(node[keyword]))
                throw new Error(`INVALID_SCHEMA_${keyword}`);
            for (const child of node[keyword])
                visit(child);
        }
    };
    visit(root);
};
const normalizeLogicalKey = (value) => {
    if (!isRecord(value) || typeof value.kind !== "string") {
        throw new Error("INVALID_LOGICAL_KEY");
    }
    switch (value.kind) {
        case "event": {
            if (!exactKeys(value, ["kind", "eventType"]))
                throw new Error("INVALID_LOGICAL_KEY");
            return Object.freeze({
                kind: "event",
                eventType: requireNonEmptyString(value.eventType, "EVENT_TYPE"),
            });
        }
        case "device.request": {
            if (!exactKeys(value, [
                "kind",
                "pluginId",
                "authorKeyId",
                "capabilityId",
                "capabilityVersion",
            ])) {
                throw new Error("INVALID_LOGICAL_KEY");
            }
            return Object.freeze({
                kind: "device.request",
                pluginId: requireNonEmptyString(value.pluginId, "PLUGIN_ID"),
                authorKeyId: requireNonEmptyString(value.authorKeyId, "AUTHOR_KEY_ID"),
                capabilityId: requireNonEmptyString(value.capabilityId, "CAPABILITY_ID"),
                capabilityVersion: requireNonEmptyString(value.capabilityVersion, "CAPABILITY_VERSION"),
            });
        }
        case "response.success": {
            if (!exactKeys(value, ["kind", "operation", "status"])) {
                throw new Error("INVALID_LOGICAL_KEY");
            }
            return Object.freeze({
                kind: "response.success",
                operation: requireNonEmptyString(value.operation, "OPERATION"),
                status: requireInteger(value.status, "STATUS"),
            });
        }
        case "response.failure": {
            if (!exactKeys(value, ["kind", "errorCode"]))
                throw new Error("INVALID_LOGICAL_KEY");
            return Object.freeze({
                kind: "response.failure",
                errorCode: requireNonEmptyString(value.errorCode, "ERROR_CODE"),
            });
        }
        default:
            throw new Error("INVALID_LOGICAL_KEY");
    }
};
const normalizeFullKey = (value) => {
    if (!isRecord(value) || typeof value.kind !== "string") {
        throw new Error("INVALID_CATALOG_KEY");
    }
    switch (value.kind) {
        case "event":
            if (!exactKeys(value, ["kind", "eventType", "schemaSha256"])) {
                throw new Error("INVALID_CATALOG_KEY");
            }
            return Object.freeze({
                logical: normalizeLogicalKey({ kind: "event", eventType: value.eventType }),
                schemaSha256: requireSchemaDigest(value.schemaSha256),
            });
        case "device.request":
            if (!exactKeys(value, [
                "kind",
                "pluginId",
                "authorKeyId",
                "capabilityId",
                "capabilityVersion",
                "schemaSha256",
            ])) {
                throw new Error("INVALID_CATALOG_KEY");
            }
            return Object.freeze({
                logical: normalizeLogicalKey({
                    kind: "device.request",
                    pluginId: value.pluginId,
                    authorKeyId: value.authorKeyId,
                    capabilityId: value.capabilityId,
                    capabilityVersion: value.capabilityVersion,
                }),
                schemaSha256: requireSchemaDigest(value.schemaSha256),
            });
        case "response.success":
            if (!exactKeys(value, ["kind", "operation", "status", "schemaSha256"])) {
                throw new Error("INVALID_CATALOG_KEY");
            }
            return Object.freeze({
                logical: normalizeLogicalKey({
                    kind: "response.success",
                    operation: value.operation,
                    status: value.status,
                }),
                schemaSha256: requireSchemaDigest(value.schemaSha256),
            });
        case "response.failure":
            if (!exactKeys(value, ["kind", "errorCode", "schemaSha256"])) {
                throw new Error("INVALID_CATALOG_KEY");
            }
            return Object.freeze({
                logical: normalizeLogicalKey({ kind: "response.failure", errorCode: value.errorCode }),
                schemaSha256: requireSchemaDigest(value.schemaSha256),
            });
        default:
            throw new Error("INVALID_CATALOG_KEY");
    }
};
const normalizeBindingSet = (value) => {
    if (!isRecord(value) || !exactKeys(value, ["core", "device"])) {
        throw new Error("INVALID_BINDING_SET");
    }
    if (!Array.isArray(value.core) || !Array.isArray(value.device)) {
        throw new Error("INVALID_BINDING_SET");
    }
    const core = [];
    const device = [];
    const logicalKeys = new Set();
    const addBinding = (candidate, expectedKind) => {
        if (!isRecord(candidate))
            throw new Error("INVALID_BINDING");
        let logical;
        let schemaSha256;
        if (hasOwn(candidate, "key")) {
            if (!exactKeys(candidate, ["key", "schemaSha256"])) {
                throw new Error("INVALID_BINDING");
            }
            logical = normalizeLogicalKey(candidate.key);
            schemaSha256 = requireSchemaDigest(candidate.schemaSha256);
        }
        else {
            if (!hasOwn(candidate, "schemaSha256"))
                throw new Error("INVALID_BINDING");
            const { schemaSha256: candidateDigest, ...logicalCandidate } = candidate;
            logical = normalizeLogicalKey(logicalCandidate);
            schemaSha256 = requireSchemaDigest(candidateDigest);
        }
        if ((expectedKind === "core" && logical.kind === "device.request") ||
            (expectedKind === "device" && logical.kind !== "device.request")) {
            throw new Error("INVALID_BINDING_KIND");
        }
        const keyString = logicalKeyString(logical);
        if (logicalKeys.has(keyString))
            throw new Error("DUPLICATE_BINDING");
        logicalKeys.add(keyString);
        if (logical.kind === "device.request") {
            device.push(Object.freeze({ ...logical, schemaSha256 }));
        }
        else if (logical.kind === "event") {
            core.push(Object.freeze({ ...logical, schemaSha256 }));
        }
        else if (logical.kind === "response.success") {
            core.push(Object.freeze({ ...logical, schemaSha256 }));
        }
        else {
            core.push(Object.freeze({ ...logical, schemaSha256 }));
        }
    };
    for (const binding of value.core)
        addBinding(binding, "core");
    for (const binding of value.device)
        addBinding(binding, "device");
    return deepFreeze({ core, device });
};
const compileSchema = (schema) => {
    const ajv = new Ajv2020({
        strict: true,
        allErrors: true,
        coerceTypes: false,
        removeAdditional: false,
        useDefaults: false,
    });
    addFormats(ajv);
    try {
        return ajv.compile(schema);
    }
    catch (cause) {
        const message = cause instanceof Error ? cause.message : "unknown";
        throw new Error(`SCHEMA_COMPILE_FAILED:${message}`);
    }
};
const normalizeAjvErrors = (errors) => {
    const diagnostics = new Set();
    for (const error of errors ?? []) {
        diagnostics.add(`${error.instancePath}\t${error.schemaPath}\t${error.keyword}\t${canonicalJson(error.params)}`);
    }
    return Object.freeze([...diagnostics].sort((left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"))));
};
const failedResult = (errors) => Object.freeze({ ok: false, errors: Object.freeze([...errors]) });
const dispatchFailure = (reason, key) => {
    const params = key === undefined ? { reason } : { key, reason };
    return failedResult([`\t\tdispatch\t${canonicalJson(params)}`]);
};
const dispatchKindFor = (value) => {
    if (!isRecord(value) || typeof value.kind !== "string")
        return undefined;
    switch (value.kind) {
        case "event":
        case "device.request":
        case "response.success":
        case "response.failure":
            return value.kind;
        default:
            return undefined;
    }
};
const normalizeDispatch = (value) => {
    if (!isRecord(value) || typeof value.kind !== "string") {
        throw new Error("INVALID_DISPATCH");
    }
    switch (value.kind) {
        case "event":
            if (!exactKeys(value, ["kind", "eventType"]))
                throw new Error("INVALID_DISPATCH");
            return Object.freeze({
                kind: "event",
                eventType: requireNonEmptyString(value.eventType, "EVENT_TYPE"),
            });
        case "device.request":
            if (!exactKeys(value, ["kind"]))
                throw new Error("INVALID_DISPATCH");
            return Object.freeze({ kind: "device.request" });
        case "response.success":
            if (!exactKeys(value, ["kind", "operation", "status"])) {
                throw new Error("INVALID_DISPATCH");
            }
            return Object.freeze({
                kind: "response.success",
                operation: requireNonEmptyString(value.operation, "OPERATION"),
                status: requireInteger(value.status, "STATUS"),
            });
        case "response.failure":
            if (!exactKeys(value, ["kind"]))
                throw new Error("INVALID_DISPATCH");
            return Object.freeze({ kind: "response.failure" });
        default:
            throw new Error("INVALID_DISPATCH");
    }
};
const outerSchemaForKind = (kind) => {
    switch (kind) {
        case "event":
            return "event";
        case "device.request":
            return "device.request";
        case "response.success":
            return "response.success";
        case "response.failure":
            return "response.failure";
    }
};
const logicalKeyForDispatch = (dispatch, value) => {
    switch (dispatch.kind) {
        case "event":
            return Object.freeze({ kind: "event", eventType: dispatch.eventType });
        case "device.request": {
            if (!isRecord(value) || !isRecord(value.provider) || !isRecord(value.capability)) {
                throw new Error("INVALID_DEVICE_OUTER_VALUE");
            }
            return normalizeLogicalKey({
                kind: "device.request",
                pluginId: value.provider.pluginId,
                authorKeyId: value.provider.authorKeyId,
                capabilityId: value.capability.id,
                capabilityVersion: value.capability.version,
            });
        }
        case "response.success":
            return Object.freeze({
                kind: "response.success",
                operation: dispatch.operation,
                status: dispatch.status,
            });
        case "response.failure": {
            if (!isRecord(value) || !isRecord(value.error))
                throw new Error("INVALID_FAILURE_OUTER_VALUE");
            return normalizeLogicalKey({ kind: "response.failure", errorCode: value.error.code });
        }
    }
};
const dynamicValueFor = (dispatch, value) => {
    if (!isRecord(value))
        throw new Error("INVALID_OUTER_VALUE");
    switch (dispatch.kind) {
        case "event":
            return value.payload;
        case "device.request":
            return value.parameters;
        case "response.success":
            return value.data;
        case "response.failure":
            if (!isRecord(value.error))
                throw new Error("INVALID_FAILURE_OUTER_VALUE");
            return value.error.details;
    }
};
export const createGatewayDispatchedValidator = (entries, bindings) => {
    const clonedEntries = deepFreeze(cloneForConstruction(entries));
    if (!Array.isArray(clonedEntries))
        throw new Error("INVALID_CATALOG");
    const catalogByFullKey = new Map();
    const catalogLogicalKeys = new Set();
    for (const candidate of clonedEntries) {
        if (!isRecord(candidate) || !exactKeys(candidate, ["key", "schema"]) || !isRecord(candidate.schema)) {
            throw new Error("INVALID_CATALOG_ENTRY");
        }
        const key = normalizeFullKey(candidate.key);
        const logical = logicalKeyString(key.logical);
        if (catalogLogicalKeys.has(logical))
            throw new Error("DUPLICATE_CATALOG_LOGICAL_KEY");
        catalogLogicalKeys.add(logical);
        const schema = candidate.schema;
        validateSchemaSubset(schema);
        const computedDigest = gatewaySubschemaSha256(schema);
        if (computedDigest !== key.schemaSha256)
            throw new Error("SCHEMA_DIGEST_MISMATCH");
        const compiled = Object.freeze({
            validate: compileSchema(schema),
            schemaSha256: key.schemaSha256,
        });
        catalogByFullKey.set(fullKeyString(key.logical, key.schemaSha256), compiled);
    }
    const verifiedBindings = normalizeBindingSet(cloneForConstruction(bindings));
    const bindingByLogicalKey = new Map();
    for (const binding of [...verifiedBindings.core, ...verifiedBindings.device]) {
        const { schemaSha256, ...logicalCandidate } = binding;
        const logical = normalizeLogicalKey(logicalCandidate);
        const logicalString = logicalKeyString(logical);
        if (bindingByLogicalKey.has(logicalString))
            throw new Error("DUPLICATE_BINDING");
        if (!catalogByFullKey.has(fullKeyString(logical, schemaSha256))) {
            throw new Error("BINDING_CATALOG_MISMATCH");
        }
        bindingByLogicalKey.set(logicalString, schemaSha256);
    }
    const validate = (dispatch, value) => {
        try {
            const dispatchKind = dispatchKindFor(dispatch);
            if (dispatchKind === undefined)
                return dispatchFailure("invalid_dispatch");
            const outerResult = validateGatewayValue(outerSchemaForKind(dispatchKind), value);
            if (!outerResult.ok)
                return failedResult(outerResult.errors);
            const normalizedDispatch = normalizeDispatch(dispatch);
            const logical = logicalKeyForDispatch(normalizedDispatch, value);
            const logicalString = logicalKeyString(logical);
            const schemaSha256 = bindingByLogicalKey.get(logicalString);
            if (schemaSha256 === undefined)
                return dispatchFailure("binding_not_found", logical);
            const compiled = catalogByFullKey.get(fullKeyString(logical, schemaSha256));
            if (compiled === undefined)
                return dispatchFailure("catalog_entry_not_found", logical);
            if (compiled.validate(dynamicValueFor(normalizedDispatch, value))) {
                return Object.freeze({ ok: true });
            }
            return failedResult(normalizeAjvErrors(compiled.validate.errors));
        }
        catch {
            return dispatchFailure("validation_failed");
        }
    };
    return Object.freeze({ validate });
};
