// Package authz implements fail-closed public-key allowlisting for agents mode.
package authz

import (
	"bytes"
	"fmt"
	"os"

	"golang.org/x/crypto/ssh"
)

// LoadAuthorizedKeys reads an OpenSSH authorized_keys file and returns the
// public keys it contains. Missing files and unreadable paths return an error
// (callers treat that as deny). An empty or comment-only file returns a nil
// slice and a nil error — also a deny for agents mode.
func LoadAuthorizedKeys(path string) ([]ssh.PublicKey, error) {
	if path == "" {
		return nil, fmt.Errorf("authorized keys path is empty")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseAuthorizedKeys(data)
}

// ParseAuthorizedKeys parses the full contents of an authorized_keys file.
func ParseAuthorizedKeys(data []byte) ([]ssh.PublicKey, error) {
	var keys []ssh.PublicKey
	rest := data
	for len(rest) > 0 {
		var key ssh.PublicKey
		var err error
		key, _, _, rest, err = ssh.ParseAuthorizedKey(rest)
		if err != nil {
			// Remaining lines are comments, blanks, or unparseable — stop.
			break
		}
		keys = append(keys, key)
	}
	return keys, nil
}

// KeysEqual reports whether two SSH public keys are the same key material.
// x/crypto/ssh has no exported KeysEqual in current modules; equality is the
// wire-form Marshal comparison used throughout that package's tests.
func KeysEqual(a, b ssh.PublicKey) bool {
	if a == nil || b == nil {
		return a == b
	}
	return bytes.Equal(a.Marshal(), b.Marshal())
}

// KeyAuthorized reports whether candidate matches any key in authorized.
// A nil candidate never matches.
func KeyAuthorized(candidate ssh.PublicKey, authorized []ssh.PublicKey) bool {
	if candidate == nil || len(authorized) == 0 {
		return false
	}
	for _, k := range authorized {
		if KeysEqual(candidate, k) {
			return true
		}
	}
	return false
}
