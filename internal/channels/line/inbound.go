package line

import (
	"errors"

	"github.com/line/line-bot-sdk-go/v8/linebot/webhook"
)

// nativeMessage is the supported media/text projection of SDK webhook variants.
type nativeMessage struct {
	ID, Type, Text, QuoteToken, Filename string
	Size, Duration                       int64
	Provider                             *webhook.ContentProvider
}

type sourceData struct{ kind, user, destination string }

func nativeSource(source webhook.SourceInterface) (sourceData, error) {
	switch value := source.(type) {
	case webhook.UserSource:
		return sourceData{"user", value.UserId, value.UserId}, nil
	case webhook.GroupSource:
		return sourceData{"group", value.UserId, value.GroupId}, nil
	case webhook.RoomSource:
		return sourceData{"room", value.UserId, value.RoomId}, nil
	default:
		return sourceData{}, errors.New("invalid_source_type")
	}
}

func nativeContent(content webhook.MessageContentInterface) (nativeMessage, bool) {
	switch value := content.(type) {
	case webhook.TextMessageContent:
		return nativeMessage{ID: value.Id, Type: "text", Text: value.Text, QuoteToken: value.QuoteToken}, true
	case webhook.ImageMessageContent:
		return nativeMessage{ID: value.Id, Type: "image", QuoteToken: value.QuoteToken, Provider: value.ContentProvider}, true
	case webhook.AudioMessageContent:
		return nativeMessage{ID: value.Id, Type: "audio", Duration: value.Duration, Provider: value.ContentProvider}, true
	case webhook.VideoMessageContent:
		return nativeMessage{ID: value.Id, Type: "video", QuoteToken: value.QuoteToken, Duration: value.Duration, Provider: value.ContentProvider}, true
	case webhook.FileMessageContent:
		return nativeMessage{ID: value.Id, Type: "file", Filename: value.FileName, Size: int64(value.FileSize)}, true
	default:
		return nativeMessage{}, false
	}
}
