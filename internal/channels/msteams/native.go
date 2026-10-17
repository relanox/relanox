package msteams

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
	"github.com/relanox/relanox/internal/channels/common"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/clientcredentials"
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
	keysLoading       map[string]chan struct{}
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
	client := common.SDKHTTPClient(c.HTTP, ctx, common.MaxJSONBytes)
	ctx = context.WithValue(ctx, oauth2.HTTPClient, client)
	credentials := clientcredentials.Config{ClientID: c.AppID, ClientSecret: secret, TokenURL: c.TokenURL, Scopes: []string{"https://api.botframework.com/.default"}, AuthStyle: oauth2.AuthStyleInParams}
	// Use one retrieval, not a long-lived SDK TokenSource: the outer cache checks
	// the current secret and owns invalidation. InParams disables auth probing.
	token, err := credentials.Token(ctx)
	if err != nil {
		return "", time.Time{}, oauthError(ctx, err)
	}
	if token == nil || token.AccessToken == "" || !token.Expiry.After(time.Now()) || !positiveExpiry(token.Extra("expires_in")) {
		return "", time.Time{}, errors.New("oauth_unavailable")
	}
	return token.AccessToken, token.Expiry, nil
}

func positiveExpiry(value any) bool {
	// The SDK converts JSON lifetimes through int32; check the original value
	// too so an out-of-range negative lifetime cannot wrap into a future expiry.
	switch value := value.(type) {
	case float64:
		return value > 0
	case string:
		seconds, err := strconv.ParseInt(value, 10, 64)
		return err == nil && seconds > 0
	}
	return false
}

func oauthError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var response *oauth2.RetrieveError
	if errors.As(err, &response) && response.Response != nil && (response.Response.StatusCode < 200 || response.Response.StatusCode >= 300) {
		// RetrieveError includes remote descriptions and bodies; keep only the
		// native status and retry headers, without exposing credential echoes.
		return &common.HTTPError{Status: response.Response.StatusCode, Header: response.Response.Header}
	}
	return errors.New("oauth_unavailable")
}

func (c *NativeClient) keySet(ctx context.Context, endpoint string) (keyfunc.Keyfunc, error) {
	for {
		c.keysMu.Lock()
		if c.keys == nil {
			c.keys = make(map[string]keyfunc.Keyfunc)
			c.keysLoading = make(map[string]chan struct{})
		}
		if c.keys[endpoint] != nil {
			keys := c.keys[endpoint]
			c.keysMu.Unlock()
			return keys, nil
		}
		if c.lifetime == nil {
			c.lifetime, c.cancel = context.WithCancel(context.Background())
		}
		if err := c.lifetime.Err(); err != nil {
			c.keysMu.Unlock()
			return nil, err
		}
		if pending := c.keysLoading[endpoint]; pending != nil {
			c.keysMu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-pending:
				continue
			}
		}
		pending := make(chan struct{})
		c.keysLoading[endpoint] = pending
		lifetime := c.lifetime
		c.keysMu.Unlock()
		// The initial download belongs to this Authenticate call. Once loaded,
		// refresh belongs to the channel lifetime rather than an old HTTP request.
		initial, cancelInitial := context.WithCancel(lifetime)
		stopInitial := context.AfterFunc(ctx, cancelInitial)
		noFirstError := false
		keys, err := keyfunc.NewDefaultOverrideCtx(initial, []string{endpoint}, keyfunc.Override{
			Client: common.HTTPClient(c.HTTP), HTTPTimeout: 10 * time.Second, NoErrorReturnFirstHTTPReq: &noFirstError,
			RefreshErrorHandlerFunc: func(string) func(context.Context, error) { return func(context.Context, error) {} },
		})
		stopInitial()
		if err == nil && ctx.Err() != nil {
			err = ctx.Err()
		}
		if err != nil {
			cancelInitial()
		}
		c.keysMu.Lock()
		delete(c.keysLoading, endpoint)
		close(pending)
		if err == nil && lifetime.Err() == nil {
			c.keys[endpoint] = keys
		} else if err == nil {
			err = lifetime.Err()
		}
		c.keysMu.Unlock()
		return keys, err
	}
}

func (c *NativeClient) Authenticate(ctx context.Context, authorization, serviceURL string) error {
	if !strings.HasPrefix(authorization, "Bearer ") {
		return errors.New("unauthorized_activity")
	}
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
