package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"

	"github.com/relanox/relanox/internal/app"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
	"github.com/spf13/cobra"
)

func (c *command) validateCommand() *cobra.Command {
	return &cobra.Command{Use: "validate", Short: "Validate configuration offline", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		cfg, err := c.load()
		if err != nil {
			return err
		}
		if err = app.Validate(cfg); err != nil {
			return err
		}
		return c.output(map[string]any{"valid": true, "config": cfg.Path}, "Configuration is valid: "+cfg.Path)
	}}
}

// Administrative reads never create an absent SQLite database as a side effect.
func openExisting(ctx context.Context, cfg config.Config) (*storage.Store, error) {
	if cfg.Storage.Driver == "sqlite" {
		info, err := os.Stat(cfg.Storage.Path)
		if err != nil || !info.Mode().IsRegular() {
			return nil, problem("database_not_initialized")
		}
	}
	store, err := storage.OpenExisting(ctx, cfg.Storage, cfg.ResolveSecret)
	if err != nil {
		if errors.Is(err, storage.ErrDatabaseUninitialized) {
			return nil, problem("database_not_initialized")
		}
		if errors.Is(err, storage.ErrIncompatibleDatabase) {
			return nil, problem("incompatible_database_requires_explicit_migration")
		}
		return nil, problem("database_unavailable")
	}
	return store, nil
}

type requestSummary struct {
	ID              string               `json:"id"`
	Version         int64                `json:"version"`
	Channel         model.ChannelAddress `json:"channel"`
	EndpointID      string               `json:"endpointId"`
	Dispatch        model.AttemptState   `json:"dispatch"`
	AcceptedAt      time.Time            `json:"acceptedAt"`
	FinalDeliveryID string               `json:"finalDeliveryId,omitempty"`
	Text            *string              `json:"text,omitempty"`
}

type deliverySummary struct {
	ID           string               `json:"id"`
	Version      int64                `json:"version"`
	ChannelID    string               `json:"channelId"`
	EndpointID   string               `json:"endpointId"`
	Status       model.DeliveryStatus `json:"status"`
	Attempts     int                  `json:"attempts"`
	ErrorCode    string               `json:"errorCode,omitempty"`
	CreatedAt    time.Time            `json:"createdAt"`
	CurrentChunk int                  `json:"currentChunk"`
	Chunks       int                  `json:"chunks"`
	Text         []string             `json:"text,omitempty"`
}

func (c *command) statusCommand() *cobra.Command {
	var filter model.StatusFilter
	var include bool
	cmd := &cobra.Command{Use: "status", Short: "Read durable queue status without connecting channels", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		if err := validateFilter(filter); err != nil {
			return err
		}
		cfg, err := c.load()
		if err != nil {
			return err
		}
		store, err := openExisting(cmd.Context(), cfg)
		if err != nil {
			return err
		}
		// Operations report their outcome before releasing this command's database handle.
		defer func() { _ = store.Close() }()
		stats, err := store.Stats(cmd.Context())
		if err != nil {
			return problem("status_unavailable")
		}
		requests, err := store.ListInbound(cmd.Context(), model.ListInboundInput{StatusFilter: filter, Recent: filter.AfterID == ""})
		if err != nil {
			return problem("status_unavailable")
		}
		deliveries, err := store.ListOutbound(cmd.Context(), filter)
		if err != nil {
			return problem("status_unavailable")
		}
		value := map[string]any{"stats": stats, "requests": summarizeRequests(requests, include), "deliveries": summarizeDeliveries(deliveries, include)}
		if c.json {
			return c.output(value, "")
		}
		if err := c.printStatus(stats, requests, deliveries); err != nil {
			return err
		}
		if include {
			return json.NewEncoder(c.options.Out).Encode(value)
		}
		return nil
	}}
	cmd.Flags().IntVar(&filter.Limit, "limit", 50, "Maximum records per list (1-1000)")
	cmd.Flags().StringVar(&filter.AfterID, "after-id", "", "Continue after this record ID")
	cmd.Flags().StringVar(&filter.EndpointID, "endpoint-id", "", "Filter by endpoint")
	cmd.Flags().Var((*attemptFlag)(&filter.DispatchStatus), "dispatch-status", "due, accepted, rejected or unknown")
	cmd.Flags().Var((*deliveryFlag)(&filter.DeliveryStatus), "delivery-status", "pending, sent, rejected or unknown")
	cmd.Flags().BoolVar(&include, "include-content", false, "Include message text in output")
	return cmd
}

