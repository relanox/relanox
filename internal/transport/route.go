package transport

import (
	"crypto/hmac"
	"encoding/hex"
	"net/http"

	"github.com/relanox/relanox/internal/model"
)

func VerifyHexMAC(expected []byte, received string) bool {
	decoded, err := hex.DecodeString(received)
	return err == nil && hmac.Equal(expected, decoded)
}

// RouteHandler authenticates before the body is read, then bounds the native
// handler's reads. Native handlers must treat MaxBytesError as rejection.
func RouteHandler(route model.HTTPRoute) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if route.Authorize != nil {
			if err := route.Authorize(r); err != nil {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		}
		if route.MaxBodyBytes > 0 {
			if r.ContentLength > route.MaxBodyBytes {
				http.Error(w, "request_too_large", http.StatusRequestEntityTooLarge)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, route.MaxBodyBytes)
		}
		route.Handler.ServeHTTP(w, r)
	})
}
