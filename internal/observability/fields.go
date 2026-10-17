package observability

import (
	"regexp"
	"strings"

	"github.com/relanox/relanox/internal/model"
)

func vocabulary(values string) map[string]bool {
	result := map[string]bool{}
	for _, value := range strings.Fields(values) {
		result[value] = true
	}
	return result
}

var operations = vocabulary("ingest dispatch prepare enqueue_message read_media send storage http worker connection recovery retention startup shutdown discovery")

var outcomes = vocabulary("ok error accepted prepared completed transcribed failed duplicate rejected retryable unknown sent conflict unauthorized connected disconnected degraded stale not_found queued updated pending expired awaiting_final")

var events = vocabulary("inbound.accepted inbound.duplicate inbound.rejected inbound.failed dispatch.completed prepare.completed transcription.failed middleware.failed message.queued media.read delivery.completed retry.scheduled delivery.unknown connection.changed worker.completed worker.failed work.completed storage.failed cleanup.failed recovery.completed retention.completed startup.completed shutdown.completed operation.failed channel_attachment_unavailable")

var errorClasses = vocabulary("timeout network authentication authorization rate_limit invalid_input conflict storage unsupported unavailable unknown internal")

var errorCodes = vocabulary("timeout network authentication authorization rate_limit invalid_input conflict storage unsupported unavailable unknown internal call_cancelled call_timeout middleware_filtered preparation_failed preparation_exception invalid_preparation_result unsupported_format audio_too_large audio_too_long media_unavailable provider_unavailable recognition_failed invalid_response interrupted disabled retry_budget_exhausted invalid_chunk_index component_missing component_exception invalid_agent_outcome invalid_channel_outcome storage_unavailable storage_operation_failed storage_cleanup_failed not_accepting worker_failed media_download_failed sender_not_allowed unbound_conversation unsupported_message_type authentication_timeout authentication_failed connection_failed socket_error socket_transport_error socket_connection_error gateway_transport_error gateway_connection_error reconnect_exhausted sync_failed receive_failed frame_processing_failed wechat_poll_failed wechat_session_expired muse_connect_failed muse_dispatch_failed grok_trigger_uncertain")

// Keep exact operational constants emitted by the statically composed native
// adapters. Remote messages and arbitrary error strings never enter this set.
var nativeErrorCodes = vocabulary(`
address_unresolved agent_error agent_missing bot_connection_replaced
callback_reply_used callback_state_conflict callback_stopped callback_stream_expired
channel_error channel_missing customer_window_expired dingtalk_reconnecting
dot_callback_forbidden dot_callback_uncertain dot_endpoint_revoked dot_event_too_large
dot_no_active_subscription dot_subscription_unavailable
feishu_api_error feishu_native_error feishu_startup_failed feishu_token_invalid
file_consent_contention file_consent_declined file_consent_requires_personal_chat
file_consent_send_uncertain file_upload_failed file_upload_incomplete
grok_body_invalid grok_body_too_large grok_config_invalid grok_credentials_invalid
grok_dispatch_cancelled grok_endpoint_invalid grok_request_invalid grok_routine_url_invalid
identity_unavailable ingest_failed invalid_callback_chunk invalid_delivery_chunk
invalid_file_consent_identity invalid_file_consent_state invalid_irc_text invalid_media
invalid_media_caption invalid_native_input invalid_request invalid_rich_media invalid_rich_text
invalid_staff_id invalid_target invalid_thread invalid_upload_part_origin invalid_upload_plan
invalid_publication_url media_caption_unsupported media_format_unsupported media_protocol_limit
media_publication_unavailable media_requires_preview media_too_large media_unsupported
media_upload_response_invalid missing_file_upload_info missing_media missing_message_receipt
muse_body_invalid muse_config_invalid muse_credentials_invalid muse_endpoint_invalid
muse_trigger_uncertain muse_configuration_invalid muse_credentials_invalid muse_queue_invalid
muse_account_invalid muse_vm_invalid muse_connect_invalid
native_connection_failed native_file_send_unsupported native_invalid_response
native_media_upload_failed native_media_upload_rejected native_receive_failed
native_retry_key_retained native_send_uncertain native_preparation_failed not_connected
oauth_token_rejected platform_request_rejected qq_duplicate_effect qq_gateway_disconnected
qq_gateway_fatal_close qq_gateway_retry_exhausted qq_native_error qq_preparation_failed
qq_reconnecting qq_session_state_failed qq_upload_daily_limit
qq_40034100 qq_50055001 qq_50055006 qq_40093001 qq_850027
rate_limited relayed_line_too_large reply_context_unavailable retry_key_expired
rich_text_limit_exceeded rich_text_unsupported rpc_invalid_result rpc_recipient_failure
send_cancelled_before_transmit socket_send_uncertain staff_rate_limited telegram_api_rejected
target_identity_changed text_limit_exceeded text_too_long unauthorized_sender
unauthorized_conversation unknown_account too_many_attachments media_total_too_large
unsupported_media_type unsupported_media_format untrusted_file_upload_origin
untrusted_service_origin wechat_rate_limited wechat_send_rejected wechat_send_unknown
wechat_upload_failed wecom_native_error wecom_rate_limited wecom_reconnecting wecom_request_rejected
`)

