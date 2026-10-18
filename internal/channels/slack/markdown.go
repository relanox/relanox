package slack

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	slackapi "github.com/slack-go/slack"
	"github.com/slack-go/slack/slackutilsx"
)

func markdown(value string) (string, []slackapi.Block) {
	var sections []slackapi.RichTextElement
	var elements []slackapi.RichTextSectionElement
	var fallback strings.Builder
	flush := func() {
		if len(elements) > 0 {
			sections = append(sections, slackapi.NewRichTextSection(elements...))
			elements = nil
		}
	}
	for _, run := range text.Runs(value) {
		fallback.WriteString(run.Text)
		if run.Href != "" && run.Href != run.Text {
			fallback.WriteString(" (" + run.Href + ")")
		}
		if run.Pre {
			flush()
			sections = append(sections, &slackapi.RichTextPreformatted{Type: slackapi.RTEPreformatted, Elements: []slackapi.RichTextSectionElement{slackapi.NewRichTextSectionTextElement(run.Text, nil)}})
			continue
		}
		elements = append(elements, markdownElement(run))
	}
	flush()
	return slackutilsx.EscapeMessage(fallback.String()), []slackapi.Block{slackapi.NewRichTextBlock("", sections...)}
}

func markdownElement(run text.Run) slackapi.RichTextSectionElement {
	var style *slackapi.RichTextSectionTextStyle
	if run.Bold || run.Italic || run.Strike || run.Code {
		style = &slackapi.RichTextSectionTextStyle{Bold: run.Bold, Italic: run.Italic, Strike: run.Strike, Code: run.Code}
	}
	if run.Href != "" {
		return slackapi.NewRichTextSectionLinkElement(run.Href, run.Text, style)
	}
	return slackapi.NewRichTextSectionTextElement(run.Text, style)
}

func markdownPayload(value string, target model.ReplyTarget) string {
	fallback, blocks := markdown(value)
	thread := target.ThreadID
	if thread == "" {
		thread = target.ReplyToID
	}
	payload := struct {
		Channel     string           `json:"channel"`
		Text        string           `json:"text"`
		Blocks      []slackapi.Block `json:"blocks"`
		Markdown    bool             `json:"mrkdwn"`
		Parse       string           `json:"parse"`
		UnfurlLinks bool             `json:"unfurl_links"`
		UnfurlMedia bool             `json:"unfurl_media"`
		Thread      string           `json:"thread_ts,omitempty"`
	}{Channel: target.ChatID, Text: fallback, Blocks: blocks, Parse: "none", Thread: thread}
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
	return strings.TrimSuffix(out.String(), "\n")
}
