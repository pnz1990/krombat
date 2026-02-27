package k8s

import (
	"context"
	"encoding/json"
	"log"

	"github.com/pnz1990/krombat/backend/internal/ws"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
)

var (
	DungeonGVR = schema.GroupVersionResource{Group: "game.k8s.example", Version: "v1alpha1", Resource: "dungeons"}
	AttackGVR  = schema.GroupVersionResource{Group: "game.k8s.example", Version: "v1alpha1", Resource: "attacks"}
)

func StartWatchers(client *Client, hub *ws.Hub) {
	go watchResource(client, hub, DungeonGVR, "DUNGEON_UPDATE")
	go watchResource(client, hub, AttackGVR, "ATTACK_EVENT")
}

func watchResource(client *Client, hub *ws.Hub, gvr schema.GroupVersionResource, eventType string) {
	for {
		watcher, err := client.Dynamic.Resource(gvr).Namespace("").Watch(context.Background(), metav1.ListOptions{})
		if err != nil {
			log.Printf("Watch error for %s: %v, retrying...", gvr.Resource, err)
			continue
		}
		for event := range watcher.ResultChan() {
			if event.Type == watch.Error {
				continue
			}
			obj, ok := event.Object.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			msg := ws.Event{
				Type:      eventType,
				Action:    string(event.Type),
				Name:      obj.GetName(),
				Namespace: obj.GetNamespace(),
				Payload:   obj.Object,
			}
			// For attacks, use the dungeon namespace/name from spec
			eventNS := obj.GetNamespace()
			eventName := obj.GetName()
			if eventType == "ATTACK_EVENT" {
				spec, _ := obj.Object["spec"].(map[string]interface{})
				if ns, ok := spec["dungeonNamespace"].(string); ok {
					eventNS = ns
				}
				if n, ok := spec["dungeonName"].(string); ok {
					eventName = n
				}
			}
			data, _ := json.Marshal(msg)
			hub.Broadcast(data, eventNS, eventName)
		}
	}
}
