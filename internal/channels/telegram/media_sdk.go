package telegram

import (
	"bytes"
	"context"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

func (c *Channel) sendMedia(ctx context.Context, client *bot.Bot, input model.SendInput, thread int, reply *models.ReplyParameters, caption text.TelegramText) (*models.Message, error) {
	if input.Media == nil || input.Media.Reference.ID != input.Chunk.Media.ID || int64(len(input.Media.Data)) != input.Media.Reference.Size {
		return nil, &apiError{code: 400}
	}
	method, _, maximum := mediaMethod(input.Media.Reference)
	if int64(len(input.Media.Data)) > min(maximum, common.MediaLimit(c.host)) {
		return nil, &apiError{code: 400}
	}
	file := &models.InputFileUpload{Filename: input.Media.Reference.FileName, Data: bytes.NewReader(input.Media.Data)}
	entities := sdkEntities(caption.Entities)
	duration := 0
	if value := input.Media.Reference.DurationMS; value != nil && *value > 0 {
		duration = int(*value / 1000)
		if *value%1000 != 0 {
			duration++
		}
	}
	switch method {
	case "sendPhoto":
		return client.SendPhoto(ctx, &bot.SendPhotoParams{ChatID: input.Target.ChatID, MessageThreadID: thread, ReplyParameters: reply, Photo: file, Caption: caption.Text, CaptionEntities: entities})
	case "sendAnimation":
		return client.SendAnimation(ctx, &bot.SendAnimationParams{ChatID: input.Target.ChatID, MessageThreadID: thread, ReplyParameters: reply, Animation: file, Caption: caption.Text, CaptionEntities: entities, Duration: duration})
	case "sendVoice":
		return client.SendVoice(ctx, &bot.SendVoiceParams{ChatID: input.Target.ChatID, MessageThreadID: thread, ReplyParameters: reply, Voice: file, Caption: caption.Text, CaptionEntities: entities, Duration: duration})
	case "sendAudio":
		return client.SendAudio(ctx, &bot.SendAudioParams{ChatID: input.Target.ChatID, MessageThreadID: thread, ReplyParameters: reply, Audio: file, Caption: caption.Text, CaptionEntities: entities, Duration: duration})
	case "sendVideo":
		return client.SendVideo(ctx, &bot.SendVideoParams{ChatID: input.Target.ChatID, MessageThreadID: thread, ReplyParameters: reply, Video: file, Caption: caption.Text, CaptionEntities: entities, Duration: duration})
	default:
		return client.SendDocument(ctx, &bot.SendDocumentParams{ChatID: input.Target.ChatID, MessageThreadID: thread, ReplyParameters: reply, Document: file, Caption: caption.Text, CaptionEntities: entities})
	}
}
