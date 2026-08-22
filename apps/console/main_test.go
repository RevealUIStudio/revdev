package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"

	gossh "golang.org/x/crypto/ssh"
)

func TestEnvOrDefault_ReturnsEnvValue(t *testing.T) {
	t.Setenv("TEST_ENV_OR_DEFAULT", "custom-value")

	got := envOrDefault("TEST_ENV_OR_DEFAULT", "fallback")
	if got != "custom-value" {
		t.Errorf("envOrDefault() = %q, want %q", got, "custom-value")
	}
}

func TestEnvOrDefault_ReturnsFallbackWhenUnset(t *testing.T) {
	os.Unsetenv("TEST_ENV_OR_DEFAULT_MISSING")

	got := envOrDefault("TEST_ENV_OR_DEFAULT_MISSING", "fallback")
	if got != "fallback" {
		t.Errorf("envOrDefault() = %q, want %q", got, "fallback")
	}
}

func TestEnvOrDefault_ReturnsFallbackWhenEmpty(t *testing.T) {
	t.Setenv("TEST_ENV_OR_DEFAULT_EMPTY", "")

	got := envOrDefault("TEST_ENV_OR_DEFAULT_EMPTY", "fallback")
	if got != "fallback" {
		t.Errorf("envOrDefault() = %q, want %q", got, "fallback")
	}
}

func TestEnvOrDefault_DefaultPortValue(t *testing.T) {
	os.Unsetenv("PORT")

	got := envOrDefault("PORT", defaultListenPort)
	if got != "2222" {
		t.Errorf("envOrDefault() = %q, want %q", got, "2222")
	}
}

func TestDefaultListenHost_IsLoopback(t *testing.T) {
	if defaultListenHost != "127.0.0.1" {
		t.Errorf("defaultListenHost = %q, want 127.0.0.1", defaultListenHost)
	}
}

func TestEnvOrDefault_DefaultHostValue(t *testing.T) {
	os.Unsetenv("HOST")

	got := envOrDefault("HOST", defaultListenHost)
	if got != "127.0.0.1" {
		t.Errorf("envOrDefault() = %q, want %q", got, "127.0.0.1")
	}
}

func mustTestKey(t *testing.T) gossh.PublicKey {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	return signer.PublicKey()
}

func writeTestAuthorizedKeys(t *testing.T, path string, keys ...gossh.PublicKey) {
	t.Helper()
	var body []byte
	for _, k := range keys {
		body = append(body, gossh.MarshalAuthorizedKey(k)...)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write authorized_keys: %v", err)
	}
}

func TestRequiredAuthorizedKeys_MissingRefusesStart(t *testing.T) {
	_, err := requiredAuthorizedKeys(filepath.Join(t.TempDir(), "missing"))
	if err == nil {
		t.Fatal("expected error when authorized_keys is missing")
	}
}

func TestRequiredAuthorizedKeys_EmptyRefusesStart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "authorized_keys")
	if err := os.WriteFile(path, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := requiredAuthorizedKeys(path)
	if err == nil {
		t.Fatal("expected error when authorized_keys is empty")
	}
}

func TestRequiredAuthorizedKeys_EmptyPathRefusesStart(t *testing.T) {
	_, err := requiredAuthorizedKeys("")
	if err == nil {
		t.Fatal("expected error when CONSOLE_AUTHORIZED_KEYS is unset")
	}
}

func TestAuthorizePublicKey_RejectsUnknownKey(t *testing.T) {
	allowed := mustTestKey(t)
	intruder := mustTestKey(t)
	if authorizePublicKey(intruder, []gossh.PublicKey{allowed}) {
		t.Fatal("unknown public key must be rejected")
	}
}

func TestAuthorizePublicKey_AcceptsAllowlistedKey(t *testing.T) {
	allowed := mustTestKey(t)
	if !authorizePublicKey(allowed, []gossh.PublicKey{allowed}) {
		t.Fatal("allowlisted public key must be accepted")
	}
}

func TestAuthorizePublicKey_RejectsNilKey(t *testing.T) {
	allowed := mustTestKey(t)
	if authorizePublicKey(nil, []gossh.PublicKey{allowed}) {
		t.Fatal("nil public key must be rejected")
	}
}

func TestAuthorizePublicKey_RejectsEmptyAllowlist(t *testing.T) {
	pub := mustTestKey(t)
	if authorizePublicKey(pub, nil) {
		t.Fatal("empty allowlist must reject every key")
	}
}

func TestRequiredAuthorizedKeys_MatchingKeyLoads(t *testing.T) {
	pub := mustTestKey(t)
	path := filepath.Join(t.TempDir(), "authorized_keys")
	writeTestAuthorizedKeys(t, path, pub)

	keys, err := requiredAuthorizedKeys(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !authorizePublicKey(pub, keys) {
		t.Fatal("key from the loaded file must authorize")
	}
	if authorizePublicKey(mustTestKey(t), keys) {
		t.Fatal("unknown key must still be rejected after a real load")
	}
}
