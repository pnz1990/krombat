package ws

import (
	"log/slog"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

type Event struct {
	Type      string      `json:"type"`
	Action    string      `json:"action,omitempty"`
	Name      string      `json:"name,omitempty"`
	Namespace string      `json:"namespace,omitempty"`
	Payload   interface{} `json:"payload,omitempty"`
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type connFilter struct {
	namespace string
	name      string
}

type Hub struct {
	mu      sync.RWMutex
	clients map[*websocket.Conn]connFilter
}

func NewHub() *Hub {
	return &Hub{clients: make(map[*websocket.Conn]connFilter)}
}

func (h *Hub) Run() {}

func (h *Hub) Add(conn *websocket.Conn, namespace, name string) {
	h.mu.Lock()
	h.clients[conn] = connFilter{namespace: namespace, name: name}
	h.mu.Unlock()
}

func (h *Hub) Remove(conn *websocket.Conn) {
	h.mu.Lock()
	delete(h.clients, conn)
	h.mu.Unlock()
	conn.Close()
}

func (h *Hub) Broadcast(msg []byte, eventNS, eventName string) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for conn, f := range h.clients {
		if f.namespace != "" && f.namespace != eventNS {
			continue
		}
		if f.name != "" && f.name != eventName {
			continue
		}
		if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			slog.Warn("ws write error", "error", err)
			go h.Remove(conn)
		}
	}
}

func (h *Hub) Upgrade(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	return upgrader.Upgrade(w, r, nil)
}
