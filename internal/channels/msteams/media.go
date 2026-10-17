package msteams

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

// Consent and upload envelopes follow the Teams file API, with sequential
// OneDrive fragments of 10 MiB (a multiple of 320 KiB, below 60 MiB).
// https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4
// https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession
type uploadInfo struct {
	UploadURL  string `json:"uploadUrl"`
	ContentURL string `json:"contentUrl"`
	UniqueID   string `json:"uniqueId"`
	FileType   string `json:"fileType"`
}

type consentState struct {
	Phase          string      `json:"phase"`
	Offset         int64       `json:"offset,omitempty"`
	ConversationID string      `json:"conversationId"`
	UserID         string      `json:"userId"`
	BotID          string      `json:"botId"`
	UploadInfo     *uploadInfo `json:"uploadInfo,omitempty"`
}

func (s consentState) matches(target targetData) bool {
	return s.ConversationID == target.ConversationID && s.UserID == target.UserID && s.BotID == target.BotID
}

func (c *Channel) acceptConsent(ctx context.Context, input activity) error {
	var invoke struct {
		Action  string `json:"action"`
		Context struct {
			ConsentID string `json:"consentId"`
		} `json:"context"`
		UploadInfo *uploadInfo `json:"uploadInfo,omitempty"`
	}
	if json.Unmarshal(input.Value, &invoke) != nil || !slices.Contains([]string{"accept", "decline"}, invoke.Action) || invoke.Context.ConsentID == "" {
		return errors.New("invalid_file_consent")
	}
	key := "consent:" + invoke.Context.ConsentID
	state, entry, err := common.ReadState[consentState](ctx, c.host.State(), key)
	if err != nil {
		return err
	}
	if entry == nil {
		return errors.New("unknown_file_consent")
	}
	if state.ConversationID != input.Conversation.ID || state.UserID != input.From.ID || state.BotID != c.config.BotID {
		return errors.New("invalid_file_consent_identity")
	}
	if state.Phase != "waiting" && state.Phase != "posting" {
		return nil
	}
	if invoke.Action == "accept" && (invoke.UploadInfo == nil || !validEndpoint(invoke.UploadInfo.UploadURL) || !validEndpoint(invoke.UploadInfo.ContentURL) || invoke.UploadInfo.UniqueID == "" || invoke.UploadInfo.FileType == "") {
		return errors.New("missing_file_upload_info")
	}
	state.Phase = invoke.Action
	state.UploadInfo = invoke.UploadInfo
	result, err := c.host.State().CompareAndSet(ctx, model.CompareAndSetStateInput{Key: key, ExpectedVersion: &entry.Version, Value: common.Data(state)})
	if err != nil {
		return err
	}
	if result.Status != model.Updated {
		return errors.New("file_consent_contention")
	}
	return nil
}

type preparedAttachment struct {
	attachment *attachment
	outcome    *model.SendResult
	consentKey string
}

func outcome(result model.SendResult) preparedAttachment { return preparedAttachment{outcome: &result} }

func (c *Channel) prepareAttachment(ctx context.Context, input model.SendInput, target targetData) (preparedAttachment, error) {
	if input.Chunk.Media == nil {
		return preparedAttachment{}, nil
	}
	if input.Media == nil {
		return outcome(common.Reject("missing_media")), nil
	}
	media := input.Media
	if media.Reference.Kind == model.Image && (len(media.Data) <= 15000 || !target.Personal) {
		return c.imageAttachment(ctx, input)
	}
	if !target.Personal {
		return outcome(common.Reject("file_consent_requires_personal_chat")), nil
	}
	key := "consent:" + input.Chunk.IdempotencyKey
	state, entry, err := common.ReadState[consentState](ctx, c.host.State(), key)
	if err != nil {
		return preparedAttachment{}, err
	}
	if entry == nil {
		return c.reserveConsent(ctx, key, input, target)
	}
	if !state.matches(target) {
		return outcome(common.Reject("invalid_file_consent_identity")), nil
	}
	switch state.Phase {
	case "posting":
		return outcome(model.SendResult{Status: model.Unknown, ErrorCode: "file_consent_send_uncertain"}), nil
	case "waiting":
		return outcome(model.SendResult{Status: model.Pending, RetryAfter: 30 * time.Second}), nil
	case "decline":
		return outcome(common.Reject("file_consent_declined")), nil
	case "accept", "uploaded":
	default:
		return outcome(common.Reject("invalid_file_consent_state")), nil
	}
	info := state.UploadInfo
	if info == nil {
		return outcome(common.Reject("missing_file_upload_info")), nil
	}
	if !validEndpoint(info.UploadURL) || !slices.Contains(c.config.TrustedUploadOrigins, common.Origin(info.UploadURL)) {
		return outcome(common.Reject("untrusted_file_upload_origin")), nil
	}
	if state.Phase != "uploaded" {
		result, err := c.uploadFile(ctx, key, input)
		if err != nil {
			return preparedAttachment{}, err
		}
		if result != nil {
			return outcome(*result), nil
		}
	}
	return preparedAttachment{attachment: &attachment{ContentType: "application/vnd.microsoft.teams.card.file.info", ContentURL: info.ContentURL, Name: media.Reference.FileName, Content: common.Data(map[string]string{"uniqueId": info.UniqueID, "fileType": info.FileType})}}, nil
}

