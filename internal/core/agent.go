package core

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/relanox/relanox/internal/model"
)

type agentHost struct {
	commonHost
	kind model.AgentKind
}

var _ model.AgentHost = (*agentHost)(nil)

type scopedAgent struct {
	runtime   *Runtime
	kind      model.AgentKind
	principal model.Principal
}

var _ model.ScopedAgentHost = (*scopedAgent)(nil)

func (h *agentHost) ForPrincipal(ctx context.Context, principal model.Principal) (model.ScopedAgentHost, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validID(principal.Subject, 1024) || len(principal.EndpointIDs) == 0 {
		return nil, failure("unauthorized_principal")
	}
	seen := map[string]bool{}
	var scope []string
	for _, id := range principal.EndpointIDs {
		endpoint, ok := h.runtime.endpoints[id]
		if !ok || endpoint.Agent != h.kind {
			return nil, failure("unauthorized_principal")
		}
		if !seen[id] {
			scope = append(scope, id)
			seen[id] = true
		}
	}
	return &scopedAgent{runtime: h.runtime, kind: h.kind, principal: model.Principal{Subject: principal.Subject, EndpointIDs: scope}}, nil
}

func (s *scopedAgent) Media() model.AgentMediaHost { return &agentMedia{scope: s} }

func (s *scopedAgent) authorized(ctx context.Context, id string) (*model.ConversationRecord, error) {
	current, ok := s.runtime.configured[id]
	if !ok || current.Endpoint.Agent != s.kind || !slices.Contains(s.principal.EndpointIDs, current.Endpoint.ID) {
		return nil, nil
	}
	stored, err := s.runtime.store.GetConversation(ctx, id, false)
	if err != nil {
		return nil, err
	}
	if stored == nil || !equal(stored.Address, current.Address) || !equal(stored.Endpoint, current.Endpoint) {
		return nil, nil
	}
	return stored, nil
}

func (s *scopedAgent) channelIDs() []string {
	var ids []string
	for id, conv := range s.runtime.configured {
		if conv.Endpoint.Agent == s.kind && slices.Contains(s.principal.EndpointIDs, conv.Endpoint.ID) {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	return ids
}

func (s *scopedAgent) readable(ctx context.Context, record *model.InboundRecord) (bool, error) {
	if record == nil || record.RedactedAt != nil || isFiltered(*record) || needsPreparation(*record) {
		return false, nil
	}
	conv, err := s.authorized(ctx, record.Snapshot.Channel.ID)
	return conv != nil && equal(record.Snapshot.Endpoint, conv.Endpoint) && equal(record.Snapshot.Channel, conv.Address), err
}

func (s *scopedAgent) ReadMessages(ctx context.Context, input model.ReadMessagesInput) ([]model.AgentMessage, error) {
	if input.Limit == 0 {
		input.Limit = 5
	}
	if input.Limit < 1 || input.Limit > 20 || input.RequestID != "" && input.Pending || input.Cursor != nil && !input.Pending {
		return nil, failure("invalid_message_query")
	}
	if input.RequestID != "" && !validID(input.RequestID, 1024) {
		return nil, failure("invalid_message_query")
	}
	var records []model.InboundRecord
	var err error
	switch {
	case input.Pending:
		records, err = s.runtime.store.ListPendingInbound(ctx, model.ListPendingInboundInput{ChannelIDs: s.channelIDs(), EndpointIDs: s.principal.EndpointIDs, Limit: input.Limit, Cursor: input.Cursor})
	case input.RequestID != "":
		var record *model.InboundRecord
		record, err = s.runtime.store.GetInbound(ctx, input.RequestID)
		if record != nil {
			records = append(records, *record)
		}
	default:
		records, err = s.runtime.store.ListInbound(ctx, model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: input.Limit}, ChannelIDs: s.channelIDs(), Recent: true, ReadyOnly: true})
	}
	if err != nil {
		return nil, err
	}
	out := make([]model.AgentMessage, 0, len(records))
	for _, record := range records {
		visible, err := s.readable(ctx, &record)
		if err != nil {
			return nil, err
		}
		if !visible {
			continue
		}
		message := preparedMessage(record)
		reply, err := s.runtime.replyStatus(ctx, record)
		if err != nil {
			return nil, err
		}
		message.Reply = &reply
		out = append(out, message)
	}
	return out, nil
}

func project(snapshot model.InboundSnapshot) model.AgentMessage {
	attachments := append([]model.MediaReference(nil), snapshot.Attachments...)
	for i := range attachments {
		if attachments[i].DurationMS != nil {
			value := *attachments[i].DurationMS
			attachments[i].DurationMS = &value
		}
	}
	return model.AgentMessage{RequestID: snapshot.RequestID, AcceptedAt: snapshot.AcceptedAt, Channel: snapshot.Channel, SenderID: snapshot.SenderID, Text: snapshot.Text, Context: append(json.RawMessage(nil), snapshot.Context...), Attachments: attachments}
}

func isFiltered(record model.InboundRecord) bool {
	if record.Dispatch.ErrorCode == "middleware_filtered" {
		return true
	}
	for _, result := range record.Preparation {
		if result.Status == "completed" && result.Output != nil && result.Output.Filtered {
			return true
		}
	}
	return false
}

