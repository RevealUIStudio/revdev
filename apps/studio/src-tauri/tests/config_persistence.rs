//! Exercise the actual store and shared writer without operator configuration.
mod config {
    include!("../src/config.rs");

    #[cfg(test)]
    mod loading_contract {
        use super::*;

        fn configured(intent: &str) -> StudioConfig {
            StudioConfig {
                intent: Some(intent.to_string()),
                setup_complete: true,
                ..StudioConfig::default()
            }
        }
        struct LoadFixture(PathBuf);
        impl LoadFixture {
            fn new() -> Self {
                let root = std::env::temp_dir()
                    .join(format!("studio-config-load-{}", uuid::Uuid::new_v4()));
                fs::create_dir(&root).unwrap();
                Self(root)
            }
            fn path(&self) -> PathBuf {
                self.0.join("config.json")
            }
        }
        impl Drop for LoadFixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        #[test]
        fn missing_config_defaults_without_writing_and_valid_config_restores() {
            let fixture = LoadFixture::new();
            let path = fixture.path();
            let state = ConfigState::load_at(&path).unwrap();
            assert!(!state.config.lock().unwrap().setup_complete);
            assert!(!path.exists());
            let expected = configured("restored");
            save_config_at(&path, &expected).unwrap();
            let state = ConfigState::load_at(&path).unwrap();
            assert_eq!(
                serde_json::to_value(&*state.config.lock().unwrap()).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
            let nested = fixture.0.join("not-created/config.json");
            assert!(ConfigState::load_at(&nested).is_ok());
            assert!(!nested.parent().unwrap().exists());
        }
        #[test]
        fn invalid_saved_config_refuses_state_and_preserves_original_bytes() {
            let fixture = LoadFixture::new();
            let path = fixture.path();
            let invalid: [&[u8]; 3] = [b"{", b"{\"setupComplete\":\"invalid\"}", b"\xff"];
            for original in invalid {
                fs::write(&path, original).unwrap();
                let error = ConfigState::load_at(&path)
                    .err()
                    .expect("Invalid config must refuse state");
                assert!(!error.contains("invalid"));
                assert_eq!(fs::read(&path).unwrap(), original);
            }
        }
        #[test]
        fn directory_read_failure_is_not_a_new_installation() {
            let fixture = LoadFixture::new();
            let path = fixture.path();
            fs::create_dir(&path).unwrap();
            assert!(ConfigState::load_at(&path).is_err());
            assert!(path.is_dir());
        }
        #[test]
        fn unavailable_config_directory_has_no_working_directory_fallback() {
            assert!(config_path_from(None).is_err());
            let base = PathBuf::from("synthetic-supported-directory");
            assert_eq!(
                config_path_from(Some(base.clone())).unwrap(),
                base.join("revealui-studio/config.json")
            );
        }
        #[cfg(unix)]
        #[test]
        fn dangling_config_links_refuse_defaults_but_valid_parent_links_allow_first_run() {
            use std::os::unix::fs::symlink;
            let fixture = LoadFixture::new();
            let path = fixture.path();
            symlink(fixture.0.join("absent.json"), &path).unwrap();
            assert!(ConfigState::load_at(&path).is_err());
            assert!(fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink());
            let parent = fixture.0.join("linked-parent");
            symlink(fixture.0.join("absent-directory"), &parent).unwrap();
            assert!(ConfigState::load_at(&parent.join("config.json")).is_err());
            fs::remove_file(&parent).unwrap();
            let real_parent = fixture.0.join("existing-directory");
            fs::create_dir(&real_parent).unwrap();
            symlink(&real_parent, &parent).unwrap();
            assert!(ConfigState::load_at(&parent.join("config.json")).is_ok());
            assert!(!real_parent.join("config.json").exists());
        }
    }
}
#[path = "../src/private_file.rs"]
mod private_file;
