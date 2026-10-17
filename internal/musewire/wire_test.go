package musewire

import (
	"bytes"
	"encoding/hex"
	"testing"
)

// Source-backed protobuf byte fixtures use the native field numbers in:
// https://github.com/facebookincubator/muse-gadget-sdk/blob/fa073045a5572a8e3367fae142c1b7a7c554f222/linux/src/musegadget/noise/envelope.py
// https://github.com/facebookincubator/muse-gadget-sdk/blob/fa073045a5572a8e3367fae142c1b7a7c554f222/linux/src/musegadget/noise/framing.py
// These protect native field numbering and omitted defaults against accidental
// local array indexing. Existing TS Muse tests never decode wire messages.
func TestNativeResponseAndTransportDefaults(t *testing.T) {
	// Produced by the official encode_service_request/encode_service_frame/
	// encode_application_request functions with this method, body and headers.
	request := requestFrame(1, "/chat/stream", []byte("{}"), "native-request")
	if got := hex.EncodeToString(request); got != "12980108011293010a04504f5354120c2f636861742f73747265616d1a200a0c436f6e74656e742d5479706512106170706c69636174696f6e2f6a736f6e1a1e0a0661636365707412146170706c69636174696f6e2f782d6e646a736f6e1a1e0a0c782d726571756573742d6964120e6e61746976652d726571756573741a150a08782d6170702d6964120968617463682d77656222027b7d2801" {
		t.Fatal(got)
	}
	// ServiceResponse.payload=1; ServiceFrame stream=7,response=3;
	// ApplicationResponse status=200,body="ok",end_body=true.
	frame, err := parseResponse(unhex(t, "0a0d08071a0908c8011a026f6b2001"))
	if err != nil || frame.id != 7 || frame.status != 200 || string(frame.body) != "ok" || !frame.end {
		t.Fatalf("%+v %v", frame, err)
	}
	var a assembler
	// chunk_id=9,payload="ok"; omitted chunk_index defaults to0,total_chunks to1.
	out, done, err := a.accept(unhex(t, "080922026f6b"))
	if err != nil || !done || string(out) != "ok" {
		t.Fatalf("%q %v %v", out, done, err)
	}
	chunks, err := chunksWithID([]byte("ok"), 9)
	if err != nil || len(chunks) != 1 || hex.EncodeToString(chunks[0]) != "08091000180122026f6b" {
		t.Fatalf("%x %v", chunks, err)
	}
}

func TestRejectsAmbiguousAndMalformedWire(t *testing.T) {
	for _, raw := range []string{"0a0608011a002200", "0a0608011a0208ff", "0a020800", "0affffffffffffffffffff02", "00", "0a030801ff"} {
		if _, err := parseResponse(unhex(t, raw)); err == nil {
			t.Fatalf("accepted malformed response %s", raw)
		}
	}
	var a assembler
	// chunk0 of2 followed by duplicate0 must poison the decoder.
	chunk := unhex(t, "080910001802220161")
	if _, done, err := a.accept(chunk); err != nil || done {
		t.Fatal(done, err)
	}
	if _, _, err := a.accept(chunk); err == nil {
		t.Fatal("accepted duplicate chunk")
	}
	if _, _, err := a.accept(unhex(t, "080910011802220162")); err == nil {
		t.Fatal("reused poisoned decoder")
	}
}

func TestChunkLimitAndOutOfOrderReassembly(t *testing.T) {
	data := bytes.Repeat([]byte{0x7a}, maxChunk+1)
	chunks, err := chunksWithID(data, 42)
	if err != nil {
		t.Fatal(err)
	}
	var a assembler
	if _, done, err := a.accept(chunks[1]); err != nil || done {
		t.Fatal(done, err)
	}
	got, done, err := a.accept(chunks[0])
	if err != nil || !done || !bytes.Equal(got, data) {
		t.Fatal("reassembly failed", err)
	}
	if _, err = chunksWithID(make([]byte, maxChunk*256+1), 42); err == nil {
		t.Fatal("accepted excessive chunk count")
	}
}
