package deployment_test

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

func docker(t *testing.T, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", args[0], err, output)
	}
	return strings.TrimSpace(string(output))
}

func cleanupDocker(args ...string) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = exec.CommandContext(ctx, "docker", args...).Run()
}

func seedDatabase(t *testing.T, path string) {
	t.Helper()
	ctx := context.Background()
	store, err := storage.Open(ctx, config.Storage{Driver: "sqlite", Path: path}, nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := store.CompareAndSetState(ctx, model.StateNamespace{Component: "deployment", OwnerID: "smoke"}, model.CompareAndSetStateInput{Key: "persistent-marker", Value: json.RawMessage(`{"retained":true}`)})
	if err != nil || result.Status != model.Updated {
		t.Fatalf("seed=%#v %v", result, err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	// Docker cp retains these fixture permissions while assigning root ownership.
	// The actual non-root container process must be able to reopen this database.
	if err = os.Chmod(path, 0666); err != nil {
		t.Fatal(err)
	}
}

func awaitHealthy(t *testing.T, container string) {
	t.Helper()
	deadline := time.Now().Add(35 * time.Second)
	for time.Now().Before(deadline) {
		state := docker(t, "inspect", "--format", `{{.State.Status}} {{.State.Health.Status}}`, container)
		if state == "running healthy" {
			return
		}
		if strings.HasPrefix(state, "exited") {
			t.Fatalf("container exited: %s", docker(t, "logs", container))
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("container never became healthy: %s", docker(t, "inspect", "--format", `{{json .State.Health}}`, container))
}

func assertPersisted(t *testing.T, container, directory string) {
	t.Helper()
	path := filepath.Join(directory, uuid.NewString()+".db")
	docker(t, "cp", container+":/data/relanox.db", path)
	store, err := storage.OpenExisting(context.Background(), config.Storage{Driver: "sqlite", Path: path}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	marker, err := store.GetState(context.Background(), model.StateNamespace{Component: "deployment", OwnerID: "smoke"}, "persistent-marker")
	if err != nil || marker == nil || string(marker.Value) != `{"retained":true}` {
		t.Fatalf("container lost durable state: %#v %v", marker, err)
	}
}

// Protects the actual distribution: a scratch image needs CA/config/state paths,
// a usable non-root UID, functioning doctor healthcheck and graceful SIGTERM.
// Binary/unit tests miss missing COPY files and named-volume permission errors.
// A real Ent fixture and the production image are used; no test-only runtime seam.
func TestProductionContainerHealthShutdownAndPersistentRestart(t *testing.T) {
	image := os.Getenv("RELANOX_TEST_CONTAINER_IMAGE")
	if image == "" {
		t.Skip("RELANOX_TEST_CONTAINER_IMAGE not set")
	}
	directory := t.TempDir()
	configDir := filepath.Join(directory, "config")
	if err := os.Mkdir(configDir, 0755); err != nil {
		t.Fatal(err)
	}
	data := []byte(`{"storage":{"driver":"sqlite","path":"/data/relanox.db"},"http":{"listen":"0.0.0.0:8787","managementListen":"127.0.0.1:8788"},"accounts":[],"endpoints":[],"bindings":[]}`)
	if err := os.WriteFile(filepath.Join(configDir, "relanox.json"), data, 0644); err != nil {
		t.Fatal(err)
	}
	seed := filepath.Join(directory, "seed.db")
	seedDatabase(t, seed)
	name := "relanox-go-smoke-" + uuid.NewString()
	volume := name + "-data"
	docker(t, "volume", "create", volume)
	defer cleanupDocker("volume", "rm", volume)
	container := docker(t, "create", "--name", name, "--read-only", "--mount", "type=bind,source="+configDir+",target=/config,readonly", "--mount", "type=volume,source="+volume+",target=/data", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--health-interval=1s", "--health-start-period=1s", image)
	defer cleanupDocker("rm", "--force", container)
	if user := docker(t, "inspect", "--format", `{{.Config.User}}`, container); user != "10001:10001" {
		t.Fatalf("image does not run as expected non-root UID: %s", user)
	}
	docker(t, "cp", seed, container+":/data/relanox.db")
	for range 2 {
		docker(t, "start", container)
		awaitHealthy(t, container)
		if status := docker(t, "exec", container, "/relanox", "status", "--json"); !strings.Contains(status, `"stats"`) {
			t.Fatalf("container CLI failed: %s", status)
		}
		docker(t, "stop", "--time", "35", container)
		if code := docker(t, "inspect", "--format", `{{.State.ExitCode}}`, container); code != "0" {
			t.Fatalf("SIGTERM exit=%s: %s", code, docker(t, "logs", container))
		}
		assertPersisted(t, container, directory)
	}
	docker(t, "cp", container+":/licenses/Relanox-LICENSE", filepath.Join(directory, "image-LICENSE"))
}
