package irc

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	wire "gopkg.in/irc.v4"
)

type protocolHost struct {
	model.ChannelHost
	received chan model.IngestInput
	status   chan model.ConnectionStatus
}

func (h *protocolHost) BoundChatIDs() []string { return []string{"#room"} }

func (h *protocolHost) Connection(status model.ConnectionStatus, _ string) {
	select {
	case h.status <- status:
	default:
	}
}

func (h *protocolHost) Ingest(_ context.Context, input model.IngestInput) (model.IngestReceipt, error) {
	h.received <- input
	return model.IngestReceipt{RequestID: "accepted"}, nil
}

type ircPeer struct {
	t        *testing.T
	listener net.Listener
	roots    *x509.CertPool
	sent     chan *wire.Message
	done     chan struct{}
	writes   atomic.Int64
}

func newPeer(t *testing.T) *ircPeer {
	t.Helper()
	certificateServer := httptest.NewTLSServer(nil)
	certificates := certificateServer.TLS.Certificates
	roots := x509.NewCertPool()
	roots.AddCert(certificateServer.Certificate())
	certificateServer.Close()
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: certificates, MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatal(err)
	}
	return &ircPeer{t: t, listener: listener, roots: roots, sent: make(chan *wire.Message, 100), done: make(chan struct{})}
}

func (p *ircPeer) account(t *testing.T) (*Channel, *protocolHost) {
	t.Helper()
	port := p.listener.Addr().(*net.TCPAddr).Port
	host := &protocolHost{received: make(chan model.IngestInput, 10), status: make(chan model.ConnectionStatus, 10)}
	cfg := Config{Server: "127.0.0.1", Port: port, Nick: "RelayBot", SASL: &SASL{Username: "relay", Password: model.SecretRef{Env: "SASL_PASSWORD"}}}
	channel, err := New(host, model.AccountConfig{ID: "irc", Channel: model.IRC, AllowedSenders: []string{"account:alice"}, Config: common.Data(cfg)}, common.Options{TLSClientConfig: &tls.Config{RootCAs: p.roots, MinVersion: tls.VersionTLS12}, ResolveSecret: func(model.SecretRef) (string, error) { return strings.Repeat("p", 293), nil }})
	if err != nil {
		t.Fatal(err)
	}
	return channel, host
}

