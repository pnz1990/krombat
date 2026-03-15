package handlers

import (
	"bufio"
	"context"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/google/uuid"
)

type ctxKey string

const ctxKeyRequestID ctxKey = "request_id"

// responseWriter wraps http.ResponseWriter to capture status code and bytes written.
type responseWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.status = code
	rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
	n, err := rw.ResponseWriter.Write(b)
	rw.bytes += n
	return n, err
}

// Hijack implements http.Hijacker so that gorilla/websocket can take over the
// underlying TCP connection for WebSocket upgrades.
func (rw *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return rw.ResponseWriter.(http.Hijacker).Hijack()
}

// pathParamRe matches dynamic path segments (namespace names and dungeon names).
// Replaced with canonical placeholders to prevent label cardinality explosion.
var pathParamRe = regexp.MustCompile(`/[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]/[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]`)

// sanitizePath replaces dynamic path segments (namespace, dungeon name) with
// canonical placeholders so Prometheus label cardinality stays bounded.
func sanitizePath(path string) string {
	return pathParamRe.ReplaceAllString(path, "/:ns/:name")
}

// requestIDFromCtx extracts the request ID from the context.
func requestIDFromCtx(r *http.Request) string {
	if v, ok := r.Context().Value(ctxKeyRequestID).(string); ok {
		return v
	}
	return ""
}

// AccessLog wraps every route with structured access logging, request ID
// injection, and Prometheus counter/histogram instrumentation.
func AccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// Propagate or generate request ID
		reqID := r.Header.Get("X-Request-Id")
		if reqID == "" {
			reqID = uuid.NewString()
		}
		w.Header().Set("X-Request-Id", reqID)
		ctx := context.WithValue(r.Context(), ctxKeyRequestID, reqID)

		rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rw, r.WithContext(ctx))

		durationMs := time.Since(start).Milliseconds()
		sanitized := sanitizePath(r.URL.Path)
		statusStr := strconv.Itoa(rw.status)

		// Increment request counter (all requests, success and error)
		httpRequests.With(map[string]string{
			"method": r.Method,
			"path":   sanitized,
			"status": statusStr,
		}).Inc()

		// Observe latency histogram
		httpDuration.With(map[string]string{
			"method": r.Method,
			"path":   sanitized,
			"status": statusStr,
		}).Observe(float64(durationMs))

		slog.Info("http_request",
			"component", "api",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rw.status,
			"duration_ms", durationMs,
			"bytes", rw.bytes,
			"request_id", reqID,
			"remote_addr", r.RemoteAddr,
		)
	})
}
