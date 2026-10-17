package cli

import (
	"github.com/relanox/relanox/internal/app"
	"github.com/spf13/cobra"
)

func (c *command) runCommand() *cobra.Command {
	return &cobra.Command{Use: "run", Short: "Start native channels, hosted agents and durable workers", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		cfg, err := c.load()
		if err != nil {
			return err
		}
		application, err := app.New(cmd.Context(), cfg, app.Options{LogWriter: c.options.Err})
		if err != nil {
			return err
		}
		return application.Run(cmd.Context())
	}}
}
