package slack

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	slackapi "github.com/slack-go/slack"
	"github.com/slack-go/slack/slackevents"
)

func authorizeWebhook(request *http.Request) error {
	timestamp, err := strconv.ParseInt(request.Header.Get("X-Slack-Request-Timestamp"), 10, 64)
	now := time.Now().Unix()
	if err != nil || timestamp < now-300 || timestamp > now+300 || !strings.HasPrefix(request.Header.Get("X-Slack-Signature"), "v0=") {
		return errors.New("invalid_native_authentication")
	}
	return nil
}

func (c *Channel) mountWebhook() error {
	return c.host.MountHTTP(model.HTTPRoute{Pattern: "/events", MaxBodyBytes: common.MaxJSONBytes, Authorize: authorizeWebhook, Handler: http.HandlerFunc(c.webhook)})
}

func (c *Channel) webhook(w http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	secret, err := c.options.Secret(*c.config.SigningSecret)
	if err != nil {
		http.Error(w, "credentials_unavailable", http.StatusServiceUnavailable)
		return
	}
	verifier, err := slackapi.NewSecretsVerifier(request.Header, secret)
	if err != nil {
		http.Error(w, "invalid_native_authentication", http.StatusUnauthorized)
		return
	}
	raw, err := common.ReadBounded(request.Body, common.MaxJSONBytes)
	if err != nil {
		http.Error(w, "invalid_native_body", http.StatusBadRequest)
		return
	}
	_, err = verifier.Write(raw)
	if err != nil || verifier.Ensure() != nil {
		http.Error(w, "invalid_native_authentication", http.StatusUnauthorized)
		return
	}
	var envelope struct {
		Type      string `json:"type"`
		Challenge string `json:"challenge"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		http.Error(w, "invalid_native_body", http.StatusBadRequest)
		return
	}
	if envelope.Type == slackevents.URLVerification {
		if envelope.Challenge == "" || len(envelope.Challenge) > 1024 {
			http.Error(w, "invalid_challenge", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"challenge": envelope.Challenge})
		return
	}
	_, bot, err := c.client(request.Context())
	if err == nil {
		err = c.receive(request.Context(), raw, bot)
	}
	if err != nil && !common.PolicyRejection(err) {
		http.Error(w, "native_acceptance_failed", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (c *Channel) envelope(raw json.RawMessage, bot *identity) (*slackevents.EventsAPICallbackEvent, error) {
	var envelope slackevents.EventsAPICallbackEvent
	if json.Unmarshal(raw, &envelope) != nil {
		return nil, errors.New("invalid_native_event")
	}
	if envelope.Type != slackevents.CallbackEvent {
		return nil, nil
	}
	if envelope.TeamID != bot.TeamID || envelope.APIAppID != c.config.AppID || envelope.EventID == "" || len(envelope.EventID) > 256 || envelope.InnerEvent == nil {
		return nil, errors.New("native_event_identity_mismatch")
	}
	return &envelope, nil
}

func (c *Channel) humanMessage(message slackevents.MessageEvent, bot *identity) bool {
	if message.Type != "message" && message.Type != "app_mention" {
		return false
	}
	if message.SubType != "" && !slices.Contains([]string{"file_share", "me_message", "thread_broadcast"}, message.SubType) {
		return false
	}
	return message.BotID == "" && message.User != bot.UserID && slices.Contains(c.account.AllowedSenders, message.User) && slices.Contains(c.host.BoundChatIDs(), message.Channel)
}

func (c *Channel) receive(ctx context.Context, raw json.RawMessage, bot *identity) error {
	envelope, err := c.envelope(raw, bot)
	if err != nil || envelope == nil {
		return err
	}
	var message slackevents.MessageEvent
	if json.Unmarshal(*envelope.InnerEvent, &message) != nil {
		return errors.New("invalid_native_message")
	}
	if !c.humanMessage(message, bot) {
		return nil
	}
	thread := message.ThreadTimeStamp
	if thread == "" && message.SubType == "thread_broadcast" && message.Root != nil {
		thread = message.Root.ThreadTimestamp
	}
	if !validAddress(message.Channel, thread) || message.SubType == "thread_broadcast" && thread == "" {
		return errors.New("invalid_native_thread")
	}
	received, err := nativeTime(message.TimeStamp)
	if err != nil {
		return err
	}
	var files []slackapi.File
	if message.Message != nil {
		files = message.Message.Files
	}
	attachments, err := c.attachments(ctx, files)
	if err != nil {
		return err
	}
	if message.Text == "" && len(attachments) == 0 {
		return nil
	}
	sourceID := envelope.EventID
	// Slack can deliver one post as both message.* and app_mention. Native
	// team/channel/ts identify the same plain post; subtypes/files retain their
	// native event identity because they may represent distinct file events.
	if message.SubType == "" && len(files) == 0 {
		sourceID = "slack-message:" + string(common.Data([]string{bot.TeamID, message.Channel, message.TimeStamp}))
	}
	return common.Ingest(ctx, c.host, model.IngestInput{Source: model.SourceKey{Channel: model.Slack, AccountID: c.account.ID, EventID: sourceID}, SenderID: message.User, Text: message.Text, Attachments: attachments, ReceivedAt: received, Target: model.ReplyTarget{Channel: model.Slack, AccountID: c.account.ID, ChatID: message.Channel, ThreadID: thread, ReplyToID: message.TimeStamp, Data: common.Data(c.target(bot))}})
}

func (c *Channel) attachments(ctx context.Context, files []slackapi.File) ([]model.MediaUpload, error) {
	if len(files) > 10 {
		return nil, errors.New("too_many_attachments")
	}
	result := make([]model.MediaUpload, 0, len(files))
	token, _, err := c.credentials()
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		if file.URLPrivate == "" && file.URLPrivateDownload == "" {
			file, err = c.fileInfo(ctx, file.ID)
			if err != nil {
				return nil, err
			}
		}
		media, err := c.attachment(ctx, file, token)
		if err != nil {
			return nil, err
		}
		result = append(result, media)
	}
	return result, nil
}

func (c *Channel) fileInfo(ctx context.Context, id string) (slackapi.File, error) {
	if !nativeID(id) {
		return slackapi.File{}, errors.New("invalid_file_identity")
	}
	client, _, err := c.client(ctx)
	if err != nil {
		return slackapi.File{}, err
	}
	file, _, _, err := client.GetFileInfoContext(ctx, id, 1, 1)
	if err != nil {
		return slackapi.File{}, err
	}
	if file == nil || file.ID != id {
		return slackapi.File{}, errors.New("file_identity_mismatch")
	}
	return *file, nil
}

func (c *Channel) attachment(ctx context.Context, file slackapi.File, token string) (model.MediaUpload, error) {
	if file.Size < 0 || int64(file.Size) > common.MediaLimit(c.host) {
		return model.MediaUpload{}, errors.New("media_too_large")
	}
	value := file.URLPrivateDownload
	if value == "" {
		value = file.URLPrivate
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || (common.Origin(value) != "https://files.slack.com" && common.Origin(value) != common.Origin(c.config.APIBaseURL)) {
		return model.MediaUpload{}, errors.New("invalid_attachment_url")
	}
	data, headers, err := c.downloadFile(ctx, value, token)
	if err != nil {
		return model.MediaUpload{}, err
	}
	mimeType := file.Mimetype
	if mimeType == "" {
		mimeType = strings.TrimSpace(strings.Split(headers.Get("Content-Type"), ";")[0])
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	name := file.Name
	if name == "" {
		name = file.ID
	}
	return model.MediaUpload{Kind: common.MediaKind(mimeType), MIMEType: mimeType, FileName: name, Data: data}, nil
}