// Protects native SASL 400-byte termination, account-tag authorization, DM case
// mapping and relayed line budgets with actual TLS socket traffic. Omitting the
// empty SASL terminator prevents registration; nickname-only authorization accepts
// impersonation. HTTP channels cover none of these contracts. No extra seam.
// https://ircv3.net/specs/extensions/sasl-3.1
// https://ircv3.net/specs/extensions/account-tag
// https://ircv3.net/specs/extensions/message-tags
// https://modern.ircdocs.horse/#rplisupport-005
func TestTLSRegistrationAccountTagsAndReply(t *testing.T) {
	peer := newPeer(t)
	defer peer.listener.Close()
	go peer.serve()
	channel, host := peer.account(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := channel.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer closeChannel(t, channel)
	group := receive(t, host.received)
	direct := receive(t, host.received)
	if group.SenderID != "account:alice" || group.Source.EventID != "native-id" || group.Target.ChatID != "#room" || group.ReceivedAt.Format(time.RFC3339) != "2026-10-17T00:00:00Z" {
		t.Fatalf("IRC identity: %+v", group)
	}
	if direct.Target.ChatID != "dm:sender{" || direct.Target.ReplyToID != "direct-id" {
		t.Fatalf("IRC DM case mapping: %+v", direct.Target)
	}
	resolved, err := channel.Resolve(ctx, model.ChannelAddress{Platform: model.IRC, AccountID: "irc", ChatID: "#room"}, &group.Target)
	if err != nil || !resolved.Available {
		t.Fatalf("resolve: %+v %v", resolved, err)
	}
	result, err := channel.Send(ctx, model.SendInput{Target: *resolved.Target, Reply: &model.ReplyReference{RequestID: "req", Kind: model.Final}, Chunk: model.DeliveryChunk{Text: "**answer**"}})
	if err != nil || result.Status != model.Sent || !strings.Contains(string(result.Receipt.Data), "socket_write") {
		t.Fatalf("send: %+v %v", result, err)
	}
	message := outbound(t, peer.sent)
	if message.Tags["+reply"] != "native-id" || message.Params[0] != "#room" || message.Trailing() != "\x02answer\x0f" {
		t.Fatalf("native reply: %+v", message)
	}
	assertLineBounds(t, channel, *resolved.Target, peer)
	var data targetData
	if json.Unmarshal(group.Target.Data, &data) != nil {
		t.Fatal("target")
	}
	data.Port++
	changed := group.Target
	changed.Data = common.Data(data)
	resolved, err = channel.Resolve(ctx, model.ChannelAddress{Platform: model.IRC, AccountID: "irc", ChatID: "#room"}, &changed)
	if err != nil || resolved.Available {
		t.Fatal("changed IRC server identity accepted")
	}
}

func assertLineBounds(t *testing.T, channel *Channel, target model.ReplyTarget, peer *ircPeer) {
	t.Helper()
	ctx := context.Background()
	parts, err := channel.SplitText("**"+strings.Repeat("界", 500)+"**", target)
	if err != nil || len(parts) < 2 {
		t.Fatalf("split: %d %v", len(parts), err)
	}
	for _, part := range parts {
		result, err := channel.Send(ctx, model.SendInput{Target: target, Chunk: model.DeliveryChunk{Text: part}})
		if err != nil || result.Status != model.Sent {
			t.Fatalf("split send: %+v %v", result, err)
		}
		message := outbound(t, peer.sent)
		line := message.String()
		if len(":RelayBot!"+strings.Repeat("u", 12)+"@"+strings.Repeat("h", 100)+" "+line+"\r\n") > 512 {
			t.Fatalf("server relay would exceed 512 bytes: %d", len(line))
		}
	}
	before := peer.writes.Load()
	result, err := channel.Send(ctx, model.SendInput{Target: target, Chunk: model.DeliveryChunk{Text: "\x01ACTION unsafe\x01"}})
	if err != nil || result.Status != model.Rejected || peer.writes.Load() != before {
		t.Fatalf("CTCP injection: %+v %v", result, err)
	}
}

func receive(t *testing.T, received <-chan model.IngestInput) model.IngestInput {
	t.Helper()
	select {
	case value := <-received:
		return value
	case <-time.After(3 * time.Second):
		t.Fatal("native IRC message did not arrive")
		return model.IngestInput{}
	}
}

func outbound(t *testing.T, sent <-chan *wire.Message) *wire.Message {
	t.Helper()
	select {
	case value := <-sent:
		return value
	case <-time.After(time.Second):
		t.Fatal("native IRC send did not arrive")
		return nil
	}
}

func closeChannel(t *testing.T, channel *Channel) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := channel.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

func (p *ircPeer) serve() {
	defer close(p.done)
	socket, err := p.listener.Accept()
	if err != nil {
		p.t.Error(err)
		return
	}
	defer socket.Close()
	_ = socket.SetDeadline(time.Now().Add(10 * time.Second))
	reader := wire.NewReader(socket)
	for i, command := range []string{"CAP", "NICK", "USER"} {
		message, err := reader.ReadMessage()
		if err != nil {
			p.t.Error(err)
			return
		}
		if message.Command != command {
			p.t.Errorf("registration %d: %+v", i, message)
			return
		}
	}
	if !p.authenticate(socket, reader) {
		return
	}
	io.WriteString(socket, ":server 001 RelayBot :Welcome\r\n:server 005 RelayBot HOSTLEN=100 USERLEN=12 CASEMAPPING=rfc1459 :are supported by this server\r\n")
	request, err := reader.ReadMessage()
	if err != nil || request.Command != "JOIN" || request.Trailing() != "#room" {
		p.t.Errorf("bound JOIN %+v %v", request, err)
		return
	}
	p.sendInbound(socket)
	for {
		message, err := reader.ReadMessage()
		if err != nil {
			return
		}
		if message.Command == "PONG" {
			if message.Trailing() != "keepalive" {
				p.t.Error("native PONG")
			}
			continue
		}
		if message.Command != "PRIVMSG" {
			p.t.Errorf("unexpected IRC command %+v", message)
			return
		}
		p.writes.Add(1)
		p.sent <- message
	}
}

func (p *ircPeer) authenticate(socket net.Conn, reader *wire.Reader) bool {
	io.WriteString(socket, ":server CAP * LS :account-tag server-time message-tags sasl=PLAIN\r\n")
	request, err := reader.ReadMessage()
	if err != nil || request.Command != "CAP" || !strings.Contains(request.Trailing(), "sasl") {
		p.t.Errorf("CAP request %+v %v", request, err)
		return false
	}
	io.WriteString(socket, ":server CAP RelayBot ACK :account-tag server-time message-tags sasl\r\n")
	request, err = reader.ReadMessage()
	if err != nil || request.Command != "AUTHENTICATE" || request.Trailing() != "PLAIN" {
		p.t.Errorf("SASL mechanism: %+v %v", request, err)
		return false
	}
	io.WriteString(socket, "AUTHENTICATE +\r\n")
	request, err = reader.ReadMessage()
	if err != nil {
		p.t.Error(err)
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(request.Trailing())
	if err != nil || string(decoded) != "\x00relay\x00"+strings.Repeat("p", 293) || len(request.Trailing()) != 400 {
		p.t.Error("SASL PLAIN payload")
	}
	request, err = reader.ReadMessage()
	if err != nil || request.Trailing() != "+" {
		p.t.Errorf("missing 400-byte SASL terminator %+v %v", request, err)
		return false
	}
	io.WriteString(socket, ":server 903 RelayBot :SASL successful\r\n")
	request, err = reader.ReadMessage()
	if err != nil || request.Command != "CAP" || request.Trailing() != "END" {
		p.t.Error("CAP did not finish")
		return false
	}
	return true
}

func (p *ircPeer) sendInbound(socket net.Conn) {
	io.WriteString(socket, ":NoAccount!u@host PRIVMSG #room :ignored\r\n@account=mallory :Sender!u@host PRIVMSG #room :ignored\r\n@account=alice;msgid=native-id;time=2026-10-17T00:00:00Z :Sender[!u@host PRIVMSG #room :original\r\n@account=alice;msgid=direct-id :Sender[!u@host PRIVMSG RelayBot :private\r\nPING :keepalive\r\n")
}

// Authentication capabilities are a registration gate: a TLS connection without
// account-tag cannot silently fall back to spoofable nicks. Only explicit config
// enables fallback. The main happy-path peer always advertises account-tag.
func TestMissingAccountTagDoesNotBecomeReady(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		socket, err := listener.Accept()
		if err != nil {
			return
		}
		defer socket.Close()
		scanner := bufio.NewScanner(socket)
		for i := 0; i < 3 && scanner.Scan(); i++ {
		}
		io.WriteString(socket, ":server CAP * LS :message-tags\r\n")
		io.Copy(io.Discard, socket)
	}()
	port, _ := strconv.Atoi(strings.Split(listener.Addr().String(), ":")[1])
	disabled := false
	host := &protocolHost{received: make(chan model.IngestInput, 1), status: make(chan model.ConnectionStatus, 10)}
	channel, err := New(host, model.AccountConfig{ID: "irc", Channel: model.IRC, Config: common.Data(Config{Server: "127.0.0.1", Port: port, Nick: "RelayBot", TLS: &disabled, AllowInsecureLocalhost: true})}, common.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err = channel.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer closeChannel(t, channel)
	select {
	case status := <-host.status:
		if status == model.Connected {
			t.Fatal("unauthenticated connection became ready")
		}
	case <-time.After(time.Second):
		t.Fatal("required capability failure did not terminate")
	}
}
