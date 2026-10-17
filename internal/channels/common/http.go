// Package common contains transport primitives shared by native channels.
// It deliberately has no routing, persistence, retry queue, or authorization.
package common

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/transport"
)

const MaxJSONBytes int64 = 4 * 1024 * 1024

type HTTPError struct {
	Status int
	Header http.Header
	Body   []byte
}

func (e *HTTPError) Error() string { return fmt.Sprintf("native_http_%d", e.Status) }

func HTTPClient(base *http.Client) *http.Client {
	client := *transport.NewClient(transport.Options{Timeout: 120 * time.Second})
	if base != nil {
		client = *base
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	return &client
}

func ReadBounded(reader io.Reader, maximum int64) ([]byte, error) {
	if maximum <= 0 {
		return nil, errors.New("invalid_body_limit")
	}
	raw, err := transport.ReadBody(reader, maximum)
	if errors.Is(err, transport.ErrResponseTooLarge) {
		return nil, errors.New("media_too_large")
	}
	return raw, err
}

func Do(client *http.Client, request *http.Request, maximum int64) ([]byte, http.Header, error) {
	response, err := HTTPClient(client).Do(request)
	if err != nil {
		return nil, nil, err
	}
	defer response.Body.Close()
	limit := maximum
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		limit = 64 * 1024
	}
	if response.ContentLength > limit {
		return nil, response.Header, errors.New("media_too_large")
	}
	raw, err := ReadBounded(response.Body, limit)
	if err != nil {
		return nil, response.Header, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, response.Header, &HTTPError{Status: response.StatusCode, Header: response.Header, Body: raw}
	}
	return raw, response.Header, nil
}

func JSON(ctx context.Context, client *http.Client, method, endpoint string, headers http.Header, input, output any) error {
	var body io.Reader
	if input != nil {
		raw, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	request.Header = headers.Clone()
	if request.Header == nil {
		request.Header = make(http.Header)
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	raw, _, err := Do(client, request, MaxJSONBytes)
	if err != nil || output == nil {
		return err
	}
	if err = json.Unmarshal(raw, output); err != nil {
		return errors.New("native_invalid_response")
	}
	return nil
}

func Multipart(ctx context.Context, client *http.Client, endpoint string, headers http.Header, fields map[string]string, field, filename string, data []byte, output any) error {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			return err
		}
	}
	part, err := writer.CreateFormFile(field, filename)
	if err != nil {
		return err
	}
	if _, err = part.Write(data); err != nil {
		return err
	}
	if err = writer.Close(); err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return err
	}
	request.Header = headers.Clone()
	if request.Header == nil {
		request.Header = make(http.Header)
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	raw, _, err := Do(client, request, MaxJSONBytes)
	if err != nil || output == nil {
		return err
	}
	if err = json.Unmarshal(raw, output); err != nil {
		return errors.New("native_invalid_response")
	}
	return nil
}

func Origin(value string) string {
	u, err := url.Parse(value)
	if err != nil {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

func Contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func RandomID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw[:])
}

func RetryAfter(header http.Header) time.Duration {
	value := header.Get("Retry-After")
	if seconds, err := strconv.ParseFloat(value, 64); err == nil && seconds > 0 {
		return time.Duration(seconds * float64(time.Second))
	}
	if at, err := http.ParseTime(value); err == nil {
		if delta := time.Until(at); delta > 0 {
			return delta
		}
	}
	return 0
}

type DownloadOptions struct {
	MaxBytes              int64
	TrustedOrigins        []string
	AllowInsecureLoopback bool
	Headers               http.Header
}

type Downloaded struct {
	Data     []byte
	MIMEType string
	FileName string
}

// Download pins the validated DNS answer for the request. Credentials are sent
// only to administrator-configured exact origins; redirects are never followed.
func Download(ctx context.Context, value string, options DownloadOptions) (Downloaded, error) {
	var result Downloaded
	u, err := url.Parse(value)
	if err != nil || u.Host == "" {
		return result, errors.New("forbidden_destination")
	}
	trusted := Contains(options.TrustedOrigins, Origin(value))
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.User != nil || u.Fragment != "" || (u.Scheme != "https" && !(trusted && loopback && options.AllowInsecureLoopback && u.Scheme == "http")) || (!trusted && len(options.Headers) > 0) {
		return result, errors.New("forbidden_destination")
	}
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	policy := transport.Options{Timeout: 120 * time.Second}
	if trusted {
		policy.AllowPrivateHosts = []string{u.Hostname()}
	}
	client := transport.NewClient(policy)
	defer client.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, value, nil)
	if err != nil {
		return result, err
	}
	request.Header = options.Headers.Clone()
	if request.Header == nil {
		request.Header = make(http.Header)
	}
	request.Header.Set("Accept-Encoding", "identity")
	raw, headers, err := Do(client, request, options.MaxBytes)
	if err != nil {
		return result, err
	}
	result.Data = raw
	result.MIMEType = strings.ToLower(strings.TrimSpace(strings.Split(headers.Get("Content-Type"), ";")[0]))
	if result.MIMEType == "" {
		result.MIMEType = "application/octet-stream"
	}
	_, params, _ := mime.ParseMediaType(headers.Get("Content-Disposition"))
	result.FileName = params["filename"]
	if result.FileName == "" {
		result.FileName = path.Base(u.Path)
	}
	return result, nil
}
