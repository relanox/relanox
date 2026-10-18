package config_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/config"
)

// Operator JSON must retain explicit disable switches and lifecycle budgets.
// Relation/secret tests do not check omitted settings or these configurable
// operations. Exercise the public decoder and its exported JSON contract.
func TestOperationalSettingsDefaultsAndOverrides(t *testing.T) {
	for _, fixture := range []struct {
		name, fields string
		metrics      bool
		logs         *bool
		startup      int
		shutdown     int
	}{
		{name: "defaults", metrics: true, startup: 30, shutdown: 15},
		{name: "partial", fields: `"observability":{"level":"warn"},`, metrics: true, startup: 30, shutdown: 15},
		{name: "disabled", fields: `"observability":{"logs":false,"metrics":false},"http":{"startupTimeoutSeconds":12,"shutdownTimeoutSeconds":45},`, logs: new(false), startup: 12, shutdown: 45},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			cfg, err := config.Decode([]byte(strings.Replace(validConfig, `"storage":`, fixture.fields+`"storage":`, 1)))
			if err != nil {
				t.Fatal(err)
			}
			data, err := json.Marshal(cfg)
			if err != nil {
				t.Fatal(err)
			}
			var actual struct {
				HTTP struct {
					Startup  int `json:"startupTimeoutSeconds"`
					Shutdown int `json:"shutdownTimeoutSeconds"`
				}
				Observability struct {
					Logs    *bool
					Metrics bool
				}
			}
			if err = json.Unmarshal(data, &actual); err != nil {
				t.Fatal(err)
			}
			if actual.HTTP.Startup != fixture.startup || actual.HTTP.Shutdown != fixture.shutdown || actual.Observability.Metrics != fixture.metrics {
				t.Fatalf("operational settings = %+v", actual)
			}
			if fixture.logs != nil && (actual.Observability.Logs == nil || *actual.Observability.Logs != *fixture.logs) {
				t.Fatalf("explicit log switch = %v", actual.Observability.Logs)
			}
			if cfg.Queue.SendLeaseSeconds != 630 {
				t.Fatalf("send lease = %d; must cover the 600-second native call", cfg.Queue.SendLeaseSeconds)
			}
		})
	}
}
