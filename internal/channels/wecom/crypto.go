package wecom

import (
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-sphere/wecom-aibot-go-sdk/aibot"
)

// CallbackCrypto implements the native WeCom callback envelope through the SDK.
// Its 32-byte PKCS#7 padding also matches WecomTeam/aibot-node-sdk 1.0.7.
// https://github.com/WecomTeam/aibot-node-sdk
type CallbackCrypto struct{ crypto *aibot.WecomCrypto }

func NewCallbackCrypto(token, encodedKey, receiveID string) (*CallbackCrypto, error) {
	key, err := callbackKey(encodedKey)
	if err != nil || token == "" {
		return nil, errors.New("invalid_callback_credentials")
	}
	crypto, err := aibot.NewWecomCrypto(token, key, receiveID)
	if err != nil {
		return nil, errors.New("invalid_callback_credentials")
	}
	return &CallbackCrypto{crypto: crypto}, nil
}

func callbackKey(encoded string) (string, error) {
	key, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(encoded, "="))
	if err != nil || len(key) != 32 {
		return "", errors.New("invalid_crypto_key")
	}
	return base64.StdEncoding.EncodeToString(key), nil
}

func (c *CallbackCrypto) Signature(timestamp, nonce, encrypted string) string {
	return c.crypto.ComputeSignature(timestamp, nonce, encrypted)
}

func (c *CallbackCrypto) Verify(query url.Values, encrypted string, now time.Time) bool {
	timestamp, nonce := query.Get("timestamp"), query.Get("nonce")
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || len(timestamp) > 12 || nonce == "" || now.Sub(time.Unix(seconds, 0)).Abs() > 5*time.Minute {
		return false
	}
	signature, err := hex.DecodeString(query.Get("msg_signature"))
	if err != nil || len(signature) != sha1.Size {
		return false
	}
	// The SDK compares strings directly; freshness and constant-time comparison
	// remain at the authenticated callback boundary.
	expected, _ := hex.DecodeString(c.Signature(timestamp, nonce, encrypted))
	return subtle.ConstantTimeCompare(signature, expected) == 1
}

func (c *CallbackCrypto) Decrypt(encoded string) ([]byte, error) {
	plain, err := c.crypto.Decrypt(encoded)
	if err != nil {
		// SDK errors may contain the decrypted receive ID.
		return nil, errors.New("invalid_callback_ciphertext")
	}
	return []byte(plain), nil
}

func (c *CallbackCrypto) Encrypt(plain []byte, timestamp, nonce string) (string, string, error) {
	if uint64(len(plain)) > uint64(^uint32(0)) {
		return "", "", errors.New("callback_too_large")
	}
	encrypted, signature, err := c.crypto.Encrypt(string(plain), timestamp, nonce)
	if err != nil {
		return "", "", errors.New("callback_encrypt_failed")
	}
	return encrypted, signature, nil
}

// DecryptFile uses the independent key on each media resource, not the bot key.
func DecryptFile(encrypted []byte, encodedKey string) ([]byte, error) {
	key, err := callbackKey(encodedKey)
	if err != nil {
		return nil, errors.New("invalid_media_key")
	}
	plain, err := aibot.DecryptFile(encrypted, key)
	if err != nil {
		return nil, errors.New("invalid_media_ciphertext")
	}
	return plain, nil
}
