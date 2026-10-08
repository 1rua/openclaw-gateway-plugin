export const OPENCLAW_HOST_API = Object.freeze({
    minVersion: "2026.7.1",
    maxVersion: "2026.7.1",
    verifiedCommit: "0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c",
});
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const EXPOSURE_MODES = Object.freeze([
    "host-route",
    "loopback-reverse-proxy",
    "direct-tls",
]);
const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;
const parseVersion = (value) => {
    if (typeof value !== "string")
        return undefined;
    const match = versionPattern.exec(value);
    if (match === null)
        return undefined;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (![major, minor, patch].every(Number.isSafeInteger))
        return undefined;
    const suffix = match[4] ?? "";
    return Object.freeze({
        major,
        minor,
        patch,
        // OpenClaw correction tags such as 2026.7.1-2 carry the same API
        // surface as the base 2026.7.1 runtime package.
        suffix: /^\d+$/u.test(suffix) ? "" : suffix,
    });
};
const compareParsedVersions = (left, right) => {
    for (const key of ["major", "minor", "patch"]) {
        if (left[key] !== right[key])
            return left[key] - right[key];
    }
    if (left.suffix === right.suffix)
        return 0;
    if (left.suffix.length === 0)
        return 1;
    if (right.suffix.length === 0)
        return -1;
    return left.suffix < right.suffix ? -1 : 1;
};
const compareVersions = (left, right) => {
    const parsedLeft = parseVersion(left);
    const parsedRight = parseVersion(right);
    if (parsedLeft === undefined || parsedRight === undefined)
        return Number.NaN;
    return compareParsedVersions(parsedLeft, parsedRight);
};
const validHostApiRange = (hostApi) => {
    if (!/^[0-9a-f]{40}$/iu.test(hostApi.verifiedCommit))
        return false;
    const minimum = parseVersion(hostApi.minVersion);
    const maximum = parseVersion(hostApi.maxVersion);
    return minimum !== undefined
        && maximum !== undefined
        && compareParsedVersions(minimum, maximum) <= 0;
};
export const isHostApiCompatible = (hostVersion, hostApi = OPENCLAW_HOST_API) => {
    if (hostVersion === undefined || !validHostApiRange(hostApi))
        return false;
    const minimum = compareVersions(hostVersion, hostApi.minVersion);
    const maximum = compareVersions(hostVersion, hostApi.maxVersion);
    return Number.isFinite(minimum) && Number.isFinite(maximum) && minimum >= 0 && maximum <= 0;
};
/**
 * Wire error code to HTTP status. Codes absent from this map are caller errors
 * and answer 400, the contract's default for malformed input.
 */
const ERROR_STATUS = Object.freeze({
    HOST_INCOMPATIBLE: 503,
    AUTHENTICATION_REQUIRED: 401,
    AUTHENTICATION_FAILED: 401,
    REFRESH_REUSED: 401,
    SESSION_EXPIRED: 401,
    SESSION_REVOKED: 401,
    SIGNATURE_INVALID: 401,
    NON_CANONICAL_TARGET: 401,
    REQUEST_REPLAYED: 401,
    CLOCK_SKEWED: 401,
    ACCOUNT_NOT_FOUND: 404,
    ATTACHMENT_EXPIRED: 410,
    ATTACHMENT_DIGEST_MISMATCH: 400,
    PROTOCOL_INCOMPATIBLE: 406,
    IDEMPOTENCY_CONFLICT: 409,
    CURSOR_CONFLICT: 409,
    CURSOR_EXPIRED: 410,
    REQUEST_BODY_TOO_LARGE: 413,
    ATTACHMENT_STORAGE_UNAVAILABLE: 507,
    RATE_LIMITED: 429,
});
const errorStatus = (response) => {
    const code = response.error?.code;
    if (code !== undefined && ERROR_STATUS[code] !== undefined)
        return ERROR_STATUS[code];
    if (response.error !== undefined)
        return 400;
    return 200;
};
/**
 * Endpoints contract §4/§5 run *before* authentication. They carry no verified
 * identity, so they never reach the verifier and never receive one.
 *
 * `DELETE /sessions/current` is also the one route whose request signature is
 * waived (Wave 0 ruling D4): `Timestamp`, `Nonce`, `Signature`, `Request-Id`
 * and `Idempotency-Key` are exempt, `Authorization` plus the five identity
 * headers are kept. The waiver is this per-route entry and nothing else — it is
 * never generalised by method or by path prefix. `DELETE /pairings/current` is
 * deliberately absent: destroying a pairing needs the full nine-header
 * signature, so it stays behind the verifier like every other authenticated
 * route.
 */
