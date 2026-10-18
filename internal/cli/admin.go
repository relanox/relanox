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
	"slices"
	"strconv"
	"strings"
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
	RequestID  string               `json:"requestId"`
	AccountID  string               `json:"accountId"`
	Version    int64                `json:"version"`
	Channel    model.ChannelAddress `json:"channel"`
	EndpointID string               `json:"endpointId"`
	Dispatch   dispatchSummary      `json:"dispatch"`
	Reply      model.ReplyStatus    `json:"reply"`
	AcceptedAt int64                `json:"acceptedAt"`
	RedactedAt *int64               `json:"redactedAt,omitempty"`
	Text       *string              `json:"text,omitempty"`
}

// Operator summaries omit lease tokens and use Unix milliseconds for timestamps.
type dispatchSummary struct {
	Status    model.AttemptStatus `json:"status"`
	Attempts  int                 `json:"attempts"`
	DueAt     int64               `json:"dueAt"`
	ErrorCode string              `json:"errorCode,omitempty"`
}

type deliverySummary struct {
	DeliveryID   string                `json:"deliveryId"`
	Version      int64                 `json:"version"`
	ChannelID    string                `json:"channelId"`
	EndpointID   string                `json:"endpointId"`
	Status       model.DeliveryStatus  `json:"status"`
	Attempts     int                   `json:"attempts"`
	ErrorCode    string                `json:"errorCode,omitempty"`
	CreatedAt    int64                 `json:"createdAt"`
	DueAt        int64                 `json:"dueAt"`
	RedactedAt   *int64                `json:"redactedAt,omitempty"`
	Reply        *model.ReplyReference `json:"reply,omitempty"`
	CurrentChunk int                   `json:"currentChunk"`
	ChunkCount   int                   `json:"chunkCount"`
	Text         *string               `json:"text,omitempty"`
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
		summaries, err := summarizeRequests(cmd.Context(), store, requests, include)
		if err != nil {
			return problem("status_unavailable")
		}
		value := map[string]any{"stats": stats, "requests": summaries, "deliveries": summarizeDeliveries(deliveries, include)}
		if c.structured() {
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

func summarizeRequests(ctx context.Context, store *storage.Store, records []model.InboundRecord, content bool) ([]requestSummary, error) {
	result := make([]requestSummary, 0, len(records))
	for _, r := range records {
		var delivery *model.OutboundRecord
		if r.FinalDeliveryID != "" {
			var err error
			delivery, err = store.GetOutbound(ctx, r.FinalDeliveryID)
			if err != nil {
				return nil, err
			}
		}
		v := requestSummary{RequestID: r.Snapshot.RequestID, AccountID: r.Snapshot.Source.AccountID, Version: r.Version, Channel: r.Snapshot.Channel, EndpointID: r.Snapshot.Endpoint.ID, AcceptedAt: r.Snapshot.AcceptedAt.UnixMilli(), RedactedAt: optionalMilliseconds(r.RedactedAt), Reply: model.RequestReplyStatus(r, delivery)}
		v.Dispatch = dispatchSummary{Status: r.Dispatch.Status, Attempts: r.Dispatch.Attempts, DueAt: r.Dispatch.DueAt.UnixMilli(), ErrorCode: r.Dispatch.ErrorCode}
		if content {
			text := r.Snapshot.Text
			v.Text = &text
		}
		result = append(result, v)
	}
	return result, nil
}

func summarizeDeliveries(records []model.OutboundRecord, content bool) []deliverySummary {
	result := make([]deliverySummary, 0, len(records))
	for _, r := range records {
		v := deliverySummary{DeliveryID: r.DeliveryID, Version: r.Version, ChannelID: r.ChannelID, EndpointID: r.Endpoint.ID, Status: r.Status, Attempts: r.Attempts, ErrorCode: r.ErrorCode, CreatedAt: r.CreatedAt.UnixMilli(), DueAt: r.DueAt.UnixMilli(), RedactedAt: optionalMilliseconds(r.RedactedAt), Reply: r.Reply, CurrentChunk: r.CurrentChunk, ChunkCount: len(r.Chunks)}
		if content {
			var text strings.Builder
			for _, chunk := range r.Chunks {
				text.WriteString(chunk.Text)
			}
			value := text.String()
			v.Text = &value
		}
		result = append(result, v)
	}
	return result
}

func optionalMilliseconds(value *time.Time) *int64 {
	if value == nil {
		return nil
	}
	milliseconds := value.UnixMilli()
	return &milliseconds
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
		missing := missingSecrets(cfg)
		checks["credentials"] = len(missing) == 0
		checks["missingSecrets"] = missing
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

func missingSecrets(cfg config.Config) []string {
	data, _ := json.Marshal(cfg)
	var value any
	_ = json.Unmarshal(data, &value)
	missing := map[string]bool{}
	collectMissingSecrets(cfg, value, missing)
	result := make([]string, 0, len(missing))
	for name := range missing {
		result = append(result, name)
	}
	slices.Sort(result)
	return result
}

func collectMissingSecrets(cfg config.Config, value any, missing map[string]bool) {
	switch v := value.(type) {
	case []any:
		for _, item := range v {
			collectMissingSecrets(cfg, item, missing)
		}
	case map[string]any:
		if ref, ok := secretReference(v); ok {
			if _, err := cfg.ResolveSecret(ref); err != nil {
				addMissingReference(missing, ref)
			}
			return
		}
		for _, item := range v {
			collectMissingSecrets(cfg, item, missing)
		}
	}
}

func secretReference(value map[string]any) (model.SecretRef, bool) {
	env, hasEnv := value["env"].(string)
	file, hasFile := value["file"].(string)
	return model.SecretRef{Env: env, File: file}, hasEnv && len(value) <= 2 || hasFile && len(value) == 1
}

func addMissingReference(missing map[string]bool, ref model.SecretRef) {
	if ref.Env != "" {
		missing[ref.Env] = true
	}
	if ref.File != "" {
		missing[ref.File] = true
	}
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
