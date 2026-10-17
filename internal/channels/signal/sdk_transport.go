package signal

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/taigrr/signalcli"
)

// rpcTransport adds authorization and validates the correlation that the SDK's
// Call currently omits. JSON-RPC IDs correlate responses; signal-cli does not
// promise native idempotency from reusing one, so the SDK may generate its ID.
type rpcTransport struct {
	base    http.RoundTripper
	headers http.Header
}

func (t rpcTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.GetBody == nil {
		return nil, errors.New("rpc_request_unavailable")
	}
	body, err := request.GetBody()
	if err != nil {
		return nil, err
	}
	var input signalcli.RPCRequest
	err = json.NewDecoder(body).Decode(&input)
	body.Close()
	if err != nil || input.ID == "" {
		return nil, errors.New("rpc_request_invalid")
	}
	request = request.Clone(request.Context())
	for key, values := range t.headers {
		request.Header[key] = append([]string(nil), values...)
	}
	response, err := t.base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body) // Already bounded by SDKHTTPClient.
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &common.HTTPError{Status: response.StatusCode, Header: response.Header, Body: raw}
	}
	if err = validateRPC(raw, input.ID); err != nil {
		return nil, err
	}
	response.Body = io.NopCloser(bytes.NewReader(raw))
	return response, nil
}

func validateRPC(raw []byte, id string) error {
	var response signalcli.RPCResponse
	if json.Unmarshal(raw, &response) != nil || response.JSONRPC != "2.0" || response.ID != id {
		return errors.New("rpc_response_mismatch")
	}
	if response.Error != nil {
		return errors.New("rpc_operation_error")
	}
	if len(response.Result) == 0 || string(response.Result) == "null" {
		return errors.New("rpc_missing_result")
	}
	return nil
}
