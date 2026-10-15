import { createReadStream, readFileSync, statSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
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
// 仅用于正在传输的原件检测宿主文件变化，不进入消息版本或协议字段。
export const nativeHistoryStamp = (binding) => {
    const source = nativeTranscript(binding);
    if (source === undefined)
        return JSON.stringify([binding, null]);
    const stat = statSync(source.file, { bigint: true });
    return JSON.stringify([binding, source, ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)]);
};
/** The binding is produced exclusively by the verified SDK's session recorder. */
export const readNativeHistory = async (binding) => {
    const source = nativeTranscript(binding);
    if (source === undefined)
        return [];
    const rows = [];
    const lines = createInterface({ input: createReadStream(source.file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
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
        rows.push({ nativeId: `${source.sessionId}:${raw.id}`, sender: message.role, text,
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
