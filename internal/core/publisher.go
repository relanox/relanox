package core

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/model"
)

type channelMedia struct {
	runtime   *Runtime
	accountID string
}

type mediaTicket struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func mediaNamespace(account string) model.StateNamespace {
	return model.StateNamespace{Component: "core:media-publisher", OwnerID: account}
}

func (h *channelMedia) Publish(ctx context.Context, channelID, id string, lifetime time.Duration) (string, error) {
	if h.runtime.cfg.HTTP.PublicURL == "" {
		return "", failure("public_url_required")
	}
	if lifetime == 0 {
		lifetime = 24 * time.Hour
	}
	if lifetime < time.Second || lifetime > 7*24*time.Hour {
		return "", failure("invalid_media_url_lifetime")
	}
	allowed, err := h.runtime.publicationAllowed(ctx, h.accountID, channelID)
	if err != nil {
		return "", err
	}
	if !allowed {
		return "", failure("account_scope_mismatch")
	}
	asset, err := h.runtime.store.GetMedia(ctx, channelID, id)
	if err != nil {
		return "", err
	}
	if asset == nil {
		return "", failure("media_not_found")
	}
	if _, err := verifiedMedia(*asset, asset.Reference, h.runtime.cfg.Media.MaxBytes); err != nil {
		return "", err
	}
	ticket, err := h.ticket(ctx, channelID+"/"+id, lifetime)
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(h.runtime.cfg.HTTP.PublicURL, "/") + "/media/" + url.PathEscape(h.accountID) + "/" + url.PathEscape(channelID) + "/" + url.PathEscape(id) + "?token=" + ticket.Token, nil
}

func (h *channelMedia) ticket(ctx context.Context, key string, lifetime time.Duration) (mediaTicket, error) {
	namespace := mediaNamespace(h.accountID)
	expired, err := h.runtime.store.ListState(ctx, namespace, model.ListStateInput{ExpiresBefore: timePointer(time.Now()), Limit: 64})
	if err != nil {
		return mediaTicket{}, err
	}
	for _, entry := range expired {
		if _, err := h.runtime.store.DeleteState(ctx, namespace, entry.Key, entry.Version); err != nil {
			return mediaTicket{}, err
		}
	}
	for range 8 {
		entry, err := h.runtime.store.GetState(ctx, namespace, "index/"+key)
		if err != nil {
			return mediaTicket{}, err
		}
		var existing mediaTicket
		if entry != nil && json.Unmarshal(entry.Value, &existing) == nil && !existing.ExpiresAt.Before(time.Now().Add(lifetime)) && len(existing.Token) == 64 {
			return existing, nil
		}
		var entropy [32]byte
		if _, err := rand.Read(entropy[:]); err != nil {
			return mediaTicket{}, err
		}
		ticket := mediaTicket{Token: hex.EncodeToString(entropy[:]), ExpiresAt: time.Now().Add(lifetime).UTC()}
		value, _ := json.Marshal(ticket)
		issued, err := h.runtime.store.CompareAndSetState(ctx, namespace, model.CompareAndSetStateInput{Key: "ticket/" + key + "/" + ticket.Token, Value: value, ExpiresAt: &ticket.ExpiresAt})
		if err != nil {
			return mediaTicket{}, err
		}
		if issued.Status != model.Updated {
			continue
		}
		input := model.CompareAndSetStateInput{Key: "index/" + key, Value: value, ExpiresAt: &ticket.ExpiresAt}
		if entry != nil {
			input.ExpectedVersion = &entry.Version
		}
		result, err := h.runtime.store.CompareAndSetState(ctx, namespace, input)
		if err != nil {
			return mediaTicket{}, err
		}
		if result.Status == model.Updated {
			return ticket, nil
		}
	}
	return mediaTicket{}, failure("media_publish_conflict")
}

func timePointer(value time.Time) *time.Time { return &value }

func (r *Runtime) mountMedia() error {
	if r.cfg.HTTP.PublicURL == "" {
		return nil
	}
	return r.mount(model.HTTPRoute{Pattern: "/media/", MaxBodyBytes: 1024, Handler: http.HandlerFunc(r.serveMedia)})
}

func (r *Runtime) serveMedia(w http.ResponseWriter, request *http.Request) {
	if request.Method != "GET" && request.Method != "HEAD" {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	parts := strings.Split(strings.TrimPrefix(request.URL.Path, "/media/"), "/")
	if len(parts) != 3 || !validID(parts[0], 128) || !validID(parts[1], 1024) || !validID(parts[2], 128) {
		http.NotFound(w, request)
		return
	}
	asset, err := r.publishedMedia(request.Context(), parts[0], parts[1], parts[2], request.URL.Query().Get("token"))
	if err != nil || asset == nil {
		http.NotFound(w, request)
		return
	}
	w.Header().Set("Content-Type", asset.Reference.MIMEType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": asset.Reference.FileName}))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.FormatInt(int64(len(asset.Data)), 10))
	if request.Method == "GET" {
		_, _ = w.Write(asset.Data)
	}
}

func (r *Runtime) publishedMedia(ctx context.Context, account, channel, id, token string) (*model.StoredMedia, error) {
	if len(token) != 64 {
		return nil, nil
	}
	entry, err := r.store.GetState(ctx, mediaNamespace(account), "ticket/"+channel+"/"+id+"/"+token)
	if err != nil || entry == nil {
		return nil, err
	}
	var ticket mediaTicket
	if json.Unmarshal(entry.Value, &ticket) != nil || !ticket.ExpiresAt.After(time.Now()) || subtle.ConstantTimeCompare([]byte(token), []byte(ticket.Token)) != 1 {
		return nil, nil
	}
	allowed, err := r.publicationAllowed(ctx, account, channel)
	if err != nil || !allowed {
		return nil, err
	}
	asset, err := r.store.GetMedia(ctx, channel, id)
	if err != nil || asset == nil {
		return nil, err
	}
	verified, err := verifiedMedia(*asset, asset.Reference, r.cfg.Media.MaxBytes)
	if err != nil {
		return nil, err
	}
	return &verified, nil
}

func (r *Runtime) publicationAllowed(ctx context.Context, account, channel string) (bool, error) {
	current, ok := r.configured[channel]
	if !ok || current.Address.AccountID != account {
		return false, nil
	}
	stored, err := r.store.GetConversation(ctx, channel, false)
	return stored != nil && equal(current.Address, stored.Address) && equal(current.Endpoint, stored.Endpoint), err
}
