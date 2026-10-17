package qq

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

const chunkThreshold = 5 * 1024 * 1024
const md5PrefixBytes = 10002432

type uploadResponse struct {
	FileInfo string `json:"file_info"`
	TTL      *int64 `json:"ttl"`
}

func fileType(kind model.MediaKind) int {
	return map[model.MediaKind]int{model.Image: 1, model.Video: 2, model.Audio: 3, model.File: 4}[kind]
}

func uploadFormat(media model.StoredMedia) bool {
	formats := map[model.MediaKind][]string{model.Image: {"image/jpeg", "image/png"}, model.Audio: {"audio/silk", "audio/x-silk"}, model.Video: {"video/mp4"}}
	return media.Reference.Kind == model.File || common.Contains(formats[media.Reference.Kind], media.Reference.MIMEType)
}

func sanitizedName(name string) string {
	clean := strings.Map(func(char rune) rune {
		if char < 32 || char == 127 {
			return -1
		}
		if strings.ContainsRune(`\/:*?"<>|`, char) {
			return '_'
		}
		return char
	}, name)
	clean = strings.Join(strings.Fields(clean), " ")
	if clean == "" {
		return "file"
	}
	return clean
}

func (c *Channel) upload(ctx context.Context, input model.SendInput, target targetData) (string, error) {
	if input.Chunk.Media == nil {
		return "", nil
	}
	if input.Media == nil {
		return "", errors.New("missing_media")
	}
	media := *input.Media
	if !uploadFormat(media) {
		return "", errors.New("unsupported_media_format")
	}
	maximum := min(common.MediaLimit(c.host), int64(100*1024*1024))
	if media.Reference.Kind == model.Image {
		maximum = min(maximum, 30*1024*1024)
	}
	if media.Reference.Kind == model.Audio {
		maximum = min(maximum, 20*1024*1024)
	}
	if int64(len(media.Data)) > maximum {
		return "", errors.New("media_too_large")
	}
	var response uploadResponse
	var err error
	if len(media.Data) >= chunkThreshold {
		response, err = c.uploadChunked(ctx, input.Target.ChatID, target.Type, media)
	} else {
		response, err = c.uploadSmall(ctx, input.Target.ChatID, target.Type, media)
	}
	if err != nil {
		return "", err
	}
	if response.FileInfo == "" || response.TTL == nil || *response.TTL < 0 {
		return "", errors.New("invalid_qq_upload_response")
	}
	return response.FileInfo, nil
}

func (c *Channel) uploadSmall(ctx context.Context, chatID, kind string, media model.StoredMedia) (uploadResponse, error) {
	var response uploadResponse
	request := struct {
		FileType int    `json:"file_type"`
		Send     bool   `json:"srv_send_msg"`
		Data     string `json:"file_data"`
		FileName string `json:"file_name,omitempty"`
	}{FileType: fileType(media.Reference.Kind), Data: base64.StdEncoding.EncodeToString(media.Data)}
	if media.Reference.Kind == model.File {
		request.FileName = sanitizedName(media.Reference.FileName)
	}
	err := c.api(ctx, http.MethodPost, route(kind, chatID, "files"), request, &response)
	return response, err
}

type uploadPart struct {
	Index int    `json:"index"`
	URL   string `json:"presigned_url"`
}
type uploadPlan struct {
	ID        string       `json:"upload_id"`
	BlockSize int64        `json:"block_size"`
	Parts     []uploadPart `json:"parts"`
}

func validPlan(plan uploadPlan, size int64) bool {
	if plan.ID == "" || plan.BlockSize <= 0 || plan.BlockSize > 100*1024*1024 || len(plan.Parts) == 0 || len(plan.Parts) > 10000 {
		return false
	}
	total := (size + plan.BlockSize - 1) / plan.BlockSize
	if int64(len(plan.Parts)) != total {
		return false
	}
	seen := make(map[int]bool, len(plan.Parts))
	for _, part := range plan.Parts {
		if part.Index < 1 || int64(part.Index) > total || seen[part.Index] || !safeHTTPS(part.URL) {
			return false
		}
		seen[part.Index] = true
	}
	return true
}

