package googlechat

import (
	"context"
	"errors"
	"html"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	chat "google.golang.org/api/chat/v1"
	"google.golang.org/api/googleapi"
)

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	data, code := c.sendTarget(input)
	if code != "" {
		if code == "oauth_unavailable" {
			return common.Retry(code, 0), nil
		}
		return common.Reject(code), nil
	}
	if text.Length(input.Chunk.Text, model.UTF8) > 30000 {
		return common.Reject("text_too_long"), nil
	}
	cards, err := c.cards(ctx, input)
	if err != nil {
		return common.Failure(err, true), nil
	}
	token, err := c.accessToken(ctx)
	if err != nil {
		return common.Retry("oauth_unavailable", 0), nil
	}
	message := &chat.Message{Text: input.Chunk.Text, CardsV2: cards}
	if message.Text != "" {
		message.MarkupSyntax = "MARKUP_SYNTAX_MARKDOWN"
	}
	if data.Thread != "" {
		message.Thread = &chat.Thread{Name: data.Thread}
	}
	if input.Reply != nil {
		message.QuotedMessageMetadata = data.Quote
	}
	// Native requestId provides server-side replay of the first successful create.
	// https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/create
	key := uuid.NewSHA1(uuid.NameSpaceURL, []byte("relanox/googlechat/"+c.account.ID+"/"+input.ChannelID+"/"+input.Chunk.IdempotencyKey)).String()
	call := c.service.Spaces.Messages.Create(data.Space, message).RequestId(key).Context(ctx)
	if data.Thread != "" {
		call.MessageReplyOption("REPLY_MESSAGE_OR_FAIL")
	}
	call.Header().Set("Authorization", "Bearer "+token)
	response, err := call.Do()
	if err != nil {
		return c.sendFailure(err), nil
	}
	if !messageID.MatchString(response.Name) || !strings.HasPrefix(response.Name, data.Space+"/messages/") {
		return model.SendResult{Status: model.Unknown, ErrorCode: "native_send_uncertain"}, nil
	}
	return common.Sent(response.Name), nil
}

func (c *Channel) sendTarget(input model.SendInput) (targetData, string) {
	var data targetData
	target := input.Target
	if target.Channel != model.GoogleChat || target.AccountID != c.account.ID || !validAddress(target.ChatID, target.ThreadID) || common.DecodeConfig(target.Data, &data) != nil || data.Space != target.ChatID || data.Thread != target.ThreadID || input.Chunk.IdempotencyKey == "" {
		return data, "invalid_target"
	}
	credentials, _, err := c.credentials()
	if err != nil {
		return data, "oauth_unavailable"
	}
	if data.Scope != (scope{ClientEmail: credentials.Email, APIBase: apiOrigin}) {
		return data, "target_identity_changed"
	}
	if input.Reply != nil && (!validQuote(data.Quote, target.ChatID) || data.Quote.Name != target.ReplyToID) {
		return data, "reply_context_unavailable"
	}
	return data, ""
}

func (c *Channel) invalidateToken(err error) {
	var native *googleapi.Error
	if errors.As(err, &native) && native.Code == 401 {
		c.tokens.Invalidate()
	}
}

func (c *Channel) sendFailure(err error) model.SendResult {
	var native *googleapi.Error
	if errors.As(err, &native) {
		c.invalidateToken(err)
		return common.Failure(&common.HTTPError{Status: native.Code, Header: native.Header}, false)
	}
	return common.Failure(err, false)
}

func (c *Channel) cards(ctx context.Context, input model.SendInput) ([]*chat.CardWithId, error) {
	if len(input.Chunk.RichText) == 0 && input.Chunk.Media == nil {
		return nil, nil
	}
	if c.host.Media() == nil {
		return nil, errors.New("media_publication_unavailable")
	}
	widgets := []*chat.GoogleAppsCardV1Widget{}
	if len(input.Chunk.RichText) > 0 {
		if code := common.ValidateRich(input, *c.Capabilities().RichText, model.UTF8, common.MediaLimit(c.host)); code != "" {
			return nil, errors.New(code)
		}
		for _, part := range input.Chunk.RichText {
			widget, err := c.richWidget(ctx, input.ChannelID, part)
			if err != nil {
				return nil, err
			}
			widgets = append(widgets, widget)
		}
	} else {
		if input.Media == nil || input.Media.Reference.ID != input.Chunk.Media.ID {
			return nil, errors.New("invalid_media")
		}
		value, err := c.host.Media().Publish(ctx, input.ChannelID, input.Media.Reference.ID, 24*time.Hour)
		if err != nil {
			return nil, err
		}
		ref := input.Media.Reference
		if ref.Kind == model.Image {
			widgets = append(widgets, &chat.GoogleAppsCardV1Widget{Image: &chat.GoogleAppsCardV1Image{ImageUrl: value, AltText: ref.FileName}})
		}
		widgets = append(widgets, &chat.GoogleAppsCardV1Widget{ButtonList: &chat.GoogleAppsCardV1ButtonList{Buttons: []*chat.GoogleAppsCardV1Button{{Text: ref.FileName, OnClick: &chat.GoogleAppsCardV1OnClick{OpenLink: &chat.GoogleAppsCardV1OpenLink{Url: value}}}}}})
	}
	cards := []*chat.CardWithId{{CardId: input.Chunk.IdempotencyKey, Card: &chat.GoogleAppsCardV1Card{Sections: []*chat.GoogleAppsCardV1Section{{Widgets: widgets}}}}}
	if len(common.Data(cards)) > 24000 {
		return nil, errors.New("rich_text_limit_exceeded")
	}
	return cards, nil
}

func (c *Channel) richWidget(ctx context.Context, channelID string, part model.RichTextPart) (*chat.GoogleAppsCardV1Widget, error) {
	if part.Type == "text" {
		return &chat.GoogleAppsCardV1Widget{TextParagraph: &chat.GoogleAppsCardV1TextParagraph{Text: cardText(part.Text)}}, nil
	}
	value, err := c.host.Media().Publish(ctx, channelID, part.Media.ID, 24*time.Hour)
	if err != nil {
		return nil, err
	}
	label := part.Label
	if label == "" {
		label = part.Media.FileName
	}
	return &chat.GoogleAppsCardV1Widget{Image: &chat.GoogleAppsCardV1Image{ImageUrl: value, AltText: label}}, nil
}

func cardText(value string) string {
	var output strings.Builder
	for _, run := range text.Runs(value) {
		fragment := strings.ReplaceAll(html.EscapeString(run.Text), "\n", "<br>")
		if run.Bold {
			fragment = "<b>" + fragment + "</b>"
		}
		if run.Italic {
			fragment = "<i>" + fragment + "</i>"
		}
		if run.Strike {
			fragment = "<s>" + fragment + "</s>"
		}
		if run.Href != "" {
			fragment = `<a href="` + html.EscapeString(run.Href) + `">` + fragment + "</a>"
		}
		output.WriteString(fragment)
	}
	return output.String()
}
