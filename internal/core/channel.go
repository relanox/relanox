package core

import (
	"bytes"
	"context"
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/relanox/relanox/internal/model"
)

type channelHost struct {
	commonHost
	account model.AccountConfig
}

var _ model.ChannelHost = (*channelHost)(nil)

func (h *channelHost) BoundChatIDs() []string {
	seen := map[string]bool{}
	for _, binding := range h.runtime.cfg.Bindings {
		if binding.AccountID == h.account.ID {
			seen[binding.ChatID] = true
		}
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

func (h *channelHost) BoundAddresses() []model.ChannelAddress {
	addresses := make([]model.ChannelAddress, 0)
	for _, conversation := range h.runtime.configured {
		if conversation.Address.AccountID == h.account.ID {
			addresses = append(addresses, conversation.Address)
		}
	}
	slices.SortFunc(addresses, func(a, b model.ChannelAddress) int { return strings.Compare(a.ID, b.ID) })
	return addresses
}

func (h *channelHost) MaxMediaBytes() int64 { return h.runtime.cfg.Media.MaxBytes }

func (h *channelHost) Media() model.ChannelMediaHost {
	if h.runtime.cfg.HTTP.PublicURL == "" {
		return nil
	}
	return &channelMedia{runtime: h.runtime, accountID: h.account.ID}
}

// Discovery reports native addresses for configuration; it never creates an
// authorization binding or changes the sender allowlist.
func (h *channelHost) DiscoverConversation(ctx context.Context, input model.DiscoveredConversation) error {
	if !validID(input.ChatID, 1024) || !validID(input.SenderID, 1024) || len(input.ThreadID) > 1024 {
		return failure("invalid_conversation")
	}
	if !slices.Contains(h.account.AllowedSenders, input.SenderID) {
		return nil
	}
	h.runtime.observe.Count("relanox_discovered_conversations_total", model.MetricLabels{Channel: h.account.Channel, Component: "core", Operation: "discovery"}, 1)
	return h.rememberDiscovery(ctx, input)
}

func (h *channelHost) Ingest(ctx context.Context, input model.IngestInput) (model.IngestReceipt, error) {
	if !h.runtime.accepting.Load() {
		return model.IngestReceipt{}, failure("not_accepting")
	}
	binding, err := h.authorizeInput(input)
	if err != nil {
		return model.IngestReceipt{}, err
	}
	assets, err := h.inboundAssets(input.Attachments)
	if err != nil {
		return model.IngestReceipt{}, err
	}
	endpoint := h.runtime.endpoints[binding.EndpointID]
	snapshot := model.InboundSnapshot{Source: input.Source, SenderID: input.SenderID, Text: input.Text, Target: input.Target, ReceivedAt: input.ReceivedAt, Context: input.Context, Trace: input.Trace, Channel: conversationAddress(binding, endpoint, h.account.Channel), RequestID: uuid.NewString(), Endpoint: endpoint, AcceptedAt: time.Now().UTC().Truncate(time.Millisecond)}
	for _, asset := range assets {
		snapshot.Attachments = append(snapshot.Attachments, asset.Reference)
	}
	for _, preparer := range h.runtime.preparerOrder {
		plan, err := preparer.Plan(project(snapshot))
		if err != nil {
			return model.IngestReceipt{}, failure("preparation_plan_failed")
		}
		if plan == nil {
			continue
		}
		if plan.ID != preparer.ID() || len(plan.Options) > maxTextBytes || len(plan.Options) > 0 && !json.Valid(plan.Options) {
			return model.IngestReceipt{}, failure("invalid_preparation_plan")
		}
		snapshot.Preparation = append(snapshot.Preparation, *plan)
	}
	traceCtx, span := h.runtime.observe.Span(ctx, "ingest", model.LogFields{Component: "core", Operation: "ingest", ChannelID: snapshot.Channel.ID}, input.Trace)
	if span.Context() != nil {
		snapshot.Trace = span.Context()
	}
	receipt, err := h.runtime.store.AcceptInbound(traceCtx, snapshot, assets)
	outcome := "accepted"
	if receipt.Duplicate {
		outcome = "duplicate"
	}
	if err != nil {
		outcome = "failed"
	}
	span.End(outcome)
	h.runtime.observe.Count("relanox_inbound_total", model.MetricLabels{Channel: h.account.Channel, Outcome: outcome}, 1)
	if err == nil {
		h.runtime.observe.Log(ctx, "info", "inbound."+outcome, model.LogFields{Component: "core", RequestID: receipt.RequestID, Outcome: outcome})
	}
	return receipt, err
}

func (h *channelHost) authorizeInput(input model.IngestInput) (model.Binding, error) {
	if input.Source.Channel != h.account.Channel || input.Source.AccountID != h.account.ID || input.Target.Channel != h.account.Channel || input.Target.AccountID != h.account.ID {
		return model.Binding{}, failure("account_scope_mismatch")
	}
	if !validID(input.Source.EventID, 1024) || !validID(input.SenderID, 1024) || !validID(input.Target.ChatID, 1024) || len(input.Target.ThreadID) > 1024 || input.ReceivedAt.IsZero() {
		return model.Binding{}, failure("invalid_inbound_message")
	}
	if err := validText(input.Text, len(input.Attachments) > 0); err != nil {
		return model.Binding{}, err
	}
	if !validContext(input.Context, input.Target.Data) {
		return model.Binding{}, failure("invalid_message_context")
	}
	binding, ok := h.runtime.bindings[bindingKey(h.account.ID, input.Target.ChatID, input.Target.ThreadID)]
	if !ok {
		return model.Binding{}, failure("unauthorized_conversation")
	}
	if !slices.Contains(h.account.AllowedSenders, input.SenderID) || binding.AllowedSenders != nil && !slices.Contains(binding.AllowedSenders, input.SenderID) {
		return model.Binding{}, failure("unauthorized_sender")
	}
	return binding, nil
}

func validContext(value, target json.RawMessage) bool {
	values := [2]json.RawMessage{value, target}
	for i := range values {
		if len(values[i]) == 0 {
			values[i] = nil
		}
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(values) == nil && encoded.Len()-1 <= 64*1024
}

func (h *channelHost) inboundAssets(uploads []model.MediaUpload) ([]model.StoredMedia, error) {
	limits := h.runtime.cfg.Media
	if len(uploads) > limits.MaxAttachments {
		return nil, failure("too_many_attachments")
	}
	channel := h.runtime.channel(h.account.ID)
	if channel == nil {
		return nil, failure("channel_missing")
	}
	assets := make([]model.StoredMedia, 0, len(uploads))
	var total int64
	for _, upload := range uploads {
		if upload.PreviewMediaID != "" {
			return nil, failure("invalid_media_preview")
		}
		if !slices.Contains(channel.Capabilities().Media.Receive, upload.Kind) {
			return nil, failure("media_not_supported")
		}
		asset, err := storeUpload(upload, uuid.NewString(), limits.MaxBytes)
		if err != nil {
			return nil, err
		}
		total += asset.Reference.Size
		assets = append(assets, asset)
	}
	if total > limits.MaxTotalBytes {
		return nil, failure("media_total_too_large")
	}
	return assets, nil
}
