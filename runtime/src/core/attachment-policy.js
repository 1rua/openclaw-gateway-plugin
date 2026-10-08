export const DEFAULT_ATTACHMENT_POLICY = Object.freeze({
    attachmentTtlSeconds: 3_600,
    eventRetentionSeconds: 86_400,
    maxClockSkewSeconds: 120,
});
export const assertAttachmentPolicy = (policy) => {
    if (!Number.isSafeInteger(policy.attachmentTtlSeconds) || policy.attachmentTtlSeconds <= 0) {
        throw new Error("SCHEMA_INVALID");
    }
    return policy;
};
