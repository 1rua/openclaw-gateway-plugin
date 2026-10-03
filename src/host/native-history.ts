import { createReadStream, readFileSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { createInterface } from "node:readline";

export type NativeHistoryMessage = Readonly<{
  nativeId: string; sender: "user" | "assistant"; text: string; timestamp: number;
  clientMessageId?: string; deleted?: boolean; mediaPaths?: readonly string[];
}>;

/** The binding is produced exclusively by the verified SDK's session recorder. */
export const readNativeHistory = async (binding: Readonly<{ storePath: string; sessionKey: string }>): Promise<NativeHistoryMessage[]> => {
  const store = JSON.parse(readFileSync(binding.storePath, "utf8")) as Record<string, Record<string, unknown>>;
  const entry = store[binding.sessionKey] ?? Object.entries(store).find(([key]) => key.toLowerCase() === binding.sessionKey.toLowerCase())?.[1];
  if (entry === undefined) return [];
  if (typeof entry.sessionId !== "string" || !/^[A-Za-z0-9._-]+$/.test(entry.sessionId)) throw new Error("HOST_HISTORY_UNAVAILABLE");
  const base = dirname(binding.storePath);
  const file = resolve(base, typeof entry.sessionFile === "string" ? entry.sessionFile : `${entry.sessionId}.jsonl`);
  const within = relative(base, file);
  if (within.startsWith("..") || isAbsolute(within)) throw new Error("HOST_HISTORY_UNAVAILABLE");
  const rows: NativeHistoryMessage[] = [];
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (raw.type !== "message" || typeof raw.id !== "string") continue;
    const message = raw.message as Record<string, unknown> | undefined;
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    // Hidden reasoning/tool blocks are never exported as user-visible history.
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.flatMap((part: unknown) => typeof part === "object" && part !== null &&
          (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string"
          ? [(part as Record<string, unknown>).text as string] : []).join("") : "";
    const time = typeof message.timestamp === "number" ? message.timestamp : Date.parse(String(raw.timestamp));
    rows.push({ nativeId: `${entry.sessionId}:${raw.id}`, sender: message.role, text,
      timestamp: Number.isFinite(time) ? time : rows.length + 1,
      ...(Array.isArray(message.content) ? {mediaPaths:message.content.flatMap((part:unknown)=> {
        const p=part as Record<string,unknown>; const source=p?.source as Record<string,unknown>|undefined;
        const url=typeof p?.path==="string" ? p.path : typeof source?.url==="string" ? source.url : "";
        return url.startsWith("file://") || url.startsWith("/") ? [url] : [];
      })} : {}),
      ...(typeof message.platform_message_id === "string" ? { clientMessageId: message.platform_message_id } : {}),
    });
  }
  return rows;
};
