export type AttachmentState =
  | "created"
  | "uploading"
  | "verified"
  | "delivered"
  | "acknowledged"
  | "failed"
  | "expired"
  | "deleted";

export type AttachmentEvent =
  | "begin_upload"
  | "verify"
  | "deliver"
  | "acknowledge"
  | "fail"
  | "expire"
  | "cleanup";

export type DeviceRequestState =
  | "pending"
  | "claimed"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled"
  | "expired"
  | "outcome_unknown";

export type DeviceRequestEvent =
  | "claim"
  | "cancel"
  | "expire"
  | "result_succeeded"
  | "result_failed"
  | "result_denied"
  | "result_cancelled"
  | "result_outcome_unknown"
  | "recover_outcome_unknown";

export type DeviceRequestRisk = "read" | "sync" | "write" | "high-privilege-ephemeral";

const attachmentTransitions: Readonly<Record<string, Readonly<Record<string, AttachmentState>>>> = {
  created: { begin_upload: "uploading", fail: "failed", expire: "expired" },
  uploading: { verify: "verified", fail: "failed", expire: "expired" },
  verified: { deliver: "delivered", fail: "failed", expire: "expired" },
  delivered: { acknowledge: "acknowledged", expire: "expired" },
  acknowledged: { cleanup: "deleted" },
  failed: { cleanup: "deleted" },
  expired: { cleanup: "deleted" },
  deleted: {},
};

const deviceRequestTransitions: Readonly<
  Record<string, Readonly<Record<string, DeviceRequestState>>>
> = {
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

const invalidTransition = (): never => {
  throw new Error("INVALID_STATE_TRANSITION");
};

export const nextAttachmentState = (
  current: AttachmentState,
  event: AttachmentEvent,
): AttachmentState => {
  const transitions =
    typeof current === "string" ? attachmentTransitions[current] : undefined;
  const next = typeof event === "string" ? transitions?.[event] : undefined;
  return next ?? invalidTransition();
};

export const nextDeviceRequestState = (
  current: DeviceRequestState,
  event: DeviceRequestEvent,
): DeviceRequestState => {
  const transitions =
    typeof current === "string" ? deviceRequestTransitions[current] : undefined;
  const next = typeof event === "string" ? transitions?.[event] : undefined;
  return next ?? invalidTransition();
};

export const maximumDeviceRequestQueueSeconds = (
  risk: DeviceRequestRisk,
): 86400 | 900 | 0 => {
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

export type GenerationState =
  | "idle"
  | "streaming"
  | "completed"
  | "cancel_requested"
  | "cancelled"
  | "failed"
  | "outcome_unknown";

export type GenerationEvent =
  | "start"
  | "chunk"
  | "complete"
  | "request_cancel"
  | "cancelled"
  | "fail"
  | "timeout_outcome_unknown";

const generationTransitions: Readonly<
  Record<string, Readonly<Record<string, GenerationState>>>
> = {
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

export const nextGenerationState = (
  current: GenerationState,
  event: GenerationEvent,
): GenerationState => {
  const transitions =
    typeof current === "string" ? generationTransitions[current] : undefined;
  const next = typeof event === "string" ? transitions?.[event] : undefined;
  return next ?? invalidTransition();
};

export interface MessageBatchMember {
  readonly clientMessageId: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<{ readonly attachmentId: string }>;
}

export function joinMessageBatch(
  members: readonly Readonly<{ clientMessageId: string; text: string }>[],
): string {
  if (members.length === 0 || members.length > 20) throw new Error("SCHEMA_INVALID");
  if (new Set(members.map((member) => member.clientMessageId)).size !== members.length) {
    throw new Error("SCHEMA_INVALID");
  }
  return members.map((m) => m.text.replace(/^\n+|\n+$/g, "")).join("\n");
}
