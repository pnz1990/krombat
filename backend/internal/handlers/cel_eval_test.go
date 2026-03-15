package handlers_test

import (
	"strings"
	"testing"

	"github.com/pnz1990/krombat/backend/internal/handlers"
)

func TestEvalCEL(t *testing.T) {
	spec := map[string]interface{}{
		"heroHP":    int64(150),
		"heroClass": "warrior",
		"bossHP":    int64(200),
		"inventory": "sword,shield",
		"name":      "test-dungeon",
		"namespace": "default",
	}

	tests := []struct {
		expr    string
		want    string
		wantErr bool
	}{
		// Basic field access
		{"schema.spec.heroHP > 100", "true", false},
		{"schema.spec.heroClass == \"warrior\"", "true", false},
		{"schema.spec.bossHP == 0", "false", false},
		// Metadata
		{"schema.metadata.name", "test-dungeon", false},
		// cel.bind() macro — the core test
		{"cel.bind(x, schema.spec.heroHP, x * 2)", "300", false},
		{"cel.bind(hp, schema.spec.heroHP, hp > 100 ? \"alive\" : \"dead\")", "alive", false},
		// Arithmetic
		{"schema.spec.heroHP + schema.spec.bossHP", "350", false},
		// String operations (ext.Strings)
		{"schema.spec.heroClass.startsWith(\"war\")", "true", false},
		// random.seededInt — deterministic
		{"random.seededInt(0, 100, \"test-seed\")", "", false}, // just check no error
		// csv.add — library.CSV
		{"csv.add(schema.spec.inventory, \"potion\", 5)", "", false}, // just check no error
		// Error case: invalid expression
		{"schema.spec.nonexistent.deep.access + 1", "", true},
	}

	for _, tt := range tests {
		result, errMsg := handlers.EvalCEL(tt.expr, spec)
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
	spec := map[string]interface{}{"heroHP": int64(100)}
	longExpr := strings.Repeat("a", 2001)
	_, errMsg := handlers.EvalCEL(longExpr, spec)
	if errMsg == "" {
		t.Error("expected error for too-long expression")
	}
}
