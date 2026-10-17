// Copyright (c) Meta Platforms, Inc. and affiliates.
// Licensed under the Apache License, Version 2.0.
// Go adaptation of muse-gadget-sdk/linux/src/musegadget/noise/noise_xx.py.
package musewire

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
)

var errProtocol = errors.New("muse: invalid wire protocol")

type cipherState struct {
	aead  cipher.AEAD
	nonce uint64
	dead  bool
}

func newCipher(key []byte) *cipherState {
	block, err := aes.NewCipher(key)
	if err != nil {
		panic(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	return &cipherState{aead: aead}
}

func (s *cipherState) crypt(data, ad []byte, decrypt bool) ([]byte, error) {
	if s.dead || s.nonce >= 1<<53-1 {
		s.dead = true
		return nil, errProtocol
	}
	if s.aead == nil {
		return append([]byte{}, data...), nil
	}
	var iv [12]byte
	binary.BigEndian.PutUint64(iv[4:], s.nonce)
	s.nonce++
	if !decrypt {
		return s.aead.Seal(nil, iv[:], data, ad), nil
	}
	plain, err := s.aead.Open(nil, iv[:], data, ad)
	if err != nil {
		s.dead = true
		return nil, errProtocol
	}
	return plain, nil
}

func mac(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	_, _ = h.Write(data)
	return h.Sum(nil)
}

func derive(key, input []byte) ([]byte, []byte) {
	temp := mac(key, input)
	first := mac(temp, []byte{1})
	return first, mac(temp, append(append([]byte{}, first...), 2))
}

type handshake struct {
	h, ck  []byte
	cipher *cipherState
	e      *ecdh.PrivateKey
	re     []byte
	phase  int
}

func newHandshake() *handshake {
	h := make([]byte, 32)
	copy(h, "Noise_XX_25519_AESGCM_SHA256")
	s := &handshake{h: h, ck: append([]byte{}, h...), cipher: &cipherState{}}
	s.mixHash(nil)
	return s
}

func (s *handshake) mixHash(data []byte) {
	h := sha256.New()
	_, _ = h.Write(s.h)
	_, _ = h.Write(data)
	s.h = h.Sum(nil)
}

func (s *handshake) mixKey(data []byte) {
	var key []byte
	s.ck, key = derive(s.ck, data)
	s.cipher = newCipher(key)
}

func (s *handshake) crypt(data []byte, decrypt bool) ([]byte, error) {
	out, err := s.cipher.crypt(data, s.h, decrypt)
	if err != nil {
		s.phase = -1
		return nil, err
	}
	if decrypt {
		s.mixHash(data)
	} else {
		s.mixHash(out)
	}
	return out, nil
}

func (s *handshake) message1(key *ecdh.PrivateKey) ([]byte, error) {
	if s.phase != 0 {
		return nil, errProtocol
	}
	var err error
	if key == nil {
		key, err = ecdh.X25519().GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}
	}
	s.e = key
	pub := key.PublicKey().Bytes()
	s.mixHash(pub)
	if _, err = s.crypt(nil, false); err != nil {
		return nil, err
	}
	s.phase = 1
	return pub, nil
}

func dh(key *ecdh.PrivateKey, raw []byte) ([]byte, error) {
	pub, err := ecdh.X25519().NewPublicKey(raw)
	if err != nil {
		return nil, errProtocol
	}
	shared, err := key.ECDH(pub)
	if err != nil {
		return nil, errProtocol
	}
	return shared, nil
}

func (s *handshake) message2(msg []byte) error {
	if s.phase != 1 || len(msg) < 96 {
		s.phase = -1
		return errProtocol
	}
	s.phase = -1
	s.re = append([]byte{}, msg[:32]...)
	s.mixHash(s.re)
	shared, err := dh(s.e, s.re)
	if err != nil {
		return err
	}
	s.mixKey(shared)
	remote, err := s.crypt(msg[32:80], true)
	if err != nil {
		return err
	}
	shared, err = dh(s.e, remote)
	if err != nil {
		return err
	}
	s.mixKey(shared)
	if _, err = s.crypt(msg[80:], true); err != nil {
		return err
	}
	s.phase = 2
	return nil
}

func (s *handshake) finish(key *ecdh.PrivateKey) (msg []byte, send, receive *cipherState, err error) {
	if s.phase != 2 {
		return nil, nil, nil, errProtocol
	}
	s.phase = -1
	if key == nil {
		key, err = ecdh.X25519().GenerateKey(rand.Reader)
		if err != nil {
			return
		}
	}
	msg, err = s.crypt(key.PublicKey().Bytes(), false)
	if err != nil {
		return
	}
	shared, e := dh(key, s.re)
	if e != nil {
		err = e
		return
	}
	s.mixKey(shared)
	tail, e := s.crypt(nil, false)
	if e != nil {
		err = e
		return
	}
	msg = append(msg, tail...)
	k1, k2 := derive(s.ck, nil)
	send, receive = newCipher(k1), newCipher(k2)
	clear(s.ck)
	clear(s.h)
	s.e = nil
	s.re = nil
	s.phase = 3
	return
}
