package speech

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/transport"
	asr "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/asr/v20190614"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tencenterrors "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
)

var formats = map[string]string{"audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/pcm": "pcm", "audio/speex": "speex", "audio/silk": "silk", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/amr": "amr", "audio/amr-wb": "amr"}

func voiceFormat(media model.StoredMedia) string {
	header := media.Data[:min(512, len(media.Data))]
	if bytes.HasPrefix(header, []byte("#!SILK_V3")) || len(header) > 1 && bytes.HasPrefix(header[1:], []byte("#!SILK_V3")) {
		return "silk"
	}
	mimeType, _, err := mime.ParseMediaType(media.Reference.MIMEType)
	if err != nil {
		return ""
	}
	mimeType = strings.ToLower(mimeType)
	if mimeType == "audio/ogg" || mimeType == "audio/opus" {
		if bytes.HasPrefix(header, []byte("OggS")) && bytes.Contains(header, []byte("OpusHead")) {
			return "ogg-opus"
		}
		return ""
	}
	return formats[mimeType]
}

// Native SentenceRecognition limits and fields are defined by Tencent's SDK:
// https://github.com/TencentCloud/tencentcloud-sdk-go/blob/master/tencentcloud/asr/v20190614/models.go
func (p *Preparer) recognize(ctx context.Context, media model.StoredMedia, options capturedOptions) (string, string) {
	format := voiceFormat(media)
	if format == "" {
		return "", "unsupported_format"
	}
	if len(media.Data) == 0 || base64.StdEncoding.EncodedLen(len(media.Data)) > 3_000_000 {
		return "", "audio_too_large"
	}
	if media.Reference.DurationMS != nil && *media.Reference.DurationMS > 60_000 {
		return "", "audio_too_long"
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	client, err := p.client(options)
	if err != nil {
		return "", "provider_unavailable"
	}
	request := asr.NewSentenceRecognitionRequest()
	request.EngSerViceType = common.StringPtr(options.Engine)
	request.SourceType = common.Uint64Ptr(1)
	request.VoiceFormat = common.StringPtr(format)
	request.Data = common.StringPtr(base64.StdEncoding.EncodeToString(media.Data))
	request.DataLen = common.Int64Ptr(int64(len(media.Data)))
	response, err := client.SentenceRecognitionWithContext(ctx, request)
	var timeout net.Error
	// The SDK preserves network causes, and its own timeout or a transport
	// deadline can fire before the recognition context reports expiration.
	if ctx.Err() != nil || errors.As(err, &timeout) && timeout.Timeout() {
		return "", "timeout"
	}
	if err != nil {
		var cloud *tencenterrors.TencentCloudSDKError
		if errors.As(err, &cloud) && cloud.Code != "ClientError.NetworkError" {
			return "", "recognition_failed"
		}
		return "", "provider_unavailable"
	}
	if response == nil || response.Response == nil || response.Response.Result == nil {
		return "", "invalid_response"
	}
	text := strings.TrimSpace(*response.Response.Result)
	if text == "" || !utf8.ValidString(text) || utf8.RuneCountInString(text) > 16_384 {
		return "", "invalid_response"
	}
	return text, ""
}

func (p *Preparer) client(options capturedOptions) (*asr.Client, error) {
	id, err := p.options.ResolveSecret(options.SecretID)
	if err != nil || strings.TrimSpace(id) == "" {
		return nil, errors.New("speech_credentials_unavailable")
	}
	key, err := p.options.ResolveSecret(options.SecretKey)
	if err != nil || strings.TrimSpace(key) == "" {
		return nil, errors.New("speech_credentials_unavailable")
	}
	settings := profile.NewClientProfile()
	settings.HttpProfile.ReqTimeout = 8
	settings.HttpProfile.Endpoint = "asr.tencentcloudapi.com"
	settings.DisableRegionBreaker = true
	client, err := asr.NewClient(common.NewCredential(id, key), options.Region, settings)
	if err != nil {
		return nil, errors.New("speech_client_unavailable")
	}
	base := p.options.HTTPClient.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	client.WithHttpTransport(speechTransport{base: base})
	return client, nil
}

type speechTransport struct{ base http.RoundTripper }

func (t speechTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Scheme != "https" || request.URL.Host != "asr.tencentcloudapi.com" || request.URL.User != nil {
		return nil, errors.New("invalid_speech_destination")
	}
	response, err := t.base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	data, err := transport.ReadBody(response.Body, 1<<20)
	_ = response.Body.Close()
	if err != nil {
		return nil, err
	}
	response.Body = io.NopCloser(bytes.NewReader(data))
	return response, nil
}
