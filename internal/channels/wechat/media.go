package wechat

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/md5"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

func mediaKey(hexKey, encodedKey string) ([]byte, error) {
	if hexKey != "" {
		key, err := hex.DecodeString(hexKey)
		if err != nil || len(key) != 16 {
			return nil, errors.New("invalid_media_key")
		}
		return key, nil
	}
	if encodedKey == "" {
		return nil, nil
	}
	raw, err := base64.StdEncoding.DecodeString(encodedKey)
	if err != nil {
		return nil, errors.New("invalid_media_key")
	}
	if len(raw) == 16 {
		return raw, nil
	}
	key, err := hex.DecodeString(string(raw))
	if err != nil || len(key) != 16 {
		return nil, errors.New("invalid_media_key")
	}
	return key, nil
}

func cryptECB(data, key []byte, encrypt bool) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	if encrypt {
		n := aes.BlockSize - len(data)%aes.BlockSize
		data = append(bytes.Clone(data), bytes.Repeat([]byte{byte(n)}, n)...)
	}
	if len(data) == 0 || len(data)%aes.BlockSize != 0 {
		return nil, errors.New("invalid_media_ciphertext")
	}
	result := make([]byte, len(data))
	for offset := 0; offset < len(data); offset += aes.BlockSize {
		if encrypt {
			block.Encrypt(result[offset:], data[offset:])
		} else {
			block.Decrypt(result[offset:], data[offset:])
		}
	}
	if encrypt {
		return result, nil
	}
	n := int(result[len(result)-1])
	if n < 1 || n > aes.BlockSize || n > len(result) {
		return nil, errors.New("invalid_media_padding")
	}
	for _, value := range result[len(result)-n:] {
		if int(value) != n {
			return nil, errors.New("invalid_media_padding")
		}
	}
	return result[:len(result)-n], nil
}

func (c *Client) cdnURL(full, operation, param, filekey string) (string, error) {
	base, err := url.Parse(c.CDNBase)
	if err != nil {
		return "", errors.New("invalid_cdn_destination")
	}
	expected := strings.TrimRight(base.Path, "/") + "/" + operation
	u := *base
	u.Path = expected
	if full != "" {
		parsed, err := url.Parse(full)
		if err != nil {
			return "", errors.New("invalid_cdn_destination")
		}
		u = *parsed
	}
	if common.Origin(u.String()) != common.Origin(base.String()) || u.User != nil || u.Fragment != "" || u.Path != expected {
		return "", errors.New("invalid_cdn_destination")
	}
	if full == "" {
		query := u.Query()
		query.Set("encrypted_query_param", param)
		if filekey != "" {
			query.Set("filekey", filekey)
		}
		u.RawQuery = query.Encode()
	}
	return u.String(), nil
}

func mediaDescription(item Item) (*Content, model.MediaKind, string, string) {
	switch item.Type {
	case 2:
		return item.Image, model.Image, "image/jpeg", "image.jpg"
	case 3:
		if item.Voice == nil {
			return nil, "", "", ""
		}
		formats := map[int][2]string{5: {"audio/amr", "amr"}, 6: {"audio/silk", "silk"}, 7: {"audio/mpeg", "mp3"}, 8: {"audio/ogg", "ogg"}}
		if format, ok := formats[item.Voice.EncodeType]; ok {
			return item.Voice, model.Audio, format[0], "voice." + format[1]
		}
		return item.Voice, model.File, "application/octet-stream", "voice.bin"
	case 4:
		return item.File, model.File, "application/octet-stream", "attachment"
	case 5:
		return item.Video, model.Video, "video/mp4", "video.mp4"
	}
	return nil, "", "", ""
}

func imageFormat(data []byte) (string, string) {
	switch {
	case bytes.HasPrefix(data, []byte{137, 80, 78, 71, 13, 10, 26, 10}):
		return "image/png", "image.png"
	case bytes.HasPrefix(data, []byte("GIF87a")) || bytes.HasPrefix(data, []byte("GIF89a")):
		return "image/gif", "image.gif"
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return "image/webp", "image.webp"
	}
	return "", ""
}