// Native chunk metadata includes protocol-mandated MD5, SHA1 and the exact
// 10,002,432-byte MD5 prefix. Parts are 1-based. Preparatory upload calls cannot
// send a user-visible message (srv_send_msg=false on small uploads).
// qqbot-nodejs 1.0.5 protocol/api/media-chunked.ts and protocol/types.ts.
func (c *Channel) uploadChunked(ctx context.Context, chatID, kind string, media model.StoredMedia) (uploadResponse, error) {
	var response uploadResponse
	md5All := md5.Sum(media.Data)
	sha1All := sha1.Sum(media.Data)
	md5Prefix := md5All
	if len(media.Data) > md5PrefixBytes {
		md5Prefix = md5.Sum(media.Data[:md5PrefixBytes])
	}
	request := struct {
		FileType  int    `json:"file_type"`
		Name      string `json:"file_name"`
		Size      int64  `json:"file_size"`
		MD5       string `json:"md5"`
		SHA1      string `json:"sha1"`
		MD5Prefix string `json:"md5_10m"`
	}{FileType: fileType(media.Reference.Kind), Name: media.Reference.FileName, Size: int64(len(media.Data)), MD5: hex.EncodeToString(md5All[:]), SHA1: hex.EncodeToString(sha1All[:]), MD5Prefix: hex.EncodeToString(md5Prefix[:])}
	if media.Reference.Kind == model.File {
		request.Name = sanitizedName(request.Name)
	}
	var plan uploadPlan
	if err := c.api(ctx, http.MethodPost, route(kind, chatID, "upload_prepare"), request, &plan); err != nil {
		return response, err
	}
	if !validPlan(plan, int64(len(media.Data))) {
		return response, errors.New("invalid_upload_plan")
	}
	for _, part := range plan.Parts {
		if err := c.uploadPart(ctx, chatID, kind, media.Data, plan, part); err != nil {
			return response, err
		}
	}
	err := c.api(ctx, http.MethodPost, route(kind, chatID, "files"), struct {
		ID string `json:"upload_id"`
	}{plan.ID}, &response)
	return response, err
}

func (c *Channel) uploadPart(ctx context.Context, chatID, kind string, data []byte, plan uploadPlan, part uploadPart) error {
	start := int64(part.Index-1) * plan.BlockSize
	end := min(int64(len(data)), start+plan.BlockSize)
	fragment := data[start:end]
	if err := c.putPart(ctx, part.URL, fragment); err != nil {
		return err
	}
	checksum := md5.Sum(fragment)
	request := struct {
		ID    string `json:"upload_id"`
		Index int    `json:"part_index"`
		Size  int    `json:"block_size"`
		MD5   string `json:"md5"`
	}{plan.ID, part.Index, len(fragment), hex.EncodeToString(checksum[:])}
	return c.api(ctx, http.MethodPost, route(kind, chatID, "upload_part_finish"), request, new(struct{}))
}

func (c *Channel) putPart(ctx context.Context, endpoint string, data []byte) error {
	if !safeHTTPS(endpoint) {
		return errors.New("invalid_upload_part_origin")
	}
	client := c.uploadHTTP
	if common.Contains(c.config.TrustedUploadOrigins, common.Origin(endpoint)) {
		client = c.trustedUploadHTTP
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, bytes.NewReader(data))
	if err != nil {
		return err
	}
	// Presigned COS upload receives no QQ access token or application secret.
	_, _, err = common.Do(client, request, common.MaxJSONBytes)
	return err
}

var unsafeLabel = regexp.MustCompile(`[\\\[\]\r\n]`)

func (c *Channel) richMarkdown(ctx context.Context, input model.SendInput) (string, error) {
	if len(input.Chunk.RichText) == 0 {
		return input.Chunk.Text, nil
	}
	if c.host.Media() == nil || !strings.HasPrefix(c.host.PublicURL(), "https://") {
		return "", errors.New("media_publication_unavailable")
	}
	var fragments []string
	for _, part := range input.Chunk.RichText {
		if part.Type == "text" {
			fragments = append(fragments, part.Text)
			continue
		}
		endpoint, err := c.host.Media().Publish(ctx, input.ChannelID, part.Media.ID, 10*time.Minute)
		if err != nil {
			return "", err
		}
		if !safeHTTPS(endpoint) {
			return "", errors.New("invalid_publication_url")
		}
		label := part.Label
		if label == "" {
			label = part.Media.FileName
		}
		endpoint = strings.NewReplacer("(", "%28", ")", "%29").Replace(endpoint)
		fragments = append(fragments, "!["+unsafeLabel.ReplaceAllString(label, " ")+"]("+endpoint+")")
	}
	result := strings.Join(fragments, "\n\n")
	if len(result) > 2000 {
		return "", errors.New("rich_text_limit_exceeded")
	}
	return result, nil
}