func (c *Channel) reserveConsent(ctx context.Context, key string, input model.SendInput, target targetData) (preparedAttachment, error) {
	state := consentState{Phase: "posting", ConversationID: target.ConversationID, UserID: target.UserID, BotID: target.BotID}
	result, err := c.host.State().CompareAndSet(ctx, model.CompareAndSetStateInput{Key: key, Value: common.Data(state)})
	if err != nil {
		return preparedAttachment{}, err
	}
	if result.Status != model.Updated {
		return outcome(common.Retry("file_consent_contention", time.Second)), nil
	}
	context := map[string]string{"consentId": input.Chunk.IdempotencyKey}
	description := input.Chunk.Text
	if description == "" {
		description = input.Media.Reference.FileName
	}
	return preparedAttachment{consentKey: key, attachment: &attachment{ContentType: "application/vnd.microsoft.teams.card.file.consent", Name: input.Media.Reference.FileName, Content: common.Data(map[string]any{"description": description, "sizeInBytes": input.Media.Reference.Size, "acceptContext": context, "declineContext": context})}}, nil
}

func (c *Channel) uploadFile(ctx context.Context, key string, input model.SendInput) (*model.SendResult, error) {
	if input.Media == nil {
		return nil, errors.New("missing_media")
	}
	state, entry, err := common.ReadState[consentState](ctx, c.host.State(), key)
	if err != nil {
		return nil, err
	}
	if entry == nil || state.UploadInfo == nil {
		return nil, errors.New("missing_consent_state")
	}
	size := int64(len(input.Media.Data))
	if state.Offset < 0 || state.Offset > size {
		return nil, errors.New("invalid_upload_offset")
	}
	for offset := state.Offset; offset < size; {
		end := min(size, offset+10*1024*1024)
		request, err := http.NewRequestWithContext(ctx, http.MethodPut, state.UploadInfo.UploadURL, bytes.NewReader(input.Media.Data[offset:end]))
		if err != nil {
			return nil, err
		}
		request.Header.Set("Content-Type", input.Media.Reference.MIMEType)
		request.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, end-1, size))
		response, err := common.HTTPClient(c.options.HTTPClient).Do(request)
		if err != nil {
			result := common.Retry("file_upload_failed", 0)
			return &result, nil
		}
		_, readErr := common.ReadBounded(response.Body, common.MaxJSONBytes)
		_ = response.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		if result := uploadFailure(response); result != nil {
			return result, nil
		}
		complete := end == size && response.StatusCode != 202
		if end == size && !complete {
			result := common.Retry("file_upload_incomplete", 0)
			return &result, nil
		}
		state.Offset = end
		state.Phase = "accept"
		if complete {
			state.Phase = "uploaded"
		}
		result, err := c.host.State().CompareAndSet(ctx, model.CompareAndSetStateInput{Key: key, ExpectedVersion: &entry.Version, Value: common.Data(state)})
		if err != nil {
			return nil, err
		}
		if result.Status != model.Updated {
			return nil, errors.New("file_consent_contention")
		}
		offset = end
		entry.Version = result.Version
	}
	return nil, nil
}

func uploadFailure(response *http.Response) *model.SendResult {
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	result := common.Reject("file_upload_failed")
	if response.StatusCode == 429 || response.StatusCode >= 500 {
		result = common.Retry("file_upload_failed", common.RetryAfter(response.Header))
	}
	return &result
}

func (c *Channel) consentRefused(ctx context.Context, key string) error {
	state, entry, err := common.ReadState[consentState](ctx, c.host.State(), key)
	if err != nil {
		return err
	}
	if entry == nil || state.Phase != "posting" {
		return nil
	}
	result, err := c.host.State().Delete(ctx, key, entry.Version)
	if err != nil {
		return err
	}
	if result.Status != model.Updated {
		return errors.New("file_consent_contention")
	}
	return nil
}

