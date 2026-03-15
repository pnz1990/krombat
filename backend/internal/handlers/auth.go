package handlers

// GitHub OAuth 2.0 SSO — session-cookie auth for Krombat.
//
// Flow:
//   1. Frontend calls GET /api/v1/auth/login  → redirect to GitHub OAuth
//   2. GitHub redirects to GET /api/v1/auth/callback?code=...&state=...
//      → backend exchanges code for token, fetches user identity, sets cookie
//   3. Frontend calls GET /api/v1/auth/me     → returns {login, avatarUrl} or 401
//   4. GET /api/v1/auth/logout               → clears cookie
//
// Sessions are kept in-memory (map protected by mutex) with a 24h TTL.
// No external store needed — pods restart clean, sessions are re-established
// via re-login.  With 3 replicas each pod has its own session store; the ALB's
// sticky-session is NOT used, so after any pod restart the user will be asked
// to log in again (acceptable for a demo).
//
// The session token is a 32-byte random value (hex-encoded) set as an
// HttpOnly, Secure, SameSite=Lax cookie.
//
// Required env vars:
//   GITHUB_CLIENT_ID      — from krombat-github-oauth Secret
//   GITHUB_CLIENT_SECRET  — from krombat-github-oauth Secret
//   GITHUB_CALLBACK_URL   — e.g. https://learn-kro.eks.aws.dev/api/v1/auth/callback

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"
)

const (
	sessionCookieName = "krombat_session"
	sessionTTL        = 24 * time.Hour
	oauthStateTTL     = 10 * time.Minute
)

// Session holds an authenticated user's identity.
type Session struct {
	Login     string
	AvatarURL string
	ExpiresAt time.Time
}

// sessionStore is an in-memory session registry.
type sessionStore struct {
	mu   sync.RWMutex
	data map[string]*Session
}

func newSessionStore() *sessionStore {
	s := &sessionStore{data: make(map[string]*Session)}
	go s.reapLoop()
	return s
}

func (s *sessionStore) set(token string, sess *Session) {
	s.mu.Lock()
	s.data[token] = sess
	s.mu.Unlock()
}

func (s *sessionStore) get(token string) (*Session, bool) {
	s.mu.RLock()
	sess, ok := s.data[token]
	s.mu.RUnlock()
	if !ok || time.Now().After(sess.ExpiresAt) {
		return nil, false
	}
	return sess, true
}

func (s *sessionStore) delete(token string) {
	s.mu.Lock()
	delete(s.data, token)
	s.mu.Unlock()
}

func (s *sessionStore) reapLoop() {
	for range time.Tick(15 * time.Minute) {
		s.mu.Lock()
		now := time.Now()
		for t, sess := range s.data {
			if now.After(sess.ExpiresAt) {
				delete(s.data, t)
			}
		}
		s.mu.Unlock()
	}
}

// oauthStateStore prevents CSRF during OAuth dance.
type oauthStateStore struct {
	mu   sync.Mutex
	data map[string]time.Time
}

func newOAuthStateStore() *oauthStateStore {
	return &oauthStateStore{data: make(map[string]time.Time)}
}

func (o *oauthStateStore) add(state string) {
	o.mu.Lock()
	o.data[state] = time.Now().Add(oauthStateTTL)
	o.mu.Unlock()
}

func (o *oauthStateStore) consume(state string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	exp, ok := o.data[state]
	if !ok || time.Now().After(exp) {
		return false
	}
	delete(o.data, state)
	return true
}

// package-level singletons
var (
	sessions    = newSessionStore()
	oauthStates = newOAuthStateStore()
)

// randomHex generates a cryptographically random hex string of `n` bytes.
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// contextKey is used to attach session data to request contexts.
type contextKey int

const sessionContextKey contextKey = 1

// sessionFromCtx returns the Session attached to r's context, or nil.
func sessionFromCtx(ctx context.Context) *Session {
	v := ctx.Value(sessionContextKey)
	if v == nil {
		return nil
	}
	return v.(*Session)
}

// AuthMiddleware extracts the session cookie, validates it, and injects the
// Session into the request context.  Always calls next — endpoints that
// require auth check sessionFromCtx themselves.
//
// Test bypass: if KROMBAT_TEST_USER env var is set and the request carries
// X-Test-User header matching the env value, a synthetic session is injected.
// This is used by integration tests to bypass OAuth without live GitHub creds.
func AuthMiddleware(next http.Handler) http.Handler {
	testUser := os.Getenv("KROMBAT_TEST_USER")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Test bypass (only active when KROMBAT_TEST_USER is configured)
		if testUser != "" && r.Header.Get("X-Test-User") == testUser {
			synthetic := &Session{
				Login:     testUser,
				AvatarURL: "",
				ExpiresAt: time.Now().Add(24 * time.Hour),
			}
			r = r.WithContext(context.WithValue(r.Context(), sessionContextKey, synthetic))
			next.ServeHTTP(w, r)
			return
		}
		// Normal cookie-based session lookup
		cookie, err := r.Cookie(sessionCookieName)
		if err == nil && cookie.Value != "" {
			if sess, ok := sessions.get(cookie.Value); ok {
				r = r.WithContext(context.WithValue(r.Context(), sessionContextKey, sess))
			}
		}
		next.ServeHTTP(w, r)
	})
}

