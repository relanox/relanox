// Copyright (c) Meta Platforms, Inc. and affiliates.
// Licensed under the Apache License, Version 2.0.
// Muse's Noise XX policy wraps the upstream Noise protocol implementation.
package musewire

import (
	"crypto/rand"
	"errors"
	"io"

	"github.com/flynn/noise"
)

var errProtocol = errors.New("muse: invalid wire protocol")

var museCipherSuite = noise.NewCipherSuite(noise.DH25519, noise.CipherAESGCM, noise.HashSHA256)

// Muse reserves all nonces at and above JavaScript's largest safe integer,
// unlike Noise's wider uint64 range. An authentication failure kills the session.
type cipherState struct {
	state *noise.CipherState
	dead  bool
}

func (s *cipherState) crypt(data, ad []byte, decrypt bool) ([]byte, error) {
	if s.dead || s.state == nil || s.state.Nonce() >= 1<<53-1 {
		s.dead = true
		return nil, errProtocol
	}
	var out []byte
	var err error
	if decrypt {
		out, err = s.state.Decrypt(nil, ad, data)
	} else {
		out, err = s.state.Encrypt(nil, ad, data)
	}
	if err != nil {
		s.dead = true
		return nil, errProtocol
	}
	return out, nil
}

type handshake struct {
	state *noise.HandshakeState
	phase int
}

// A fresh static key is scoped to this connection, as in the Muse SDK.
func newHandshake(random io.Reader) (*handshake, error) {
	key, err := noise.DH25519.GenerateKeypair(random)
	if err != nil {
		return nil, err
	}
	state, err := noise.NewHandshakeState(noise.Config{
		CipherSuite: museCipherSuite, Pattern: noise.HandshakeXX,
		Initiator: true, StaticKeypair: key, Random: random,
	})
	if err != nil {
		return nil, err
	}
	return &handshake{state: state}, nil
}

func (s *handshake) message1() ([]byte, error) {
	if s.phase != 0 {
		return nil, errProtocol
	}
	s.phase = -1
	out, _, _, err := s.state.WriteMessage(nil, nil)
	if err != nil {
		return nil, errProtocol
	}
	s.phase = 1
	return out, nil
}

func (s *handshake) message2(msg []byte) error {
	if s.phase != 1 {
		return errProtocol
	}
	s.phase = -1
	if _, _, _, err := s.state.ReadMessage(nil, msg); err != nil {
		return errProtocol
	}
	s.phase = 2
	return nil
}

func (s *handshake) finish() ([]byte, *cipherState, *cipherState, error) {
	if s.phase != 2 {
		return nil, nil, nil, errProtocol
	}
	s.phase = -1
	msg, send, receive, err := s.state.WriteMessage(nil, nil)
	if err != nil {
		return nil, nil, nil, errProtocol
	}
	s.phase = 3
	s.state = nil
	return msg, &cipherState{state: send}, &cipherState{state: receive}, nil
}

// Start production handshakes with cryptographic entropy, never reusable keys.
func freshHandshake() (*handshake, error) { return newHandshake(rand.Reader) }
