package wecom

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// CallbackCrypto implements the native WeCom callback envelope. The wire layout
// and 32-byte PKCS#7 padding follow WecomTeam/aibot-node-sdk 1.0.7,
// src/wecom-crypto/index.ts (MIT), not the 16-byte default used by AES helpers.
// https://github.com/WecomTeam/aibot-node-sdk
type CallbackCrypto struct {
	token     string
	key       []byte
	receiveID string
}

func NewCallbackCrypto(token, encodedKey, receiveID string) (*CallbackCrypto, error) {
	key, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(encodedKey, "="))
	if err != nil || len(key) != 32 || token == "" {
		return nil, errors.New("invalid_callback_credentials")
	}
	return &CallbackCrypto{token: token, key: key, receiveID: receiveID}, nil
}

func (c *CallbackCrypto) Signature(timestamp, nonce, encrypted string) string {
	parts := []string{c.token, timestamp, nonce, encrypted}
	sort.Strings(parts)
	digest := sha1.Sum([]byte(strings.Join(parts, "")))
	return hex.EncodeToString(digest[:])
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
	expected, _ := hex.DecodeString(c.Signature(timestamp, nonce, encrypted))
	return subtle.ConstantTimeCompare(signature, expected) == 1
}

func unpad(data []byte, block int) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("invalid_padding")
	}
	n := int(data[len(data)-1])
	if n < 1 || n > block || n > len(data) {
		return nil, errors.New("invalid_padding")
	}
	for _, value := range data[len(data)-n:] {
		if int(value) != n {
			return nil, errors.New("invalid_padding")
		}
	}
	return data[:len(data)-n], nil
}

func decryptCBC(encrypted, key []byte) ([]byte, error) {
	if len(key) != 32 || len(encrypted) == 0 || len(encrypted)%aes.BlockSize != 0 {
		return nil, errors.New("invalid_ciphertext")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	plain := make([]byte, len(encrypted))
	cipher.NewCBCDecrypter(block, key[:aes.BlockSize]).CryptBlocks(plain, encrypted)
	return unpad(plain, 32)
}

func (c *CallbackCrypto) Decrypt(encoded string) ([]byte, error) {
	encrypted, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, errors.New("invalid_callback_ciphertext")
	}
	plain, err := decryptCBC(encrypted, c.key)
	if err != nil || len(plain) < 20 {
		return nil, errors.New("invalid_callback_ciphertext")
	}
	length := uint64(binary.BigEndian.Uint32(plain[16:20]))
	if length > uint64(len(plain)-20) {
		return nil, errors.New("invalid_callback_length")
	}
	end := 20 + int(length)
	if c.receiveID != "" && string(plain[end:]) != c.receiveID {
		return nil, errors.New("callback_identity_mismatch")
	}
	return plain[20:end], nil
}

func (c *CallbackCrypto) Encrypt(plain []byte, timestamp, nonce string) (string, string, error) {
	if uint64(len(plain)) > uint64(^uint32(0)) {
		return "", "", errors.New("callback_too_large")
	}
	raw := make([]byte, 20, 20+len(plain)+len(c.receiveID)+32)
	if _, err := rand.Read(raw[:16]); err != nil {
		return "", "", err
	}
	binary.BigEndian.PutUint32(raw[16:], uint32(len(plain)))
	raw = append(raw, plain...)
	raw = append(raw, c.receiveID...)
	n := 32 - len(raw)%32
	raw = append(raw, bytes.Repeat([]byte{byte(n)}, n)...)
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return "", "", err
	}
	cipher.NewCBCEncrypter(block, c.key[:aes.BlockSize]).CryptBlocks(raw, raw)
	encrypted := base64.StdEncoding.EncodeToString(raw)
	return encrypted, c.Signature(timestamp, nonce, encrypted), nil
}

// DecryptFile uses the independent key on each media resource, not the bot key.
func DecryptFile(encrypted []byte, encodedKey string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(encodedKey)
	if err != nil {
		return nil, errors.New("invalid_media_key")
	}
	return decryptCBC(encrypted, key)
}
