package handlers

// cel_eval.go — A minimal CEL-subset evaluator for the Playground feature.
//
// Supports the subset of CEL that appears in kro dungeon-graph RGDs:
//   - Field access:  schema.spec.<field>  (returns string/int/bool)
//   - Literals:      42, "normal", true, false
//   - Comparisons:   ==  !=  <  <=  >  >=
//   - Arithmetic:    +  -  *  /  (integer only)
//   - Logical:       &&  ||  !
//   - Ternary:       cond ? a : b
//   - Functions:     size(x)  string(x)  int(x)  has(self.spec.x)
//   - Optional:      self.spec.?field.orValue(default)
//
// Intentionally NOT supported (to prevent abuse): any()  filter()  map()
// external I/O, network calls, or panic-inducing inputs.
//
// Max expression length: 256 chars.  Evaluation depth: 32 levels.
// Returns (result string, wasError bool).

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

const maxExprLen = 256
const maxDepth = 32

// celValue holds a dynamically-typed CEL value.
type celValue struct {
	kind    celKind
	intVal  int64
	strVal  string
	boolVal bool
}

type celKind int

const (
	celInt celKind = iota
	celStr
	celBool
	celNull
)

func (v celValue) String() string {
	switch v.kind {
	case celInt:
		return strconv.FormatInt(v.intVal, 10)
	case celStr:
		return v.strVal
	case celBool:
		if v.boolVal {
			return "true"
		}
		return "false"
	}
	return "null"
}

func celBoolVal(b bool) celValue  { return celValue{kind: celBool, boolVal: b} }
func celIntVal(n int64) celValue  { return celValue{kind: celInt, intVal: n} }
func celStrVal(s string) celValue { return celValue{kind: celStr, strVal: s} }

// EvalCEL evaluates expr against the provided dungeon spec bindings.
// spec is a map of field-name → value (string or int64 or bool).
// Returns (result, errMsg).  errMsg is empty on success.
func EvalCEL(expr string, spec map[string]interface{}) (string, string) {
	expr = strings.TrimSpace(expr)
	if len(expr) > maxExprLen {
		return "", fmt.Sprintf("expression too long (max %d chars)", maxExprLen)
	}
	p := &celParser{src: expr, spec: spec, depth: 0}
	val, err := p.parseFull()
	if err != nil {
		return "", err.Error()
	}
	return val.String(), ""
}

// celParser is a recursive-descent parser/evaluator.
type celParser struct {
	src   string
	pos   int
	spec  map[string]interface{}
	depth int
}

func (p *celParser) parseFull() (celValue, error) {
	v, err := p.parseTernary()
	if err != nil {
		return celValue{}, err
	}
	p.skipWS()
	if p.pos < len(p.src) {
		return celValue{}, fmt.Errorf("unexpected token at position %d: %q", p.pos, p.src[p.pos:])
	}
	return v, nil
}

func (p *celParser) parseTernary() (celValue, error) {
	p.depth++
	if p.depth > maxDepth {
		return celValue{}, fmt.Errorf("expression too deeply nested")
	}
	defer func() { p.depth-- }()

	cond, err := p.parseOr()
	if err != nil {
		return celValue{}, err
	}
	p.skipWS()
	if p.pos >= len(p.src) || p.src[p.pos] != '?' {
		return cond, nil
	}
	p.pos++ // consume '?'
	thenVal, err := p.parseTernary()
	if err != nil {
		return celValue{}, err
	}
	p.skipWS()
	if p.pos >= len(p.src) || p.src[p.pos] != ':' {
		return celValue{}, fmt.Errorf("expected ':' in ternary expression")
	}
	p.pos++ // consume ':'
	elseVal, err := p.parseTernary()
	if err != nil {
		return celValue{}, err
	}
	if cond.kind == celBool && cond.boolVal {
		return thenVal, nil
	}
	return elseVal, nil
}

func (p *celParser) parseOr() (celValue, error) {
	left, err := p.parseAnd()
	if err != nil {
		return celValue{}, err
	}
	for {
		p.skipWS()
		if !p.consume("||") {
			break
		}
		right, err := p.parseAnd()
		if err != nil {
			return celValue{}, err
		}
		left = celBoolVal(isTruthy(left) || isTruthy(right))
	}
	return left, nil
}

func (p *celParser) parseAnd() (celValue, error) {
	left, err := p.parseCmp()
	if err != nil {
		return celValue{}, err
	}
	for {
		p.skipWS()
		if !p.consume("&&") {
			break
		}
		right, err := p.parseCmp()
		if err != nil {
			return celValue{}, err
		}
		left = celBoolVal(isTruthy(left) && isTruthy(right))
	}
	return left, nil
}

