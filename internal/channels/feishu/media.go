package feishu

import (
	"bytes"
	"context"
	"errors"
	"strings"

	"github.com/larksuite/oapi-sdk-go/v3/channel/normalize"
	larktypes "github.com/larksuite/oapi-sdk-go/v3/channel/types"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

func (c *Channel) downloadResources(ctx context.Context, messageID string, resources []larktypes.Resource) ([]model.MediaUpload, error) {
	var result []model.MediaUpload
	for _, resource := range resources {
		token, err := c.token(ctx)
		if err != nil {
			return nil, err
		}
		kind := "file"
		if resource.Type == "image" {
			kind = "image"
		}
		request := larkim.NewGetMessageResourceReqBuilder().MessageId(messageID).FileKey(resource.FileKey).Type(kind).Build()
		response, err := c.imClient(ctx, common.MediaLimit(c.host)).MessageResource.Get(ctx, request, larkcore.WithTenantAccessToken(token))
		if err != nil {
			return nil, err
		}
		if err := nativeError(response.ApiResp, nil); err != nil {
			return nil, err
		}
		data := response.RawBody
		mimeType := strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0])
		if mimeType == "" || mimeType == "application/octet-stream" {
			mimeType = map[string]string{"image": "image/jpeg", "audio": "audio/ogg", "video": "video/mp4"}[resource.Type]
			if mimeType == "" {
				mimeType = "application/octet-stream"
			}
		}
		name := resource.FileName
		if name == "" {
			name = resource.FileKey
		}
		media := model.MediaUpload{Kind: common.MediaKind(mimeType), MIMEType: mimeType, FileName: name, Data: data}
		if resource.DurationMs != nil && *resource.DurationMs > 0 {
			duration := int64(*resource.DurationMs)
			media.DurationMS = &duration
		}
		result = append(result, media)
	}
	return result, nil
}

func (c *Channel) uploadImage(ctx context.Context, media model.StoredMedia) (string, error) {
	token, err := c.token(ctx)
	if err != nil {
		return "", err
	}
	kind := "message"
	body := &larkim.CreateImageReqBody{ImageType: &kind, Image: namedReader{Reader: bytes.NewReader(media.Data), name: media.Reference.FileName}}
	request := larkim.NewCreateImageReqBuilder().Body(body).Build()
	response, err := c.imClient(ctx, common.MaxJSONBytes).Image.Create(ctx, request, larkcore.WithTenantAccessToken(token))
	if err != nil {
		return "", err
	}
	if err := nativeError(response.ApiResp, nil); err != nil {
		return "", err
	}
	if response.Code != 0 {
		return "", &apiError{code: response.Code}
	}
	if response.Data == nil || response.Data.ImageKey == nil || *response.Data.ImageKey == "" {
		return "", errors.New("missing_uploaded_key")
	}
	return *response.Data.ImageKey, nil
}

func mediaDuration(media model.StoredMedia) (*int64, error) {
	if media.Reference.DurationMS != nil && *media.Reference.DurationMS > 0 {
		return media.Reference.DurationMS, nil
	}
	if media.Reference.Kind != model.Audio && media.Reference.Kind != model.Video {
		return nil, nil
	}
	var duration int
	var err error
	if media.Reference.Kind == model.Audio {
		duration, err = normalize.ParseOpusDuration(bytes.NewReader(media.Data))
	} else {
		duration, err = normalize.ParseMP4Duration(bytes.NewReader(media.Data))
	}
	if err != nil || duration <= 0 {
		return nil, errors.New("missing_media_duration")
	}
	milliseconds := int64(duration)
	return &milliseconds, nil
}

func (c *Channel) uploadFile(ctx context.Context, media model.StoredMedia) (string, *int64, error) {
	token, err := c.token(ctx)
	if err != nil {
		return "", nil, err
	}
	duration, err := mediaDuration(media)
	if err != nil {
		return "", nil, err
	}
	fileType := "stream"
	if media.Reference.Kind == model.Audio {
		fileType = "opus"
	} else if media.Reference.Kind == model.Video {
		fileType = "mp4"
	}
	body := &larkim.CreateFileReqBody{FileType: &fileType, FileName: &media.Reference.FileName, File: namedReader{Reader: bytes.NewReader(media.Data), name: media.Reference.FileName}}
	if duration != nil {
		nativeDuration := int(*duration)
		if int64(nativeDuration) != *duration {
			return "", nil, errors.New("invalid_media_duration")
		}
		body.Duration = &nativeDuration
	}
	request := larkim.NewCreateFileReqBuilder().Body(body).Build()
	response, err := c.imClient(ctx, common.MaxJSONBytes).File.Create(ctx, request, larkcore.WithTenantAccessToken(token))
	if err != nil {
		return "", nil, err
	}
	if err := nativeError(response.ApiResp, nil); err != nil {
		return "", nil, err
	}
	if response.Code != 0 {
		return "", nil, &apiError{code: response.Code}
	}
	if response.Data == nil || response.Data.FileKey == nil || *response.Data.FileKey == "" {
		return "", nil, errors.New("missing_uploaded_key")
	}
	return *response.Data.FileKey, duration, nil
}

func post(rows [][]map[string]string) string {
	return string(common.Data(map[string]any{"zh_cn": map[string]any{"title": "", "content": rows}}))
}

func (c *Channel) nativeContent(ctx context.Context, input model.SendInput) (string, string, error) {
	if len(input.Chunk.RichText) > 0 {
		rows := make([][]map[string]string, 0, len(input.Chunk.RichText))
		index := 0
		for _, part := range input.Chunk.RichText {
			if part.Type == "text" {
				rows = append(rows, []map[string]string{{"tag": "md", "text": part.Text}})
				continue
			}
			key, err := c.uploadImage(ctx, input.RichMedia[index])
			index++
			if err != nil {
				return "", "", err
			}
			rows = append(rows, []map[string]string{{"tag": "img", "image_key": key}})
		}
		return post(rows), "post", nil
	}
	if input.Chunk.Media == nil {
		return post([][]map[string]string{{{"tag": "md", "text": input.Chunk.Text}}}), "post", nil
	}
	if input.Media == nil {
		return "", "", errors.New("missing_media")
	}
	media := input.Media
	if media.Reference.Kind == model.Image {
		key, err := c.uploadImage(ctx, *media)
		return string(common.Data(map[string]string{"image_key": key})), "image", err
	}
	key, duration, err := c.uploadFile(ctx, *media)
	if err != nil {
		return "", "", err
	}
	body := map[string]any{"file_key": key}
	if duration != nil {
		body["duration"] = *duration
	}
	kind := string(media.Reference.Kind)
	if kind == "video" {
		kind = "media"
		if input.Preview != nil {
			preview, err := c.uploadImage(ctx, *input.Preview)
			if err != nil {
				return "", "", err
			}
			body["image_key"] = preview
		}
	}
	return string(common.Data(body)), kind, nil
}
