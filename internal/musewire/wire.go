// Copyright (c) Meta Platforms, Inc. and affiliates.
// Licensed under the Apache License, Version 2.0.
// Go adaptation of muse-gadget-sdk/linux/src/musegadget/noise/{envelope,framing}.py.
package musewire

import (
	"crypto/rand"
	"encoding/binary"
	"time"
)

const maxChunk = 65489

func uintField(out []byte, number int, n uint64) []byte {
	out = binary.AppendUvarint(out, uint64(number<<3))
	return binary.AppendUvarint(out, n)
}

func bytesField(out []byte, number int, b []byte) []byte {
	out = binary.AppendUvarint(out, uint64(number<<3|2))
	out = binary.AppendUvarint(out, uint64(len(b)))
	return append(out, b...)
}

type field struct {
	wire int
	n    uint64
	b    []byte
}

func decode(data []byte) (map[int][]field, error) {
	fields := make(map[int][]field)
	for len(data) > 0 {
		key, n := binary.Uvarint(data)
		if n <= 0 {
			return nil, errProtocol
		}
		data = data[n:]
		number, wire := int(key>>3), int(key&7)
		if number < 1 || number > 536870911 || number >= 19000 && number <= 19999 {
			return nil, errProtocol
		}
		f := field{wire: wire}
		switch wire {
		case 0:
			f.n, n = binary.Uvarint(data)
			if n <= 0 {
				return nil, errProtocol
			}
			data = data[n:]
		case 1, 2, 5:
			size := uint64(8)
			if wire == 5 {
				size = 4
			}
			if wire == 2 {
				size, n = binary.Uvarint(data)
				if n <= 0 {
					return nil, errProtocol
				}
				data = data[n:]
			}
			if size > uint64(len(data)) {
				return nil, errProtocol
			}
			f.b = data[:int(size)]
			data = data[int(size):]
		default:
			return nil, errProtocol
		}
		fields[number] = append(fields[number], f)
	}
	return fields, nil
}

func value(fields map[int][]field, n, wire int) (field, error) {
	fs := fields[n]
	if len(fs) == 0 {
		return field{wire: wire}, nil
	}
	f := fs[len(fs)-1]
	if f.wire != wire {
		return field{}, errProtocol
	}
	return f, nil
}

func getBytes(fields map[int][]field, n int) ([]byte, error) {
	f, e := value(fields, n, 2)
	return f.b, e
}

func getUint(fields map[int][]field, n int) (uint64, error) {
	f, e := value(fields, n, 0)
	return f.n, e
}

func requestFrame(id uint64, path string, body []byte, requestID string) []byte {
	request := bytesField(nil, 1, []byte("POST"))
	request = bytesField(request, 2, []byte(path))
	headers := [][2]string{{"Content-Type", "application/json"}, {"accept", "application/x-ndjson"}, {"x-request-id", requestID}, {"x-app-id", "hatch-web"}}
	for _, h := range headers {
		header := bytesField(nil, 1, []byte(h[0]))
		header = bytesField(header, 2, []byte(h[1]))
		request = bytesField(request, 3, header)
	}
	request = bytesField(request, 4, body)
	request = uintField(request, 5, 1)
	frame := uintField(nil, 1, id)
	frame = bytesField(frame, 2, request)
	return bytesField(nil, 2, frame)
}

type responseFrame struct {
	id     uint64
	status int
	kind   int
	body   []byte
	end    bool
}

func parseResponse(data []byte) (responseFrame, error) {
	outer, err := decode(data)
	if err != nil {
		return responseFrame{}, err
	}
	raw, err := getBytes(outer, 1)
	if err != nil {
		return responseFrame{}, err
	}
	frame, err := decode(raw)
	if err != nil {
		return responseFrame{}, err
	}
	id, err := getUint(frame, 1)
	if err != nil || id == 0 || id > 1<<63-1 {
		return responseFrame{}, errProtocol
	}
	kind := 0
	for _, k := range []int{2, 3, 4, 5} {
		if len(frame[k]) > 0 {
			if kind != 0 {
				return responseFrame{}, errProtocol
			}
			kind = k
		}
	}
	if kind < 3 {
		return responseFrame{}, errProtocol
	}
	raw, err = getBytes(frame, kind)
	if err != nil {
		return responseFrame{}, err
	}
	body, err := decode(raw)
	if err != nil {
		return responseFrame{}, err
	}
	out := responseFrame{id: id, kind: kind}
	if kind == 5 {
		out.end = true
		return out, nil
	}
	dataField, endField := 1, 2
	if kind == 3 {
		status, e := getUint(body, 1)
		if e != nil || status < 100 || status > 599 {
			return responseFrame{}, errProtocol
		}
		out.status = int(status)
		dataField, endField = 3, 4
	}
	out.body, err = getBytes(body, dataField)
	if err != nil {
		return responseFrame{}, err
	}
	end, err := getUint(body, endField)
	out.end = end != 0
	return out, err
}

func frameChunks(data []byte) ([][]byte, error) {
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	return chunksWithID(data, binary.BigEndian.Uint64(random[:]))
}

func chunksWithID(data []byte, id uint64) ([][]byte, error) {
	total := max(1, (len(data)+maxChunk-1)/maxChunk)
	if total > 256 {
		return nil, errProtocol
	}
	out := make([][]byte, total)
	for i := range total {
		start := i * maxChunk
		end := min(len(data), start+maxChunk)
		f := uintField(nil, 1, id)
		f = uintField(f, 2, uint64(i))
		f = uintField(f, 3, uint64(total))
		out[i] = bytesField(f, 4, data[start:end])
	}
	return out, nil
}

type assembly struct {
	total   uint64
	chunks  map[uint64][]byte
	created time.Time
}

type assembler struct {
	pending map[uint64]*assembly
	dead    bool
}

func (a *assembler) accept(data []byte) (out []byte, complete bool, err error) {
	if a.dead {
		return nil, false, errProtocol
	}
	defer func() {
		if err != nil {
			a.dead = true
			a.pending = nil
		}
	}()
	f, err := decode(data)
	if err != nil {
		return nil, false, err
	}
	id, err := getUint(f, 1)
	if err != nil {
		return nil, false, err
	}
	i, err := getUint(f, 2)
	if err != nil {
		return nil, false, err
	}
	total, err := getUint(f, 3)
	if err != nil {
		return nil, false, err
	}
	if len(f[3]) == 0 {
		total = 1
	}
	payload, err := getBytes(f, 4)
	if err != nil {
		return nil, false, err
	}
	if total < 1 || total > 256 || i >= total || len(payload) > maxChunk {
		return nil, false, errProtocol
	}
	if a.pending == nil {
		a.pending = make(map[uint64]*assembly)
	}
	for key, item := range a.pending {
		if time.Since(item.created) > time.Minute {
			delete(a.pending, key)
		}
	}
	item := a.pending[id]
	if item == nil {
		if len(a.pending) >= 16 {
			return nil, false, errProtocol
		}
		item = &assembly{total: total, chunks: make(map[uint64][]byte), created: time.Now()}
		a.pending[id] = item
	}
	if item.total != total {
		return nil, false, errProtocol
	}
	if _, ok := item.chunks[i]; ok {
		return nil, false, errProtocol
	}
	item.chunks[i] = append([]byte{}, payload...)
	if uint64(len(item.chunks)) != total {
		return nil, false, nil
	}
	delete(a.pending, id)
	for i := uint64(0); i < total; i++ {
		out = append(out, item.chunks[i]...)
	}
	return out, true, nil
}