func (c *command) printStatus(stats model.StorageStats, requests []model.InboundRecord, deliveries []model.OutboundRecord) error {
	if _, err := fmt.Fprintf(c.options.Out, "Pending: %d  Undelivered: %d  Unknown: %d\n", stats.Pending, stats.Undelivered, stats.Unknown); err != nil {
		return err
	}
	for _, r := range requests {
		if _, err := fmt.Fprintf(c.options.Out, "request %s version=%d status=%s endpoint=%s\n", r.Snapshot.RequestID, r.Version, r.Dispatch.Status, r.Snapshot.Endpoint.ID); err != nil {
			return err
		}
	}
	for _, r := range deliveries {
		if _, err := fmt.Fprintf(c.options.Out, "delivery %s version=%d status=%s endpoint=%s\n", r.DeliveryID, r.Version, r.Status, r.Endpoint.ID); err != nil {
			return err
		}
	}
	return nil
}

type attemptFlag model.AttemptStatus

func (v *attemptFlag) Set(s string) error { *v = attemptFlag(s); return nil }
func (v *attemptFlag) String() string     { return string(*v) }
func (*attemptFlag) Type() string         { return "status" }

type deliveryFlag model.DeliveryStatus

func (v *deliveryFlag) Set(s string) error { *v = deliveryFlag(s); return nil }
func (v *deliveryFlag) String() string     { return string(*v) }
func (*deliveryFlag) Type() string         { return "status" }

func validateFilter(f model.StatusFilter) error {
	if f.Limit < 1 || f.Limit > 1000 {
		return problem("invalid_limit")
	}
	switch f.DispatchStatus {
	case "", model.AttemptDue, model.AttemptAccepted, model.AttemptRejected, model.AttemptUnknown:
	default:
		return problem("invalid_dispatch_status")
	}
	switch f.DeliveryStatus {
	case "", model.DeliveryPending, model.DeliverySent, model.DeliveryRejected, model.DeliveryUnknown:
	default:
		return problem("invalid_delivery_status")
	}
	return nil
}

func summarizeRequests(records []model.InboundRecord, content bool) []requestSummary {
	result := make([]requestSummary, 0, len(records))
	for _, r := range records {
		v := requestSummary{ID: r.Snapshot.RequestID, Version: r.Version, Channel: r.Snapshot.Channel, EndpointID: r.Snapshot.Endpoint.ID, Dispatch: r.Dispatch, AcceptedAt: r.Snapshot.AcceptedAt, FinalDeliveryID: r.FinalDeliveryID}
		// Lease tokens fence active workers and are never operator credentials.
		v.Dispatch.Lease = nil
		if content {
			text := r.Snapshot.Text
			v.Text = &text
		}
		result = append(result, v)
	}
	return result
}

func summarizeDeliveries(records []model.OutboundRecord, content bool) []deliverySummary {
	result := make([]deliverySummary, 0, len(records))
	for _, r := range records {
		v := deliverySummary{ID: r.DeliveryID, Version: r.Version, ChannelID: r.ChannelID, EndpointID: r.Endpoint.ID, Status: r.Status, Attempts: r.Attempts, ErrorCode: r.ErrorCode, CreatedAt: r.CreatedAt, CurrentChunk: r.CurrentChunk, Chunks: len(r.Chunks)}
		if content {
			for _, chunk := range r.Chunks {
				v.Text = append(v.Text, chunk.Text)
			}
		}
		result = append(result, v)
	}
	return result
}

func (c *command) requeueCommand() *cobra.Command {
	var kind string
	var input model.RequeueInput
	cmd := &cobra.Command{Use: "requeue", Short: "Requeue one failed durable record with a version check", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		switch kind {
		case "request", "dispatch":
			input.Kind = model.DispatchWork
		case "delivery", "send":
			input.Kind = model.SendWork
		case "prepare":
			input.Kind = model.PrepareWork
		default:
			return problem("invalid_requeue_kind")
		}
		if input.ID == "" || input.ExpectedVersion < 1 {
			return problem("record_id_and_expected_version_required")
		}
		cfg, err := c.load()
		if err != nil {
			return err
		}
		store, err := openExisting(cmd.Context(), cfg)
		if err != nil {
			return err
		}
		// Operations report their outcome before releasing this command's database handle.
		defer func() { _ = store.Close() }()
		input.Now = time.Now()
		result, err := store.Requeue(cmd.Context(), input)
		if err != nil {
			return problem("requeue_failed")
		}
		if err = c.output(map[string]any{"status": result.Status, "version": result.Version}, fmt.Sprintf("%s (version %d)", result.Status, result.Version)); err != nil {
			return err
		}
		if result.Status != model.Updated {
			return problem("requeue_rejected_or_conflicted")
		}
		return nil
	}}
	cmd.Flags().StringVar(&kind, "kind", "", "request, delivery or prepare")
	cmd.Flags().StringVar(&input.ID, "id", "", "Record ID")
	cmd.Flags().Int64Var(&input.ExpectedVersion, "expected-version", 0, "Version from status")
	cmd.Flags().BoolVar(&input.AcknowledgeUnknown, "acknowledge-unknown", false, "Explicitly permit replay of an ambiguous remote effect")
	return cmd
}

