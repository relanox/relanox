package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/relanox/relanox/internal/cli"
	"github.com/relanox/relanox/internal/config"
)

var version = "dev"

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := cli.Run(ctx, os.Args[1:], cli.Options{Version: version}); err != nil {
		code := safeError(err)
		if cli.JSONError(err) {
			_ = json.NewEncoder(os.Stderr).Encode(map[string]any{"ok": false, "errorCode": code})
		} else {
			fmt.Fprintln(os.Stderr, "relanox:", code)
		}
		os.Exit(1)
	}
}

func safeError(err error) string {
	var field *config.FieldError
	if errors.As(err, &field) {
		return field.Error()
	}
	var command *cli.Error
	if errors.As(err, &command) {
		return command.Code
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	return "command_failed"
}
