package handlers

// GitHub OAuth 2.0 SSO — session-cookie auth for Krombat.
//
// Flow:
//   1. Frontend calls GET /api/v1/auth/login  → redirect to GitHub OAuth
//      A short-lived HttpOnly cookie "krombat_oauth_state" is set on the browser.
//   2. GitHub redirects to GET /api/v1/auth/callback?code=...&state=...
//      The state param is compared to the cookie value (CSRF guard that works
//      across all pods — no shared in-memory store needed).
//   3. Backend exchanges code for token, fetches user identity, sets a signed
//      session cookie "krombat_session" containing login+avatarUrl+expiry,
//      HMAC-signed with SESSION_SECRET.  Any pod can verify it independently.
//   4. Frontend calls GET /api/v1/auth/me  → decodes cookie, returns identity or 401
//   5. GET /api/v1/auth/logout             → clears cookie
//
// This design is stateless across pods: no shared store, no sticky sessions.
// The session cookie carries all state; the HMAC prevents tampering.
//
// Required env vars:
//   GITHUB_CLIENT_ID      — from krombat-github-oauth Secret
//   GITHUB_CLIENT_SECRET  — from krombat-github-oauth Secret
//   SESSION_SECRET        — random ≥32-byte string for HMAC signing
//   GITHUB_CALLBACK_URL   — e.g. https://learn-kro.eks.aws.dev/api/v1/auth/callback

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	sessionCookieName    = "krombat_session"
	oauthStateCookieName = "krombat_oauth_state"
	// #429: reduced from 24h to 4h — limits stolen-cookie exposure window.
	sessionTTL = 4 * time.Hour
)

// sessionPayload is the data encoded in the session cookie.
// #429: Jti (JWT ID) is a per-session nonce for future revocation support.
// When a revocation store is added, Jti values can be blocklisted at logout.
type sessionPayload struct {
	Login     string `json:"l"`
	AvatarURL string `json:"a"`
	ExpiresAt int64  `json:"e"` // unix seconds
	Jti       string `json:"j"` // per-session nonce for revocation
}

// sessionSecret returns the HMAC key from SESSION_SECRET env var.
// main.go validates this is non-empty at startup — this function will only
// be called after that check passes. The random fallback is intentionally
// removed: running without a stable secret breaks multi-replica sessions.
var sessionSecret = func() []byte {
	s := os.Getenv("SESSION_SECRET")
	if s == "" {
		// This should never happen — main.go exits if SESSION_SECRET is absent.
		// Panic here to make any misconfiguration immediately obvious in tests.
		panic("auth: SESSION_SECRET is not set — main.go should have exited")
	}
	return []byte(s)
}()

// signToken encodes payload as JSON, appends an HMAC-SHA256 signature, and
// returns "<hex-json>.<hex-sig>" — safe for use as a cookie value.
func signToken(p sessionPayload) (string, error) {
	data, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	encoded := hex.EncodeToString(data)
	mac := hmac.New(sha256.New, sessionSecret)
	mac.Write([]byte(encoded))
	sig := hex.EncodeToString(mac.Sum(nil))
	return encoded + "." + sig, nil
}

// verifyToken parses and verifies a token produced by signToken.
// Returns nil if the token is invalid or expired.
func verifyToken(token string) *sessionPayload {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return nil
	}
	encoded, sig := parts[0], parts[1]
	// Verify HMAC
	mac := hmac.New(sha256.New, sessionSecret)
	mac.Write([]byte(encoded))
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(sig), []byte(expected)) {
		return nil
	}
	// Decode payload
	data, err := hex.DecodeString(encoded)
	if err != nil {
		return nil
	}
	var p sessionPayload
	if err := json.Unmarshal(data, &p); err != nil {
		return nil
	}
	// Check expiry
	if time.Now().Unix() > p.ExpiresAt {
		return nil
	}
	return &p
}

