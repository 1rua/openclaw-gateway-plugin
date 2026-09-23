declare module "openclaw/plugin-sdk/channel-inbound" {
  export type ChannelInboundMediaInput = Readonly<{
    path?: string | null;
    url?: string | null;
    contentType?: string | null;
    kind?: "image" | "video" | "audio" | "document" | "unknown" | null;
    messageId?: string | null;
  }>;

  export type InboundMediaFacts = Readonly<{
    path?: string;
    url?: string;
    contentType?: string;
    kind?: "image" | "video" | "audio" | "document" | "unknown";
    messageId?: string;
  }>;

  export function toInboundMediaFacts(
    media: readonly ChannelInboundMediaInput[] | null | undefined,
    defaults?: Readonly<{ kind?: InboundMediaFacts["kind"]; messageId?: string }>,
  ): InboundMediaFacts[];
}