type nativeAttachment struct {
	URL         string `json:"url,omitempty"`
	FileName    string `json:"filename,omitempty"`
	ContentType string `json:"content_type,omitempty"`
	Recognition string `json:"asr_refer_text,omitempty"`
}

func remoteURL(value string) string {
	if strings.HasPrefix(value, "//") {
		value = "https:" + value
	}
	if !safeHTTPS(value) {
		return ""
	}
	return value
}

func specificMIME(value string) string {
	parsed, _, err := mime.ParseMediaType(strings.ToLower(value))
	if err != nil || len(parsed) > 128 || !strings.Contains(parsed, "/") || parsed == "application/octet-stream" || parsed == "binary/octet-stream" {
		return ""
	}
	return parsed
}

func attachmentMIME(declared, downloaded, name string, data []byte) string {
	// Tencent voice sometimes declares AMR while delivering SILK, optionally
	// preceded by the Tencent 0x02 byte. Preserve the real codec for speech.
	if bytes.HasPrefix(data, []byte("#!SILK_V3")) || bytes.HasPrefix(data, []byte("\x02#!SILK_V3")) {
		return "audio/silk"
	}
	inferred := map[string]string{".amr": "audio/amr", ".silk": "audio/silk"}[strings.ToLower(path.Ext(name))]
	if inferred == "" {
		inferred = mime.TypeByExtension(path.Ext(name))
	}
	for _, value := range []string{declared, downloaded, inferred} {
		if result := specificMIME(value); result != "" {
			return result
		}
	}
	return "application/octet-stream"
}

type remoteImage struct {
	URL      string `json:"url"`
	FileName string `json:"fileName"`
}
type downloadedAttachments struct {
	uploads   []model.MediaUpload
	fallbacks []string
	images    []remoteImage
}

func retainAttachment(attachment nativeAttachment, result *downloadedAttachments) {
	endpoint := remoteURL(attachment.URL)
	name := attachment.FileName
	if name == "" {
		name = "attachment"
	}
	mimeType := attachmentMIME(attachment.ContentType, "", name, nil)
	if strings.HasPrefix(mimeType, "image/") && endpoint != "" {
		result.images = append(result.images, remoteImage{URL: endpoint, FileName: name})
		result.fallbacks = append(result.fallbacks, "[Image: "+endpoint+"]")
		return
	}
	if attachment.ContentType == "voice" || strings.HasPrefix(mimeType, "audio/") {
		text := strings.TrimSpace(attachment.Recognition)
		if text == "" {
			text = "[Voice message - transcription unavailable]"
		}
		result.fallbacks = append(result.fallbacks, text)
		return
	}
	result.fallbacks = append(result.fallbacks, "[Attachment: "+name+"]")
}

func (c *Channel) downloadAttachments(ctx context.Context, attachments []nativeAttachment) (downloadedAttachments, error) {
	var result downloadedAttachments
	for _, attachment := range attachments {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		media, err := c.downloadAttachment(ctx, attachment)
		if err == nil {
			result.uploads = append(result.uploads, media)
			continue
		}
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		if observer := c.host.Observer(); observer != nil {
			observer.Log(ctx, "warn", "channel_attachment_unavailable", model.LogFields{Component: "qq", ErrorCode: "media_download_failed"})
		}
		retainAttachment(attachment, &result)
	}
	return result, nil
}

func (c *Channel) downloadAttachment(ctx context.Context, attachment nativeAttachment) (model.MediaUpload, error) {
	endpoint := remoteURL(attachment.URL)
	if endpoint == "" {
		return model.MediaUpload{}, errors.New("missing_attachment_url")
	}
	download, err := common.Download(ctx, endpoint, common.DownloadOptions{MaxBytes: common.MediaLimit(c.host), TLSClientConfig: c.options.TLSClientConfig})
	if err != nil {
		return model.MediaUpload{}, err
	}
	name := attachment.FileName
	if name == "" {
		u, _ := url.Parse(endpoint)
		name = path.Base(u.Path)
	}
	if name == "" || name == "." || name == "/" {
		name = "attachment.bin"
	}
	mimeType := attachmentMIME(attachment.ContentType, download.MIMEType, name, download.Data)
	return model.MediaUpload{Kind: common.MediaKind(mimeType), MIMEType: mimeType, FileName: name, Data: download.Data}, nil
}
