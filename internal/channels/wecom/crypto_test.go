package wecom

import (
	"net/url"
	"testing"
	"time"
)

// Protects actual platform envelope decryption and freshness. A change to AES
// padding or SHA1 ordering breaks the SDK-recorded fixture; roundtrip-only tests
// cannot detect matching encoder/decoder mistakes. No test-only production seam.
func TestOfficialCallbackFixture(t *testing.T) {
	// Recorded from @wecom/aibot-node-sdk 1.0.7 WecomCrypto.encrypt with
	// public fixture credentials. https://github.com/WecomTeam/aibot-node-sdk
	c, err := NewCallbackCrypto("public-fixture-token", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY", "")
	if err != nil {
		t.Fatal(err)
	}
	const encrypted = "Vi9evZLb8KLExjTUFYu3C4xi8CFHIR++eHyzVUYdDwPEWI4lWk8WuNLVyHHa6BBqQzEmoPI8ZDMrdHQJLSUX1aW5taT9B5A3ad6S0vIiWyT7YMbzolh6+A5TyxIEyB+Z"
	query := url.Values{"timestamp": {"1792166400"}, "nonce": {"fixture-nonce"}, "msg_signature": {"f033051c15d31fd78926daccb111d35fca9437cd"}}
	now := time.Unix(1792166400, 0)
	if !c.Verify(query, encrypted, now) {
		t.Fatal("official signature rejected")
	}
	plain, err := c.Decrypt(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if string(plain) != `{"msgid":"fixture","msgtype":"text","text":{"content":"你好"}}` {
		t.Fatalf("wrong plaintext: %s", plain)
	}
	if c.Verify(query, encrypted, now.Add(6*time.Minute)) {
		t.Fatal("stale callback accepted")
	}
	if c.Verify(query, encrypted+"A", now) {
		t.Fatal("modified ciphertext accepted")
	}
	query.Set("msg_signature", "f033051c15d31fd78926daccb111d35fca9437ce")
	if c.Verify(query, encrypted, now) {
		t.Fatal("forged signature accepted")
	}
}
