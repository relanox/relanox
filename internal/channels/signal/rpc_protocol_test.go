package signal

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

// The SDK Call omits JSON-RPC version/ID checks and accepts a missing result.
// Existing SSE/media success traffic cannot catch a receipt for another call
// being reported as sent. The peer only emits documented wire responses; Send
// and Resolve remain production operations with no added test-only seam.
// https://www.jsonrpc.org/specification#response_object
func TestRPCReceiptsRequireMatchingEnvelope(t *testing.T) {
	for _, fixture := range []struct {
		name, version, result string
		wrongID               bool
		status                int
		want                  model.Outcome
	}{
		{"valid", "2.0", `{"timestamp":1700000001000}`, false, 200, model.Sent},
		{"wrong-id", "2.0", `{"timestamp":1700000001000}`, true, 200, model.Unknown},
		{"wrong-version", "1.0", `{"timestamp":1700000001000}`, false, 200, model.Unknown},
		{"null-result", "2.0", `null`, false, 200, model.Unknown},
		{"http-timeout", "2.0", `{"timestamp":1700000001000}`, false, 408, model.Unknown},
		{"http-server-error", "2.0", `{"timestamp":1700000001000}`, false, 500, model.Unknown},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					ID string `json:"id"`
				}
				if json.NewDecoder(r.Body).Decode(&request) != nil || request.ID == "" {
					t.Error("invalid native request")
				}
				if fixture.wrongID {
					request.ID = "another-call"
				}
				w.WriteHeader(fixture.status)
				fmt.Fprintf(w, `{"jsonrpc":%q,"id":%q,"result":%s}`, fixture.version, request.ID, fixture.result)
			}))
			defer peer.Close()
			account := model.AccountConfig{ID: "signal", Channel: model.Signal, Config: common.Data(Config{ServiceURL: peer.URL, Account: "+12025550100", AllowInsecureLocalhost: true})}
			channel, err := New(&protocolHost{}, account, common.Options{HTTPClient: peer.Client()})
			if err != nil {
				t.Fatal(err)
			}
			resolved, err := channel.Resolve(context.Background(), model.ChannelAddress{Platform: model.Signal, AccountID: "signal", ChatID: "direct:recipient-uuid"}, nil)
			if err != nil || !resolved.Available {
				t.Fatalf("resolve: %+v %v", resolved, err)
			}
			result, err := channel.Send(context.Background(), model.SendInput{Target: *resolved.Target, Chunk: model.DeliveryChunk{Text: "hello", IdempotencyKey: "delivery-key"}})
			if err != nil || result.Status != fixture.want {
				t.Fatalf("send: %+v %v", result, err)
			}
		})
	}
}
