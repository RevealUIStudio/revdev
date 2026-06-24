package proxy

import (
	"fmt"
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
