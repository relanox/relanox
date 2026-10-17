package common

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// WhatsApp requires the file part's actual Content-Type, independently of its
// type form field. A generic CreateFormFile silently sends octet-stream. Existing
// channel upload tests only assert field names/bytes. This checks real multipart
// parsing with no production seam or mocked protocol behavior.
func TestMultipartPreservesExplicitFileMIMEAndLegacyDefault(t *testing.T) {
	// Verified Meta sample sets both properties:
	// https://github.com/fbsamples/whatsapp-api-examples/blob/main/media-messages-js/complete-app/controller/media.js
	for _, explicit := range []bool{false, true} {
		wanted := "application/octet-stream"
		if explicit {
			wanted = "image/jpeg"
		}
		peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if err := r.ParseMultipartForm(1024); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			defer r.MultipartForm.RemoveAll()
			files := r.MultipartForm.File["file"]
			if len(files) != 1 {
				t.Error("missing native file part")
				w.WriteHeader(400)
				return
			}
			file := files[0]
			if file.Header.Get("Content-Type") != wanted || file.Filename != "native image.jpg" || r.FormValue("type") != "image/jpeg" {
				t.Errorf("native multipart: %+v", file)
			}
			content, err := file.Open()
			if err != nil {
				t.Error(err)
				return
			}
			defer content.Close()
			data, err := io.ReadAll(content)
			if err != nil || string(data) != "native-bytes" {
				t.Error("multipart file bytes changed")
			}
			w.Write([]byte(`{"id":"media"}`))
		}))
		var err error
		if explicit {
			err = MultipartMIME(context.Background(), peer.Client(), peer.URL, nil, map[string]string{"type": "image/jpeg"}, "file", "native image.jpg", "image/jpeg", []byte("native-bytes"), nil)
		} else {
			err = Multipart(context.Background(), peer.Client(), peer.URL, nil, map[string]string{"type": "image/jpeg"}, "file", "native image.jpg", []byte("native-bytes"), nil)
		}
		peer.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
}
