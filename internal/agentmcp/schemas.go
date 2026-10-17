package agentmcp

func enumSchema(values ...string) map[string]any {
	return map[string]any{"type": "string", "enum": values}
}

func nonnegative() map[string]any { return map[string]any{"type": "integer", "minimum": 0} }

func channelSchema() map[string]any {
	text := map[string]any{"type": "string"}
	return object(map[string]any{"id": text, "platform": enumSchema("telegram", "discord", "slack", "feishu", "wecom", "wechat", "dingtalk", "qq", "msteams", "whatsapp", "matrix", "googlechat", "line", "mattermost", "signal", "irc"), "accountId": text, "chatId": text, "threadId": text}, "id", "platform", "accountId", "chatId")
}

func replySchema() map[string]any {
	return object(map[string]any{"status": enumSchema("awaiting_final", "expired", "pending", "sent", "rejected", "unknown"), "deliveryId": stringSchema(1024), "errorCode": map[string]any{"type": "string"}}, "status")
}

// IncomingSchema describes the stable notification projection, including
// millisecond timestamps and native channel/media identifiers. Event payloads
// omit reply state; retained-message reads may include it.
func IncomingSchema(includeReply bool) map[string]any {
	text := map[string]any{"type": "string"}
	attachment := object(map[string]any{"id": text, "kind": enumSchema("image", "audio", "video", "file"), "mimeType": text, "fileName": text, "size": nonnegative(), "sha256": text, "durationMs": map[string]any{"type": "integer", "minimum": 1}, "previewMediaId": text}, "id", "kind", "mimeType", "fileName", "size", "sha256")
	properties := map[string]any{"requestId": text, "acceptedAt": nonnegative(), "text": text, "context": map[string]any{}, "extensions": map[string]any{"type": "object"}, "attachments": map[string]any{"type": "array", "items": attachment}, "source": object(map[string]any{"channel": channelSchema(), "senderId": text}, "channel", "senderId")}
	if includeReply {
		properties["reply"] = replySchema()
	}
	return object(properties, "requestId", "acceptedAt", "text", "context", "source")
}

func cursorSchema() map[string]any {
	return object(map[string]any{"acceptedAt": nonnegative(), "requestId": stringSchema(512)}, "acceptedAt", "requestId")
}

func readOutputSchema() map[string]any {
	return object(map[string]any{"nextCursor": cursorSchema(), "messages": map[string]any{"type": "array", "items": IncomingSchema(true)}}, "messages")
}

func sendOutputSchema() map[string]any {
	return map[string]any{"anyOf": []any{object(map[string]any{"status": enumSchema("queued"), "deliveryId": stringSchema(1024), "replay": map[string]any{"type": "boolean"}}, "status", "deliveryId", "replay"), object(map[string]any{"status": enumSchema("not_found", "unauthorized", "conflict")}, "status")}}
}

func statusOutputSchema() map[string]any {
	text := map[string]any{"type": "string"}
	limits := object(map[string]any{"maxBytes": nonnegative(), "maxTotalBytes": nonnegative(), "maxAttachments": nonnegative()}, "maxBytes", "maxTotalBytes", "maxAttachments")
	richLimits := object(map[string]any{"maxParts": nonnegative(), "maxTextLength": nonnegative(), "imageMimeTypes": map[string]any{"type": "array", "items": text}, "maxImageBytes": nonnegative(), "maxTotalImageBytes": nonnegative()}, "maxParts", "maxTextLength")
	channel := object(map[string]any{"channel": channelSchema(), "connection": enumSchema("connected", "disconnected", "degraded"), "send": object(map[string]any{"status": enumSchema("available", "unavailable"), "reason": text}, "status"), "media": map[string]any{"type": "array", "items": enumSchema("image", "audio", "video", "file")}, "richText": enumSchema("native", "sequential", "text-only", "text-then-images"), "richTextLimits": richLimits, "maxTextLength": nonnegative(), "lengthUnit": enumSchema("utf16", "codepoint", "utf8"), "maxTextLengthPerMessage": nonnegative(), "maxChunksPerMessage": nonnegative(), "maxAttachments": nonnegative()}, "channel", "connection", "send", "media", "maxTextLength", "lengthUnit")
	connection := object(map[string]any{"endpointId": text, "eventName": enumSchema("relanox.message_available"), "activeSubscriptions": nonnegative()}, "endpointId", "eventName", "activeSubscriptions")
	return object(map[string]any{"request": object(map[string]any{"id": text, "reply": replySchema()}, "id", "reply"), "channels": map[string]any{"type": "array", "items": channel}, "mediaLimits": limits, "delivery": object(map[string]any{"id": text, "channel": text, "status": enumSchema("pending", "sent", "rejected", "unknown"), "errorCode": text}, "id", "channel", "status"), "connection": connection}, "channels", "mediaLimits")
}
