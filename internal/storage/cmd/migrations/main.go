// Command migrations writes Ent-generated schema migrations against an empty
// development database. It does not apply the generated statements.
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"os"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	entschema "entgo.io/ent/dialect/sql/schema"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/relanox/relanox/internal/storage/ent"
	_ "modernc.org/sqlite"
)

func main() {
	driver := flag.String("driver", "sqlite", "sqlite or postgres")
	output := flag.String("out", "", "output SQL path")
	flag.Parse()
	if *output == "" {
		fail(fmt.Errorf("output path required"))
	}
	name, dsn, entDialect := "sqlite", "file:relanox_migration?mode=memory&cache=shared&_pragma=foreign_keys(1)", dialect.SQLite
	if *driver == "postgres" {
		name, dsn, entDialect = "pgx", os.Getenv("RELANOX_MIGRATION_URL"), dialect.Postgres
	} else if *driver != "sqlite" {
		fail(fmt.Errorf("unsupported driver"))
	}
	if dsn == "" {
		fail(fmt.Errorf("RELANOX_MIGRATION_URL required"))
	}
	db, err := sql.Open(name, dsn)
	if err != nil {
		fail(fmt.Errorf("database open failed"))
	}
	client := ent.NewClient(ent.Driver(entsql.OpenDB(entDialect, db)))
	defer func() { _ = client.Close() }()
	file, err := os.Create(*output)
	if err != nil {
		fail(err)
	}
	defer func() { _ = file.Close() }()
	if _, err = file.WriteString("-- Generated from internal/storage/ent/schema. Do not edit.\n"); err != nil {
		fail(err)
	}
	if err = client.Schema.WriteTo(context.Background(), file); err != nil {
		fail(err)
	}
	writer := ent.NewClient(ent.Driver(entschema.NewWriteDriver(entDialect, file)))
	if err = writer.Metadata.Create().SetID("schema").SetFormat(1).Exec(context.Background()); err != nil {
		fail(err)
	}
}

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
