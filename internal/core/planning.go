package core

import (
	"slices"
	"strconv"
	"strings"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

type messagePart struct {
	text  string
	media bool
	index int
	image bool
	label string
}

type richMessage struct {
	parts       []messagePart
	attachments []model.AgentAttachment
	order       []int
}

func planMessage(source string, supplied []model.AgentAttachment) (richMessage, error) {
	message := richMessage{attachments: append([]model.AgentAttachment(nil), supplied...)}
	parts, err := text.ParseRichMarkdown(source)
	if err != nil {
		return message, err
	}
	used := map[int]bool{}
	for _, part := range parts {
		if part.Media == nil {
			message.parts = append(message.parts, messagePart{text: part.Text})
			continue
		}
		index, err := attachmentIndex(part.Media, &message, supplied)
		if err != nil {
			return message, err
		}
		if used[index] {
			return message, failure("duplicate_attachment")
		}
		used[index] = true
		message.order = append(message.order, index)
		message.parts = append(message.parts, messagePart{media: true, index: index, image: part.Media.Image, label: part.Media.Label})
	}
	for index := range message.attachments {
		if !used[index] {
			message.order = append(message.order, index)
			message.parts = append(message.parts, messagePart{media: true, index: index})
		}
	}
	return message, nil
}

func attachmentIndex(ref *text.MediaReference, message *richMessage, supplied []model.AgentAttachment) (int, error) {
	if ref.Attachment > 0 {
		if ref.Attachment > len(supplied) {
			return 0, failure("invalid_media_reference")
		}
		return ref.Attachment - 1, nil
	}
	for i, attachment := range message.attachments {
		if attachment.MediaID == ref.ID {
			return i, nil
		}
	}
	index := len(message.attachments)
	message.attachments = append(message.attachments, model.AgentAttachment{MediaID: ref.ID})
	return index, nil
}

func orderedReferences(message richMessage, refs []model.MediaReference) ([]model.MediaReference, error) {
	for _, part := range message.parts {
		if part.media && part.image && refs[part.index].Kind != model.Image {
			return nil, failure("invalid_image_reference")
		}
	}
	ordered := make([]model.MediaReference, 0, len(message.order))
	for _, index := range message.order {
		if index >= len(refs) {
			return nil, failure("invalid_media_reference")
		}
		ordered = append(ordered, refs[index])
	}
	return ordered, nil
}

type chunkBuilder struct {
	capabilities model.ChannelCapabilities
	chunks       []model.DeliveryChunk
	pending      []model.RichTextPart
	textLength   int
	imageBytes   int64
}

func (b *chunkBuilder) flush() {
	hasImage := false
	for _, part := range b.pending {
		hasImage = hasImage || part.Type == "image"
	}
	if hasImage {
		b.chunks = append(b.chunks, model.DeliveryChunk{RichText: b.pending})
	} else {
		for _, part := range b.pending {
			b.chunks = append(b.chunks, model.DeliveryChunk{Text: part.Text})
		}
	}
	b.pending = nil
	b.textLength = 0
	b.imageBytes = 0
}

func (b *chunkBuilder) add(part model.RichTextPart) {
	rich := b.capabilities.RichText
	if rich == nil {
		if part.Type == "text" {
			b.chunks = append(b.chunks, model.DeliveryChunk{Text: part.Text})
		} else {
			b.chunks = append(b.chunks, model.DeliveryChunk{Media: part.Media})
		}
		return
	}
	length, bytes := 0, int64(0)
	if part.Type == "text" {
		length = text.Length(part.Text, b.capabilities.LengthUnit)
	} else if part.Media != nil {
		bytes = part.Media.Size
	}
	if len(b.pending) >= rich.MaxParts || b.textLength+length > rich.MaxTextLength || rich.MaxTotalImageBytes > 0 && b.imageBytes+bytes > rich.MaxTotalImageBytes {
		b.flush()
	}
	b.pending = append(b.pending, part)
	b.textLength += length
	b.imageBytes += bytes
}

func (b *chunkBuilder) media(ref model.MediaReference) {
	b.flush()
	b.chunks = append(b.chunks, model.DeliveryChunk{Media: &ref})
}

func splitText(channel model.Channel, source string, target model.ReplyTarget) ([]string, error) {
	if strings.TrimSpace(source) == "" {
		return nil, nil
	}
	fragments := []string{source}
	if rich := channel.Capabilities().RichText; rich != nil {
		var err error
		fragments, err = text.SplitMarkdown(source, rich.MaxTextLength, channel.Capabilities().LengthUnit)
		if err != nil {
			return nil, err
		}
	}
	var parts []string
	for _, fragment := range fragments {
		chunks, err := channel.SplitText(fragment, target)
		if err != nil {
			return nil, err
		}
		if len(chunks) == 0 {
			return nil, failure("invalid_channel_split")
		}
		for _, chunk := range chunks {
			if chunk == "" {
				return nil, failure("invalid_channel_split")
			}
			parts = append(parts, chunk)
		}
	}
	return parts, nil
}

func deliveryPlan(channel model.Channel, deliveryID string, message richMessage, refs []model.MediaReference, target model.ReplyTarget) ([]model.DeliveryChunk, error) {
	capabilities := channel.Capabilities()
	if err := validatePlanInput(capabilities, message, refs); err != nil {
		return nil, err
	}
	return buildDeliveryPlan(channel, deliveryID, message, refs, target)
}

func validatePlanInput(capabilities model.ChannelCapabilities, message richMessage, refs []model.MediaReference) error {
	if capabilities.MaxAttachments > 0 && len(refs) > capabilities.MaxAttachments {
		return failure("media_not_supported")
	}
	for _, ref := range refs {
		if !slices.Contains(capabilities.Media.Send, ref.Kind) {
			return failure("media_not_supported")
		}
	}
	var visible strings.Builder
	for _, part := range message.parts {
		if part.media {
			visible.WriteString(part.label)
		} else {
			visible.WriteString(part.text)
		}
	}
	if capabilities.MaxTextLengthPerMessage > 0 && text.Length(visible.String(), capabilities.LengthUnit) > capabilities.MaxTextLengthPerMessage {
		return failure("reply_exceeds_channel_limit")
	}
	return nil
}

func buildDeliveryPlan(channel model.Channel, deliveryID string, message richMessage, refs []model.MediaReference, target model.ReplyTarget) ([]model.DeliveryChunk, error) {
	capabilities := channel.Capabilities()
	if channel.Kind() == model.WeCom && capabilities.Transport == model.HTTPTransport {
		message.parts = wecomOrder(message.parts)
	}
	builder := chunkBuilder{capabilities: capabilities}
	for _, part := range message.parts {
		if !part.media {
			if err := addText(&builder, channel, part.text, target); err != nil {
				return nil, err
			}
			continue
		}
		if part.index >= len(refs) {
			return nil, failure("invalid_media_reference")
		}
		if err := addMedia(&builder, channel, part, refs[part.index], target); err != nil {
			return nil, err
		}
	}
	builder.flush()
	if capabilities.MaxTextLengthPerMessage > 0 && plannedTextLength(builder.chunks, capabilities.LengthUnit) > capabilities.MaxTextLengthPerMessage {
		return nil, failure("reply_exceeds_channel_limit")
	}
	if len(builder.chunks) == 0 || capabilities.MaxChunksPerMessage > 0 && len(builder.chunks) > capabilities.MaxChunksPerMessage {
		return nil, failure("reply_exceeds_channel_limit")
	}
	for i := range builder.chunks {
		builder.chunks[i].IdempotencyKey = deliveryID + ":" + strconv.Itoa(i)
	}
	return builder.chunks, nil
}

func plannedTextLength(chunks []model.DeliveryChunk, unit model.LengthUnit) int {
	total := 0
	for _, chunk := range chunks {
		total += text.Length(chunk.Text, unit)
		for _, part := range chunk.RichText {
			if part.Type == "text" {
				total += text.Length(part.Text, unit)
			}
		}
	}
	return total
}

func addText(builder *chunkBuilder, channel model.Channel, source string, target model.ReplyTarget) error {
	parts, err := splitText(channel, source, target)
	if err != nil {
		return err
	}
	for _, part := range parts {
		builder.add(model.RichTextPart{Type: "text", Text: part})
	}
	return nil
}

func addMedia(builder *chunkBuilder, channel model.Channel, part messagePart, ref model.MediaReference, target model.ReplyTarget) error {
	if part.image {
		rich := channel.Capabilities().RichText
		if rich != nil && (len(rich.ImageMIMETypes) > 0 && !slices.Contains(rich.ImageMIMETypes, ref.MIMEType) || rich.MaxImageBytes > 0 && ref.Size > rich.MaxImageBytes || rich.MaxTotalImageBytes > 0 && ref.Size > rich.MaxTotalImageBytes) {
			builder.media(ref)
			return nil
		}
		label := part.label
		if label == "" {
			label = ref.FileName
		}
		builder.add(model.RichTextPart{Type: "image", Media: &ref, Label: label})
		return nil
	}
	if part.label != "" {
		if err := addText(builder, channel, escapeLabel(part.label), target); err != nil {
			return err
		}
	}
	builder.media(ref)
	return nil
}

func escapeLabel(label string) string {
	var out strings.Builder
	for _, r := range label {
		if strings.ContainsRune("\\`*_{}[]()#+.!>~|=-", r) {
			out.WriteByte('\\')
		}
		out.WriteRune(r)
	}
	return out.String()
}

func wecomOrder(parts []messagePart) []messagePart {
	var textParts []string
	var mediaParts []messagePart
	for _, part := range parts {
		if !part.media {
			if strings.TrimSpace(part.text) != "" {
				textParts = append(textParts, part.text)
			}
			continue
		}
		if !part.image && part.label != "" {
			textParts = append(textParts, escapeLabel(part.label))
			part.label = ""
		}
		mediaParts = append(mediaParts, part)
	}
	if len(textParts) == 0 {
		return mediaParts
	}
	return append([]messagePart{{text: strings.Join(textParts, "\n\n")}}, mediaParts...)
}
