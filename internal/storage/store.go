// Package storage implements the durable relay contracts with generated Ent
// queries. A database row serializes bounded write transactions across processes;
// no network operation occurs under that lock.
package storage

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"ariga.io/atlas/sql/postgres"
	atlasschema "ariga.io/atlas/sql/schema"
	atlassqlite "ariga.io/atlas/sql/sqlite"
	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	entschema "entgo.io/ent/dialect/sql/schema"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage/ent"
	"github.com/relanox/relanox/internal/storage/ent/metadata"
	"modernc.org/sqlite"
)

const schemaFormat = 1

var ErrIncompatibleDatabase = errors.New("incompatible_database_requires_explicit_migration")

var ErrDatabaseUninitialized = errors.New("storage_database_not_initialized")

type Store struct {
	db            *sql.DB
	client        *ent.Client
	driver        string
	schema        string
	existingOnly  bool
	initialize    sync.Once
	initializeErr error
}

var _ model.Storage = (*Store)(nil)

func Open(ctx context.Context, cfg config.Storage, resolve func(model.SecretRef) (string, error)) (*Store, error) {
	return open(ctx, cfg, resolve, false)
}

// OpenExisting verifies the supported schema/format without creating a database
// or initializing an empty schema. Explicit recovery writes remain available.
func OpenExisting(ctx context.Context, cfg config.Storage, resolve func(model.SecretRef) (string, error)) (*Store, error) {
	return open(ctx, cfg, resolve, true)
}

func open(ctx context.Context, cfg config.Storage, resolve func(model.SecretRef) (string, error), existingOnly bool) (*Store, error) {
	driver, dsn, err := connection(cfg, resolve)
	if err != nil {
		return nil, err
	}
	if existingOnly && driver == "sqlite" {
		dsn, err = existingSQLite(cfg.Path, dsn)
		if err != nil {
			return nil, err
		}
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, errors.New("storage_open_failed")
	}
	entDialect := dialect.Postgres
	if driver == "sqlite" {
		entDialect = dialect.SQLite
		db.SetMaxOpenConns(1)
	} else {
		db.SetMaxOpenConns(16)
	}
	store := &Store{db: db, driver: driver, schema: cfg.Schema, existingOnly: existingOnly, client: ent.NewClient(ent.Driver(entsql.OpenDB(entDialect, db)))}
	if err = store.Initialize(ctx); err != nil {
		_ = store.Close()
		return nil, err
	}
	return store, nil
}

func existingSQLite(path, dsn string) (string, error) {
	if path == ":memory:" {
		return "", ErrDatabaseUninitialized
	}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", ErrDatabaseUninitialized
	}
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("storage_path_unavailable")
	}
	u, err := url.Parse(dsn)
	if err != nil {
		return "", errors.New("storage_path_invalid")
	}
	query := u.Query()
	query.Set("mode", "rw") // Also fences removal between Stat and actual open.
	u.RawQuery = query.Encode()
	return u.String(), nil
}

