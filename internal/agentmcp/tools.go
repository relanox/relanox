package agentmcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/relanox/relanox/internal/model"
)

type attachment struct {
	MediaID        string          `json:"mediaId,omitempty"`
	URL            string          `json:"url,omitempty"`
	Kind           model.MediaKind `json:"kind,omitempty"`
	MIMEType       string          `json:"mimeType,omitempty"`
	FileName       string          `json:"fileName,omitempty"`
	DurationMS     *int64          `json:"durationMs,omitempty"`
	PreviewMediaID string          `json:"previewMediaId,omitempty"`
	PreviewURL     string          `json:"previewUrl,omitempty"`
}

type dotFile struct {
	DownloadURL string `json:"download_url"`
	FileID      string `json:"file_id"`
	MIMEType    string `json:"mime_type,omitempty"`
	FileName    string `json:"file_name,omitempty"`
}

type sendInput struct {
	Channel        string                `json:"channel"`
	Text           string                `json:"text,omitempty"`
	IdempotencyKey string                `json:"idempotencyKey,omitempty"`
	Reply          *model.ReplyReference `json:"reply,omitempty"`
	Attachments    []attachment          `json:"attachments,omitempty"`
	Files          []dotFile             `json:"files,omitempty"`
}

type statusInput struct {
	DeliveryID string `json:"deliveryId,omitempty"`
	RequestID  string `json:"requestId,omitempty"`
}

type cursor struct {
	AcceptedAt int64  `json:"acceptedAt"`
	RequestID  string `json:"requestId"`
}

type readInput struct {
	RequestID string  `json:"requestId,omitempty"`
	Pending   bool    `json:"pending,omitempty"`
	Cursor    *cursor `json:"cursor,omitempty"`
	Limit     int     `json:"limit,omitempty"`
}

func object(properties map[string]any, required ...string) map[string]any {
	schema := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func stringSchema(maximum int) map[string]any {
	return map[string]any{"type": "string", "minLength": 1, "maxLength": maximum}
}

func annotations(read, open bool) *mcp.ToolAnnotations {
	no := false
	return &mcp.ToolAnnotations{ReadOnlyHint: read, IdempotentHint: read, DestructiveHint: &no, OpenWorldHint: &open}
}

func addTool[In any](server *mcp.Server, tool *mcp.Tool, fn func(context.Context, In) (*mcp.CallToolResult, error)) {
	mcp.AddTool[In, any](server, tool, func(ctx context.Context, _ *mcp.CallToolRequest, input In) (*mcp.CallToolResult, any, error) {
		result, err := fn(ctx, input)
		var output any
		if result != nil {
			output = result.StructuredContent
			result.StructuredContent = nil
		}
		return result, output, err
	})
}

func Envelope(value any, isError bool) *mcp.CallToolResult {
	data, err := json.Marshal(value)
	if err != nil {
		return toolError("result_unavailable")
	}
	return &mcp.CallToolResult{StructuredContent: value, Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}, IsError: isError}
}

func toolError(message string) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: message}}}
}

func (s *Server) registerTools() {
	addTool(s.SDK, &mcp.Tool{Name: "relanox_status", Description: "List authorized channels, current send availability, media limits and an optional delivery or incoming request's final reply. Reads are snapshots; check again before recovery sends.", InputSchema: object(map[string]any{"deliveryId": stringSchema(1024), "requestId": stringSchema(1024)}), OutputSchema: statusOutputSchema(), Annotations: annotations(true, false)}, s.status)
	addTool(s.SDK, &mcp.Tool{Name: "relanox_send_message", Description: "Send Markdown and ordered media to an authorized channel. Include reply {requestId,kind:progress|final} for an exact incoming request; progress does not complete it. One final delivery is allowed; changed retries conflict. A queued result means saved, not delivered. Retry identical content/order under the same idempotencyKey. Ordinary unassociated calls without a key create separate sends.", InputSchema: sendSchema(s.Options.Endpoint.Agent == model.Dot), OutputSchema: sendOutputSchema(), Annotations: annotations(false, true), Meta: s.sendMeta()}, s.send)
	addTool(s.SDK, &mcp.Tool{Name: "relanox_read_messages", Description: "Recover retained messages with exact requestId first. Otherwise newest first, default5/max20. pending=true pages unfinished work oldest first; follow nextCursor. Only awaiting_final needs an answer; pending/rejected/unknown final deliveries need delivery recovery. Reads never claim, acknowledge or replay work. Match the trigger and recheck status before replying.", InputSchema: readSchema(), OutputSchema: readOutputSchema(), Annotations: annotations(true, false)}, s.read)
	if s.Host.Media() != nil {
		s.registerMediaTools()
	}
}