func (p *celParser) parseCmp() (celValue, error) {
	left, err := p.parseAdd()
	if err != nil {
		return celValue{}, err
	}
	p.skipWS()
	ops := []string{"==", "!=", "<=", ">=", "<", ">"}
	for _, op := range ops {
		if p.consume(op) {
			right, err := p.parseAdd()
			if err != nil {
				return celValue{}, err
			}
			return celBoolVal(compare(left, right, op)), nil
		}
	}
	return left, nil
}

func (p *celParser) parseAdd() (celValue, error) {
	left, err := p.parseMul()
	if err != nil {
		return celValue{}, err
	}
	for {
		p.skipWS()
		if p.consume("+") {
			right, err := p.parseMul()
			if err != nil {
				return celValue{}, err
			}
			// String concatenation or integer addition
			if left.kind == celStr || right.kind == celStr {
				left = celStrVal(left.String() + right.String())
			} else {
				left = celIntVal(left.intVal + right.intVal)
			}
		} else if p.consume("-") {
			right, err := p.parseMul()
			if err != nil {
				return celValue{}, err
			}
			left = celIntVal(left.intVal - right.intVal)
		} else {
			break
		}
	}
	return left, nil
}

func (p *celParser) parseMul() (celValue, error) {
	left, err := p.parseUnary()
	if err != nil {
		return celValue{}, err
	}
	for {
		p.skipWS()
		if p.consume("*") {
			right, err := p.parseUnary()
			if err != nil {
				return celValue{}, err
			}
			left = celIntVal(left.intVal * right.intVal)
		} else if p.consume("/") {
			right, err := p.parseUnary()
			if err != nil {
				return celValue{}, err
			}
			if right.intVal == 0 {
				return celValue{}, fmt.Errorf("division by zero")
			}
			left = celIntVal(left.intVal / right.intVal)
		} else {
			break
		}
	}
	return left, nil
}

func (p *celParser) parseUnary() (celValue, error) {
	p.skipWS()
	if p.consume("!") {
		v, err := p.parseAtom()
		if err != nil {
			return celValue{}, err
		}
		return celBoolVal(!isTruthy(v)), nil
	}
	if p.consume("-") {
		v, err := p.parseAtom()
		if err != nil {
			return celValue{}, err
		}
		return celIntVal(-v.intVal), nil
	}
	return p.parseAtom()
}

func (p *celParser) parseAtom() (celValue, error) {
	p.skipWS()
	if p.pos >= len(p.src) {
		return celValue{}, fmt.Errorf("unexpected end of expression")
	}
	ch := p.src[p.pos]

	// Parenthesized
	if ch == '(' {
		p.pos++
		v, err := p.parseTernary()
		if err != nil {
			return celValue{}, err
		}
		p.skipWS()
		if p.pos >= len(p.src) || p.src[p.pos] != ')' {
			return celValue{}, fmt.Errorf("expected ')'")
		}
		p.pos++
		return v, nil
	}

	// String literal
	if ch == '"' || ch == '\'' {
		return p.parseString(ch)
	}

	// Integer literal
	if ch >= '0' && ch <= '9' {
		return p.parseInt()
	}

	// Identifier / keyword / function call / field access
	if isIdentStart(ch) {
		return p.parseIdent()
	}

	return celValue{}, fmt.Errorf("unexpected character %q at position %d", string(ch), p.pos)
}

func (p *celParser) parseString(quote byte) (celValue, error) {
	p.pos++ // consume opening quote
	var sb strings.Builder
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if c == quote {
			p.pos++
			return celStrVal(sb.String()), nil
		}
		if c == '\\' && p.pos+1 < len(p.src) {
			p.pos++
			switch p.src[p.pos] {
			case 'n':
				sb.WriteByte('\n')
			case 't':
				sb.WriteByte('\t')
			default:
				sb.WriteByte(p.src[p.pos])
			}
		} else {
			sb.WriteByte(c)
		}
		p.pos++
	}
	return celValue{}, fmt.Errorf("unterminated string literal")
}

func (p *celParser) parseInt() (celValue, error) {
	start := p.pos
	for p.pos < len(p.src) && p.src[p.pos] >= '0' && p.src[p.pos] <= '9' {
		p.pos++
	}
	n, err := strconv.ParseInt(p.src[start:p.pos], 10, 64)
	if err != nil {
		return celValue{}, fmt.Errorf("invalid integer: %s", p.src[start:p.pos])
	}
	return celIntVal(n), nil
}

