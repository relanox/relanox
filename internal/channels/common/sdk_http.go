package common

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
)

// SDKHTTPClient gives one SDK operation the caller's lifetime and response budget.
// Status codes and headers remain available to native SDK error decoders.
func SDKHTTPClient(base *http.Client, ctx context.Context, maximum int64) *http.Client {
	client := HTTPClient(base)
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	client.Transport = sdkTransport{base: transport, ctx: ctx, maximum: maximum}
	return client
}

type sdkTransport struct {
	base    http.RoundTripper
	ctx     context.Context
	maximum int64
}

func (t sdkTransport) CloseIdleConnections() {
	if closer, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

func (t sdkTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if t.maximum <= 0 {
		closeRequestBody(request)
		return nil, errors.New("invalid_body_limit")
	}
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	stop := context.AfterFunc(t.ctx, cancel)
	defer stop()
	if err := t.ctx.Err(); err != nil {
		closeRequestBody(request)
		return nil, err
	}
	response, err := t.base.RoundTrip(request.Clone(ctx))
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	maximum := t.maximum
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		maximum = min(maximum, 64*1024)
	}
	if response.ContentLength > maximum {
		return nil, errors.New("media_too_large")
	}
	body, err := ReadBounded(response.Body, maximum)
	if err != nil {
		return nil, err
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	return response, nil
}

func closeRequestBody(request *http.Request) {
	if request.Body != nil {
		_ = request.Body.Close()
	}
}