const PRE_AUTH_PATHS = new Set([
    "/open-android-intelligence/v2/negotiate",
    "/open-android-intelligence/v2/sessions/invite/challenge",
    "/open-android-intelligence/v2/sessions/invite/exchange", "/open-android-intelligence/v2/pairings/exchange", "/open-android-intelligence/v2/sessions/device/challenge", "/open-android-intelligence/v2/sessions/device",
    "/open-android-intelligence/v2/sessions/password",
    "/open-android-intelligence/v2/sessions/refresh",
    "/open-android-intelligence/v2/sessions/current",
]);
const isPreAuthRequest = (method, target) => {
    const path = target.split("?")[0] ?? target;
    if (!PRE_AUTH_PATHS.has(path))
        return false;
    return path === "/open-android-intelligence/v2/sessions/current" ? method === "DELETE" : method === "POST";
};
const flattenedHeaders = (headers) => {
    const flattened = {};
    for (const [name, value] of Object.entries(headers)) {
        const single = headerValue(value);
        if (single !== undefined)
            flattened[name.toLowerCase()] = single;
    }
    return Object.freeze(flattened);
};
/** Parses a pre-auth JSON body; anything unparseable is a caller error. */
const decodePreAuthBody = (body, headers) => {
    if (body.byteLength === 0)
        return undefined;
    const contentType = String(headerValue(headers["content-type"]) ?? "").split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json")
        return body;
    try {
        return JSON.parse(Buffer.from(body).toString("utf8"));
    }
    catch {
        throw new Error("SCHEMA_INVALID");
    }
};
const responseIdentity = (request) => {
    // A pre-auth request has no verified identity yet; naming one would claim an
    // authentication that never happened.
    const context = request.verifiedRequest?.context;
    return {
        requestId: context?.requestId ?? "open-android-intelligence-route",
        correlationId: context?.correlationId ?? "open-android-intelligence-route",
    };
};
const failureResponse = (request, code, details = {}) => {
    const identity = responseIdentity(request);
    return Object.freeze({
        requestId: identity.requestId,
        correlationId: identity.correlationId,
        protocol: "2.1",
        error: Object.freeze({
            code,
            message: code,
            retryable: false,
            retryAfterSeconds: null,
            details,
        }),
    });
};
const toVerifiedRequest = (routePath, request) => {
    if (request.verifiedRequest !== undefined)
        return request.verifiedRequest;
    if (request.context === undefined)
        return undefined;
    // `PATCH` is the conversation title update (contract section 7); every other
    // verb stays out of the verified-request seam.
    if (request.method !== "GET"
        && request.method !== "POST"
        && request.method !== "PUT"
        && request.method !== "DELETE"
        && request.method !== "PATCH") {
        return undefined;
    }
    return Object.freeze({
        context: request.context,
        method: request.method,
        target: request.target ?? routePath,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
        ...(request.lastEventId === undefined ? {} : { lastEventId: request.lastEventId }),
        ...(request.now === undefined ? {} : { now: request.now }),
    });
};
const responseHeaders = Object.freeze({
    "content-type": "application/json; charset=utf-8",
});
const cursorExpiredDetails = Object.freeze({
    recoverableResources: Object.freeze(["conversations", "attachments", "device-requests"]),
});
const maxBodyBytes = (value) => (value === undefined || !Number.isSafeInteger(value) || value < 0
    ? DEFAULT_MAX_BODY_BYTES
    : value);