func (c *Client) receiveMedia(ctx context.Context, items []Item, maxBytes int64, insecure bool) ([]model.MediaUpload, error) {
	var result []model.MediaUpload
	for _, item := range items {
		content, kind, mimeType, filename := mediaDescription(item)
		if content == nil || content.Media == nil {
			continue
		}
		ref := content.Media
		if ref.Query == "" && ref.FullURL == "" {
			continue
		}
		key, err := mediaKey(content.AESKey, ref.AESKey)
		if err != nil {
			return nil, err
		}
		if len(key) == 0 && kind != model.Image {
			continue
		}
		endpoint, err := c.cdnURL(ref.FullURL, "download", ref.Query, "")
		if err != nil {
			return nil, err
		}
		download, err := common.Download(ctx, endpoint, common.DownloadOptions{MaxBytes: maxBytes + 16, TrustedOrigins: []string{common.Origin(c.CDNBase)}, AllowInsecureLoopback: insecure})
		if err != nil {
			return nil, err
		}
		data := download.Data
		if len(key) > 0 {
			data, err = cryptECB(data, key, false)
			if err != nil {
				return nil, err
			}
		}
		if int64(len(data)) > maxBytes {
			return nil, errors.New("media_too_large")
		}
		if kind == model.Image {
			if detected, name := imageFormat(data); detected != "" {
				mimeType, filename = detected, name
			}
		}
		if content.FileName != "" {
			filename = content.FileName
		}
		asset := model.MediaUpload{Kind: kind, MIMEType: mimeType, FileName: filename, Data: data}
		if content.Playtime > 0 {
			duration := content.Playtime
			asset.DurationMS = &duration
		}
		result = append(result, asset)
	}
	return result, nil
}

func (c *Client) uploadMedia(ctx context.Context, media model.StoredMedia, recipient string) (Item, error) {
	var result Item
	key := make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		return result, err
	}
	filekey := common.RandomID()
	ciphertext, err := cryptECB(media.Data, key, true)
	if err != nil {
		return result, err
	}
	mediaType := map[model.MediaKind]int{model.Image: 1, model.Video: 2, model.File: 3}[media.Reference.Kind]
	if mediaType == 0 {
		return result, errors.New("unsupported_media_type")
	}
	digest := md5.Sum(media.Data)
	var ticket struct {
		FullURL   string `json:"upload_full_url"`
		Parameter string `json:"upload_param"`
	}
	err = c.Post(ctx, "getuploadurl", map[string]any{"filekey": filekey, "media_type": mediaType, "to_user_id": recipient, "rawsize": len(media.Data), "rawfilemd5": hex.EncodeToString(digest[:]), "filesize": len(ciphertext), "no_need_thumb": true, "aeskey": hex.EncodeToString(key)}, &ticket, 15*time.Second)
	if err != nil {
		return result, err
	}
	if ticket.FullURL == "" && ticket.Parameter == "" {
		return result, errors.New("missing_upload_url")
	}
	endpoint, err := c.cdnURL(ticket.FullURL, "upload", ticket.Parameter, filekey)
	if err != nil {
		return result, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(ciphertext))
	if err != nil {
		return result, err
	}
	request.Header.Set("Content-Type", "application/octet-stream")
	_, headers, err := common.Do(c.httpClient(), request, common.MaxJSONBytes)
	if err != nil {
		return result, err
	}
	param := headers.Get("x-encrypted-param")
	if param == "" {
		return result, errors.New("media_upload_failed")
	}
	ref := &CDNMedia{Query: param, AESKey: base64.StdEncoding.EncodeToString([]byte(hex.EncodeToString(key))), EncryptType: 1}
	switch media.Reference.Kind {
	case model.Image:
		return Item{Type: 2, Image: &Content{Media: ref, MidSize: len(ciphertext)}}, nil
	case model.Video:
		return Item{Type: 5, Video: &Content{Media: ref, VideoSize: len(ciphertext)}}, nil
	default:
		return Item{Type: 4, File: &Content{Media: ref, FileName: media.Reference.FileName, Length: strconv.Itoa(len(media.Data))}}, nil
	}
}
