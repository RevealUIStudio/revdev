package authz

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/ssh"
)

func mustKeyPair(t *testing.T) (ssh.PublicKey, ssh.Signer) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	return signer.PublicKey(), signer
}

func writeAuthorizedKeys(t *testing.T, path string, keys ...ssh.PublicKey) {
	t.Helper()
	var body []byte
	for _, k := range keys {
		body = append(body, ssh.MarshalAuthorizedKey(k)...)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write authorized_keys: %v", err)
	}
}

func TestLoadAuthorizedKeys_MissingFileDenies(t *testing.T) {
	keys, err := LoadAuthorizedKeys(filepath.Join(t.TempDir(), "does-not-exist"))
	if err == nil {
		t.Fatal("expected error for missing file")
	}
	if keys != nil {
		t.Fatalf("keys = %v, want nil on error", keys)
	}
}

func TestLoadAuthorizedKeys_EmptyPathDenies(t *testing.T) {
	keys, err := LoadAuthorizedKeys("")
	if err == nil {
		t.Fatal("expected error for empty path")
	}
	if keys != nil {
		t.Fatalf("keys = %v, want nil on error", keys)
	}
}

func TestLoadAuthorizedKeys_EmptyFileDenies(t *testing.T) {
	path := filepath.Join(t.TempDir(), "authorized_keys")
	if err := os.WriteFile(path, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	keys, err := LoadAuthorizedKeys(path)
	if err != nil {
		t.Fatalf("empty file should parse, got %v", err)
	}
	if len(keys) != 0 {
		t.Fatalf("len(keys) = %d, want 0", len(keys))
	}
	pub, _ := mustKeyPair(t)
	if KeyAuthorized(pub, keys) {
		t.Fatal("empty authorized set must deny any key")
	}
}

func TestLoadAuthorizedKeys_CommentOnlyDenies(t *testing.T) {
	path := filepath.Join(t.TempDir(), "authorized_keys")
	if err := os.WriteFile(path, []byte("# only a comment\n\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	keys, err := LoadAuthorizedKeys(path)
	if err != nil {
		t.Fatalf("comment-only file should parse, got %v", err)
	}
	if len(keys) != 0 {
		t.Fatalf("len(keys) = %d, want 0", len(keys))
	}
}

func TestKeyAuthorized_MatchingKeyAllows(t *testing.T) {
	pub, _ := mustKeyPair(t)
	other, _ := mustKeyPair(t)
	path := filepath.Join(t.TempDir(), "authorized_keys")
	writeAuthorizedKeys(t, path, other, pub)

	keys, err := LoadAuthorizedKeys(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !KeyAuthorized(pub, keys) {
		t.Fatal("matching key must be authorized")
	}
}

func TestKeyAuthorized_NonMatchingDenies(t *testing.T) {
	allowed, _ := mustKeyPair(t)
	intruder, _ := mustKeyPair(t)
	path := filepath.Join(t.TempDir(), "authorized_keys")
	writeAuthorizedKeys(t, path, allowed)

	keys, err := LoadAuthorizedKeys(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if KeyAuthorized(intruder, keys) {
		t.Fatal("non-matching key must be denied")
	}
}

func TestKeyAuthorized_NilCandidateDenies(t *testing.T) {
	pub, _ := mustKeyPair(t)
	if KeyAuthorized(nil, []ssh.PublicKey{pub}) {
		t.Fatal("nil candidate must be denied")
	}
}

func TestKeysEqual(t *testing.T) {
	a, _ := mustKeyPair(t)
	b, _ := mustKeyPair(t)
	if !KeysEqual(a, a) {
		t.Fatal("key must equal itself")
	}
	if KeysEqual(a, b) {
		t.Fatal("distinct keys must not equal")
	}
	if KeysEqual(nil, a) || KeysEqual(a, nil) {
		t.Fatal("nil must not equal a real key")
	}
	if !KeysEqual(nil, nil) {
		t.Fatal("nil equals nil")
	}
}