func connection(cfg config.Storage, resolve func(model.SecretRef) (string, error)) (string, string, error) {
	if cfg.Driver == "sqlite" {
		path := cfg.Path
		if path == "" {
			return "", "", errors.New("storage_path_required")
		}
		u := &url.URL{Scheme: "file"}
		if path == ":memory:" {
			u.Opaque = uuid.NewString()
		} else {
			abs, err := filepath.Abs(path)
			if err != nil {
				return "", "", errors.New("storage_path_invalid")
			}
			u.Path = filepath.ToSlash(abs)
			if !strings.HasPrefix(u.Path, "/") {
				u.Path = "/" + u.Path
			}
		}
		q := url.Values{"_pragma": {"foreign_keys(1)", "busy_timeout(5000)"}, "_txlock": {"immediate"}}
		if path == ":memory:" {
			q.Set("mode", "memory")
			q.Set("cache", "shared")
		}
		u.RawQuery = q.Encode()
		return "sqlite", u.String(), nil
	}
	if cfg.Driver != "postgres" || cfg.URL == nil || resolve == nil {
		return "", "", errors.New("storage_driver_or_url_invalid")
	}
	dsn, err := resolve(*cfg.URL)
	if err != nil {
		return "", "", errors.New("storage_url_unavailable")
	}
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Host == "" {
		return "", "", errors.New("storage_url_invalid")
	}
	if cfg.Schema != "" {
		if !regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`).MatchString(cfg.Schema) {
			return "", "", errors.New("storage_schema_invalid")
		}
		q := u.Query()
		q.Set("search_path", cfg.Schema)
		u.RawQuery = q.Encode()
	}
	return "pgx", u.String(), nil
}

// Initialize first inspects without mutating. An archived TypeScript database,
// a partial schema or an unsupported format is never automatically rebuilt.
func (s *Store) Initialize(ctx context.Context) error {
	s.initialize.Do(func() { s.initializeErr = s.initializeDatabase(ctx) })
	return s.initializeErr
}

func (s *Store) initializeDatabase(ctx context.Context) error {
	if err := s.db.PingContext(ctx); err != nil {
		return errors.New("storage_unreachable")
	}
	empty, err := s.inspect(ctx)
	if err != nil {
		return err
	}
	if !empty {
		row, err := s.client.Metadata.Get(ctx, "schema")
		if err != nil || row.Format != schemaFormat {
			return ErrIncompatibleDatabase
		}
		return nil
	}
	if s.existingOnly {
		return ErrDatabaseUninitialized
	}
	opts := []entschema.MigrateOption{}
	if s.schema != "" {
		opts = append(opts, entschema.WithSchemaName(s.schema))
	}
	if err := s.client.Schema.Create(ctx, opts...); err != nil {
		return errors.New("storage_schema_creation_failed")
	}
	return s.client.Metadata.Create().SetID("schema").SetFormat(schemaFormat).OnConflictColumns(metadata.FieldID).Ignore().Exec(ctx)
}

func (s *Store) inspect(ctx context.Context) (bool, error) {
	var inspector atlasschema.Inspector
	if s.driver == "sqlite" {
		driver, err := atlassqlite.Open(s.db)
		if err != nil {
			return false, errors.New("storage_inspection_failed")
		}
		inspector = driver
	} else {
		driver, err := postgres.Open(s.db)
		if err != nil {
			return false, errors.New("storage_inspection_failed")
		}
		inspector = driver
	}
	snapshot, err := inspector.InspectSchema(ctx, s.schema, &atlasschema.InspectOptions{Mode: atlasschema.InspectTables})
	if err != nil {
		if s.existingOnly && atlasschema.IsNotExistError(err) {
			return false, ErrDatabaseUninitialized
		}
		return false, errors.New("storage_inspection_failed")
	}
	if len(snapshot.Tables) == 0 {
		return true, nil
	}
	expected := map[string]bool{"relanox_go_metadata": false, "relanox_go_conversations": false, "relanox_go_inbounds": false, "relanox_go_outbounds": false, "relanox_go_media": false, "relanox_go_state": false, "relanox_go_inbound_assets": false, "relanox_go_outbound_assets": false}
	for _, table := range snapshot.Tables {
		if _, ok := expected[table.Name]; !ok {
			return false, ErrIncompatibleDatabase
		}
		expected[table.Name] = true
	}
	for _, found := range expected {
		if !found {
			return false, ErrIncompatibleDatabase
		}
	}
	return false, nil
}

func (s *Store) write(ctx context.Context, operation func(*ent.Tx) error) error {
	for attempt := 0; attempt < 8; attempt++ {
		err := s.transaction(ctx, operation)
		if !retryTransaction(err) {
			return err
		}
		timer := time.NewTimer(min(100*time.Millisecond, time.Duration(1<<attempt)*5*time.Millisecond))
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return errors.New("storage_write_contention")
}

func (s *Store) transaction(ctx context.Context, operation func(*ent.Tx) error) error {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err = tx.Metadata.UpdateOneID("schema").AddSerial(1).Exec(ctx); err != nil {
		return err
	}
	if err = operation(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func retryTransaction(err error) bool {
	var sqliteError *sqlite.Error
	if errors.As(err, &sqliteError) {
		return sqliteError.Code()&0xff == 5 || sqliteError.Code()&0xff == 6
	}
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && (postgresError.Code == "40001" || postgresError.Code == "40P01")
}

func (s *Store) Health(ctx context.Context) (model.Health, error) {
	if err := s.db.PingContext(ctx); err != nil {
		return model.Health{OK: false, ErrorCode: "storage_unreachable"}, nil
	}
	return model.Health{OK: true}, nil
}

func (s *Store) Close() error { return s.client.Close() }
