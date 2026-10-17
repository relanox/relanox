package main

import (
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
)

// Generated ORM output follows its pinned generator. Handwritten production
// and test code both enforce the repository's complexity/nesting limits.
func analyzeSources(paths []string) ([]string, error) {
	var sources []string
	var violations []error
	fset := token.NewFileSet()
	for _, path := range paths {
		file, err := parser.ParseFile(fset, path, nil, parser.ParseComments|parser.SkipObjectResolution)
		if err != nil {
			return nil, err
		}
		if ast.IsGenerated(file) {
			continue
		}
		sources = append(sources, path)
		ast.Walk(nestingVisitor{fset: fset, violations: &violations}, file)
	}
	return sources, errors.Join(violations...)
}

type nestingVisitor struct {
	fset       *token.FileSet
	parent     ast.Node
	depth      int
	violations *[]error
}

func (v nestingVisitor) Visit(node ast.Node) ast.Visitor {
	if node == nil {
		return nil
	}
	control := false
	switch current := node.(type) {
	case *ast.FuncDecl, *ast.FuncLit:
		v.depth = 0
	case *ast.IfStmt:
		parent, chained := v.parent.(*ast.IfStmt)
		control = !chained || parent.Else != current
	case *ast.ForStmt, *ast.RangeStmt, *ast.SwitchStmt, *ast.TypeSwitchStmt, *ast.SelectStmt:
		control = true
	}
	if control {
		v.depth++
		if v.depth == 5 {
			*v.violations = append(*v.violations, fmt.Errorf("%s: control nesting exceeds 4", v.fset.Position(node.Pos())))
		}
	}
	v.parent = node
	return v
}
