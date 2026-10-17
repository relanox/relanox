package musewire

import (
	"bytes"
	"crypto/ecdh"
	"encoding/hex"
	"testing"

	"github.com/flynn/noise"
)

// Fixture provenance: executed the official SDK's NoiseXXInitiator and
// NoiseXXResponder at fa073045a5572a8e3367fae142c1b7a7c554f222:
// https://github.com/facebookincubator/muse-gadget-sdk/blob/fa073045a5572a8e3367fae142c1b7a7c554f222/linux/src/musegadget/noise/noise_xx.py
// Key generation was replaced with private byte ranges 0..31 (initiator e),
// 32..63 (responder e), 64..95 (responder s), 96..127 (initiator s).
// Protects wire compatibility (XX token order, hash, HKDF and AES nonce endian).
// Round trips alone miss peers that share the same incorrect wire encoding.
// The production key factory consumes cryptographic entropy; fixed input here
// selects the published fixture keys without replacing protocol operations.
func TestOfficialNoiseFixture(t *testing.T) {
	h, err := newHandshake(bytes.NewReader(append(fixedKey(t, 96).Bytes(), fixedKey(t, 0).Bytes()...)))
	if err != nil {
		t.Fatal(err)
	}
	m1, err := h.message1()
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(m1); got != "8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f" {
		t.Fatal(got)
	}
	m2 := unhex(t, "358072d6365880d1aeea329adf9121383851ed21a28e3b75e965d0d2cd166254b2bb20f75b6cab3b6ff0b4ae1a69b5780d1efe7fec612a27b588ce165130c71ed9981ac2d290afcba0c6a3d962eac785ca4e4021e5fbd2db9eda5451b54e4be6")
	if err = h.message2(m2); err != nil {
		t.Fatal(err)
	}
	m3, send, receive, err := h.finish()
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(m3); got != "e036c3624ee3162c316dfff9266a75fa18894ca9591b637d15696dc63ddb5aed5957cfb40ad43a60496c4ebfd949fd9a508eb9cfeca0b9c8f38fa49ad8ff93a4" {
		t.Fatal(got)
	}
	for _, row := range []struct{ plain, expected string }{{"hello muse", "19eae1c71a70adacdef11654d034a61e581854538e820053702c"}, {"hello again", "8727cfc7d9ced7b453e941c903df2029524822f03a1ba0c032cb3a"}} {
		got, e := send.crypt([]byte(row.plain), nil, false)
		if e != nil || hex.EncodeToString(got) != row.expected {
			t.Fatalf("ciphertext %x: %v", got, e)
		}
	}
	plain, err := receive.crypt(unhex(t, "8cf721c7154e226c81ca187b687b017f0174102140fa1fbdfc90cd09"), nil, true)
	if err != nil || string(plain) != "acknowledged" {
		t.Fatalf("%q %v", plain, err)
	}
}

func TestNoiseRejectsTamperingAndPoisonsCipher(t *testing.T) {
	c := &cipherState{state: noise.UnsafeNewCipherState(museCipherSuite, [32]byte{}, 0)}
	if _, err := c.crypt(bytes.Repeat([]byte{1}, 32), nil, true); err == nil {
		t.Fatal("accepted unauthenticated ciphertext")
	}
	if _, err := c.crypt(nil, nil, false); err == nil {
		t.Fatal("reused poisoned cipher")
	}
	h, err := freshHandshake()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.message1(); err != nil {
		t.Fatal(err)
	}
	if err := h.message2(make([]byte, 96)); err == nil {
		t.Fatal("accepted low order X25519 point")
	}
}

func fixedKey(t *testing.T, start int) *ecdh.PrivateKey {
	t.Helper()
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(start + i)
	}
	key, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	data, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// The Muse SDK caps transport nonces below 2^53-1 and poisons failed sessions.
// Noise itself permits larger nonces; the golden handshake does not hit this
// boundary. Its public restoration API establishes the external boundary state.
func TestMuseNonceLimit(t *testing.T) {
	c := &cipherState{state: noise.UnsafeNewCipherState(museCipherSuite, [32]byte{}, 1<<53-2)}
	if _, err := c.crypt([]byte("last"), nil, false); err != nil {
		t.Fatal(err)
	}
	if _, err := c.crypt([]byte("exhausted"), nil, false); err == nil {
		t.Fatal("accepted exhausted Muse nonce")
	}
	c.state.SetNonce(0)
	if _, err := c.crypt(nil, nil, false); err == nil {
		t.Fatal("revived exhausted cipher")
	}
}