func needsPreparation(record model.InboundRecord) bool {
	return record.RedactedAt == nil && !isFiltered(record) && len(record.Preparation) < len(record.Snapshot.Preparation)
}

func preparedMessage(record model.InboundRecord) model.AgentMessage {
	message := project(record.Snapshot)
	for _, result := range record.Preparation {
		if result.Status != "completed" || result.Output == nil || result.Output.Filtered {
			continue
		}
		message.Text = result.Output.Text
		if len(result.Output.Data) > 0 {
			if message.Extensions == nil {
				message.Extensions = map[string]json.RawMessage{}
			}
			message.Extensions[result.ID] = result.Output.Data
		}
	}
	return message
}

func (r *Runtime) replyStatus(ctx context.Context, record model.InboundRecord) (model.ReplyStatus, error) {
	status := model.RequestReplyStatus(record, nil)
	if record.FinalDeliveryID == "" || status.Status == model.Rejected {
		return status, nil
	}
	delivery, err := r.store.GetOutbound(ctx, record.FinalDeliveryID)
	if err != nil {
		return model.ReplyStatus{}, err
	}
	return model.RequestReplyStatus(record, delivery), nil
}
func (s *scopedAgent) Status(ctx context.Context, input model.StatusInput) (model.AgentStatus, error) {
	status := model.AgentStatus{MediaLimits: s.runtime.cfg.Media, Channels: []model.AgentChannelStatus{}}
	for _, id := range s.channelIDs() {
		conv, err := s.authorized(ctx, id)
		if err != nil {
			return status, err
		}
		if conv == nil {
			continue
		}
		channel := s.runtime.channel(conv.Address.AccountID)
		if channel == nil {
			continue
		}
		view, err := s.channelStatus(ctx, *conv, channel)
		if err != nil {
			return status, err
		}
		status.Channels = append(status.Channels, view)
	}
	if input.RequestID != "" {
		request, err := s.requestStatus(ctx, input.RequestID)
		if err != nil {
			return status, err
		}
		status.Request = request
	}
	if input.DeliveryID != "" {
		delivery, err := s.deliveryStatus(ctx, input.DeliveryID)
		if err != nil {
			return status, err
		}
		status.Delivery = delivery
	}
	return status, nil
}

func (s *scopedAgent) channelStatus(ctx context.Context, conv model.ConversationRecord, channel model.Channel) (model.AgentChannelStatus, error) {
	c := channel.Capabilities()
	resolution, err := channel.Resolve(ctx, conv.Address, conv.Target)
	if err != nil {
		return model.AgentChannelStatus{}, err
	}
	availability := model.ChannelAvailability{Status: "unavailable", Reason: resolution.Reason}
	if resolution.Available {
		availability = model.ChannelAvailability{Status: "available"}
	}
	prefix := "/channels/" + string(conv.Address.Platform) + "/" + conv.Address.AccountID
	s.runtime.mu.RLock()
	connection := s.runtime.connections[prefix]
	s.runtime.mu.RUnlock()
	if connection == "" {
		connection = model.Disconnected
	}
	richMode := "sequential"
	if len(c.Media.Send) == 0 {
		richMode = "text-only"
	}
	if c.RichText != nil {
		richMode = "native"
	}
	if conv.Address.Platform == model.WeCom && c.Transport == model.HTTPTransport {
		richMode = "text-then-images"
	}
	maximum := s.runtime.cfg.Media.MaxAttachments
	if c.MaxAttachments > 0 {
		maximum = min(maximum, c.MaxAttachments)
	}
	return model.AgentChannelStatus{Channel: conv.Address, Connection: connection, Send: availability, Media: append([]model.MediaKind{}, c.Media.Send...), RichText: richMode, RichTextLimits: c.RichText, MaxTextLength: c.MaxTextLength, LengthUnit: c.LengthUnit, MaxTextLengthPerMessage: c.MaxTextLengthPerMessage, MaxChunksPerMessage: c.MaxChunksPerMessage, MaxAttachments: maximum}, nil
}

func (s *scopedAgent) requestStatus(ctx context.Context, id string) (*model.RequestStatus, error) {
	if !validID(id, 1024) {
		return nil, failure("invalid_request_id")
	}
	record, err := s.runtime.store.GetInbound(ctx, id)
	if err != nil || record == nil {
		return nil, err
	}
	conv, err := s.authorized(ctx, record.Snapshot.Channel.ID)
	if err != nil || conv == nil || !equal(record.Snapshot.Endpoint, conv.Endpoint) {
		return nil, err
	}
	reply, err := s.runtime.replyStatus(ctx, *record)
	if err != nil {
		return nil, err
	}
	return &model.RequestStatus{ID: id, Reply: reply}, nil
}

func (s *scopedAgent) deliveryStatus(ctx context.Context, id string) (*model.DeliverySummary, error) {
	if !validID(id, 1024) {
		return nil, failure("invalid_delivery_id")
	}
	record, err := s.runtime.store.GetOutbound(ctx, id)
	if err != nil || record == nil {
		return nil, err
	}
	conv, err := s.authorized(ctx, record.ChannelID)
	if err != nil || conv == nil || !equal(record.Endpoint, conv.Endpoint) {
		return nil, err
	}
	return &model.DeliverySummary{ID: id, Channel: record.ChannelID, Status: record.Status, ErrorCode: record.ErrorCode}, nil
}
