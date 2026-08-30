// RevealUI Terminal — SSH payment + agent terminal service
//
// Usage:
//
//	ssh terminal.revealui.com              — payment TUI (default)
//	ssh terminal.revealui.com -t agents    — agent terminal proxy
//
// Mode selection:
//
//	TERMINAL_MODE=agents env var forces agent mode (no SSH command parsing).
//	Otherwise, if the SSH client sends "agents" as the command, agent mode.
//	Default: payment TUI.
//
// Built with the Charm ecosystem:
//   - Wish (SSH server)
//   - Bubble Tea (TUI framework)
//   - Lip Gloss (styling)
//
// Deploy: Fly.io or VPS (persistent TCP for SSH, not Vercel).
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	tea "charm.land/bubbletea/v2"
	"charm.land/wish/v2"
	bm "charm.land/wish/v2/bubbletea"
	"github.com/charmbracelet/ssh"

	gossh "golang.org/x/crypto/ssh"

	"github.com/RevealUIStudio/revdev/apps/console/api"
	"github.com/RevealUIStudio/revdev/apps/console/authz"
	"github.com/RevealUIStudio/revdev/apps/console/proxy"
	"github.com/RevealUIStudio/revdev/apps/console/tui"
)

// Loopback by default so an unconfigured binary is not reachable on LAN.
// Set HOST explicitly only when you intend to publish the port.
const defaultListenHost = "127.0.0.1"
const defaultListenPort = "2222"

func main() {
	host := envOrDefault("HOST", defaultListenHost)
	port := envOrDefault("PORT", defaultListenPort)
	hostKeyPath := envOrDefault("HOST_KEY_PATH", ".ssh/term_ed25519")
	apiURL := envOrDefault("REVEALUI_API_URL", "https://api.revealui.com")
	apiToken := os.Getenv("REVEALUI_API_TOKEN") // optional — empty for public-only
	defaultMode := envOrDefault("TERMINAL_MODE", "tui")

	allowed, err := requiredAuthorizedKeys(os.Getenv("CONSOLE_AUTHORIZED_KEYS"))
	if err != nil {
		log.Fatalf("refusing to start: %v", err)
	}

	client := api.NewClient(apiURL, apiToken)
	termProxy := proxy.New(client, apiURL)

	s, err := wish.NewServer(
		wish.WithAddress(fmt.Sprintf("%s:%s", host, port)),
		wish.WithHostKeyPath(hostKeyPath),
		wish.WithPublicKeyAuth(func(_ ssh.Context, key ssh.PublicKey) bool {
			return authorizePublicKey(key, allowed)
		}),
		wish.WithMiddleware(
			// Handshake already allowlists CONSOLE_AUTHORIZED_KEYS. Agents
			// mode re-checks the file (fail-closed) so an emptied allowlist
			// cannot keep driving the proxy / REVEALUI_API_TOKEN.
			func(next ssh.Handler) ssh.Handler {
				return func(s ssh.Session) {
					cmd := strings.Join(s.Command(), " ")
					if strings.TrimSpace(cmd) == "agents" || defaultMode == "agents" {
						if !authorizeAgentsSession(s) {
							return
						}
						termProxy.Handle(s)
						return
					}
					next(s)
				}
			},
			bm.Middleware(func(s ssh.Session) (tea.Model, []tea.ProgramOption) {
				return tui.NewModel(s, client), nil
			}),
		),
	)
	if err != nil {
		log.Fatalf("could not create server: %v", err)
	}

	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	log.Printf("RevealUI Terminal listening on %s:%s (mode: %s)", host, port, defaultMode)
	go func() {
		if err := s.ListenAndServe(); err != nil {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-done
	log.Println("shutting down...")
	ctx, cancel := context.WithTimeout(context.Background(), 5_000_000_000) // 5s
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		log.Fatalf("shutdown error: %v", err)
	}
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// requiredAuthorizedKeys loads an OpenSSH authorized_keys file and refuses
// an empty or missing allowlist. The SSH server must not start without one:
// billing TUI and the agent proxy both inherit REVEALUI_API_TOKEN.
func requiredAuthorizedKeys(path string) ([]gossh.PublicKey, error) {
	keys, err := authz.LoadAuthorizedKeys(path)
	if err != nil {
		return nil, fmt.Errorf("CONSOLE_AUTHORIZED_KEYS: %w", err)
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("CONSOLE_AUTHORIZED_KEYS has no keys; refusing to start")
	}
	return keys, nil
}

// authorizePublicKey is the Wish public-key callback: only allowlisted keys
// get a session (payment TUI or agents). Unknown / nil keys are rejected.
func authorizePublicKey(key ssh.PublicKey, allowed []gossh.PublicKey) bool {
	if key == nil || len(allowed) == 0 {
		return false
	}
	parsed, err := gossh.ParsePublicKey(key.Marshal())
	if err != nil {
		return false
	}
	return authz.KeyAuthorized(parsed, allowed)
}

// authorizeAgentsSession fails closed: only keys listed in the OpenSSH
// authorized_keys file at CONSOLE_AUTHORIZED_KEYS may reach the agent proxy
// (and therefore any REVEALUI_API_TOKEN attached to API calls).
func authorizeAgentsSession(s ssh.Session) bool {
	path := os.Getenv("CONSOLE_AUTHORIZED_KEYS")
	keys, err := authz.LoadAuthorizedKeys(path)
	if err != nil || len(keys) == 0 {
		fmt.Fprintf(s, "\r\nagents mode denied: authorized keys unavailable\r\n")
		return false
	}
	if !authz.KeyAuthorized(s.PublicKey(), keys) {
		fmt.Fprintf(s, "\r\nagents mode denied: public key not authorized\r\n")
		return false
	}
	return true
}