// randomHex generates a cryptographically random hex string of `n` bytes.
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Session holds an authenticated user's identity (attached to request context).
type Session struct {
	Login     string
	AvatarURL string
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

// AuthMiddleware decodes the session cookie and injects the Session into the
// request context.  Always calls next — endpoints that require auth check
// sessionFromCtx themselves.
//
// Test bypass: if KROMBAT_TEST_USER env var is set and the request carries
// X-Test-User header matching the env value, a synthetic session is injected.
func AuthMiddleware(next http.Handler) http.Handler {
	testUser := os.Getenv("KROMBAT_TEST_USER")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Test bypass (only active when KROMBAT_TEST_USER is configured)
		if testUser != "" && r.Header.Get("X-Test-User") == testUser {
			synthetic := &Session{Login: testUser, AvatarURL: ""}
			r = r.WithContext(context.WithValue(r.Context(), sessionContextKey, synthetic))
			next.ServeHTTP(w, r)
			return
		}
		// Normal cookie-based session
		if cookie, err := r.Cookie(sessionCookieName); err == nil && cookie.Value != "" {
			if p := verifyToken(cookie.Value); p != nil {
				sess := &Session{Login: p.Login, AvatarURL: p.AvatarURL}
				r = r.WithContext(context.WithValue(r.Context(), sessionContextKey, sess))
			}
		}
		next.ServeHTTP(w, r)
	})
}

// LoginHandler sets a short-lived state cookie and redirects to GitHub OAuth.
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
	// Store state in a short-lived HttpOnly cookie so any pod can verify it
	// at callback time — no shared in-memory store needed.
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookieName,
		Value:    state,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   600, // 10 minutes
	})
	callbackURL := os.Getenv("GITHUB_CALLBACK_URL")
	// #428: main.go validates GITHUB_CALLBACK_URL is non-empty at startup.
	// No fallback here — a missing callback URL is a misconfiguration.
	redirectURL := fmt.Sprintf(
		"https://github.com/login/oauth/authorize?client_id=%s&redirect_uri=%s&scope=read:user&state=%s",
		clientID, callbackURL, state,
	)
	http.Redirect(w, r, redirectURL, http.StatusFound)
}

// CallbackHandler verifies the OAuth state cookie, exchanges the code for a
// token, fetches the GitHub user, and sets a signed session cookie.
func CallbackHandler(w http.ResponseWriter, r *http.Request) {
	stateParam := r.URL.Query().Get("state")
	code := r.URL.Query().Get("code")

	// Verify state against the cookie (CSRF guard, works across all pods)
	stateCookie, err := r.Cookie(oauthStateCookieName)
	if err != nil || stateCookie.Value == "" || stateCookie.Value != stateParam {
		slog.Warn("oauth state mismatch", "param", stateParam, "cookie", func() string {
			if err != nil {
				return "(missing)"
			}
			return stateCookie.Value
		}())
		http.Error(w, "invalid oauth state", http.StatusBadRequest)
		return
	}
	// Clear the state cookie immediately
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})

	if code == "" {
		http.Error(w, "missing oauth code", http.StatusBadRequest)
		return
	}

	// Exchange code for access token
	clientID := os.Getenv("GITHUB_CLIENT_ID")
	clientSecret := os.Getenv("GITHUB_CLIENT_SECRET")
	// #428: main.go validates GITHUB_CALLBACK_URL at startup — no fallback needed here.
	callbackURL := os.Getenv("GITHUB_CALLBACK_URL")

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

	// Build a signed session token (stateless — no shared store needed)
	jti, err := randomHex(16)
	if err != nil {
		http.Error(w, "session create failed", http.StatusInternalServerError)
		return
	}
	payload := sessionPayload{
		Login:     ghUser.Login,
		AvatarURL: ghUser.AvatarURL,
		ExpiresAt: time.Now().Add(sessionTTL).Unix(),
		Jti:       jti,
	}
	token, err := signToken(payload)
	if err != nil {
		http.Error(w, "session create failed", http.StatusInternalServerError)
		return
	}

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

// LogoutHandler clears the session cookie.
func LogoutHandler(w http.ResponseWriter, r *http.Request) {
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

// TestLoginHandler issues a real signed session cookie when KROMBAT_TEST_USER is configured.
// It accepts ?token=<value> as a query param so automated browser tests can
// call page.goto('/api/v1/auth/test-login?token=...') to obtain a session without
// going through the full GitHub OAuth flow.
//
// Returns 404 when KROMBAT_TEST_USER is not set (disabled in production without the secret).
func TestLoginHandler(w http.ResponseWriter, r *http.Request) {
	testUser := os.Getenv("KROMBAT_TEST_USER")
	if testUser == "" {
		http.NotFound(w, r)
		return
	}
	token := r.URL.Query().Get("token")
	if token == "" || token != testUser {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	payload := sessionPayload{
		Login:     testUser,
		AvatarURL: "",
		ExpiresAt: time.Now().Add(sessionTTL).Unix(),
		Jti:       "test", // test sessions use a fixed jti — not revocable
	}
	signed, err := signToken(payload)
	if err != nil {
		http.Error(w, "session create failed", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    signed,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
	http.Redirect(w, r, "/", http.StatusFound)
}
