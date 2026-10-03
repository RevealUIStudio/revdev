use std::path::Path;
use std::process::{Command, Output};

use super::super::error::StudioError;

/// Test a Neon connection string by running a query via psql.
#[tauri::command]
pub async fn neon_test_connection(connection_string: String) -> Result<String, StudioError> {
    run_database_command(connection_test_command(&connection_string)?).await
}

fn validate_connection_string(connection_string: &str) -> Result<(), StudioError> {
    let url = reqwest::Url::parse(connection_string)
        .map_err(|_| StudioError::Database("Enter a PostgreSQL connection URL".into()))?;
    if !matches!(url.scheme(), "postgres" | "postgresql")
        || url.host_str().is_none()
        || url.path().trim_matches('/').is_empty()
    {
        return Err(StudioError::Database(
            "Enter a PostgreSQL connection URL with a host and database name".into(),
        ));
    }
    // Keep target identity in URI authority/path so the confirmation describes
    // the same database that libpq uses; query routing aliases are ambiguous.
    for pair in url.query().unwrap_or_default().split('&') {
        let key = decode_uri_component(pair.split_once('=').map_or(pair, |(key, _)| key))?;
        if ["host", "hostaddr", "port", "dbname", "service"].contains(&key.as_str()) {
            return Err(StudioError::Database(
                "Specify the database target in the URL host, port and path".into(),
            ));
        }
    }
    Ok(())
}

fn connection_test_command(connection_string: &str) -> Result<Command, StudioError> {
    validate_connection_string(connection_string)?;
    let mut command = Command::new("psql");
    // libpq only expands a URI passed as dbname, not a PGDATABASE default.
    // Remove passwords from the URI before placing it in argv.
    let mut url = reqwest::Url::parse(connection_string).unwrap();
    let mut password = url.password().map(decode_uri_component).transpose()?;
    url.set_password(None)
        .map_err(|_| StudioError::Database("Invalid database URL".into()))?;
    let mut public_params = Vec::new();
    // libpq URI queries percent-decode values without form-style '+' decoding.
    for pair in url
        .query()
        .unwrap_or_default()
        .split('&')
        .filter(|pair| !pair.is_empty())
    {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = decode_uri_component(key)?;
        if key == "password" {
            password = Some(decode_uri_component(value)?);
        } else if key == "sslpassword" {
            return Err(StudioError::Database(
                "Encrypted client-key passwords are not supported by this connection test".into(),
            ));
        } else {
            public_params.push(pair.to_owned());
        }
    }
    url.set_query(None);
    if !public_params.is_empty() {
        url.set_query(Some(&public_params.join("&")));
    }
    if let Some(password) = password {
        command.env("PGPASSWORD", password);
    } else {
        command.env_remove("PGPASSWORD");
    }
    clear_database_routing_defaults(&mut command);
    command.env("PGCONNECT_TIMEOUT", "10").args([
        "--dbname",
        url.as_str(),
        "-X",
        "--no-password",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "SELECT NOW()",
    ]);
    Ok(command)
}

fn clear_database_routing_defaults(command: &mut Command) {
    // A URL without an explicit port must use the same default during its
    // connection test, migration and seed rather than inherit ambient PGPORT.
    for key in [
        "PGHOST",
        "PGHOSTADDR",
        "PGPORT",
        "PGDATABASE",
        "PGSERVICE",
        "PGSERVICEFILE",
    ] {
        command.env_remove(key);
    }
}

fn decode_uri_component(encoded: &str) -> Result<String, StudioError> {
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = encoded
                .get(index + 1..index + 3)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| StudioError::Database("Invalid URL component encoding".into()))?;
            decoded.push(pair);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded)
        .map_err(|_| StudioError::Database("Invalid URL component encoding".into()))
}

fn project_database_command(
    repo_path: &str,
    connection_string: &str,
    args: &[&str],
) -> Result<Command, StudioError> {
    validate_connection_string(connection_string)?;
    if repo_path.trim().is_empty() || !Path::new(repo_path).is_absolute() {
        return Err(StudioError::Database(
            "Select the absolute RevealUI project directory".into(),
        ));
    }
    let root = Path::new(repo_path)
        .canonicalize()
        .map_err(|_| StudioError::Database("Project directory does not exist".into()))?;
    if !root.join("package.json").is_file() || !root.join("pnpm-workspace.yaml").is_file() {
        return Err(StudioError::Database(
            "Select the RevealUI workspace root".into(),
        ));
    }
    let root_manifest: serde_json::Value = std::fs::read(root.join("package.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(|| {
            StudioError::Database("Cannot read the RevealUI workspace manifest".into())
        })?;
    let db_manifest: serde_json::Value = std::fs::read(root.join("packages/db/package.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(|| {
            StudioError::Database("Cannot read the RevealUI database package manifest".into())
        })?;
    if db_manifest.get("name").and_then(serde_json::Value::as_str) != Some("@revealui/db")
        || !root_manifest
            .pointer("/scripts/db:seed")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|script| !script.trim().is_empty())
        || !db_manifest
            .pointer("/scripts/db:migrate")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|script| !script.trim().is_empty())
    {
        return Err(StudioError::Database(
            "Select the RevealUI workspace with database migration and seed scripts".into(),
        ));
    }
    let mut command = Command::new("pnpm");
    clear_database_routing_defaults(&mut command);
    command
        .args(args)
        .current_dir(root)
        .env("POSTGRES_URL", connection_string)
        .env("DATABASE_URL", connection_string);
    Ok(command)
}

fn database_output(output: Output) -> Result<String, StudioError> {
    if !output.status.success() {
        return Err(StudioError::Database(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn run_database_command(mut command: Command) -> Result<String, StudioError> {
    let output = tokio::task::spawn_blocking(move || command.output())
        .await
        .map_err(|e| StudioError::Database(format!("Database command task failed: {e}")))?
        .map_err(|e| StudioError::Database(format!("Failed to run database command: {e}")))?;
    database_output(output)
}

/// Run Drizzle migrations.
#[tauri::command]
pub async fn run_db_migrate(
    repo_path: String,
    connection_string: String,
) -> Result<String, StudioError> {
    run_database_command(project_database_command(
        &repo_path,
        &connection_string,
        &[
            "--filter",
            "@revealui/db",
            "--fail-if-no-match",
            "db:migrate",
        ],
    )?)
    .await
}

/// Run database seed (mandatory — creates home page).
#[tauri::command]
pub async fn run_db_seed(
    repo_path: String,
    connection_string: String,
) -> Result<String, StudioError> {
    run_database_command(project_database_command(
        &repo_path,
        &connection_string,
        &["db:seed"],
    )?)
    .await
}
