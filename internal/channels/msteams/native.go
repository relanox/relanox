package msteams

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
	"github.com/relanox/relanox/internal/channels/common"
)

// Teams implements the Activity wire protocol directly because the official
// Teams SDK supports TypeScript, Python and C#, not Go. JWT contract follows
// microsoft/teams.js @microsoft/teams.apps 2.1.0:
// src/middleware/auth/inbound-activity-token-validator.ts and jwt-validator.ts.
// https://github.com/microsoft/teams.js
// https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
type NativeClient struct {
	AppID             string
	TenantID          string
	TokenURL          string
	Secret            func() string
	HTTP              *http.Client
	mu                sync.Mutex
	credential, token string
	expires           time.Time
	inflight          chan struct{}
	keysMu            sync.Mutex
	keys              map[string]keyfunc.Keyfunc
	lifetime          context.Context
	cancel            context.CancelFunc
}

func (c *NativeClient) Close() {
	c.keysMu.Lock()
	defer c.keysMu.Unlock()
	if c.cancel != nil {
		c.cancel()
	}
}

func (c *NativeClient) Invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.token = ""
	c.expires = time.Time{}
}

func (c *NativeClient) AccessToken(ctx context.Context) (string, error) {
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		secret := c.Secret()
		if secret == "" || strings.ContainsAny(secret, "\r\n") {
			return "", errors.New("missing_secret")
		}
		c.mu.Lock()
		if c.credential == secret && c.token != "" && time.Now().Add(30*time.Second).Before(c.expires) {
			token := c.token
			c.mu.Unlock()
			return token, nil
		}
		if pending := c.inflight; pending != nil {
			c.mu.Unlock()
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-pending:
				continue
			}
		}
		c.inflight = make(chan struct{})
		c.mu.Unlock()
		token, expiry, err := c.requestToken(ctx, secret)
		c.mu.Lock()
		if err == nil {
			c.token = token
			c.expires = expiry
			c.credential = secret
		}
		close(c.inflight)
		c.inflight = nil
		c.mu.Unlock()
		return token, err
	}
}

func (c *NativeClient) requestToken(ctx context.Context, secret string) (string, time.Time, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {c.AppID}, "client_secret": {secret}, "scope": {"https://api.botframework.com/.default"}}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", time.Time{}, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	raw, _, err := common.Do(c.HTTP, request, common.MaxJSONBytes)
	if err != nil {
		return "", time.Time{}, err
	}
	var token struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err = json.Unmarshal(raw, &token); err != nil {
		return "", time.Time{}, err
	}
	if token.AccessToken == "" || token.ExpiresIn <= 0 {
		return "", time.Time{}, errors.New("oauth_unavailable")
	}
	return token.AccessToken, time.Now().Add(time.Duration(token.ExpiresIn) * time.Second), nil
}

func (c *NativeClient) keySet(ctx context.Context, endpoint string) (keyfunc.Keyfunc, error) {
	c.keysMu.Lock()
	defer c.keysMu.Unlock()
	if c.keys == nil {
		c.keys = make(map[string]keyfunc.Keyfunc)
	}
	if c.keys[endpoint] != nil {
		return c.keys[endpoint], nil
	}
	if c.lifetime == nil {
		c.lifetime, c.cancel = context.WithCancel(context.Background())
	}
	noFirstError := false
	keys, err := keyfunc.NewDefaultOverrideCtx(c.lifetime, []string{endpoint}, keyfunc.Override{
		Client: common.HTTPClient(c.HTTP), HTTPTimeout: 10 * time.Second, NoErrorReturnFirstHTTPReq: &noFirstError,
		RefreshErrorHandlerFunc: func(string) func(context.Context, error) { return func(context.Context, error) {} },
	})
	if err != nil {
		return nil, err
	}
	c.keys[endpoint] = keys
	return keys, nil
}

func (c *NativeClient) Authenticate(ctx context.Context, authorization, serviceURL string) error {
	raw := strings.TrimPrefix(authorization, "Bearer ")
	if raw == "" {
		return errors.New("unauthorized_activity")
	}
	var unverified jwt.MapClaims
	if _, _, err := jwt.NewParser().ParseUnverified(raw, &unverified); err != nil {
		return errors.New("unauthorized_activity")
	}
	issuer, _ := unverified["iss"].(string)
	endpoint := "https://login.botframework.com/v1/.well-known/keys"
	entra := strings.HasPrefix(issuer, "https://login.microsoftonline.com/") || strings.HasPrefix(issuer, "https://sts.windows.net/")
	if entra {
		tenant, _ := unverified["tid"].(string)
		if tenant == "" || tenant != c.TenantID {
			return errors.New("unauthorized_activity")
		}
		endpoint = "https://login.microsoftonline.com/" + url.PathEscape(tenant) + "/discovery/v2.0/keys"
		if issuer != "https://login.microsoftonline.com/"+tenant+"/v2.0" && issuer != "https://sts.windows.net/"+tenant+"/" {
			return errors.New("unauthorized_activity")
		}
	} else if issuer != "https://api.botframework.com" {
		return errors.New("unauthorized_activity")
	}
	keys, err := c.keySet(ctx, endpoint)
	if err != nil {
		return errors.New("activity_keys_unavailable")
	}
	token, err := jwt.Parse(raw, keys.KeyfuncCtx(ctx), jwt.WithValidMethods([]string{"RS256"}), jwt.WithAudience(c.AppID, "api://botid-"+c.AppID, "api://"+c.AppID), jwt.WithIssuer(issuer), jwt.WithLeeway(5*time.Minute), jwt.WithExpirationRequired())
	if err != nil || !token.Valid {
		return errors.New("unauthorized_activity")
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return errors.New("unauthorized_activity")
	}
	if !entra && serviceURL != "" {
		signed, _ := claims["serviceurl"].(string)
		if signed == "" || !strings.EqualFold(strings.TrimRight(signed, "/"), strings.TrimRight(serviceURL, "/")) {
			return errors.New("activity_service_url_mismatch")
		}
	}
	return nil
}

func (c *NativeClient) Activity(ctx context.Context, serviceURL, conversationID, replyID string, body any) (string, error) {
	token, err := c.AccessToken(ctx)
	if err != nil {
		return "", err
	}
	endpoint := strings.TrimRight(serviceURL, "/") + "/v3/conversations/" + url.PathEscape(conversationID) + "/activities"
	if replyID != "" {
		endpoint += "/" + url.PathEscape(replyID)
	}
	var receipt struct {
		ID string `json:"id"`
	}
	err = common.JSON(ctx, c.HTTP, http.MethodPost, endpoint, http.Header{"Authorization": {"Bearer " + token}}, body, &receipt)
	var httpErr *common.HTTPError
	if errors.As(err, &httpErr) && httpErr.Status == 401 {
		c.Invalidate()
	}
	if err != nil {
		return "", err
	}
	if receipt.ID == "" {
		return "", errors.New("missing_message_receipt")
	}
	return receipt.ID, nil
}
