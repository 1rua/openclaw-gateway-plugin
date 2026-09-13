/**
 * The attachment limits this Gateway enforces and advertises.
 *
 * Contract §8 makes negotiation the only place a client learns these values, so
 * the same immutable policy object is used to answer negotiation and to accept,
 * reject or expire the bytes themselves — the advertised limit and the enforced
 * limit cannot drift apart.
 */
export type AttachmentPolicy = Readonly<{
  maxSingleAttachmentBytes: number;
  maxMessageAttachmentBytes: number;
  allowedMediaTypes: readonly string[];
  attachmentTtlSeconds: number;
  eventRetentionSeconds: number;
  maxClockSkewSeconds: number;
}>;

export const DEFAULT_ATTACHMENT_POLICY: AttachmentPolicy = Object.freeze({
  maxSingleAttachmentBytes: 26_214_400,
  maxMessageAttachmentBytes: 52_428_800,
  allowedMediaTypes: Object.freeze([
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
    "text/plain",
    "audio/mp4",
  ]),
  attachmentTtlSeconds: 3_600,
  eventRetentionSeconds: 86_400,
  maxClockSkewSeconds: 120,
});

export const assertAttachmentPolicy = (policy: AttachmentPolicy): AttachmentPolicy => {
  if (
    !Number.isSafeInteger(policy.maxSingleAttachmentBytes) || policy.maxSingleAttachmentBytes <= 0
    || !Number.isSafeInteger(policy.maxMessageAttachmentBytes)
    || policy.maxMessageAttachmentBytes < policy.maxSingleAttachmentBytes
    || !Number.isSafeInteger(policy.attachmentTtlSeconds) || policy.attachmentTtlSeconds <= 0
    || policy.allowedMediaTypes.length === 0
  ) {
    throw new Error("SCHEMA_INVALID");
  }
  return policy;
};