func (c *Channel) consentPosted(ctx context.Context, key string) error {
	state, entry, err := common.ReadState[consentState](ctx, c.host.State(), key)
	if err != nil {
		return err
	}
	if entry == nil {
		return errors.New("missing_consent_state")
	}
	if state.Phase != "posting" {
		return nil
	}
	state.Phase = "waiting"
	result, err := c.host.State().CompareAndSet(ctx, model.CompareAndSetStateInput{Key: key, ExpectedVersion: &entry.Version, Value: common.Data(state)})
	if err != nil {
		return err
	}
	if result.Status != model.Updated {
		return errors.New("file_consent_contention")
	}
	return nil
}

func (c *Channel) downloadAttachments(ctx context.Context, attachments []attachment) ([]model.MediaUpload, error) {
	var result []model.MediaUpload
	for _, attachment := range attachments {
		file := attachment.ContentType == "application/vnd.microsoft.teams.file.download.info"
		if slices.Contains([]string{"text/html", "text/plain"}, attachment.ContentType) && attachment.ContentURL == "" {
			continue
		}
		endpoint := attachment.ContentURL
		if file {
			var content struct {
				URL string `json:"downloadUrl"`
			}
			if json.Unmarshal(attachment.Content, &content) != nil {
				return nil, errors.New("missing_media_url")
			}
			endpoint = content.URL
		}
		if endpoint == "" {
			return nil, errors.New("missing_media_url")
		}
		headers := make(http.Header)
		if !file && slices.Contains(c.config.TrustedServiceOrigins, common.Origin(endpoint)) {
			token, err := c.client.AccessToken(ctx)
			if err != nil {
				return nil, err
			}
			headers.Set("Authorization", "Bearer "+token)
		}
		download, err := common.Download(ctx, endpoint, common.DownloadOptions{MaxBytes: common.MediaLimit(c.host), TrustedOrigins: append(append([]string{}, c.config.TrustedServiceOrigins...), c.config.MediaOrigins...), Headers: headers, TLSClientConfig: c.options.TLSClientConfig})
		if err != nil {
			var native *common.HTTPError
			if len(headers) > 0 && errors.As(err, &native) && native.Status == 401 {
				c.client.Invalidate()
			}
			return nil, err
		}
		mimeType := attachment.ContentType
		if file {
			mimeType = download.MIMEType
		}
		name := attachment.Name
		if name == "" {
			name = "attachment.bin"
		}
		result = append(result, model.MediaUpload{Kind: common.MediaKind(mimeType), MIMEType: mimeType, FileName: name, Data: download.Data})
	}
	return result, nil
}

func (c *Channel) imageAttachment(ctx context.Context, input model.SendInput) (preparedAttachment, error) {
	media := input.Media
	endpoint := "data:" + media.Reference.MIMEType + ";base64," + base64.StdEncoding.EncodeToString(media.Data)
	if len(media.Data) > 15000 {
		if c.host.Media() == nil {
			return outcome(common.Reject("media_publication_unavailable")), nil
		}
		url, err := c.host.Media().Publish(ctx, input.ChannelID, media.Reference.ID, 10*time.Minute)
		if err != nil {
			return preparedAttachment{}, err
		}
		endpoint = url
	}
	return preparedAttachment{attachment: &attachment{ContentType: media.Reference.MIMEType, Name: media.Reference.FileName, ContentURL: endpoint}}, nil
}

func (c *Channel) richAttachment(ctx context.Context, input model.SendInput) (*attachment, error) {
	if c.host.Media() == nil || !strings.HasPrefix(c.host.PublicURL(), "https://") {
		return nil, errors.New("media_publication_unavailable")
	}
	var body []any
	for _, part := range input.Chunk.RichText {
		if part.Type == "text" {
			body = append(body, map[string]any{"type": "TextBlock", "text": part.Text, "wrap": true})
			continue
		}
		endpoint, err := c.host.Media().Publish(ctx, input.ChannelID, part.Media.ID, 10*time.Minute)
		if err != nil {
			return nil, err
		}
		if !validEndpoint(endpoint) {
			return nil, errors.New("invalid_publication_url")
		}
		label := part.Label
		if label == "" {
			label = part.Media.FileName
		}
		body = append(body, map[string]any{"type": "Image", "url": endpoint, "altText": label})
	}
	result := &attachment{ContentType: "application/vnd.microsoft.card.adaptive", Content: common.Data(map[string]any{"$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "type": "AdaptiveCard", "version": "1.2", "body": body})}
	if len(common.Data(result)) > 24000 {
		return nil, errors.New("rich_text_limit_exceeded")
	}
	return result, nil
}
