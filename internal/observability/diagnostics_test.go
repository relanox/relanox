package observability_test

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/observability"
)

// Operational logs must distinguish a retained recovery gap, unavailable media
// and operator configuration failures. A closed vocabulary missing newly added
// adapters silently reduces them all to unknown; accepting arbitrary snake-case
// diagnostics instead can leak remote tokens. Existing tests exercise WeChat and
// hyphenated untrusted values only. The public Writer sink needs no new seam.
func TestNativeAndOperatorDiagnosticsRemainRecognizableAndClosed(t *testing.T) {
	rows := []struct{ component, code, want string }{
		{"channel:discord", "gateway_resume_unavailable", "gateway_resume_unavailable"},
		{"channel:discord", "history_checkpoint_failed", "history_checkpoint_failed"},
		{"channel:discord", "history_gap_unresolved", "history_gap_unresolved"},
		{"channel:discord", "native_gateway_disconnected", "native_gateway_disconnected"},
		{"channel:slack", "slack_api_rejected", "slack_api_rejected"},
		{"channel:slack", "native_socket_refresh_requested", "native_socket_refresh_requested"},
		{"channel:matrix", "sync_gap_unresolved", "sync_gap_unresolved"},
		{"channel:matrix", "native_transaction_retained", "native_transaction_retained"},
		{"channel:googlechat", "native_message_too_large", "native_message_too_large"},
		{"channel:googlechat", "media_preparation_unavailable", "media_preparation_unavailable"},
		{"channel:googlechat", "oauth_unavailable", "oauth_unavailable"},
		{"channel:mattermost", "history_recovery_incomplete", "history_recovery_incomplete"},
		{"channel:mattermost", "history_recovery_unavailable", "history_recovery_unavailable"},
		{"channel:mattermost", "native_sequence_mismatch", "native_sequence_mismatch"},
		{"cli", "config_changed_concurrently", "config_changed_concurrently"},
		{"cli", "credential_file_permissions_failed", "credential_file_permissions_failed"},
		{"cli", "service_account_json_unreadable_or_invalid", "service_account_json_unreadable_or_invalid"},
		{"cli", "storage_inspection_failed", "storage_inspection_failed"},
		{"cli", "doctor_checks_failed", "doctor_checks_failed"},
		{"agent:grok", "grok_http_503", "grok_http_503"},
		{"agent:dot", "dot_callback_http_408", "dot_callback_http_408"},
		{"channel:mattermost", "history_recovery_private_token_123", "unknown"},
		{"channel:slack", "slack_api_private_token_123", "unknown"},
		{"agent:grok", "grok_http_999", "unknown"},
	}
	var output bytes.Buffer
	observer, err := observability.New(config.Observability{Level: "info"}, observability.Options{Writer: &output})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		observer.Log(context.Background(), "warn", "operation.failed", model.LogFields{Component: row.component, ErrorCode: row.code})
	}
	closeObserver(t, observer)
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != len(rows) {
		t.Fatalf("diagnostic records lost: %d", len(lines))
	}
	for i, line := range lines {
		var record map[string]string
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		if record["component"] != rows[i].component || record["errorCode"] != rows[i].want {
			t.Fatalf("unsafe/opaque diagnostic: %s", line)
		}
	}
	if strings.Contains(output.String(), "private_token") {
		t.Fatal("untrusted native diagnostic escaped its closed vocabulary")
	}
}
