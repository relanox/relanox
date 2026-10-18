package storage_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"ariga.io/atlas/sql/postgres"
	atlasschema "ariga.io/atlas/sql/schema"
	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
	"github.com/relanox/relanox/internal/storage/ent"
)

// Status/doctor must inspect existing state without creating files or schema.
// Reusing Open would silently initialize an empty but existing SQLite file or
// PostgreSQL schema. Existing acceptance tests intentionally initialize stores
// and cannot catch that regression. Real databases and Ent/Atlas APIs suffice.
func TestOpenExistingDoesNotCreateOrInitializeSQLite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "existing.db")
	cfg := config.Storage{Driver: "sqlite", Path: path}
	if _, err := storage.OpenExisting(ctx, cfg, nil); !errors.Is(err, storage.ErrDatabaseUninitialized) {
		t.Fatalf("missing database: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("inspection created a database file")
	}
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.OpenExisting(ctx, cfg, nil); !errors.Is(err, storage.ErrDatabaseUninitialized) {
		t.Fatalf("empty database: %v", err)
	}
	assertUnchangedFile(t, path, nil)
	cfg.Path = ":memory:"
	if _, err := storage.OpenExisting(ctx, cfg, nil); !errors.Is(err, storage.ErrDatabaseUninitialized) {
		t.Fatalf("new in-memory database: %v", err)
	}
}

func TestOpenExistingReadsSupportedStateWithoutMutatingSQLite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "supported.db")
	cfg := config.Storage{Driver: "sqlite", Path: path}
	store, err := storage.Open(ctx, cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertStoredState(t, store, true)
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	store, err = storage.OpenExisting(ctx, cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertStoredState(t, store, false)
	if err := store.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	assertUnchangedFile(t, path, before)
}

func TestOpenExistingRefusesUnsupportedFormatsWithoutMutatingSQLite(t *testing.T) {
	for name, format := range map[string]int{"prior": 1, "future": 3} {
		t.Run(name, func(t *testing.T) { assertUnsupportedFormat(t, format) })
	}
}

func assertUnsupportedFormat(t *testing.T, format int) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "future.db")
	cfg := config.Storage{Driver: "sqlite", Path: path}
	store, err := storage.Open(ctx, cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertStoredState(t, store, true)
	_ = store.Close()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.SQLite, db)))
	if err := client.Metadata.UpdateOneID("schema").SetFormat(format).Exec(ctx); err != nil {
		t.Fatal(err)
	}
	_ = client.Close()
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.OpenExisting(ctx, cfg, nil); !errors.Is(err, storage.ErrIncompatibleDatabase) {
		t.Fatalf("unsupported format %d accepted: %v", format, err)
	}
	assertUnchangedFile(t, path, before)
}

func assertStoredState(t *testing.T, store *storage.Store, create bool) {
	t.Helper()
	namespace := model.StateNamespace{Component: "test", OwnerID: "existing"}
	if create {
		if result, err := store.CompareAndSetState(ctx, namespace, model.CompareAndSetStateInput{Key: "retained", Value: []byte(`{"value":"durable"}`)}); err != nil || result.Status != model.Updated {
			t.Fatalf("state: %#v %v", result, err)
		}
	}
	entry, err := store.GetState(ctx, namespace, "retained")
	if err != nil || entry == nil || entry.Version != 1 {
		t.Fatalf("existing state: %#v %v", entry, err)
	}
	var value map[string]string
	if err := json.Unmarshal(entry.Value, &value); err != nil || value["value"] != "durable" {
		t.Fatalf("existing JSON state: %s %v", entry.Value, err)
	}
}

func assertUnchangedFile(t *testing.T, path string, before []byte) {
	t.Helper()
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("read-only inspection modified database bytes")
	}
}

func TestOpenExistingDoesNotInitializePostgreSQLSchema(t *testing.T) {
	dsn := os.Getenv("RELANOX_TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("RELANOX_TEST_POSTGRES_URL is not configured")
	}
	name := createPostgresSchema(t, dsn)
	cfg := config.Storage{Driver: "postgres", Schema: name, URL: &model.SecretRef{Env: "RELANOX_TEST_POSTGRES_URL"}}
	resolve := func(model.SecretRef) (string, error) { return dsn, nil }
	if _, err := storage.OpenExisting(ctx, cfg, resolve); !errors.Is(err, storage.ErrDatabaseUninitialized) {
		t.Fatalf("empty PostgreSQL schema: %v", err)
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	driver, err := postgres.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := driver.InspectSchema(ctx, name, &atlasschema.InspectOptions{Mode: atlasschema.InspectTables})
	if err != nil || len(snapshot.Tables) != 0 {
		t.Fatalf("inspection initialized schema: %#v %v", snapshot, err)
	}
	store, err := storage.Open(ctx, cfg, resolve)
	if err != nil {
		t.Fatal(err)
	}
	assertStoredState(t, store, true)
	_ = store.Close()
	store, err = storage.OpenExisting(ctx, cfg, resolve)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	}()
	assertStoredState(t, store, false)
	cfg.Schema += "_missing"
	if _, err := storage.OpenExisting(ctx, cfg, resolve); !errors.Is(err, storage.ErrDatabaseUninitialized) {
		t.Fatalf("missing PostgreSQL schema: %v", err)
	}
}
