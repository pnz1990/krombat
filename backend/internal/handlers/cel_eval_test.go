package handlers_test

import (
	"strings"
	"testing"

	"github.com/pnz1990/krombat/backend/internal/handlers"
)

func TestEvalCEL(t *testing.T) {
	spec := map[string]interface{}{
		"heroClass":  "warrior",
		"difficulty": "easy",
		"name":       "test-dungeon",
		"namespace":  "default",
	}
	status := map[string]interface{}{
		"game": map[string]interface{}{
			"heroHP":    int64(150),
			"bossHP":    int64(200),
			"inventory": "sword,shield",
		},
	}

	tests := []struct {
		expr    string
		want    string
		wantErr bool
	}{
		// Spec field access (config/triggers stay in spec)
		{"schema.spec.heroClass == \"warrior\"", "true", false},
		// Status.game field access (kro-computed game state)
		{"schema.status.game.heroHP > 100", "true", false},
		{"schema.status.game.bossHP == 0", "false", false},
		// Metadata
		{"schema.metadata.name", "test-dungeon", false},
		// cel.bind() macro — the core test
		{"cel.bind(x, schema.status.game.heroHP, x * 2)", "300", false},
		{"cel.bind(hp, schema.status.game.heroHP, hp > 100 ? \"alive\" : \"dead\")", "alive", false},
		// Arithmetic across spec and status.game
		{"schema.status.game.heroHP + schema.status.game.bossHP", "350", false},
		// String operations (ext.Strings)
		{"schema.spec.heroClass.startsWith(\"war\")", "true", false},
		// random.seededInt — deterministic
		{"random.seededInt(0, 100, \"test-seed\")", "", false}, // just check no error
		// kstate() — safe state access
		{"kstate(schema.status.game, 'heroHP', 0)", "150", false},
		// Error case: invalid expression
		{"schema.spec.nonexistent.deep.access + 1", "", true},
	}

	for _, tt := range tests {
		result, errMsg := handlers.EvalCEL(tt.expr, spec, status)
		if tt.wantErr {
			if errMsg == "" {
				t.Errorf("[%s]: expected error but got result %q", tt.expr, result)
			} else {
				t.Logf("PASS (expected error) [%s]: %s", tt.expr, errMsg)
			}
			continue
		}
		if errMsg != "" {
			t.Errorf("[%s]: unexpected error: %s", tt.expr, errMsg)
			continue
		}
		if tt.want != "" && result != tt.want {
			t.Errorf("[%s]: got %q, want %q", tt.expr, result, tt.want)
		} else {
			t.Logf("PASS [%s] = %s", tt.expr, result)
		}
	}
}

func TestEvalCELTooLong(t *testing.T) {
	spec := map[string]interface{}{}
	status := map[string]interface{}{
		"game": map[string]interface{}{"heroHP": int64(100)},
	}
	longExpr := strings.Repeat("a", 2001)
	_, errMsg := handlers.EvalCEL(longExpr, spec, status)
	if errMsg == "" {
		t.Error("expected error for too-long expression")
	}
}