func (p *celParser) parseIdent() (celValue, error) {
	start := p.pos
	for p.pos < len(p.src) && isIdentChar(p.src[p.pos]) {
		p.pos++
	}
	// Include dots for field access chains (schema.spec.heroHP)
	for p.pos < len(p.src) && (p.src[p.pos] == '.' || isIdentChar(p.src[p.pos])) {
		p.pos++
	}
	ident := p.src[start:p.pos]

	// Check for optional chaining: self.spec.?field.orValue(default)
	if strings.Contains(ident, ".?") {
		return p.evalOptionalChain(ident)
	}

	// Keywords
	switch ident {
	case "true":
		return celBoolVal(true), nil
	case "false":
		return celBoolVal(false), nil
	case "null":
		return celValue{kind: celNull}, nil
	}

	// Function calls: consume '(' ... ')'
	p.skipWS()
	if p.pos < len(p.src) && p.src[p.pos] == '(' {
		return p.evalFunc(ident)
	}

	// Field access: schema.spec.X or self.spec.X
	return p.evalFieldAccess(ident)
}

// evalOptionalChain handles patterns like: self.spec.?field.orValue("default")
func (p *celParser) evalOptionalChain(chain string) (celValue, error) {
	// Parse: base.?field.orValue(default)
	idx := strings.Index(chain, ".?")
	if idx < 0 {
		return celValue{}, fmt.Errorf("invalid optional chain: %s", chain)
	}
	rest := chain[idx+2:] // e.g. "modifier.orValue"
	dotIdx := strings.Index(rest, ".")
	var fieldName, method string
	if dotIdx >= 0 {
		fieldName = rest[:dotIdx]
		method = rest[dotIdx+1:]
	} else {
		fieldName = rest
	}

	// Check if the field exists in spec
	val, exists := p.resolveSpecField(fieldName)

	// If method is orValue, consume the function call
	if method == "orValue" || strings.HasPrefix(method, "orValue") {
		p.skipWS()
		// consume '(' default ')'
		if p.pos >= len(p.src) || p.src[p.pos] != '(' {
			return celValue{}, fmt.Errorf("expected '(' after orValue")
		}
		p.pos++ // '('
		defaultVal, err := p.parseTernary()
		if err != nil {
			return celValue{}, err
		}
		p.skipWS()
		if p.pos >= len(p.src) || p.src[p.pos] != ')' {
			return celValue{}, fmt.Errorf("expected ')' after orValue argument")
		}
		p.pos++ // ')'
		if !exists || val.kind == celNull {
			return defaultVal, nil
		}
		return val, nil
	}

	if !exists {
		return celValue{kind: celNull}, nil
	}
	return val, nil
}

// evalFunc evaluates known built-in functions.
func (p *celParser) evalFunc(name string) (celValue, error) {
	// The ident may include a base path for method-call style: "self.spec.foo" then '('
	// For simplicity, we use just the last component as the function name.
	funcName := name
	if idx := strings.LastIndex(name, "."); idx >= 0 {
		funcName = name[idx+1:]
	}

	p.pos++ // consume '('
	// Parse comma-separated arguments
	var args []celValue
	p.skipWS()
	for p.pos < len(p.src) && p.src[p.pos] != ')' {
		arg, err := p.parseTernary()
		if err != nil {
			return celValue{}, err
		}
		args = append(args, arg)
		p.skipWS()
		if p.pos < len(p.src) && p.src[p.pos] == ',' {
			p.pos++
			p.skipWS()
		}
	}
	if p.pos >= len(p.src) {
		return celValue{}, fmt.Errorf("expected ')' after function arguments")
	}
	p.pos++ // consume ')'

	switch funcName {
	case "size":
		if len(args) != 1 {
			return celValue{}, fmt.Errorf("size() requires 1 argument")
		}
		switch args[0].kind {
		case celStr:
			return celIntVal(int64(len(args[0].strVal))), nil
		case celInt:
			return args[0], nil // size of a number = itself (for list sizes stored as int)
		}
		return celIntVal(0), nil

	case "string":
		if len(args) != 1 {
			return celValue{}, fmt.Errorf("string() requires 1 argument")
		}
		return celStrVal(args[0].String()), nil

	case "int":
		if len(args) != 1 {
			return celValue{}, fmt.Errorf("int() requires 1 argument")
		}
		switch args[0].kind {
		case celInt:
			return args[0], nil
		case celStr:
			n, err := strconv.ParseInt(strings.TrimSpace(args[0].strVal), 10, 64)
			if err != nil {
				return celValue{}, fmt.Errorf("int() cannot convert %q", args[0].strVal)
			}
			return celIntVal(n), nil
		case celBool:
			if args[0].boolVal {
				return celIntVal(1), nil
			}
			return celIntVal(0), nil
		}
		return celIntVal(0), nil

	case "has":
		// has(self.spec.field) — check existence
		if len(args) != 1 {
			return celValue{}, fmt.Errorf("has() requires 1 argument")
		}
		return celBoolVal(args[0].kind != celNull), nil

	case "min":
		if len(args) != 2 {
			return celValue{}, fmt.Errorf("min() requires 2 arguments")
		}
		if args[0].intVal < args[1].intVal {
			return args[0], nil
		}
		return args[1], nil

	case "max":
		if len(args) != 2 {
			return celValue{}, fmt.Errorf("max() requires 2 arguments")
		}
		if args[0].intVal > args[1].intVal {
			return args[0], nil
		}
		return args[1], nil
	}

	return celValue{}, fmt.Errorf("unknown function: %s()", funcName)
}

