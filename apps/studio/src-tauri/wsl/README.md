# WSL payload

`revdev-relay` is the Linux ELF Setup copies to `$HOME/.local/bin` on
Windows. The file is produced by Studio Release (`linux-relay` job) and
is gitignored. Build locally with:

```bash
cargo build --release --manifest-path apps/studio/relay/Cargo.toml
cp apps/studio/relay/target/release/revdev-relay apps/studio/src-tauri/wsl/revdev-relay
```
