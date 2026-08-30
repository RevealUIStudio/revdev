package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/RevealUIStudio/revdev/apps/console/api"
)

func TestShort(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", ""},                     // empty must not panic
		{"abc", "abc"},               // shorter than 8
		{"12345678", "12345678"},     // exactly 8
		{"123456789", "12345678"},    // longer than 8 → truncated
		{"deadbeefcafe", "deadbeef"}, // long id
	}
	for _, c := range cases {
		if got := short(c.in); got != c.want {
			t.Errorf("short(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// newTestProxy wires a Proxy to an httptest server.
func newTestProxy(serverURL string) *Proxy {
	return New(api.NewClient(serverURL, "test-token"), serverURL)
}

func TestSpawnSession_RejectsNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	defer srv.Close()

	_, err := newTestProxy(srv.URL).spawnSession("agent")
	if err == nil {
		t.Fatal("expected an error on a 500 response, got nil")
	}
	if want := "API returned 500"; !strings.Contains(err.Error(), want) {
		t.Errorf("error %q should mention %q", err, want)
	}
}

func TestSpawnSession_RejectsEmptyID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"sessionId":""}`)
	}))
	defer srv.Close()

	_, err := newTestProxy(srv.URL).spawnSession("agent")
	if err == nil {
		t.Fatal("expected an error on an empty session id, got nil")
	}
	if want := "empty session id"; !strings.Contains(err.Error(), want) {
		t.Errorf("error %q should mention %q", err, want)
	}
}

func TestSpawnSession_Succeeds(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"sessionId":"abc123xyz"}`)
	}))
	defer srv.Close()

	id, err := newTestProxy(srv.URL).spawnSession("agent")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != "abc123xyz" {
		t.Errorf("sessionID = %q, want %q", id, "abc123xyz")
	}
}

func TestSpawnSession_NameWithQuoteIsValidJSON(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read body: %v", err)
		}
		gotBody = string(raw)
		fmt.Fprint(w, `{"sessionId":"quoted-ok"}`)
	}))
	defer srv.Close()

	name := `evil","cols":1,"x":"`
	id, err := newTestProxy(srv.URL).spawnSession(name)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != "quoted-ok" {
		t.Errorf("sessionID = %q, want quoted-ok", id)
	}

	// Body must be valid JSON with the name as a single string field — not
	// broken open by sprintf injection.
	var body struct {
		Name string `json:"name"`
		Cols int    `json:"cols"`
		Rows int    `json:"rows"`
	}
	if err := json.Unmarshal([]byte(gotBody), &body); err != nil {
		t.Fatalf("request body is not valid JSON: %v\nbody=%q", err, gotBody)
	}
	if body.Name != name {
		t.Errorf("name = %q, want %q", body.Name, name)
	}
	if body.Cols != 120 || body.Rows != 30 {
		t.Errorf("cols/rows = %d/%d, want 120/30", body.Cols, body.Rows)
	}
}
