package dingtalk

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	oauth "github.com/alibabacloud-go/dingtalk/oauth2_1_0"
	robot "github.com/alibabacloud-go/dingtalk/robot_1_0"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

const apiBase = "https://api.dingtalk.com"
const uploadBase = "https://oapi.dingtalk.com"

type Config struct {
	ClientID       string            `json:"clientId"`
	ClientSecret   model.SecretRef   `json:"clientSecret"`
	RobotCode      string            `json:"robotCode"`
	RecipientTypes map[string]string `json:"recipientTypes,omitempty"`
}

func parseConfig(raw json.RawMessage) (Config, error) {
	var c Config
	if err := common.DecodeConfig(raw, &c); err != nil {
		return c, err
	}
	if c.ClientID == "" || c.RobotCode == "" {
		return c, errors.New("invalid_dingtalk_identity")
	}
	if err := config.ValidateSecretRef(c.ClientSecret, "clientSecret"); err != nil {
		return c, err
	}
	for id, kind := range c.RecipientTypes {
		if id == "" || !common.Contains([]string{"single", "group"}, kind) {
			return c, errors.New("invalid_recipient_type")
		}
	}
	return c, nil
}

func ValidateConfig(raw json.RawMessage) error { _, err := parseConfig(raw); return err }

type Channel struct {
	host         model.ChannelHost
	account      model.AccountConfig
	config       Config
	options      common.Options
	lifecycle    common.Lifecycle
	callbacks    sync.WaitGroup
	callbackGate chan struct{}
}

func New(host model.ChannelHost, account model.AccountConfig, options common.Options) (*Channel, error) {
	cfg, err := parseConfig(account.Config)
	if err != nil {
		return nil, err
	}
	if account.Channel != model.DingTalk || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	return &Channel{host: host, account: account, config: cfg, options: options, callbackGate: make(chan struct{}, 32)}, nil
}

func (c *Channel) Kind() model.ChannelKind { return model.DingTalk }

var richLimits = model.RichTextLimits{MaxParts: 20, MaxTextLength: 2000}

func (c *Channel) Capabilities() model.ChannelCapabilities {
	limits := richLimits
	return model.ChannelCapabilities{Transport: model.ConnectionTransport, MaxTextLength: 4000, LengthUnit: model.UTF8, RichText: &limits, Media: model.MediaCapabilities{Receive: common.AllMedia(), Send: common.AllMedia()}}
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitMarkdown(value, 4000, model.UTF8)
}

func (c *Channel) Start(ctx context.Context) error { return c.lifecycle.Start(ctx, c.connect) }

func (c *Channel) Close(ctx context.Context) error {
	err := c.lifecycle.Close(ctx)
	c.host.Connection(model.Disconnected, "")
	return err
}

type scope struct {
	ClientID   string `json:"clientId"`
	RobotCode  string `json:"robotCode"`
	APIBase    string `json:"apiBase"`
	UploadBase string `json:"uploadBase,omitempty"`
}

type targetData struct {
	Type               string `json:"type"`
	StaffID            string `json:"staffId,omitempty"`
	OpenConversationID string `json:"openConversationId,omitempty"`
	Scope              scope  `json:"scope"`
}

func (c *Channel) identity() scope {
	return scope{ClientID: c.config.ClientID, RobotCode: c.config.RobotCode, APIBase: apiBase, UploadBase: uploadBase}
}

func (c *Channel) valid(target targetData, chatID string, media bool) bool {
	current := c.identity()
	if target.Scope.ClientID != current.ClientID || target.Scope.RobotCode != current.RobotCode || strings.TrimRight(target.Scope.APIBase, "/") != current.APIBase || (media && strings.TrimRight(target.Scope.UploadBase, "/") != current.UploadBase) {
		return false
	}
	return (target.Type == "single" && target.StaffID == chatID) || (target.Type == "group" && target.OpenConversationID == chatID)
}