func (c *command) cleanupCommand() *cobra.Command {
	var before string
	var limit int
	cmd := &cobra.Command{Use: "cleanup", Short: "Remove expired completed records within a bounded batch", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		cutoff, err := parseCutoff(before)
		if err != nil || limit < 1 || limit > 1000 {
			return problem("invalid_cleanup_bounds")
		}
		cfg, err := c.load()
		if err != nil {
			return err
		}
		store, err := openExisting(cmd.Context(), cfg)
		if err != nil {
			return err
		}
		// Operations report their outcome before releasing this command's database handle.
		defer func() { _ = store.Close() }()
		removed, err := store.Cleanup(cmd.Context(), model.CleanupInput{Before: cutoff, Limit: limit})
		if err != nil {
			return problem("cleanup_failed")
		}
		return c.output(map[string]any{"removed": removed}, fmt.Sprintf("Removed %d completed records", removed))
	}}
	cmd.Flags().StringVar(&before, "before", "", "RFC3339 timestamp or Unix milliseconds")
	cmd.Flags().IntVar(&limit, "limit", 1000, "Maximum records per storage cleanup category (1-1000)")
	return cmd
}

func parseCutoff(value string) (time.Time, error) {
	if integer, err := strconv.ParseInt(value, 10, 64); err == nil && integer > 0 {
		return time.UnixMilli(integer), nil
	}
	return time.Parse(time.RFC3339, value)
}

func (c *command) doctorCommand() *cobra.Command {
	var management string
	cmd := &cobra.Command{Use: "doctor", Short: "Check configuration, credentials and storage without connecting channels", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		cfg, err := c.load()
		if err != nil {
			return err
		}
		if err = app.Validate(cfg); err != nil {
			return err
		}
		checks := map[string]any{"configuration": "ok"}
		checks["credentials"] = checkSecrets(cfg)
		store, err := openExisting(cmd.Context(), cfg)
		if err == nil {
			health, healthErr := store.Health(cmd.Context())
			closeErr := store.Close()
			checks["storage"] = health.OK && healthErr == nil && closeErr == nil
		} else {
			checks["storage"] = false
		}
		if management != "" {
			checks["management"] = probeManagement(cmd.Context(), management)
		}
		if err = c.output(checks, fmt.Sprint(checks)); err != nil {
			return err
		}
		for _, result := range checks {
			if result == false {
				return problem("doctor_checks_failed")
			}
		}
		return nil
	}}
	cmd.Flags().StringVar(&management, "management-url", "", "Optionally probe an existing loopback management listener")
	return cmd
}

func checkSecrets(cfg config.Config) bool {
	data, _ := json.Marshal(cfg)
	var value any
	if json.Unmarshal(data, &value) != nil {
		return false
	}
	return walkSecrets(cfg, value)
}

func walkSecrets(cfg config.Config, value any) bool {
	switch v := value.(type) {
	case []any:
		for _, item := range v {
			if !walkSecrets(cfg, item) {
				return false
			}
		}
	case map[string]any:
		if env, ok := v["env"].(string); ok && len(v) <= 2 {
			file, _ := v["file"].(string)
			_, err := cfg.ResolveSecret(model.SecretRef{Env: env, File: file})
			return err == nil
		}
		if file, ok := v["file"].(string); ok && len(v) == 1 {
			_, err := cfg.ResolveSecret(model.SecretRef{File: file})
			return err == nil
		}
		for _, item := range v {
			if !walkSecrets(cfg, item) {
				return false
			}
		}
	}
	return true
}

func probeManagement(ctx context.Context, address string) bool {
	u, err := url.Parse(address)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	ip := net.ParseIP(u.Hostname())
	if u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return false
	}
	u.Path = "/health/ready"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return false
	}
	client := &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer func() { _ = response.Body.Close() }()
	return response.StatusCode == http.StatusOK
}
