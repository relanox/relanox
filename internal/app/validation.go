package app

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/relanox/relanox/internal/config"
)

func invalid(field, code string) error { return &config.FieldError{Field: field, Code: code} }

// These strings are explicit local validation diagnostics. Decoder errors and
// rejected values are never passed through to operators.
func nativeDiagnostic(err error) error {
	var field *config.FieldError
	if errors.As(err, &field) {
		return invalid("config."+field.Field, field.Code)
	}
	code := err.Error()
	switch code {
	case "invalid_api_base_url", "insecure_api_base_url", "missing_bot_id", "invalid_bot_id", "invalid_webhook_configuration", "invalid_websocket_configuration", "invalid_wecom_mode", "invalid_recipient_type", "invalid_feishu_identity", "invalid_feishu_domain", "invalid_dingtalk_identity", "invalid_qq_app_id", "invalid_qq_environment", "invalid_trusted_upload_origin", "invalid_teams_identity", "invalid_token_endpoint", "trusted_service_origins_required", "invalid_trusted_origin", "invalid_business_identity", "invalid_signal_identity", "invalid_service_url", "insecure_service_url", "invalid_irc_identity", "irc_tls_required", "invalid_muse_identifier", "invalid_configuration":
		return invalid("config", code)
	case "mcp.auth: unsupported_authentication":
		return invalid("config.mcp.auth", "unsupported_authentication")
	case "mcp.allowedOrigins: invalid_origin":
		return invalid("config.mcp.allowedOrigins", "invalid_origin")
	case "credentialsDirectory: invalid_path":
		return invalid("config.credentialsDirectory", "invalid_path")
	default:
		return invalid("config", "invalid_native_configuration")
	}
}

// Validate is offline. It never constructs a component or opens storage.
func Validate(cfg config.Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if err := validateListen(cfg.HTTP.Listen, false); err != nil {
		return invalid("http.listen", "invalid_listen_address")
	}
	if err := validateListen(cfg.HTTP.ManagementListen, true); err != nil {
		return invalid("http.managementListen", "loopback_address_required")
	}
	if len(cfg.Endpoints) > 0 && cfg.HTTP.PublicURL == "" {
		return invalid("http.publicUrl", "required_for_agents")
	}
	for i, account := range cfg.Accounts {
		if err := ValidateAccount(account); err != nil {
			return componentField(fmt.Sprintf("accounts[%d]", i), err)
		}
	}
	for i, endpoint := range cfg.Endpoints {
		if err := ValidateEndpoint(endpoint); err != nil {
			return componentField(fmt.Sprintf("endpoints[%d]", i), err)
		}
	}
	return nil
}

func componentField(prefix string, err error) error {
	var field *config.FieldError
	if errors.As(err, &field) {
		return invalid(prefix+"."+field.Field, field.Code)
	}
	return invalid(prefix, "invalid_configuration")
}

func validateListen(address string, management bool) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	value, err := strconv.Atoi(port)
	if err != nil || value < 0 || value > 65535 {
		return errors.New("invalid_port")
	}
	if management && strings.ToLower(host) != "localhost" {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return errors.New("loopback_required")
		}
	}
	return nil
}
