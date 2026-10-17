package storage_test

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	atlassqlite "ariga.io/atlas/sql/sqlite"
	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	entschema "entgo.io/ent/dialect/sql/schema"
	"entgo.io/ent/schema/field"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

// This protects the migration refusal contract: a startup auto-migration must
// not convert or replace an archived database. Existing fresh/reopen tests do
// not exercise old schemas. Ent generates the fixture DDL; no seam is introduced.
func TestLegacyDatabaseIsRefusedBeforeMutation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	migration, err := entschema.NewMigrate(entsql.OpenDB(dialect.SQLite, db))
	if err != nil {
		t.Fatal(err)
	}
	table := entschema.NewTable("conversations").AddPrimary(&entschema.Column{Name: "id", Type: field.TypeString})
	if err := migration.Create(ctx, table); err != nil {
		t.Fatal(err)
	}
	query, args := entsql.Insert("conversations").Columns("id").Values("user-data").Query()
	if _, err := db.ExecContext(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
	s, err := storage.Open(ctx, config.Storage{Driver: "sqlite", Path: path}, nil)
	if s != nil || !errors.Is(err, storage.ErrIncompatibleDatabase) {
		t.Fatalf("legacy startup: %v %v", s, err)
	}
	inspector, err := atlassqlite.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	schema, err := inspector.InspectSchema(ctx, "main", nil)
	if err != nil || len(schema.Tables) != 1 || schema.Tables[0].Name != "conversations" {
		t.Fatalf("legacy schema mutated: %#v %v", schema, err)
	}
	query, args = entsql.Select("id").From(entsql.Table("conversations")).Query()
	var id string
	if err := db.QueryRowContext(ctx, query, args...).Scan(&id); err != nil || id != "user-data" {
		t.Fatalf("legacy data mutated: %q %v", id, err)
	}
}

func TestGeneratedMigrationOpensWithRuntime(t *testing.T) {
	// Reviewed migration SQL must create the same durable format as startup's
	// generated Ent schema, including the metadata row required on reopen.
	path := filepath.Join(t.TempDir(), "generated.db")
	cfg := config.Storage{Driver: "sqlite", Path: path}
	driver, dsn, dialectName := "sqlite", "file:"+filepath.ToSlash(path)+"?_pragma=foreign_keys(1)", "sqlite"
	var resolve func(model.SecretRef) (string, error)
	if value := os.Getenv("RELANOX_TEST_POSTGRES_URL"); value != "" {
		name := createPostgresSchema(t, value)
		cfg = config.Storage{Driver: "postgres", Schema: name, URL: &model.SecretRef{Env: "RELANOX_TEST_POSTGRES_URL"}}
		u, err := url.Parse(value)
		if err != nil {
			t.Fatal(err)
		}
		q := u.Query()
		q.Set("search_path", name)
		u.RawQuery = q.Encode()
		driver, dsn, dialectName = "pgx", u.String(), "postgres"
		resolve = func(model.SecretRef) (string, error) { return value, nil }
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join("migrations", dialectName, "001_initial.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, string(data)); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := storage.Open(ctx, cfg, resolve)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	r, err := s.State(model.StateNamespace{Component: "migration", OwnerID: "test"}).CompareAndSet(ctx, model.CompareAndSetStateInput{Key: "works", Value: json.RawMessage(`true`)})
	if err != nil || r.Status != model.Updated || r.Version != 1 {
		t.Fatalf("migrated database unusable: %#v %v", r, err)
	}
}