func (c *Channel) Resolve(_ context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	if address.Platform != model.DingTalk || address.AccountID != c.account.ID || address.ChatID == "" || address.ThreadID != "" {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	var prior targetData
	known := learned != nil && learned.Channel == model.DingTalk && learned.AccountID == c.account.ID && learned.ChatID == address.ChatID && learned.ThreadID == "" && json.Unmarshal(learned.Data, &prior) == nil && c.valid(prior, address.ChatID, false)
	kind := c.config.RecipientTypes[address.ChatID]
	if kind == "" && known {
		kind = prior.Type
	}
	if kind == "" {
		return model.ChannelResolution{Reason: "address_unresolved"}, nil
	}
	data := targetData{Type: kind, Scope: c.identity()}
	if kind == "single" {
		data.StaffID = address.ChatID
	} else {
		data.OpenConversationID = address.ChatID
	}
	return model.ChannelResolution{Available: true, Target: &model.ReplyTarget{Channel: model.DingTalk, AccountID: c.account.ID, ChatID: address.ChatID, Data: common.Data(data)}}, nil
}

// Generated request/response types preserve SDK optionality. Its generated
// methods have no context argument; the secure transport performs exactly one
// native call with caller cancellation, without SDK replay of message POSTs.
// github.com/alibabacloud-go/dingtalk v1.7.46 oauth2_1_0 and robot_1_0 (Apache-2.0).
func (c *Channel) token(ctx context.Context) (string, error) {
	secret, err := c.options.Secret(c.config.ClientSecret)
	if err != nil {
		return "", err
	}
	request := oauth.GetAccessTokenRequest{AppKey: &c.config.ClientID, AppSecret: &secret}
	var response oauth.GetAccessTokenResponseBody
	if err = common.JSON(ctx, c.options.HTTPClient, http.MethodPost, apiBase+"/v1.0/oauth2/accessToken", nil, request, &response); err != nil {
		return "", err
	}
	if response.AccessToken == nil || *response.AccessToken == "" {
		return "", errors.New("missing_access_token")
	}
	return *response.AccessToken, nil
}

func (c *Channel) sendNative(ctx context.Context, target targetData, payload messagePayload, token string) (robot.BatchSendOTOResponseBody, error) {
	var response robot.BatchSendOTOResponseBody
	headers := http.Header{"x-acs-dingtalk-access-token": {token}}
	var request any
	endpoint := "/v1.0/robot/oToMessages/batchSend"
	if target.Type == "group" {
		endpoint = "/v1.0/robot/groupMessages/send"
		request = robot.OrgGroupSendRequest{RobotCode: &c.config.RobotCode, OpenConversationId: &target.OpenConversationID, MsgKey: &payload.Key, MsgParam: &payload.Parameters}
	} else {
		request = robot.BatchSendOTORequest{RobotCode: &c.config.RobotCode, UserIds: []*string{&target.StaffID}, MsgKey: &payload.Key, MsgParam: &payload.Parameters}
	}
	err := common.JSON(ctx, c.options.HTTPClient, http.MethodPost, apiBase+endpoint, headers, request, &response)
	return response, err
}

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	var target targetData
	if input.Target.Channel != model.DingTalk || input.Target.AccountID != c.account.ID || input.Target.ThreadID != "" || json.Unmarshal(input.Target.Data, &target) != nil || !c.valid(target, input.Target.ChatID, input.Chunk.Media != nil || len(input.Chunk.RichText) > 0) {
		return common.Reject("invalid_target"), nil
	}
	if code := common.ValidateRich(input, richLimits, model.UTF8, common.MediaLimit(c.host)); code != "" {
		return common.Reject(code), nil
	}
	if code := richOverhead(input); code != "" {
		return common.Reject(code), nil
	}
	token, err := c.token(ctx)
	if err != nil {
		return common.Failure(err, true), nil
	}
	payload, err := c.message(ctx, input, token)
	if err != nil {
		return messageFailure(err), nil
	}
	if ctx.Err() != nil {
		return common.Retry("send_cancelled_before_transmit", 0), nil
	}
	response, err := c.sendNative(ctx, target, payload, token)
	if err != nil {
		return common.Failure(err, false), nil
	}
	if len(response.InvalidStaffIdList) > 0 {
		return common.Reject("invalid_staff_id"), nil
	}
	if len(response.FlowControlledStaffIdList) > 0 {
		return common.Retry("staff_rate_limited", time.Second), nil
	}
	if response.ProcessQueryKey == nil || *response.ProcessQueryKey == "" {
		return model.SendResult{Status: model.Unknown, ErrorCode: "missing_message_receipt"}, nil
	}
	receipt := common.Sent("")
	receipt.Receipt.Data = common.Data(map[string]string{"processQueryKey": *response.ProcessQueryKey})
	return receipt, nil
}

func messageFailure(err error) model.SendResult {
	var upload *uploadError
	if errors.As(err, &upload) {
		if upload.code == -1 || upload.code == 40014 || upload.code == 42001 || upload.code == 45009 {
			return common.Retry("native_media_upload_failed", time.Second)
		}
		return common.Reject("native_media_upload_rejected")
	}
	if common.Contains([]string{"missing_media", "missing_media_duration", "missing_video_preview", "rich_text_limit_exceeded", "invalid_media_id"}, err.Error()) {
		return common.Reject(err.Error())
	}
	return common.Failure(err, true)
}
