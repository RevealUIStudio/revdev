//! Shared failure-atomic file publication, extracted from managed-license persistence.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub(crate) fn atomic_write_0600(path: &Path, contents: &[u8]) -> Result<(), String> {
    atomic_write_with(
        path,
        contents,
        |file, contents| {
            file.write_all(contents)?;
            file.sync_all()
        },
        |temporary, destination| fs::rename(temporary, destination),
    )
}

fn atomic_write_with(
    path: &Path,
    contents: &[u8],
    write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
    publish: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("file path has no parent: {}", path.display()))?;
    let name = path
        .file_name()
        .ok_or_else(|| "file path has no name".to_string())?;
    let mut directories = fs::DirBuilder::new();
    directories.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        directories.mode(0o700);
        directories
            .create(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("chmod 0700 {}: {e}", parent.display()))?;
    }
    #[cfg(not(unix))]
    directories
        .create(parent)
        .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;

    // Exclusive creation prevents stale files and symlinks from being truncated.
    // Unique names also allow simultaneous writes to different files in one directory.
    let mut opened = None;
    for _ in 0..128 {
        let mut temporary_name = std::ffi::OsString::from(".");
        temporary_name.push(name);
        temporary_name.push(format!(
            ".tmp-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let temporary = parent.join(temporary_name);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temporary) {
            Ok(file) => {
                opened = Some((TemporaryFile(temporary), file));
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("open temp {}: {error}", temporary.display())),
        }
    }
    let (temporary, mut file) =
        opened.ok_or_else(|| "Cannot create unique temporary file".to_string())?;
    write(&mut file, contents)
        .map_err(|e| format!("write/sync temp {}: {e}", temporary.0.display()))?;
    drop(file);
    publish(&temporary.0, path).map_err(|e| {
        format!(
            "rename {} to {}: {e}",
            temporary.0.display(),
            path.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn directory() -> TemporaryFile {
        let path = std::env::temp_dir().join(format!(
            "studio-private-test-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        TemporaryFile(path)
    }
    fn cleanup(directory: TemporaryFile) {
        fs::remove_dir_all(&directory.0).unwrap();
    }
    #[test]
    fn replaces_complete_file_and_removes_temporary_files() {
        let dir = directory();
        let path = dir.0.join("config.json");
        fs::write(&path, b"old complete value").unwrap();
        atomic_write_0600(&path, b"replacement").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
        cleanup(dir);
    }
    #[test]
    fn failed_partial_write_or_sync_preserves_destination_and_cleans_temporary_file() {
        let dir = directory();
        let path = dir.0.join("config.json");
        fs::write(&path, b"committed").unwrap();
        for fail_after_complete_write in [false, true] {
            let result = atomic_write_with(
                &path,
                b"replacement",
                |file, bytes| {
                    file.write_all(if fail_after_complete_write {
                        bytes
                    } else {
                        &bytes[..3]
                    })?;
                    Err(io::Error::other("injected write or sync failure"))
                },
                |_, _| panic!("failed write must not publish"),
            );
            assert!(result.is_err());
            assert_eq!(fs::read(&path).unwrap(), b"committed");
            assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
        }
        cleanup(dir);
    }
    #[test]
    fn failed_publication_preserves_destination_and_cleans_temporary_file() {
        let dir = directory();
        let path = dir.0.join("config.json");
        fs::write(&path, b"committed").unwrap();
        let result = atomic_write_with(
            &path,
            b"replacement",
            |file, bytes| {
                file.write_all(bytes)?;
                file.sync_all()
            },
            |_, _| Err(io::Error::other("injected rename failure")),
        );
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"committed");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
        cleanup(dir);
    }
    #[test]
    fn parent_creation_failure_preserves_existing_file() {
        let dir = directory();
        let path = dir.0.join("config.json");
        fs::write(&path, b"committed").unwrap();
        assert!(atomic_write_0600(&path.join("child"), b"replacement").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"committed");
        cleanup(dir);
    }
    #[test]
    fn concurrent_publications_never_mix_bytes() {
        let dir = directory();
        let path = Arc::new(dir.0.join("config.json"));
        let values: Vec<Vec<u8>> = (0..8).map(|i| vec![i; 8192]).collect();
        let threads: Vec<_> = values
            .iter()
            .cloned()
            .map(|value| {
                let path = Arc::clone(&path);
                std::thread::spawn(move || atomic_write_0600(&path, &value).unwrap())
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert!(values.contains(&fs::read(&*path).unwrap()));
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
        cleanup(dir);
    }
    #[cfg(unix)]
    #[test]
    fn stale_legacy_temporary_symlink_cannot_redirect_private_writes() {
        use std::os::unix::fs::symlink;
        let dir = directory();
        let path = dir.0.join("config.json");
        let unrelated = dir.0.join("unrelated");
        fs::write(&unrelated, b"unchanged").unwrap();
        let stale = dir
            .0
            .join(format!(".config.json.tmp-{}", std::process::id()));
        symlink(&unrelated, &stale).unwrap();
        atomic_write_0600(&path, b"synthetic private bytes").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"synthetic private bytes");
        assert_eq!(fs::read(unrelated).unwrap(), b"unchanged");
        assert!(fs::symlink_metadata(stale)
            .unwrap()
            .file_type()
            .is_symlink());
        cleanup(dir);
    }
    #[cfg(unix)]
    #[test]
    fn restricts_permissions_before_writing_private_bytes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = directory();
        let path = dir.0.join("nested/config.json");
        atomic_write_with(
            &path,
            b"synthetic private bytes",
            |file, bytes| {
                assert_eq!(file.metadata()?.permissions().mode() & 0o777, 0o600);
                file.write_all(bytes)?;
                file.sync_all()
            },
            |temporary, destination| fs::rename(temporary, destination),
        )
        .unwrap();
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        cleanup(dir);
    }
}
