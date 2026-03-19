package handlers

// cel_eval.go — CEL Playground evaluator using the real kro CEL environment.
//
// Uses github.com/pnz1990/kro pkg/cel BaseDeclarations(), which registers
// exactly the same libraries that kro uses on every reconcile:
//   - ext.Bindings()  (cel.bind() macro)
//   - ext.Lists()     (lists.* functions)
//   - library.Random() (random.seededInt, random.seededString)
//   - library.Maps()  (maps.*)
//   - library.JSON()  (json.*)
//   - library.Lists() (lists.setAtIndex, lists.insertAtIndex, lists.removeAtIndex)
//   - library.KState() (kstate(scope, field, default) for safe state access)
//
// Variable bindings follow the same schema as kro RGD expressions:
//   schema.spec.<field>          — from the dungeon spec (triggers, config)
//   schema.status.game.<field>   — from the dungeon status.game (kro-computed game state)
//   schema.status.<field>        — from the dungeon status (child CR projections)
//   schema.metadata.name         — dungeon name
//   schema.metadata.namespace    — dungeon namespace
//
// Max expression length: 2000 chars (playground, not production CEL).
// Returns (result string, errMsg string). errMsg is empty on success.

import (
	"fmt"
	"strings"

	"github.com/google/cel-go/cel"
	krocel "github.com/kubernetes-sigs/kro/pkg/cel"
)

const maxCelExprLen = 2000

// buildKroCelEnv builds a CEL environment with kro's full library set
// plus a "schema" variable of type map(string, dyn) to match RGD expressions.
var kroCelEnv *cel.Env

func init() {
	opts := krocel.BaseDeclarations()
	opts = append(opts,
		cel.Variable("schema", cel.MapType(cel.StringType, cel.DynType)),
	)
	var err error
	kroCelEnv, err = cel.NewEnv(opts...)
	if err != nil {
		panic(fmt.Sprintf("failed to build kro CEL env: %v", err))
	}
}

// EvalCEL evaluates expr against the provided dungeon bindings.
// spec is a map of field-name → value from the dungeon spec (flat, k8s types).
// status is the full status map (including status.game for state-node fields).
// Returns (result, errMsg). errMsg is empty on success.
func EvalCEL(expr string, spec map[string]interface{}, status map[string]interface{}) (string, string) {
	expr = strings.TrimSpace(expr)
	if len(expr) > maxCelExprLen {
		return "", fmt.Sprintf("expression too long (max %d chars)", maxCelExprLen)
	}

	// Build the schema variable as a nested map matching kro RGD variable layout:
	// schema = { "spec": { ... }, "status": { "game": { ... }, ... }, "metadata": { ... } }
	name, _ := spec["name"].(string)
	namespace, _ := spec["namespace"].(string)

	// Build a clean spec map without our injected metadata keys
	specMap := make(map[string]interface{}, len(spec))
	for k, v := range spec {
		if k == "name" || k == "namespace" {
			continue
		}
		specMap[k] = v
	}

	// Build status map — include game state and other status fields
	statusMap := make(map[string]interface{}, len(status))
	for k, v := range status {
		statusMap[k] = v
	}

	activation := map[string]interface{}{
		"schema": map[string]interface{}{
			"spec":   specMap,
			"status": statusMap,
			"metadata": map[string]interface{}{
				"name":      name,
				"namespace": namespace,
			},
		},
	}

	ast, issues := kroCelEnv.Compile(expr)
	if issues != nil && issues.Err() != nil {
		return "", issues.Err().Error()
	}

	prg, err := kroCelEnv.Program(ast)
	if err != nil {
		return "", err.Error()
	}

	out, _, err := prg.Eval(activation)
	if err != nil {
		return "", err.Error()
	}

	// Format the result as a human-readable string.
	// cel-go values implement fmt.Stringer via their native representation.
	return fmt.Sprintf("%v", out), ""
}