// evalFieldAccess resolves schema.spec.X or self.spec.X or self.metadata.name etc.
func (p *celParser) evalFieldAccess(chain string) (celValue, error) {
	parts := strings.Split(chain, ".")
	// strip leading "schema" or "self"
	if len(parts) > 0 && (parts[0] == "schema" || parts[0] == "self") {
		parts = parts[1:]
	}
	if len(parts) == 0 {
		return celValue{kind: celNull}, nil
	}

	// spec.X or just X
	if parts[0] == "spec" && len(parts) >= 2 {
		v, _ := p.resolveSpecField(parts[1])
		return v, nil
	}
	if parts[0] == "metadata" && len(parts) >= 2 {
		switch parts[1] {
		case "name":
			if v, ok := p.spec["name"].(string); ok {
				return celStrVal(v), nil
			}
		case "namespace":
			if v, ok := p.spec["namespace"].(string); ok {
				return celStrVal(v), nil
			}
		}
		return celValue{kind: celNull}, nil
	}

	// Direct field access (just the field name, or a chain we don't recognize)
	v, _ := p.resolveSpecField(parts[0])
	return v, nil
}

// resolveSpecField looks up a field in the spec map.
func (p *celParser) resolveSpecField(field string) (celValue, bool) {
	v, ok := p.spec[field]
	if !ok {
		return celValue{kind: celNull}, false
	}
	switch x := v.(type) {
	case string:
		return celStrVal(x), true
	case int64:
		return celIntVal(x), true
	case int:
		return celIntVal(int64(x)), true
	case float64:
		return celIntVal(int64(x)), true
	case bool:
		return celBoolVal(x), true
	}
	return celStrVal(fmt.Sprintf("%v", v)), true
}

// --- Helpers ---

func (p *celParser) skipWS() {
	for p.pos < len(p.src) && unicode.IsSpace(rune(p.src[p.pos])) {
		p.pos++
	}
}

// consume tries to consume the given token, skipping leading whitespace.
// Returns true and advances pos if matched.
func (p *celParser) consume(tok string) bool {
	p.skipWS()
	if strings.HasPrefix(p.src[p.pos:], tok) {
		// Make sure we don't accidentally consume "&&" when looking for "&"
		// or "==" for "=". All our tokens are either 1 or 2 chars and none
		// is a prefix of an identifier, so this is fine for our subset.
		p.pos += len(tok)
		return true
	}
	return false
}

func isIdentStart(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_'
}

func isIdentChar(c byte) bool {
	return isIdentStart(c) || c >= '0' && c <= '9'
}

func isTruthy(v celValue) bool {
	switch v.kind {
	case celBool:
		return v.boolVal
	case celInt:
		return v.intVal != 0
	case celStr:
		return v.strVal != ""
	}
	return false
}

func compare(a, b celValue, op string) bool {
	// String comparison
	if a.kind == celStr && b.kind == celStr {
		switch op {
		case "==":
			return a.strVal == b.strVal
		case "!=":
			return a.strVal != b.strVal
		case "<":
			return a.strVal < b.strVal
		case "<=":
			return a.strVal <= b.strVal
		case ">":
			return a.strVal > b.strVal
		case ">=":
			return a.strVal >= b.strVal
		}
	}
	// Boolean comparison
	if a.kind == celBool && b.kind == celBool {
		switch op {
		case "==":
			return a.boolVal == b.boolVal
		case "!=":
			return a.boolVal != b.boolVal
		}
		return false
	}
	// Numeric (coerce bool to int)
	av, bv := a.intVal, b.intVal
	if a.kind == celBool {
		if a.boolVal {
			av = 1
		} else {
			av = 0
		}
	}
	if b.kind == celBool {
		if b.boolVal {
			bv = 1
		} else {
			bv = 0
		}
	}
	switch op {
	case "==":
		return av == bv
	case "!=":
		return av != bv
	case "<":
		return av < bv
	case "<=":
		return av <= bv
	case ">":
		return av > bv
	case ">=":
		return av >= bv
	}
	return false
}
