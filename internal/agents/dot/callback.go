package dot

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/agentmcp"
)

func callbackURL(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || !strings.EqualFold(u.Hostname(), "connectors.api.openai.com") || u.Port() != "" && u.Port() != "443" || len(value) > 4096 {
		return "", errors.New("forbidden_destination")
	}
	u.Host = "connectors.api.openai.com"
	return u.String(), nil
}

// Standard Webhooks signature contract:
// https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
func webhookSignature(secret, eventID, timestamp string, body []byte) (string, error) {
	if !strings.HasPrefix(secret, "whsec_") {
		return "", errors.New("invalid_signing_secret")
	}
	encoded := strings.TrimPrefix(secret, "whsec_")
	key, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(key) < 24 || len(key) > 64 || base64.StdEncoding.EncodeToString(key) != encoded {
		return "", errors.New("invalid_signing_secret")
	}
	h := hmac.New(sha256.New, key)
	_, _ = h.Write([]byte(eventID + "." + timestamp + "."))
	_, _ = h.Write(body)
	return "v1," + base64.StdEncoding.EncodeToString(h.Sum(nil)), nil
}

func signedHeaders(sub subscription, eventID string, body []byte) (http.Header, error) {
	now := time.Now()
	timestamp := strconv.FormatInt(now.Unix(), 10)
	signature, err := webhookSignature(sub.Secret, eventID, timestamp, body)
	if err != nil {
		return nil, err
	}
	if sub.PreviousSecret != "" && sub.PreviousUntil > now.UnixMilli() {
		previous, err := webhookSignature(sub.PreviousSecret, eventID, timestamp, body)
		if err != nil {
			return nil, err
		}
		signature += " " + previous
	}
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	headers.Set("webhook-id", eventID)
	headers.Set("webhook-timestamp", timestamp)
	headers.Set("webhook-signature", signature)
	headers.Set("X-MCP-Subscription-Id", sub.ID)
	return headers, nil
}

func postCallback(ctx context.Context, deps agentmcp.Dependencies, sub subscription, eventID string, body []byte, readBody bool) (int, []byte, error) {
	destination, err := callbackURL(sub.URL)
	if err != nil {
		return 0, nil, err
	}
	headers, err := signedHeaders(sub, eventID, body)
	if err != nil {
		return 0, nil, err
	}
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(bounded, "POST", destination, strings.NewReader(string(body)))
	if err != nil {
		return 0, nil, err
	}
	req.Header = headers
	client := *deps.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(req)
	if err != nil {
		return 0, nil, errors.New("callback_unavailable")
	}
	defer response.Body.Close()
	if !readBody {
		return response.StatusCode, nil, nil
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 16<<10+1))
	if err != nil || len(data) > 16<<10 {
		return 0, nil, errors.New("callback_response_invalid")
	}
	return response.StatusCode, data, nil
}
