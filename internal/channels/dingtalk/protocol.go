package dingtalk

// These narrow wire types follow the official DingTalk SDK v1.7.46. Pointer
// fields, native names and optionality match its OAuth and robot definitions:
// https://github.com/alibabacloud-go/dingtalk/blob/v1.7.46/oauth2_1_0/client.go
// https://github.com/alibabacloud-go/dingtalk/blob/v1.7.46/robot_1_0/client.go
// They avoid importing the generated client's unrelated gateway dependency,
// whose published module contains no license grant. See NOTICE for attribution.
type accessTokenRequest struct {
	AppKey    *string `json:"appKey,omitempty"`
	AppSecret *string `json:"appSecret,omitempty"`
}

type accessTokenResponse struct {
	AccessToken *string `json:"accessToken,omitempty"`
	ExpireIn    *int64  `json:"expireIn,omitempty"`
}

type directSendRequest struct {
	MsgKey    *string   `json:"msgKey,omitempty"`
	MsgParam  *string   `json:"msgParam,omitempty"`
	RobotCode *string   `json:"robotCode,omitempty"`
	UserIds   []*string `json:"userIds,omitempty"`
}

type groupSendRequest struct {
	MsgKey             *string `json:"msgKey,omitempty"`
	MsgParam           *string `json:"msgParam,omitempty"`
	OpenConversationId *string `json:"openConversationId,omitempty"`
	RobotCode          *string `json:"robotCode,omitempty"`
}

type sendResponse struct {
	FilteredStaffIdList       []*string `json:"filteredStaffIdList,omitempty"`
	FlowControlledStaffIdList []*string `json:"flowControlledStaffIdList,omitempty"`
	InvalidStaffIdList        []*string `json:"invalidStaffIdList,omitempty"`
	ProcessQueryKey           *string   `json:"processQueryKey,omitempty"`
}

type fileDownloadRequest struct {
	DownloadCode *string `json:"downloadCode,omitempty"`
	RobotCode    *string `json:"robotCode,omitempty"`
}

type fileDownloadResponse struct {
	DownloadUrl *string `json:"downloadUrl,omitempty"`
}
