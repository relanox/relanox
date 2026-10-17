package dingtalk

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"

	robot "github.com/alibabacloud-go/dingtalk/robot_1_0"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

type nativeContent struct {
	DownloadCode        string          `json:"downloadCode,omitempty"`
	PictureDownloadCode string          `json:"pictureDownloadCode,omitempty"`
	FileName            string          `json:"fileName,omitempty"`
	Recognition         string          `json:"recognition,omitempty"`
	Duration            int64           `json:"duration,omitempty"`
	Text                string          `json:"text,omitempty"`
	Type                string          `json:"type,omitempty"`
	RichText            []nativeContent `json:"richText,omitempty"`
}

func (c *Channel) download(ctx context.Context, content nativeContent, token string) (model.MediaUpload, error) {
	var media model.MediaUpload
	code := content.DownloadCode
	if code == "" {
		code = content.PictureDownloadCode
	}
	if code == "" {
		return media, errors.New("missing_download_code")
	}
	request := robot.RobotMessageFileDownloadRequest{DownloadCode: &code, RobotCode: &c.config.RobotCode}
	var response robot.RobotMessageFileDownloadResponseBody
	if err := common.JSON(ctx, c.options.HTTPClient, http.MethodPost, apiBase+"/v1.0/robot/messageFiles/download", http.Header{"x-acs-dingtalk-access-token": {token}}, request, &response); err != nil {
		return media, err
	}
	if response.DownloadUrl == nil || *response.DownloadUrl == "" {
		return media, errors.New("missing_download_url")
	}
	download, err := common.Download(ctx, *response.DownloadUrl, common.DownloadOptions{MaxBytes: common.MediaLimit(c.host), TLSClientConfig: c.options.TLSClientConfig})
	if err != nil {
		return media, err
	}
	filename := content.FileName
	if filename == "" {
		filename = download.FileName
	}
	if filename == "" {
		filename = "attachment.bin"
	}
	media = model.MediaUpload{Data: download.Data, MIMEType: download.MIMEType, Kind: common.MediaKind(download.MIMEType), FileName: filename}
	if content.Duration > 0 {
		media.DurationMS = &content.Duration
	}
	return media, nil
}

func (c *Channel) upload(ctx context.Context, media model.StoredMedia, token string) (string, error) {
	endpoint, _ := url.Parse(uploadBase + "/media/upload")
	query := endpoint.Query()
	query.Set("access_token", token)
	kind := string(media.Reference.Kind)
	if kind == "audio" {
		kind = "voice"
	}
	query.Set("type", kind)
	endpoint.RawQuery = query.Encode()
	var response struct {
		ErrorCode int    `json:"errcode"`
		MediaID   string `json:"media_id"`
	}
	if err := common.Multipart(ctx, c.options.HTTPClient, endpoint.String(), nil, nil, "media", media.Reference.FileName, media.Data, &response); err != nil {
		return "", err
	}
	if response.ErrorCode != 0 {
		return "", &uploadError{code: response.ErrorCode}
	}
	if response.MediaID == "" {
		return "", errors.New("media_upload_failed")
	}
	return response.MediaID, nil
}

type uploadError struct{ code int }

func (e *uploadError) Error() string { return "native_media_upload_rejected" }

type messagePayload struct {
	Key        string
	Parameters string
}

func payload(key string, data any) messagePayload {
	return messagePayload{Key: key, Parameters: string(common.Data(data))}
}

func richOverhead(input model.SendInput) string {
	if len(input.Chunk.RichText) == 0 {
		return ""
	}
	length := len(input.Chunk.RichText) * 2
	for _, part := range input.Chunk.RichText {
		if part.Type == "text" {
			length += len(part.Text)
		} else if part.Media != nil {
			label := part.Label
			if label == "" {
				label = part.Media.FileName
			}
			length += len(label) + 264
		}
	}
	if length > 4000 {
		return "rich_text_limit_exceeded"
	}
	return ""
}

var mediaIDPattern = regexp.MustCompile(`^[-@A-Za-z0-9_=]{1,256}$`)
var unsafeLabel = regexp.MustCompile(`[\\\[\]\r\n]`)

