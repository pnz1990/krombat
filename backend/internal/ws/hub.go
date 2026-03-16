package ws

import (
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var wsConnections = promauto.NewGauge(prometheus.GaugeOpts{
	Name: "k8s_rpg_ws_connections",
	Help: "Active WebSocket connections",
})

type Event struct {
	Type      string      `json:"type"`
	Action    string      `json:"action,omitempty"`
	Name      string      `json:"name,omitempty"`
	Namespace string      `json:"namespace,omitempty"`
	Payload   interface{} `json:"payload,omitempty"`
}

// allowedOrigins returns the set of origins permitted for WebSocket upgrades.
// Configured via ALLOWED_ORIGINS env var (comma-separated).  Defaults to the
// prod ALB hostname so the pod starts safely without explicit configuration.
func allowedOrigins() map[string]bool {
	raw := os.Getenv("ALLOWED_ORIGINS")
	if raw == "" {
		raw = "https://learn-kro.eks.aws.dev"
	}
	m := make(map[string]bool)
	for _, o := range strings.Split(raw, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			m[o] = true
		}
	}
	return m
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		// Allow requests with no Origin header (same-origin curl / health checks)
		if origin == "" {
			return true
		}
		return allowedOrigins()[origin]
	},
}

type connFilter struct {
	namespace string
	name      string
}

// client wraps a WebSocket connection with a per-connection write mutex.
// gorilla/websocket connections are not safe for concurrent writes; the mutex
// ensures only one goroutine calls WriteMessage at a time per connection.
type client struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
	filter  connFilter
}

func (c *client) writeMessage(msgType int, data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.WriteMessage(msgType, data)
}

type Hub struct {
	mu      sync.RWMutex
	clients map[*websocket.Conn]*client
}

func NewHub() *Hub {
	return &Hub{clients: make(map[*websocket.Conn]*client)}
}

func (h *Hub) Run() {}

func (h *Hub) Add(conn *websocket.Conn, namespace, name string) {
	h.mu.Lock()
	h.clients[conn] = &client{
		conn:   conn,
		filter: connFilter{namespace: namespace, name: name},
	}
	h.mu.Unlock()
	wsConnections.Inc()
}

func (h *Hub) Remove(conn *websocket.Conn) {
	h.mu.Lock()
	delete(h.clients, conn)
	h.mu.Unlock()
	wsConnections.Dec()
	conn.Close()
}

func (h *Hub) Broadcast(msg []byte, eventNS, eventName string) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		f := c.filter
		if f.namespace != "" && f.namespace != eventNS {
			continue
		}
		if f.name != "" && f.name != eventName {
			continue
		}
		if err := c.writeMessage(websocket.TextMessage, msg); err != nil {
			slog.Warn("ws write error", "error", err)
			go h.Remove(c.conn)
		}
	}
}

func (h *Hub) Upgrade(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	return upgrader.Upgrade(w, r, nil)
}