func (s *Server) sendMeta() mcp.Meta {
	if s.Options.Endpoint.Agent == model.Dot {
		return mcp.Meta{"openai/fileParams": []string{"files"}}
	}
	return nil
}

func sendSchema(dot bool) map[string]any {
	id := stringSchema(1024)
	attachmentSchema := map[string]any{"anyOf": []any{object(map[string]any{"mediaId": id}, "mediaId"), object(map[string]any{"url": stringSchema(8192), "kind": map[string]any{"enum": []string{"image", "audio", "video", "file"}}, "mimeType": stringSchema(128), "fileName": stringSchema(255), "durationMs": map[string]any{"type": "integer", "minimum": 1}, "previewMediaId": id, "previewUrl": stringSchema(8192)}, "url", "kind")}}
	properties := map[string]any{"channel": id, "text": map[string]any{"type": "string", "maxLength": 1 << 20, "default": ""}, "idempotencyKey": id, "reply": object(map[string]any{"requestId": id, "kind": map[string]any{"enum": []string{"progress", "final"}}}, "requestId", "kind"), "attachments": map[string]any{"type": "array", "maxItems": 10, "items": attachmentSchema}}
	if dot {
		properties["files"] = map[string]any{"type": "array", "maxItems": 10, "items": object(map[string]any{"download_url": stringSchema(8192), "file_id": id, "mime_type": stringSchema(128), "file_name": stringSchema(255)}, "download_url", "file_id")}
	}
	return object(properties, "channel")
}

func readSchema() map[string]any {
	return object(map[string]any{"requestId": stringSchema(512), "pending": map[string]any{"type": "boolean"}, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 20}, "cursor": object(map[string]any{"acceptedAt": map[string]any{"type": "integer", "minimum": 0}, "requestId": stringSchema(512)}, "acceptedAt", "requestId")})
}

func (s *Server) status(ctx context.Context, in statusInput) (*mcp.CallToolResult, error) {
	result, err := s.Host.Status(ctx, model.StatusInput{DeliveryID: in.DeliveryID, RequestID: in.RequestID})
	if err != nil {
		return toolError("Status unavailable."), nil
	}
	if result.Channels == nil {
		result.Channels = []model.AgentChannelStatus{}
	}
	for i := range result.Channels {
		if result.Channels[i].Media == nil {
			result.Channels[i].Media = []model.MediaKind{}
		}
	}
	if s.Options.StatusContext == nil {
		return Envelope(result, false), nil
	}

	extra, err := s.Options.StatusContext(ctx)
	if err != nil {
		return toolError("Status unavailable."), nil
	}
	return Envelope(struct {
		model.AgentStatus
		Connection map[string]any `json:"connection"`
	}{AgentStatus: result, Connection: extra}, false), nil
}

func (s *Server) read(ctx context.Context, in readInput) (*mcp.CallToolResult, error) {
	if in.Pending && in.RequestID != "" || in.Cursor != nil && !in.Pending {
		return toolError("Invalid recovery selection."), nil
	}
	limit := in.Limit
	if limit == 0 {
		limit = 5
	}
	input := model.ReadMessagesInput{RequestID: in.RequestID, Pending: in.Pending, Limit: limit}
	if in.Cursor != nil {
		input.Cursor = &model.MessageCursor{AcceptedAt: time.UnixMilli(in.Cursor.AcceptedAt), RequestID: in.Cursor.RequestID}
	}
	records, err := s.Host.ReadMessages(ctx, input)
	if err != nil {
		return toolError("Messages unavailable."), nil
	}
	messages := make([]map[string]any, 0, len(records))
	for _, record := range records {
		messages = append(messages, Incoming(record))
	}
	out := map[string]any{"messages": messages}
	if in.Pending && len(records) == limit {
		last := records[len(records)-1]
		out["nextCursor"] = cursor{AcceptedAt: last.AcceptedAt.UnixMilli(), RequestID: last.RequestID}
	}
	return Envelope(out, false), nil
}

