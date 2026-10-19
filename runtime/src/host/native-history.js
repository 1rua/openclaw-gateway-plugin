import { createReadStream, readFileSync, statSync, openSync, fstatSync, closeSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
const nativeTranscript = (binding) => {
    const store = JSON.parse(readFileSync(binding.storePath, "utf8"));
    const entry = store[binding.sessionKey] ?? Object.entries(store).find(([key]) => key.toLowerCase() === binding.sessionKey.toLowerCase())?.[1];
    if (entry === undefined)
        return undefined;
    if (typeof entry.sessionId !== "string" || !/^[A-Za-z0-9._-]+$/.test(entry.sessionId))
        throw new Error("HOST_HISTORY_UNAVAILABLE");
    const base = dirname(binding.storePath);
    const file = resolve(base, typeof entry.sessionFile === "string" ? entry.sessionFile : `${entry.sessionId}.jsonl`);
    const within = relative(base, file);
    if (within.startsWith("..") || isAbsolute(within))
        throw new Error("HOST_HISTORY_UNAVAILABLE");
    return { sessionId: entry.sessionId, file };
};
const fileIdentity = (stat) => `${stat.dev}:${stat.ino}`;
/** Capture before signalling abort: no transcript reads or JSONL parsing. */
export const nativeHistoryWatermark = (binding) => {
    const source = nativeTranscript(binding);
    if (!source)
        return undefined;
    const stat = statSync(source.file, { bigint: true });
    return { sessionId: source.sessionId, fileId: fileIdentity(stat), byteLength: Number(stat.size) };
};
// 仅用于正在传输的原件检测宿主文件变化，不进入消息版本或协议字段。
export const nativeHistoryStamp = (binding) => {
    const source = nativeTranscript(binding);
    if (source === undefined)
        return JSON.stringify([binding, null]);
    const stat = statSync(source.file, { bigint: true });
    return JSON.stringify([binding, source, ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)]);
};
/** Keep exact UTF-8 byte offsets, including CRLF and a final unterminated line. */
async function* transcriptLines(file, fd) {
    let pending = Buffer.alloc(0), offset = 0;
    for await (const chunk of createReadStream(file, { fd })) {
        pending = Buffer.concat([pending, chunk]);
        let newline;
        while ((newline = pending.indexOf(10)) >= 0) {
            const bytes = pending.subarray(0, newline + 1);
            offset += bytes.length;
            yield { line: bytes.toString("utf8"), end: offset };
            pending = pending.subarray(newline + 1);
        }
    }
    if (pending.length)
        yield { line: pending.toString("utf8"), end: offset + pending.length };
}
/** The binding is produced exclusively by the verified SDK's session recorder. */
const readTranscript = async (source) => {
    const rows = [];
    const fd = openSync(source.file, "r");
    let fileId;
    try {
        fileId = fileIdentity(fstatSync(fd, { bigint: true }));
    }
    catch (error) {
        closeSync(fd);
        throw error;
    }
    for await (const { line, end: byteEnd } of transcriptLines(source.file, fd)) {
        if (!line.trim())
            continue;
        const raw = JSON.parse(line);
        if (raw.type !== "message" || typeof raw.id !== "string")
            continue;
        const message = raw.message;
        if (message?.role !== "user" && message?.role !== "assistant")
            continue;
        // Hidden reasoning/tool blocks are never exported as user-visible history.
        const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
            ? message.content.flatMap((part) => typeof part === "object" && part !== null &&
                part.type === "text" && typeof part.text === "string"
                ? [part.text] : []).join("") : "";
        const time = typeof message.timestamp === "number" ? message.timestamp : Date.parse(String(raw.timestamp));
        rows.push({ nativePosition: { fileId, byteEnd }, nativeId: `${source.sessionId}:${raw.id}`, sender: message.role, text,
            ...(raw.deleted === true || message.deleted === true ? { deleted: true } : {}),
            timestamp: Number.isFinite(time) ? time : rows.length + 1,
            ...(Array.isArray(message.content) ? { mediaPaths: message.content.flatMap((part) => {
                    const p = part;
                    const source = p?.source;
                    const url = typeof p?.path === "string" ? p.path : typeof source?.url === "string" ? source.url : "";
                    return url.startsWith("file://") || url.startsWith("/") ? [url] : [];
                }) } : {}),
            ...(typeof message.platform_message_id === "string" ? { clientMessageId: message.platform_message_id } : {}), });
    }
    return rows;
};
export const readNativeHistory = async (binding) => {
    const source = nativeTranscript(binding);
    return source ? readTranscript(source) : [];
};
/** Cancellation snapshots contain native identities, never duplicated message bodies. */
export const readNativeHistorySnapshot = async (binding) => {
    let source;
    try {
        source = nativeTranscript(binding);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return { messages: [] };
        throw error;
    }
    if (!source)
        return { messages: [] };
    try {
        return { sessionId: source.sessionId, messages: await readTranscript(source) };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return { sessionId: source.sessionId, messages: [] };
        throw error;
    }
};
/** The SDK's synchronous onAgentRunStart hook runs after native session admission.
 * Read identities only, so queued previous-run writes are included in the boundary. */
export const nativeAssistantSnapshot = (binding) => {
    let source = undefined;
    try {
        source = nativeTranscript(binding);
        if (!source)
            return { assistantIds: [] };
        const assistantIds = readFileSync(source.file, "utf8").split("\n").filter(line => line.trim()).flatMap(line => {
            const entry = JSON.parse(line);
            return entry.type === "message" && typeof entry.id === "string" && entry.message?.role === "assistant" ? [`${source.sessionId}:${entry.id}`] : [];
        });
        return { sessionId: source.sessionId, assistantIds };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return { sessionId: source?.sessionId, assistantIds: [] };
        throw error;
    }
};
/** Read lifecycle flags only from a server-created, account-bound SDK route. */
export const readNativeSessionState = (binding) => {
    let store;
    try {
        store = JSON.parse(readFileSync(binding.storePath, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw new Error("HOST_INCOMPATIBLE");
    }
    const entry = store[binding.sessionKey] ?? Object.entries(store).find(([key]) => key.toLowerCase() === binding.sessionKey.toLowerCase())?.[1];
    if (!entry)
        return undefined;
    const timestamp = typeof entry.updatedAt === "number" ? entry.updatedAt : undefined;
    return { archived: typeof entry.archivedAt === "number",
        ...(typeof entry.sessionId === "string" ? { sessionId: entry.sessionId } : {}),
        ...(typeof entry.lifecycleRevision === "string" ? { lifecycleRevision: entry.lifecycleRevision } : {}),
        ...(timestamp !== undefined && Number.isFinite(timestamp) ? { updatedAt: new Date(timestamp).toISOString(), nativeUpdatedAt: timestamp } : {}) };
};
