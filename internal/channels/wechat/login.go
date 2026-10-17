package wechat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/transport"
)

// Pairing is a directly linked native client. It needs no channel registry,
// installed packages, configuration imports, or runtime plugin resolution.
// https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts
type LoginOptions struct {
	APIBase               string
	AllowInsecureLoopback bool
	HTTP                  *http.Client
	Output                string
	VerificationCodeFile  string
	Event                 func(map[string]any)
}

type Credentials struct {
	BotID      string `json:"botId"`
	BotToken   string `json:"botToken"`
	APIBaseURL string `json:"apiBaseUrl"`
	UserID     string `json:"userId"`
}

type QRCode struct {
	Code    string `json:"qrcode"`
	Content string `json:"qrcode_img_content"`
}

type LoginStatus struct {
	Status       string `json:"status"`
	BotToken     string `json:"bot_token"`
	BotID        string `json:"ilink_bot_id"`
	BaseURL      string `json:"baseurl"`
	UserID       string `json:"ilink_user_id"`
	RedirectHost string `json:"redirect_host"`
}

func loginBase(options LoginOptions) (string, error) {
	base := options.APIBase
	if base == "" {
		base = "https://ilinkai.weixin.qq.com"
	}
	u, err := TransportURL(base, options.AllowInsecureLoopback)
	if err != nil || (u != nil && u.Path != "" && u.Path != "/") {
		return "", errors.New("wechat_login_origin_invalid")
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func loginOrigin(value, initial string, insecure bool) (string, error) {
	u, err := TransportURL(value, insecure)
	if err != nil || (u != nil && u.Path != "" && u.Path != "/") {
		return "", errors.New("wechat_login_origin_invalid")
	}
	origin := u.Scheme + "://" + u.Host
	if origin == initial {
		return origin, nil
	}
	if u.Scheme != "https" || u.Port() != "" || !(u.Hostname() == "weixin.qq.com" || strings.HasSuffix(u.Hostname(), ".weixin.qq.com")) {
		return "", errors.New("wechat_login_origin_invalid")
	}
	return origin, nil
}

func BeginLogin(ctx context.Context, options LoginOptions) (QRCode, error) {
	var result QRCode
	base, err := loginBase(options)
	if err != nil {
		return result, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/ilink/bot/get_bot_qrcode?bot_type=3", bytes.NewBufferString(`{"local_token_list":[]}`))
	if err != nil {
		return result, err
	}
	if err = headers(request, false, ""); err != nil {
		return result, err
	}
	response, err := loginHTTP(options).Do(request)
	if err != nil {
		return result, err
	}
	if err = readJSON(response, &result); err != nil {
		return result, err
	}
	if result.Code == "" || result.Content == "" {
		return result, errors.New("wechat_invalid_qrcode")
	}
	return result, nil
}

func PollLogin(ctx context.Context, options LoginOptions, code, verification string) (LoginStatus, error) {
	var result LoginStatus
	base, err := loginBase(options)
	if err != nil {
		return result, err
	}
	query := url.Values{"qrcode": {code}}
	if verification != "" {
		query.Set("verify_code", verification)
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/ilink/bot/get_qrcode_status?"+query.Encode(), nil)
	if err != nil {
		return result, err
	}
	request.Header.Set("iLink-App-Id", "bot")
	request.Header.Set("iLink-App-ClientVersion", "256")
	response, err := loginHTTP(options).Do(request)
	if err != nil {
		return result, err
	}
	if err = readJSON(response, &result); err != nil {
		return result, err
	}
	switch result.Status {
	case "confirmed":
		if result.BotToken == "" || result.BotID == "" || result.UserID == "" {
			return result, errors.New("wechat_invalid_credentials")
		}
	case "wait", "scaned", "scaned_but_redirect", "expired", "need_verifycode", "verify_code_blocked", "binded_redirect":
	default:
		return result, errors.New("wechat_invalid_login_status")
	}
	return result, nil
}

func loginHTTP(options LoginOptions) *http.Client {
	if options.HTTP != nil {
		return (&Client{HTTP: options.HTTP}).httpClient()
	}
	base, _ := loginBase(options)
	policy := transport.Options{Timeout: time.Minute}
	if options.AllowInsecureLoopback {
		if parsed, err := url.Parse(base); err == nil {
			policy.AllowPrivateHosts = []string{parsed.Hostname()}
		}
	}
	return (&Client{HTTP: transport.NewClient(policy)}).httpClient()
}

func delay(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func readVerification(path string) (string, error) {
	if path == "" {
		return "", errors.New("wechat_verification_code_file_required")
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(raw))
	if len(value) < 4 || len(value) > 12 {
		return "", errors.New("wechat_verification_code_invalid")
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return "", errors.New("wechat_verification_code_invalid")
		}
	}
	return value, nil
}

func retryPoll(ctx context.Context, options LoginOptions, code, verification string) (LoginStatus, error) {
	for attempt := 0; ; attempt++ {
		result, err := PollLogin(ctx, options, code, verification)
		if err == nil || ctx.Err() != nil || attempt >= 2 {
			return result, err
		}
		var native *APIError
		if errors.As(err, &native) && native.Status != 429 && native.Status != 500 && native.Status != 502 && native.Status != 503 && native.Status != 504 {
			return result, err
		}
		if err = delay(ctx, time.Second); err != nil {
			return result, err
		}
	}
}

func Authenticate(ctx context.Context, options LoginOptions) (Credentials, error) {
	var credentials Credentials
	initial, err := loginBase(options)
	if err != nil {
		return credentials, err
	}
	options.APIBase = initial
	qr, err := BeginLogin(ctx, options)
	if err != nil {
		return credentials, err
	}
	emit := options.Event
	if emit == nil {
		emit = func(map[string]any) {}
	}
	emit(map[string]any{"event": "wechat_qrcode", "qrCode": qr.Content})
	previous, submitted := "", ""
	needsCode := false
	for ctx.Err() == nil {
		verification := ""
		if needsCode {
			verification, err = readVerification(options.VerificationCodeFile)
			if err != nil {
				return credentials, err
			}
			if verification == "" || verification == submitted {
				if err = delay(ctx, time.Second); err != nil {
					return credentials, err
				}
				continue
			}
			submitted = verification
		}
		status, err := retryPoll(ctx, options, qr.Code, verification)
		if err != nil {
			return credentials, err
		}
		if status.Status == "confirmed" {
			origin, err := loginOrigin(status.BaseURL, initial, options.AllowInsecureLoopback)
			return Credentials{BotID: status.BotID, BotToken: status.BotToken, APIBaseURL: origin, UserID: status.UserID}, err
		}
		if previous != status.Status {
			emit(map[string]any{"event": "wechat_login_status", "status": status.Status})
			previous = status.Status
		}
		if status.Status == "scaned_but_redirect" && status.RedirectHost != "" {
			options.APIBase, err = loginOrigin("https://"+status.RedirectHost, initial, options.AllowInsecureLoopback)
			if err != nil {
				return credentials, err
			}
		}
		switch status.Status {
		case "expired", "verify_code_blocked", "binded_redirect":
			return credentials, errors.New("wechat_login_" + status.Status)
		}
		needsCode = status.Status == "need_verifycode"
		if needsCode && verification != "" {
			emit(map[string]any{"event": "wechat_verification_code_rejected"})
		}
		if needsCode && options.VerificationCodeFile == "" {
			return credentials, errors.New("wechat_verification_code_file_required")
		}
		if err = delay(ctx, time.Second); err != nil {
			return credentials, err
		}
	}
	return credentials, ctx.Err()
}

// Login reserves a private file before pairing. Existing credentials are never
// overwritten; failed pairing removes only the file reserved by this call.
func Login(ctx context.Context, options LoginOptions) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if options.Output == "" {
		return errors.New("wechat_credentials_output_required")
	}
	path, err := filepath.Abs(options.Output)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		return errors.New("wechat_credentials_file_exists")
	}
	if err != nil {
		return err
	}
	saved := false
	defer func() {
		file.Close()
		if !saved {
			os.Remove(path)
		}
	}()
	credentials, err := Authenticate(ctx, options)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err = encoder.Encode(credentials); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	saved = true
	if options.Event != nil {
		options.Event(map[string]any{"ok": true, "event": "wechat_login_complete", "credentialsFile": path, "botId": credentials.BotID, "userId": credentials.UserID, "apiBaseUrl": credentials.APIBaseURL})
	}
	return nil
}
