/** Product policy retains expiry and event timing, not attachment size or MIME filters. */
export type AttachmentPolicy = Readonly<{
  attachmentTtlSeconds: number;
  eventRetentionSeconds: number;
  maxClockSkewSeconds: number;
}>;

export const DEFAULT_ATTACHMENT_POLICY: AttachmentPolicy = Object.freeze({
  attachmentTtlSeconds: 3_600,
  eventRetentionSeconds: 86_400,
  maxClockSkewSeconds: 120,
});

export const assertAttachmentPolicy = (policy: AttachmentPolicy): AttachmentPolicy => {
  if (
    !Number.isSafeInteger(policy.attachmentTtlSeconds) || policy.attachmentTtlSeconds <= 0
  ) {
    throw new Error("SCHEMA_INVALID");
  }
  return policy;
};