var nativeHTTPCode = regexp.MustCompile(`^(grok_http_|dot_callback_http_)[1-5][0-9]{2}$`)

var uuidID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

var channelID = regexp.MustCompile(`(?i)^[0-9a-f]{64}$`)

var traceID = regexp.MustCompile(`^[0-9a-f]{32}$`)

func safeComponent(value string) string {
	switch value {
	case "", "core", "cli", "speech-tencent", "storage:sqlite", "storage:postgres", "observability":
		return value
	}
	if model.ChannelKind(value).Valid() {
		return "channel:" + value
	}
	if kind, ok := strings.CutPrefix(value, "channel:"); ok && model.ChannelKind(kind).Valid() {
		return value
	}
	if kind, ok := strings.CutPrefix(value, "agent:"); ok && model.AgentKind(kind).Valid() {
		return value
	}
	return ""
}

func safeFields(fields model.LogFields) map[string]string {
	result := map[string]string{}
	if component := safeComponent(fields.Component); component != "" {
		result["component"] = component
	}
	if operations[fields.Operation] {
		result["operation"] = fields.Operation
	}
	if outcomes[fields.Outcome] {
		result["outcome"] = fields.Outcome
	}
	if fields.ErrorCode != "" {
		code := "unknown"
		if errorCodes[fields.ErrorCode] || nativeErrorCodes[fields.ErrorCode] || nativeHTTPCode.MatchString(fields.ErrorCode) {
			code = fields.ErrorCode
		}
		result["errorCode"] = code
	}
	for key, candidate := range map[string]string{"requestId": fields.RequestID, "deliveryId": fields.DeliveryID} {
		if uuidID.MatchString(candidate) {
			result[key] = candidate
		}
	}
	if channelID.MatchString(fields.ChannelID) {
		result["channelId"] = fields.ChannelID
	}
	if traceID.MatchString(fields.TraceID) {
		result["traceId"] = fields.TraceID
	}
	return result
}

func safeLabels(labels model.MetricLabels) ([]string, bool) {
	if labels.Channel != "" && !labels.Channel.Valid() || labels.Agent != "" && !labels.Agent.Valid() {
		return nil, false
	}
	component := safeComponent(labels.Component)
	if labels.Component != "" && component == "" || labels.Operation != "" && !operations[labels.Operation] || labels.Outcome != "" && !outcomes[labels.Outcome] || labels.ErrorClass != "" && !errorClasses[labels.ErrorClass] {
		return nil, false
	}
	return []string{string(labels.Channel), string(labels.Agent), component, labels.Operation, labels.Outcome, labels.ErrorClass}, true
}
