package wechat

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
)

// Native numbering and identifier optionality are defined by Tencent's iLink
// protocol and current types (MIT). Message IDs are lossless uint64 strings or
// numbers; voice item=3 is different from upload media_type=4.
// https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
// https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts
type Identifier string

// UnmarshalJSON preserves native uint64 numbers and string IDs beyond the SDK's
// int64 MessageID. Polling also advances its cursor only after durable acceptance.
func (id *Identifier) UnmarshalJSON(raw []byte) error {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil
	}
	if raw[0] == '"' {
		return json.Unmarshal(raw, (*string)(id))
	}
	if _, err := strconv.ParseUint(string(raw), 10, 64); err != nil {
		return errors.New("invalid_message_id")
	}
	*id = Identifier(raw)
	return nil
}

type CDNMedia struct {
	Query       string `json:"encrypt_query_param,omitempty"`
	AESKey      string `json:"aes_key,omitempty"`
	EncryptType int    `json:"encrypt_type,omitempty"`
	FullURL     string `json:"full_url,omitempty"`
}

type Content struct {
	Media      *CDNMedia `json:"media,omitempty"`
	AESKey     string    `json:"aeskey,omitempty"`
	Text       string    `json:"text,omitempty"`
	FileName   string    `json:"file_name,omitempty"`
	Playtime   int64     `json:"playtime,omitempty"`
	EncodeType int       `json:"encode_type,omitempty"`
	Length     string    `json:"len,omitempty"`
	MidSize    int       `json:"mid_size,omitempty"`
	VideoSize  int       `json:"video_size,omitempty"`
}

type Item struct {
	Type      int        `json:"type"`
	MessageID Identifier `json:"msg_id,omitempty"`
	Text      *Content   `json:"text_item,omitempty"`
	Image     *Content   `json:"image_item,omitempty"`
	Voice     *Content   `json:"voice_item,omitempty"`
	File      *Content   `json:"file_item,omitempty"`
	Video     *Content   `json:"video_item,omitempty"`
}

type Message struct {
	ID           Identifier `json:"message_id,omitempty"`
	ClientID     string     `json:"client_id,omitempty"`
	From         string     `json:"from_user_id,omitempty"`
	To           string     `json:"to_user_id,omitempty"`
	Group        string     `json:"group_id,omitempty"`
	Type         int        `json:"message_type,omitempty"`
	State        int        `json:"message_state,omitempty"`
	CreatedAt    int64      `json:"create_time_ms,omitempty"`
	ContextToken string     `json:"context_token,omitempty"`
	Items        []Item     `json:"item_list"`
}

type Updates struct {
	Messages []Message `json:"msgs"`
	Cursor   string    `json:"get_updates_buf"`
	Timeout  int64     `json:"longpolling_timeout_ms"`
}

type APIError struct{ Status, Code int }

func (e *APIError) Error() string { return fmt.Sprintf("wechat_api_error:%d:%d", e.Status, e.Code) }

type Client struct {
	APIBase string
	CDNBase string
	Token   func() string
	HTTP    *http.Client
}

func TransportURL(value string, insecure bool) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" {
		return nil, errors.New("invalid_transport_url")
	}
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(insecure && loopback && u.Scheme == "http")) {
		return nil, errors.New("invalid_transport_url")
	}
	return u, nil
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return common.HTTPClient(c.HTTP)
	}
	return common.HTTPClient(nil)
}

func readJSON(response *http.Response, out any) error {
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &APIError{Status: response.StatusCode}
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024+1))
	if err != nil {
		return err
	}
	if len(raw) > 4*1024*1024 {
		return errors.New("wechat_response_too_large")
	}
	var status struct{ Ret, Errcode int }
	if err = json.Unmarshal(raw, &status); err != nil {
		return errors.New("wechat_invalid_response")
	}
	code := status.Ret
	if status.Ret == -14 || status.Errcode == -14 {
		return &APIError{Code: -14}
	}
	if code == 0 {
		code = status.Errcode
	}
	if code != 0 {
		return &APIError{Code: code}
	}
	return json.Unmarshal(raw, out)
}

func headers(request *http.Request, credentials bool, token string) error {
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("iLink-App-Id", "bot")
	request.Header.Set("iLink-App-ClientVersion", "256")
	if credentials {
		if token == "" || strings.ContainsAny(token, "\r\n") {
			return errors.New("missing_bot_token")
		}
		request.Header.Set("Authorization", "Bearer "+token)
	}
	request.Header.Set("AuthorizationType", "ilink_bot_token")
	var entropy [4]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return err
	}
	request.Header.Set("X-WECHAT-UIN", base64.StdEncoding.EncodeToString([]byte(strconv.FormatUint(uint64(binary.BigEndian.Uint32(entropy[:])), 10))))
	return nil
}

func (c *Client) Post(ctx context.Context, method string, body map[string]any, output any, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	body["base_info"] = map[string]string{"channel_version": "0.1.0", "bot_agent": "Relanox/0.1.0"}
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.APIBase, "/")+"/ilink/bot/"+method, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	if c.Token == nil {
		return errors.New("missing_bot_token")
	}
	if err = headers(request, true, c.Token()); err != nil {
		return err
	}
	response, err := c.httpClient().Do(request)
	if err != nil {
		return err
	}
	return readJSON(response, output)
}
