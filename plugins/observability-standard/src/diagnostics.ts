// Exact constants emitted by native channels. Never infer categories from arbitrary error text.
export const nativeEvents = new Map([
  ["channel_policy_rejection", "inbound.rejected"],
  ["channel_input_discarded", "inbound.rejected"],
  ["channel_unsupported_input", "inbound.rejected"],
  ["channel_unsupported_sender", "inbound.rejected"],
  ["channel_event_ignored", "inbound.rejected"],
  ["channel_invalid_frame", "inbound.rejected"],
  ["channel_connection_replaced", "connection.changed"],
]);

const nativeErrors = new Map([
  ["sender_not_allowed", "authorization"],
  ["unbound_conversation", "authorization"],
  ["unsupported_message_type", "unsupported"],
  ["unsupported_or_self_text", "unsupported"],
  ["unsupported_or_empty_text", "unsupported"],
  ["encrypted_unsupported", "unsupported"],
  ["nontext_unsupported", "unsupported"],
  ["relation_unsupported", "unsupported"],
  ["ctcp_unsupported", "unsupported"],
  ["missing_staff_id", "invalid_input"],
  ["invalid_frame", "invalid_input"],
  ["invalid_gateway_frame", "invalid_input"],
  ["bot_connection_replaced", "conflict"],
  ["sync_checkpoint_conflict", "conflict"],
  ["authentication_timeout", "timeout"],
  ["authentication_failed", "authentication"],
  ["account_identity_required", "authentication"],
  ["nick_identity_fallback", "authentication"],
  ["registration_failed", "authentication"],
  ["connection_failed", "network"],
  ["socket_error", "network"],
  ["socket_transport_error", "network"],
  ["socket_connection_error", "network"],
  ["gateway_transport_error", "network"],
  ["gateway_connection_error", "network"],
  ["gateway_configuration_error", "invalid_input"],
  ["reconnect_exhausted", "unavailable"],
  ["sync_history_gap", "unavailable"],
  ["sync_failed", "unknown"],
  ["receive_failed", "unknown"],
  ["frame_processing_failed", "unknown"],
  ["socket_ingest_error", "unknown"],
  ["socket_lifecycle_error", "unknown"],
  ["gateway_ingest_error", "unknown"],
  ["gateway_lifecycle_error", "unknown"],
]);

export function nativeField(key: string, value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (key === "errorCode") {
    return nativeErrors.get(value) ?? value;
  }
  return key === "operation" && value === "receive" ? "ingest" : value;
}
