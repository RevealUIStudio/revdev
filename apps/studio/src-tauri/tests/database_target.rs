//! Synthetic command-builder checks include the actual owning database module.
//! No psql, pnpm, provider or live database is invoked by this target.
#[path = "../src/commands/error.rs"]
mod error;
mod deploy {
    mod database {
        include!("../src/commands/deploy/database.rs");

        #[cfg(test)]
        mod tests {
            use super::*;
            use std::ffi::OsStr;

            const URL: &str = "postgresql://audit:password@selected.invalid/database";

            #[test]
            fn connection_test_targets_selected_database_without_credentials_in_argv() {
                let command = connection_test_command(URL).unwrap();
                let env: std::collections::HashMap<_, _> = command.get_envs().collect();
                assert_eq!(
                    env.get(OsStr::new("PGPASSWORD")),
                    Some(&Some(OsStr::new("password")))
                );
                assert!(command
                    .get_args()
                    .any(|arg| arg == "postgresql://audit@selected.invalid/database"));
                assert!(!command
                    .get_args()
                    .any(|arg| arg.to_string_lossy().contains("password@")));
                assert!(command.get_args().any(|arg| arg == "-X"));
            }

            #[test]
            fn passwords_are_decoded_and_query_passwords_never_enter_argv() {
                assert_eq!(decode_uri_component("p%40ss+%E2%9C%93").unwrap(), "p@ss+✓");
                let command = connection_test_command(
            "postgresql://audit:p%40ss@selected.invalid/db?sslmode=require&options=-c%20x%3Dy&password=query+secret",
        )
        .unwrap();
                let env: std::collections::HashMap<_, _> = command.get_envs().collect();
                assert_eq!(
                    env.get(OsStr::new("PGPASSWORD")),
                    Some(&Some(OsStr::new("query+secret")))
                );
                let args: Vec<_> = command.get_args().collect();
                assert!(args.contains(&OsStr::new(
                    "postgresql://audit@selected.invalid/db?sslmode=require&options=-c%20x%3Dy"
                )));
            }

            #[test]
            fn connection_test_refuses_ambiguous_routing_and_removes_ambient_targets() {
                for key in ["host", "hostaddr", "port", "dbname", "service", "db%6eame"] {
                    assert!(connection_test_command(&format!("{URL}?{key}=other")).is_err());
                }
                let command = connection_test_command(URL).unwrap();
                let env: std::collections::HashMap<_, _> = command.get_envs().collect();
                for key in [
                    "PGHOST",
                    "PGHOSTADDR",
                    "PGPORT",
                    "PGDATABASE",
                    "PGSERVICE",
                    "PGSERVICEFILE",
                ] {
                    assert_eq!(env.get(OsStr::new(key)), Some(&None));
                }
            }

            #[test]
            fn rejects_missing_or_non_postgres_targets() {
                for value in [
                    "",
                    "database",
                    "https://example.invalid/db",
                    "postgresql://selected.invalid/",
                ] {
                    assert!(connection_test_command(value).is_err());
                }
                assert!(project_database_command("", URL, &["db:seed"]).is_err());
                assert!(project_database_command(".", URL, &["db:seed"]).is_err());
            }

            #[test]
            fn migration_and_seed_override_both_ambient_database_variables() {
                let root =
                    std::env::temp_dir().join(format!("revdev-db-target-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir(&root).unwrap();
                std::fs::write(
                    root.join("package.json"),
                    r#"{"name":"revealui","scripts":{"db:seed":"synthetic seed"}}"#,
                )
                .unwrap();
                std::fs::create_dir_all(root.join("packages/db")).unwrap();
                std::fs::write(
                    root.join("packages/db/package.json"),
                    r#"{"name":"@revealui/db","scripts":{"db:migrate":"synthetic migrate"}}"#,
                )
                .unwrap();
                std::fs::write(root.join("pnpm-workspace.yaml"), "packages: []").unwrap();
                for args in [
                    &[
                        "--filter",
                        "@revealui/db",
                        "--fail-if-no-match",
                        "db:migrate",
                    ][..],
                    &["db:seed"][..],
                ] {
                    let command =
                        project_database_command(root.to_str().unwrap(), URL, args).unwrap();
                    let env: std::collections::HashMap<_, _> = command.get_envs().collect();
                    for key in ["POSTGRES_URL", "DATABASE_URL"] {
                        assert_eq!(env.get(OsStr::new(key)), Some(&Some(OsStr::new(URL))));
                    }
                    assert_eq!(
                        command.get_current_dir(),
                        Some(root.canonicalize().unwrap().as_path())
                    );
                }
                std::fs::write(root.join("package.json"), "{}").unwrap();
                assert!(
                    project_database_command(root.to_str().unwrap(), URL, &["db:seed"]).is_err()
                );
                std::fs::remove_dir_all(root).unwrap();
            }
        }
    }
}
