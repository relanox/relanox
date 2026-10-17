package signal

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

const maximumEvent = 1024 * 1024

// The SDK listener owns its HTTP client and has no Last-Event-ID interface.
// Keep SSE reads here so authorization, bounded frames and the accepted durable
// cursor stay under the same cancellable connection lifetime.

func (c *Channel) cursorKey() string {
	return "events:" + string(common.Data([]string{c.config.ServiceURL, c.config.Account}))
}

func validCursor(value string) bool {
	return len(value) <= 1024 && !strings.ContainsAny(value, "\r\n\x00")
}

func (c *Channel) loop(ctx context.Context) {
	for ctx.Err() == nil {
		if err := c.connect(ctx); err != nil && ctx.Err() == nil {
			c.host.Connection(model.Degraded, "native_receive_failed")
		}
		if common.Delay(ctx, time.Second) != nil {
			break
		}
	}
	c.host.Connection(model.Disconnected, "")
}

func (c *Channel) connect(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	cursor, _, err := common.ReadState[string](ctx, c.host.State(), c.cursorKey())
	if err != nil {
		return err
	}
	if !validCursor(cursor) {
		return errors.New("invalid_event_cursor")
	}
	headers, err := c.headers()
	if err != nil {
		return err
	}
	headers.Set("Accept", "text/event-stream")
	if cursor != "" {
		headers.Set("Last-Event-ID", cursor)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.config.ServiceURL+"/api/v1/events?account="+url.QueryEscape(c.config.Account), nil)
	if err != nil {
		return err
	}
	request.Header = headers
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != 200 || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		return errors.New("invalid_event_stream")
	}
	c.host.Connection(model.Connected, "")
	return consumeEvents(response.Body, func(data []byte, id string) error {
		if err := c.receive(ctx, data); err != nil && !common.PolicyRejection(err) {
			return err
		}
		if !validCursor(id) {
			return errors.New("invalid_event_cursor")
		}
		return common.SaveState(ctx, c.host.State(), c.cursorKey(), id, nil)
	})
}

// A signal-cli SSE event is acknowledged only after the complete callback
// succeeds. Connection drops therefore replay failed acceptance using its ID.
func consumeEvents(reader io.Reader, consume func([]byte, string) error) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), maximumEvent+1)
	var data strings.Builder
	event, id := "", ""
	frameSize := 0
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		frameSize += len(line) + 1
		if frameSize > maximumEvent {
			return errors.New("event_too_large")
		}
		if line == "" {
			if data.Len() > 0 && (event == "" || event == "receive") {
				if err := consume([]byte(strings.TrimSuffix(data.String(), "\n")), id); err != nil {
					return err
				}
			}
			data.Reset()
			event = ""
			frameSize = 0
			continue
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "data":
			data.WriteString(value)
			data.WriteByte('\n')
		case "event":
			event = value
		case "id":
			if strings.ContainsRune(value, '\x00') {
				return errors.New("invalid_event_cursor")
			}
			id = value
		}
	}
	return scanner.Err()
}
