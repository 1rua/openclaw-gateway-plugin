const attachmentTransitions = {
    created: { begin_upload: "uploading", fail: "failed", expire: "expired" },
    uploading: { verify: "verified", fail: "failed", expire: "expired" },
    verified: { deliver: "delivered", fail: "failed", expire: "expired" },
    delivered: { acknowledge: "acknowledged", expire: "expired" },
    acknowledged: { cleanup: "deleted" },
    failed: { cleanup: "deleted" },
    expired: { cleanup: "deleted" },
    deleted: {},
};
const deviceRequestTransitions = {
    pending: { claim: "claimed", cancel: "cancelled", expire: "expired" },
    claimed: {
        cancel: "cancel_requested",
        expire: "outcome_unknown",
        result_succeeded: "succeeded",
        result_failed: "failed",
        result_denied: "denied",
        result_cancelled: "cancelled",
        result_outcome_unknown: "outcome_unknown",
        recover_outcome_unknown: "outcome_unknown",
    },
    cancel_requested: {
        expire: "outcome_unknown",
        result_succeeded: "succeeded",
        result_failed: "failed",
        result_denied: "denied",
        result_cancelled: "cancelled",
        result_outcome_unknown: "outcome_unknown",
        recover_outcome_unknown: "outcome_unknown",
    },
    succeeded: {},
    failed: {},
    denied: {},
    cancelled: {},
    expired: {},
    outcome_unknown: {},
};
const invalidTransition = () => {
    throw new Error("INVALID_STATE_TRANSITION");
};
export const nextAttachmentState = (current, event) => {
    const transitions = typeof current === "string" ? attachmentTransitions[current] : undefined;
    const next = typeof event === "string" ? transitions?.[event] : undefined;
    return next ?? invalidTransition();
};
export const nextDeviceRequestState = (current, event) => {
    const transitions = typeof current === "string" ? deviceRequestTransitions[current] : undefined;
    const next = typeof event === "string" ? transitions?.[event] : undefined;
    return next ?? invalidTransition();
};
export const maximumDeviceRequestQueueSeconds = (risk) => {
    switch (risk) {
        case "read":
        case "sync":
            return 86400;
        case "write":
            return 900;
        case "high-privilege-ephemeral":
            return 0;
        default:
            throw new Error("SCHEMA_INVALID");
    }
};
const generationTransitions = {
    idle: { start: "streaming" },
    streaming: {
        chunk: "streaming",
        complete: "completed",
        request_cancel: "cancel_requested",
        fail: "failed",
        timeout_outcome_unknown: "outcome_unknown",
    },
    cancel_requested: {
        cancelled: "cancelled",
        complete: "completed",
        fail: "failed",
        timeout_outcome_unknown: "outcome_unknown",
    },
    completed: {},
    cancelled: {},
    failed: {},
    outcome_unknown: {},
};
export const nextGenerationState = (current, event) => {
    const transitions = typeof current === "string" ? generationTransitions[current] : undefined;
    const next = typeof event === "string" ? transitions?.[event] : undefined;
    return next ?? invalidTransition();
};
export function joinMessageBatch(members) {
    if (members.length === 0 || members.length > 20)
        throw new Error("SCHEMA_INVALID");
    if (new Set(members.map((member) => member.clientMessageId)).size !== members.length) {
        throw new Error("SCHEMA_INVALID");
    }
    return members.map((m) => m.text.replace(/^\n+|\n+$/g, "")).join("\n");
}