func (c *Channel) richMessage(ctx context.Context, input model.SendInput, token string) (messagePayload, error) {
	var fragments []string
	index := 0
	for _, part := range input.Chunk.RichText {
		if part.Type == "text" {
			fragments = append(fragments, part.Text)
			continue
		}
		mediaID, err := c.upload(ctx, input.RichMedia[index], token)
		index++
		if err != nil {
			return messagePayload{}, err
		}
		if !mediaIDPattern.MatchString(mediaID) {
			return messagePayload{}, errors.New("invalid_media_id")
		}
		label := part.Label
		if label == "" {
			label = part.Media.FileName
		}
		fragments = append(fragments, "!["+unsafeLabel.ReplaceAllString(label, " ")+"]("+mediaID+")")
	}
	text := strings.Join(fragments, "\n\n")
	if len(text) > 4000 {
		return messagePayload{}, errors.New("rich_text_limit_exceeded")
	}
	return payload("sampleMarkdown", map[string]string{"title": "Relanox", "text": text}), nil
}

func (c *Channel) message(ctx context.Context, input model.SendInput, token string) (messagePayload, error) {
	if len(input.Chunk.RichText) > 0 {
		return c.richMessage(ctx, input, token)
	}
	if input.Chunk.Media == nil {
		return payload("sampleMarkdown", map[string]string{"title": "Relanox", "text": input.Chunk.Text}), nil
	}
	if input.Media == nil {
		return messagePayload{}, errors.New("missing_media")
	}
	media := input.Media
	if (media.Reference.Kind == model.Audio || media.Reference.Kind == model.Video) && (media.Reference.DurationMS == nil || *media.Reference.DurationMS <= 0) {
		return messagePayload{}, errors.New("missing_media_duration")
	}
	if media.Reference.Kind == model.Video && input.Preview == nil {
		return messagePayload{}, errors.New("missing_video_preview")
	}
	mediaID, err := c.upload(ctx, *media, token)
	if err != nil {
		return messagePayload{}, err
	}
	switch media.Reference.Kind {
	case model.Image:
		return payload("sampleImageMsg", map[string]string{"photoURL": mediaID}), nil
	case model.Audio:
		return payload("sampleAudio", map[string]string{"mediaId": mediaID, "duration": strconv.FormatInt(*media.Reference.DurationMS, 10)}), nil
	case model.Video:
		preview, err := c.upload(ctx, *input.Preview, token)
		if err != nil {
			return messagePayload{}, err
		}
		return payload("sampleVideo", map[string]string{"videoMediaId": mediaID, "picMediaId": preview, "videoType": "mp4", "duration": strconv.FormatInt((*media.Reference.DurationMS+999)/1000, 10)}), nil
	default:
		return payload("sampleFile", map[string]string{"mediaId": mediaID, "fileName": media.Reference.FileName, "fileType": strings.TrimPrefix(path.Ext(media.Reference.FileName), ".")}), nil
	}
}

func (c *Channel) receiveContent(ctx context.Context, message nativeMessage) (string, []model.MediaUpload, error) {
	text := ""
	if message.Text != nil {
		text = message.Text.Content
	}
	if message.Type == "text" {
		return text, nil, nil
	}
	if message.Content == nil {
		return "", nil, nil
	}
	if text == "" {
		text = message.Content.Recognition
	}
	token, err := c.token(ctx)
	if err != nil {
		return "", nil, err
	}
	items := message.Content.RichText
	if len(items) == 0 {
		items = []nativeContent{*message.Content}
	}
	var attachments []model.MediaUpload
	for _, item := range items {
		text += item.Text
		if item.DownloadCode == "" && item.PictureDownloadCode == "" {
			continue
		}
		media, err := c.download(ctx, item, token)
		if err != nil {
			return "", nil, err
		}
		attachments = append(attachments, media)
	}
	if text == "" && len(attachments) == 0 {
		return "", nil, errors.New("missing_media_content")
	}
	return text, attachments, nil
}
