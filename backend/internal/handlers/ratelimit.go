package handlers

import (
	"net/http"
	"sync"
	"time"
)

type rateLimiter struct {
	mu       sync.Mutex
	last     map[string]time.Time
	interval time.Duration
}

func newRateLimiter(interval time.Duration) *rateLimiter {
	return &rateLimiter{last: make(map[string]time.Time), interval: interval}
}

func (rl *rateLimiter) Allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	if t, ok := rl.last[key]; ok && time.Since(t) < rl.interval {
		return false
	}
	rl.last[key] = time.Now()
	return true
}

func (rl *rateLimiter) Wrap(next http.HandlerFunc, keyFn func(*http.Request) string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !rl.Allow(keyFn(r)) {
			http.Error(w, "rate limit exceeded, try again shortly", http.StatusTooManyRequests)
			return
		}
		next(w, r)
	}
}