func (s *Server) send(ctx context.Context, in sendInput) (*mcp.CallToolResult, error) {
	media := s.Host.Media()
	limits := model.MediaLimits{}
	if media != nil {
		limits = media.Limits()
	}
	if len(in.Attachments)+len(in.Files) > limits.MaxAttachments {
		return toolError("Too many attachments for this endpoint."), nil
	}
	downloads := len(in.Files) > 0
	for _, a := range in.Attachments {
		downloads = downloads || a.URL != ""
	}
	if downloads {
		allowed, err := media.Authorize(ctx, in.Channel)
		if err != nil || !allowed {
			return Envelope(map[string]string{"status": "not_found"}, true), nil
		}
	}
	resolved, err := s.resolveSendMedia(ctx, in, limits)
	if err != nil {
		return toolError("Message could not be queued: unavailable channel, invalid message, attachment or media limit exceeded. Check relanox_status."), nil
	}
	result, err := s.Host.SendMessage(ctx, model.SendMessageInput{Channel: in.Channel, Text: in.Text, IdempotencyKey: in.IdempotencyKey, Reply: in.Reply, Attachments: resolved})
	if err != nil {
		return toolError("Message could not be queued."), nil
	}
	out := map[string]any{"status": result.Status}
	if result.Status == model.Queued {
		out["deliveryId"] = result.DeliveryID
		out["replay"] = result.Replay
	}
	return Envelope(out, result.Status != model.Queued), nil
}

func (s *Server) resolveSendMedia(ctx context.Context, in sendInput, limits model.MediaLimits) ([]model.AgentAttachment, error) {
	bounded, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	remaining := limits.MaxTotalBytes
	out := make([]model.AgentAttachment, 0, len(in.Attachments)+len(in.Files))
	for _, item := range in.Attachments {
		if item.MediaID != "" {
			out = append(out, model.AgentAttachment{MediaID: item.MediaID})
			continue
		}
		upload, err := s.download(bounded, item.URL, min(limits.MaxBytes, remaining))
		if err != nil {
			return nil, err
		}
		upload.Kind = item.Kind
		upload.DurationMS = item.DurationMS
		upload.PreviewMediaID = item.PreviewMediaID
		if item.MIMEType != "" {
			upload.MIMEType = item.MIMEType
		}
		if item.FileName != "" {
			upload.FileName = item.FileName
		}
		remaining -= int64(len(upload.Data))
		resolved := model.AgentAttachment{Upload: &upload}
		if item.PreviewURL != "" {
			preview, err := s.download(bounded, item.PreviewURL, min(limits.MaxBytes, remaining))
			if err != nil {
				return nil, err
			}
			preview.Kind = model.Image
			preview.FileName = "preview"
			remaining -= int64(len(preview.Data))
			resolved.Preview = &preview
		}
		out = append(out, resolved)
	}
	for _, file := range in.Files {
		upload, err := s.download(bounded, file.DownloadURL, min(limits.MaxBytes, remaining))
		if err != nil {
			return nil, err
		}
		if file.MIMEType != "" {
			upload.MIMEType = file.MIMEType
		}
		if file.FileName != "" {
			upload.FileName = file.FileName
		}
		category := strings.Split(upload.MIMEType, "/")[0]
		upload.Kind = model.File
		if category == "image" || category == "audio" || category == "video" {
			upload.Kind = model.MediaKind(category)
		}
		remaining -= int64(len(upload.Data))
		out = append(out, model.AgentAttachment{Upload: &upload})
	}
	return out, nil
}

func (s *Server) download(ctx context.Context, value string, limit int64) (model.MediaUpload, error) {
	var zero model.MediaUpload
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Host == "" || u.Fragment != "" || limit <= 0 {
		return zero, errors.New("invalid_media_url")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return zero, err
	}
	response, err := s.Options.Dependencies.Client().Do(req)
	if err != nil {
		return zero, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 || response.ContentLength > limit {
		return zero, errors.New("media_unavailable")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return zero, errors.New("media_too_large")
	}
	mimeType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	fileName := ""
	if _, parameters, err := mime.ParseMediaType(response.Header.Get("Content-Disposition")); err == nil {
		fileName = parameters["filename"]
	}
	if fileName == "" {
		fileName = path.Base(u.Path)
		if fileName == "." || fileName == "/" || fileName == "" {
			fileName = "attachment"
		}
	}
	return model.MediaUpload{Kind: model.File, MIMEType: mimeType, FileName: fileName, Data: data}, nil
}