const headerValue = (value) => (Array.isArray(value) ? value[0] : value);
const asBodyChunk = (value) => {
    if (typeof value === "string")
        return Buffer.from(value, "utf8");
    if (value instanceof Uint8Array)
        return value;
    throw new Error("REQUEST_BODY_INVALID");
};
const readRequestBody = async (request, limit) => {
    const contentLength = headerValue(request.headers["content-length"]);
    if (contentLength !== undefined) {
        const declaredLength = Number(contentLength);
        if (!Number.isSafeInteger(declaredLength) || declaredLength < 0)
            throw new Error("REQUEST_BODY_INVALID");
        if (declaredLength > limit)
            throw new Error("REQUEST_BODY_TOO_LARGE");
    }
    const chunks = [];
    let length = 0;
    for await (const value of request) {
        const chunk = asBodyChunk(value);
        length += chunk.byteLength;
        if (length > limit)
            throw new Error("REQUEST_BODY_TOO_LARGE");
        chunks.push(chunk);
    }
    if (chunks.length === 0)
        return new Uint8Array();
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
};
const rawHeaderValues = (rawHeaders, wanted) => {
    const values = [];
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
        if (rawHeaders[index].toLowerCase() === wanted)
            values.push(rawHeaders[index + 1]);
    }
    return values;
};
const parseSingletonAttachmentHeaders = (request) => {
    const lengths = rawHeaderValues(request.rawHeaders, "content-length");
    const digests = rawHeaderValues(request.rawHeaders, "digest");
    if (lengths.length !== 1
        || digests.length !== 1
        || rawHeaderValues(request.rawHeaders, "content-encoding").length !== 0
        || rawHeaderValues(request.rawHeaders, "transfer-encoding").length !== 0
        || !/^(?:0|[1-9][0-9]*)$/u.test(lengths[0]))
        return undefined;
    const contentLength = Number(lengths[0]);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0)
        return undefined;
    const match = /^sha-256=([A-Za-z0-9+/]{43}=)$/u.exec(digests[0]);
    if (match === null)
        return undefined;
    const decoded = Buffer.from(match[1], "base64");
    if (decoded.byteLength !== 32 || decoded.toString("base64") !== match[1])
        return undefined;
    return Object.freeze({ contentLength, sha256: decoded.toString("hex") });
};
const writeSseChunk = async (response, chunk) => {
    if (response.write(chunk))
        return;
    await new Promise((resolve, reject) => {
        const onDrain = () => finish();
        const onClose = () => finish(new Error("SSE_CLIENT_DISCONNECTED"));
        const onError = (error) => finish(error);
        const finish = (error) => {
            response.removeListener("drain", onDrain);
            response.removeListener("close", onClose);
            response.removeListener("error", onError);
            if (error === undefined)
                resolve();
            else
                reject(error);
        };
        response.once("drain", onDrain);
        response.once("close", onClose);
        response.once("error", onError);
    });
};
const writeSseEvent = async (response, event) => {
    const data = JSON.stringify({
        correlationId: event.correlationId,
        occurredAt: event.occurredAt,
        payload: event.payload,
    });
    await writeSseChunk(response, `id: ${event.eventId}\nevent: ${event.eventType}\ndata: ${data}\n\n`);
};
const streamGatewayEvents = async (request, response, verifiedRequest, target, services) => {
    const cursor = new URL(`https://gateway.local${target}`).searchParams.get("cursor");
    const lastEventIds = rawHeaderValues(request.rawHeaders, "last-event-id");
    if (lastEventIds.length > 1)
        return rawFailureResponse({ verifiedRequest }, "SCHEMA_INVALID");
    if (lastEventIds.length === 1 && (cursor === null || lastEventIds[0] !== cursor)) {
        return rawFailureResponse({ verifiedRequest }, "CURSOR_CONFLICT");
    }
    let account;
    try {
        account = await services.core.openGatewayAccount(verifiedRequest.context.accountId);
        // Subscribe before replay: events committed during replay are either in the
        // snapshot or queued online, and event_sequence de-duplicates the overlap.
        const pending = new Map();
        let wake;
        let closed = false;
        const authorized = () => services.core.isEventSessionActive?.(verifiedRequest.context) === true;
        const unsubscribe = account.events.subscribe((event) => {
            if (!authorized()) {
                closed = true;
                wake?.();
                return;
            }
            pending.set(event.sequence, event);
            wake?.();
        });
        const close = () => {
            closed = true;
            wake?.();
        };
        request.once("aborted", close);
        response.once("close", close);
        const lifecycleTimer = setInterval(() => { if (!authorized())
            close(); }, 1_000);
        let registered = false;
        try {
            if (!authorized())
                return rawFailureResponse({ verifiedRequest }, "SESSION_REVOKED");
            services.core.setDeviceOnline?.(verifiedRequest.context, true);
            registered = true;
            const replay = account.events.readAfterWithSequence(cursor);
            let sequence = account.events.sequenceAfter(cursor);
            response.statusCode = 200;
            response.setHeader("content-type", "text/event-stream; charset=utf-8");
            response.setHeader("cache-control", "no-cache, no-transform");
            response.setHeader("connection", "keep-alive");
            response.setHeader("x-accel-buffering", "no");
            response.flushHeaders?.();
            for (const event of replay) {
                if (closed || !authorized())
                    break;
                await writeSseEvent(response, event);
                sequence = event.sequence;
                pending.delete(event.sequence);
            }
            while (!closed && !response.destroyed && !response.writableEnded) {
                if (!authorized())
                    break;
                const next = [...pending.values()].sort((left, right) => left.sequence - right.sequence);
                const deliver = next.find((event) => event.sequence > sequence);
                if (deliver !== undefined) {
                    pending.delete(deliver.sequence);
                    await writeSseEvent(response, deliver);
                    sequence = deliver.sequence;
                    continue;
                }
                const heartbeat = await new Promise((resolve) => {
                    let finished = false;
                    const finish = (timedOut) => {
                        if (finished)
                            return;
                        finished = true;
                        clearTimeout(timer);
                        wake = undefined;
                        resolve(timedOut);
                    };
                    const timer = setTimeout(() => finish(true), 15_000);
                    wake = () => finish(false);
                    if (closed || pending.size > 0)
                        finish(false);
                });
                if (closed || !authorized())
                    break;
                if (heartbeat)
                    await writeSseChunk(response, ": ping\n\n");
            }
            return null;
        }
        finally {
            if (registered)
                services.core.setDeviceOnline?.(verifiedRequest.context, false);
            clearInterval(lifecycleTimer);
            unsubscribe();
            request.removeListener("aborted", close);
            response.removeListener("close", close);
            if (response.headersSent && !response.destroyed && !response.writableEnded)
                response.end();
        }
    }
    catch (error) {
        if (response.headersSent)
            return null;
        const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
        if (code === "CURSOR_EXPIRED")
            return rawFailureResponse({ verifiedRequest }, code, cursorExpiredDetails);
        return rawFailureResponse({ verifiedRequest }, code === "ATTACHMENT_STORAGE_UNAVAILABLE" ? code : "INTERNAL_ERROR");
    }
    finally {
        account?.close();
    }
};
const rawRequestTarget = (request) => {
    const target = request.url;
    return typeof target === "string" && target.startsWith("/") ? target : undefined;
};
const rawRequestMethod = (request) => {
    if (request.method === "GET"
        || request.method === "POST"
        || request.method === "PUT"
        || request.method === "DELETE"
        || request.method === "PATCH") {
        return request.method;
    }
    return undefined;
};
const incompatibleResponse = (request, services) => Object.freeze({
    statusCode: 503,
    headers: responseHeaders,
    body: failureResponse(request, "HOST_INCOMPATIBLE", Object.freeze({
        hostVersion: services.hostVersion ?? null,
        minVersion: services.hostApi.minVersion,
        maxVersion: services.hostApi.maxVersion,
        verifiedCommit: services.hostApi.verifiedCommit,
    })),
});
const authenticationRequiredResponse = (request) => Object.freeze({
    statusCode: 401,
    headers: responseHeaders,
    body: failureResponse(request, "AUTHENTICATION_REQUIRED"),
});
const rawFailureResponse = (request, code, details = {}) => {
    const body = failureResponse(request, code, details);
    return Object.freeze({ statusCode: errorStatus(body), headers: responseHeaders, body });
};
const routeErrorCode = (error) => {
    const code = error instanceof Error ? error.message : "";
    return code === "ATTACHMENT_STORAGE_UNAVAILABLE"
        || code === "ATTACHMENT_DIGEST_MISMATCH"
        || code === "ATTACHMENT_EXPIRED"
        || code === "SCHEMA_INVALID"
        || code === "CURSOR_EXPIRED"
        || code === "CURSOR_CONFLICT"
        || code === "OUTCOME_UNKNOWN"
        ? code
        : "INTERNAL_ERROR";
};
const createRoute = (routePath, match, services) => {
    const handle = async (request) => {
        if (!isHostApiCompatible(services.hostVersion, services.hostApi))
            return incompatibleResponse(request, services);
        const verifiedRequest = toVerifiedRequest(routePath, request);
        if (verifiedRequest === undefined)
            return authenticationRequiredResponse(request);
        const body = await services.core.handle(verifiedRequest);
        return Object.freeze({
            statusCode: errorStatus(body),
            headers: responseHeaders,
            body,
        });
    };
    const handleRaw = async (request, response) => {
        const emptyRequest = {};
        if (!isHostApiCompatible(services.hostVersion, services.hostApi))
            return incompatibleResponse(emptyRequest, services);
        const method = rawRequestMethod(request);
        const target = rawRequestTarget(request);
        if (method === undefined || target === undefined)
            return authenticationRequiredResponse(emptyRequest);
        const attachmentContentMatch = method === "PUT"
            ? target.split("?")[0].match(/^\/open-android-intelligence\/v2\/attachments\/([^/]+)\/content$/)
            : undefined;
        if (attachmentContentMatch?.[1] !== undefined) {
            const headers = parseSingletonAttachmentHeaders(request);
            if (headers === undefined)
                return rawFailureResponse(emptyRequest, "SCHEMA_INVALID");
            if (services.verifyRequest === undefined)
                return authenticationRequiredResponse(emptyRequest);
            let verified;
            try {
                verified = await services.verifyRequest({
                    request,
                    req: request,
                    method,
                    target,
                    headers: Object.freeze({ ...request.headers }),
                    rawHeaders: Object.freeze([...request.rawHeaders]),
                    body: new Uint8Array(),
                    declaredBodyDigestHex: headers.sha256,
                });
            }
            catch {
                verified = undefined;
            }
            if (verified === undefined)
                return authenticationRequiredResponse(emptyRequest);
            if (services.core.uploadAttachmentContent === undefined)
                return rawFailureResponse(emptyRequest, "HOST_INCOMPATIBLE");
            try {
                const response = await services.core.uploadAttachmentContent(verified, request, headers);
                if (response.error !== undefined) {
                    console.warn(`[open_android] Attachment stream rejected: code=${response.error.code}`);
                }
                return Object.freeze({ statusCode: errorStatus(response), headers: responseHeaders, body: response });
            }
            catch (error) {
                const code = routeErrorCode(error);
                console.warn(`[open_android] Attachment stream route failed: code=${code}`);
                return rawFailureResponse(emptyRequest, code);
            }
        }
        let body;
        try {
            body = await readRequestBody(request, services.maxBodyBytes);
        }
        catch (error) {
            const code = error instanceof Error ? error.message : "REQUEST_BODY_INVALID";
            return rawFailureResponse(emptyRequest, code === "REQUEST_BODY_TOO_LARGE" ? code : "REQUEST_BODY_INVALID");
        }
        let verifiedRequest;
        if (isPreAuthRequest(method, target)) {
            // No verifier is involved: these endpoints exist to establish the session
            // the verifier will later require.
            let preAuthBody;
            try {
                preAuthBody = decodePreAuthBody(body, request.headers);
            }
            catch (error) {
                return rawFailureResponse(emptyRequest, error instanceof Error ? error.message : "SCHEMA_INVALID");
            }
            verifiedRequest = Object.freeze({
                method,
                target,
                ...(preAuthBody === undefined ? {} : { body: preAuthBody }),
                headers: flattenedHeaders(request.headers),
                ...(request.socket?.remoteAddress === undefined ? {} : { remoteAddress: request.socket.remoteAddress }),
            });
        }
        else {
            if (services.verifyRequest === undefined)
                return authenticationRequiredResponse(emptyRequest);
            try {
                verifiedRequest = await services.verifyRequest({
                    request,
                    req: request,
                    method,
                    target,
                    headers: Object.freeze({ ...request.headers }),
                    rawHeaders: Object.freeze([...request.rawHeaders]),
                    body,
                });
            }
            catch {
                verifiedRequest = undefined;
            }
            if (verifiedRequest === undefined)
                return authenticationRequiredResponse(emptyRequest);
        }
        const eventsRoute = method === "GET" && target.split("?")[0] === "/open-android-intelligence/v2/events";
        const accept = String(headerValue(request.headers["accept"]) ?? "").toLowerCase();
        if (eventsRoute && accept.split(",").some((value) => value.trim().startsWith("text/event-stream"))) {
            return await streamGatewayEvents(request, response, verifiedRequest, target, services);
        }
        const coreResponse = await services.core.handle(verifiedRequest);
        return Object.freeze({
            statusCode: errorStatus(coreResponse),
            headers: responseHeaders,
            body: coreResponse,
        });
    };
    return Object.freeze({
        path: routePath,
        auth: "plugin",
        match,
        handle,
        handler: async (request, response) => {
            let result;
            try {
                const rawResult = await handleRaw(request, response);
                if (rawResult === null)
                    return true;
                result = rawResult;
            }
            catch (error) {
                const code = routeErrorCode(error);
                console.warn(`[open_android] Gateway route failed: code=${code}`);
                result = rawFailureResponse({}, code);
            }
            response.statusCode = result.statusCode;
            for (const [name, value] of Object.entries(result.headers))
                response.setHeader(name, value);
            response.end(JSON.stringify(result.body));
            return true;
        },
    });
};
const routeDefinitions = Object.freeze([
    Object.freeze({ path: "/open-android-intelligence/v2/negotiate", match: "exact" }),
    Object.freeze({ path: "/open-android-intelligence/v2/sessions/invite/challenge", match: "exact" }),
    Object.freeze({ path: "/open-android-intelligence/v2/sessions/invite/exchange", match: "exact" }),
    Object.freeze({ path: "/open-android-intelligence/v2/pairings/exchange", match: "exact" }),
    Object.freeze({ path: "/open-android-intelligence/v2/sessions/device/challenge", match: "exact" }),
    Object.freeze({ path: "/open-android-intelligence/v2/sessions/device", match: "exact" }),
    Object.freeze({ path: "/open-android-intelligence/v2/sessions/password", match: "exact" }),
    Object.freeze({ path: "/open-android-intelligence/v2/sessions/refresh", match: "exact" }),
    Object.freeze({ path: "/open-android-intelligence/v2/sessions/current", match: "exact" }),
    // 解除配对 (contract §5.6, D1). Authenticated like every other /v2 route: it
    // is not in `PRE_AUTH_PATHS`, so it reaches the host verifier's full §6.1
    // nine-header signature check instead of the logout route's waiver.
    Object.freeze({ path: "/open-android-intelligence/v2/pairings/current", match: "exact" }),
    Object.freeze({ path: "/open-android-intelligence/v2/pairings/current/", match: "prefix" }),
    Object.freeze({ path: "/open-android-intelligence/v2/sync/snapshot", match: "exact" }),
    Object.freeze({ path: "/open-android-intelligence/v2/commands", match: "exact" }),
    Object.freeze({ path: "/open-android-intelligence/v2/events", match: "exact" }),
    Object.freeze({ path: "/open-android-intelligence/v2/conversations", match: "exact" }),
    Object.freeze({ path: "/open-android-intelligence/v2/conversations/", match: "prefix" }),
    Object.freeze({ path: "/open-android-intelligence/v2/attachments", match: "exact" }),
    Object.freeze({ path: "/open-android-intelligence/v2/attachments/", match: "prefix" }),
    Object.freeze({ path: "/open-android-intelligence/v2/device-requests/", match: "prefix" }),
]);
export const createGatewayRoutes = (services) => {
    const hostApi = services.hostApi ?? OPENCLAW_HOST_API;
    const resolvedServices = {
        core: services.core,
        hostVersion: services.hostVersion,
        hostApi,
        verifyRequest: services.verifyRequest,
        maxBodyBytes: maxBodyBytes(services.maxBodyBytes),
    };
    return Object.freeze(routeDefinitions.map(({ path, match }) => createRoute(path, match, resolvedServices)));
};
export const gatewayRoutes = createGatewayRoutes;
export const createGatewayExposure = (mode, services) => {
    if (!EXPOSURE_MODES.includes(mode))
        throw new Error("EXPOSURE_MODE_INVALID");
    const routes = createGatewayRoutes(services);
    const listener = mode === "host-route"
        ? Object.freeze({ kind: "host-route", ownedBy: "openclaw-gateway", active: true })
        : mode === "loopback-reverse-proxy"
            ? Object.freeze({ kind: "loopback", bind: "127.0.0.1", tlsTerminatedBy: "user-configured-reverse-proxy", active: false })
            : Object.freeze({ kind: "direct-tls", bind: "127.0.0.1", requiresExplicitCertificate: true, active: false });
    return Object.freeze({
        mode,
        routes,
        listener,
        admin: Object.freeze({ localOnly: true, remotePort: null }),
    });
};