// LoginHandler redirects the browser to GitHub's OAuth authorize page.
func LoginHandler(w http.ResponseWriter, r *http.Request) {
	clientID := os.Getenv("GITHUB_CLIENT_ID")
	if clientID == "" {
		http.Error(w, "OAuth not configured", http.StatusServiceUnavailable)
		return
	}
	state, err := randomHex(16)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	oauthStates.add(state)
	callbackURL := os.Getenv("GITHUB_CALLBACK_URL")
	if callbackURL == "" {
		callbackURL = "https://learn-kro.eks.aws.dev/api/v1/auth/callback"
	}
	redirectURL := "https://github.com/login/oauth/authorize" +
		"?client_id=" + clientID +
		"&redirect_uri=" + callbackURL +
		"&scope=read:user" +
		"&state=" + state
	http.Redirect(w, r, redirectURL, http.StatusFound)
}

// CallbackHandler exchanges the OAuth code for a token, fetches the GitHub
// user, and sets a session cookie.
func CallbackHandler(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	code := r.URL.Query().Get("code")
	if !oauthStates.consume(state) {
		http.Error(w, "invalid oauth state", http.StatusBadRequest)
		return
	}
	if code == "" {
		http.Error(w, "missing oauth code", http.StatusBadRequest)
		return
	}

	// Exchange code for access token
	clientID := os.Getenv("GITHUB_CLIENT_ID")
	clientSecret := os.Getenv("GITHUB_CLIENT_SECRET")
	callbackURL := os.Getenv("GITHUB_CALLBACK_URL")
	if callbackURL == "" {
		callbackURL = "https://learn-kro.eks.aws.dev/api/v1/auth/callback"
	}

	tokenURL := "https://github.com/login/oauth/access_token"
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, tokenURL, nil)
	q := req.URL.Query()
	q.Set("client_id", clientID)
	q.Set("client_secret", clientSecret)
	q.Set("code", code)
	q.Set("redirect_uri", callbackURL)
	req.URL.RawQuery = q.Encode()
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		slog.Error("oauth token exchange failed", "error", err)
		http.Error(w, "token exchange failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	var tokenResp struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil || tokenResp.AccessToken == "" {
		slog.Error("oauth token decode failed", "error", err, "oauthError", tokenResp.Error)
		http.Error(w, "token decode failed", http.StatusBadGateway)
		return
	}

	// Fetch GitHub user identity
	ghReq, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, "https://api.github.com/user", nil)
	ghReq.Header.Set("Authorization", "Bearer "+tokenResp.AccessToken)
	ghReq.Header.Set("Accept", "application/vnd.github+json")
	ghResp, err := http.DefaultClient.Do(ghReq)
	if err != nil {
		slog.Error("github user fetch failed", "error", err)
		http.Error(w, "user fetch failed", http.StatusBadGateway)
		return
	}
	defer ghResp.Body.Close()

	var ghUser struct {
		Login     string `json:"login"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := json.NewDecoder(ghResp.Body).Decode(&ghUser); err != nil || ghUser.Login == "" {
		slog.Error("github user decode failed", "error", err)
		http.Error(w, "user decode failed", http.StatusBadGateway)
		return
	}

	// Create session
	token, err := randomHex(32)
	if err != nil {
		http.Error(w, "session create failed", http.StatusInternalServerError)
		return
	}
	sessions.set(token, &Session{
		Login:     ghUser.Login,
		AvatarURL: ghUser.AvatarURL,
		ExpiresAt: time.Now().Add(sessionTTL),
	})

	slog.Info("user logged in", "component", "auth", "login", ghUser.Login)

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})

	// Redirect to frontend root after successful login
	http.Redirect(w, r, "/", http.StatusFound)
}

// MeHandler returns the current user's identity, or 401 if not authenticated.
func MeHandler(w http.ResponseWriter, r *http.Request) {
	sess := sessionFromCtx(r.Context())
	if sess == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]string{"error": "not authenticated"})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"login":     sess.Login,
		"avatarUrl": sess.AvatarURL,
	})
}

// LogoutHandler clears the session cookie and deletes the session.
func LogoutHandler(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(sessionCookieName)
	if err == nil && cookie.Value != "" {
		sessions.delete(cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"ok": "logged out"})
}
