package slack

import (
	"bytes"
	"context"
	"io"
	"log"
	"net/http"

	"github.com/relanox/relanox/internal/channels/common"
	slackapi "github.com/slack-go/slack"
)

func (c *Channel) downloadFile(ctx context.Context, endpoint, token string) ([]byte, http.Header, error) {
	response := &downloadHTTP{client: common.SDKHTTPClient(c.http, ctx, common.MediaLimit(c.host))}
	client := slackapi.New(token, slackapi.OptionAPIURL(c.config.APIBaseURL+"/"),
		slackapi.OptionHTTPClient(response), slackapi.OptionLog(log.New(io.Discard, "", 0)))
	var data bytes.Buffer
	if err := client.GetFileContext(ctx, endpoint, &data); err != nil {
		return nil, nil, err
	}
	return data.Bytes(), response.header, nil
}

// GetFileContext writes the file but does not expose the response's MIME type.
// Capture only headers at the SDK HTTP boundary to retain the native fallback.
type downloadHTTP struct {
	client *http.Client
	header http.Header
}

func (d *downloadHTTP) Do(request *http.Request) (*http.Response, error) {
	response, err := d.client.Do(request)
	if response != nil {
		d.header = response.Header.Clone()
	}
	return response, err
}
