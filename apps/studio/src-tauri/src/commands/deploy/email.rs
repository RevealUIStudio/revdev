use super::super::error::StudioError;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use ts_rs::TS;

const TEST_SEND_WINDOW: Duration = Duration::from_secs(60);
const TEST_SEND_MAX: usize = 5;

static TEST_SEND_TIMES: Mutex<VecDeque<Instant>> = Mutex::new(VecDeque::new());

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "bindings/")]
pub struct EmailTestResult {
    pub message_id: String,
    pub sent_at: String,
}

pub(crate) fn take_test_send_slot() -> Result<(), StudioError> {
    let mut times = TEST_SEND_TIMES
        .lock()
        .map_err(|e| StudioError::LockPoisoned(e.to_string()))?;
    let now = Instant::now();
    while times.front().is_some_and(|t| now.duration_since(*t) > TEST_SEND_WINDOW) {
        times.pop_front();
    }
    if times.len() >= TEST_SEND_MAX {
        return Err(StudioError::Other(
            "Rate limit: 5 test emails per minute. Wait and try again.".into(),
        ));
    }
    times.push_back(now);
    Ok(())
}

fn require_test_inputs(to_email: &str, from_email: &str, private_key: &str) -> Result<(), StudioError> {
    if to_email.trim().is_empty() {
        return Err(StudioError::Config("Test recipient address is required".into()));
    }
    if from_email.trim().is_empty() {
        return Err(StudioError::Config(
            "From address is required (Workspace user with domain-wide delegation)".into(),
        ));
    }
    if private_key.trim().is_empty() {
        return Err(StudioError::Config("Service account private key is required".into()));
    }
    Ok(())
}

/// Send a test email via Resend API.
#[tauri::command]
pub async fn resend_send_test(api_key: String, to_email: String) -> Result<bool, StudioError> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.resend.com/emails")
        .bearer_auth(&api_key)
        .json(&serde_json::json!({
            "from": "RevDev <noreply@resend.dev>",
            "to": [to_email],
            "subject": "RevDev — Email Test",
            "text": "Your email configuration is working. This is a test from the RevDev setup wizard."
        }))
        .send()
        .await?;

    if resp.status().is_success() {
        Ok(true)
    } else {
        let text = resp.text().await.unwrap_or_default();
        Err(StudioError::Network(format!("Resend API error: {}", text)))
    }
}

/// Send a test email via SMTP.
#[tauri::command]
pub async fn smtp_send_test(
    host: String,
    port: u16,
    user: String,
    pass: String,
    to_email: String,
) -> Result<bool, StudioError> {
    use lettre::{
        message::Mailbox,
        transport::smtp::authentication::Credentials,
        AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    };

    // Use the SMTP user as the "from" address — self-hosters won't have noreply@revealui.com
    let from_addr = format!("RevDev <{}>", user);
    let email = Message::builder()
        .from(
            from_addr
                .parse()
                .map_err(|e| StudioError::Other(format!("Invalid from address: {e}")))?,
        )
        .to(to_email
            .parse::<Mailbox>()
            .map_err(|e| StudioError::Other(format!("Invalid to address: {e}")))?)
        .subject("RevDev — SMTP Test")
        .body("This is a test email from RevDev.".to_string())
        .map_err(|e| StudioError::Other(format!("Build email: {e}")))?;

    let creds = Credentials::new(user, pass);
    let mailer = AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
        .map_err(|e| StudioError::Network(format!("SMTP relay: {e}")))?
        .port(port)
        .credentials(creds)
        .build();

    mailer
        .send(email)
        .await
        .map_err(|e| StudioError::Network(format!("SMTP send failed: {e}")))?;

    Ok(true)
}

/// Send a real Gmail test message with a service account + domain-wide delegation.
/// Returns the Gmail message id. Never reports success without a send.
#[tauri::command]
pub async fn gmail_send_test(
    service_account_email: String,
    private_key: String,
    from_email: String,
    to_email: String,
) -> Result<EmailTestResult, StudioError> {
    require_test_inputs(&to_email, &from_email, &private_key)?;
    if service_account_email.trim().is_empty() {
        return Err(StudioError::Config("Service account email is required".into()));
    }
    take_test_send_slot()?;

    let token = google_access_token(&service_account_email, &private_key, &from_email).await?;
    let raw = rfc2822_raw(&from_email, &to_email)?;
    let client = reqwest::Client::new();
    let resp = client
        .post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
        .bearer_auth(&token)
        .json(&serde_json::json!({ "raw": raw }))
        .send()
        .await?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(StudioError::Network(classify_gmail_error(status.as_u16(), &body)));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| StudioError::Network(format!("Gmail response: {e}")))?;
    let message_id = parsed
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| StudioError::Network("Gmail send succeeded but returned no message id".into()))?
        .to_string();

    Ok(EmailTestResult {
        message_id,
        sent_at: chrono_like_now(),
    })
}

fn chrono_like_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn rfc2822_raw(from: &str, to: &str) -> Result<String, StudioError> {
    let message = format!(
        "From: {from}\r\nTo: {to}\r\nSubject: RevDev email test\r\n\r\nYour Gmail configuration is working. This is a test from the RevDev deploy wizard.\r\n"
    );
    use base64::Engine;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(message.as_bytes()))
}

#[derive(Serialize)]
struct GoogleClaims {
    iss: String,
    sub: String,
    scope: String,
    aud: String,
    iat: u64,
    exp: u64,
}

async fn google_access_token(
    client_email: &str,
    private_key_pem: &str,
    impersonate: &str,
) -> Result<String, StudioError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| StudioError::Crypto(e.to_string()))?
        .as_secs();
    let claims = GoogleClaims {
        iss: client_email.trim().to_string(),
        sub: impersonate.trim().to_string(),
        scope: "https://www.googleapis.com/auth/gmail.send".into(),
        aud: "https://oauth2.googleapis.com/token".into(),
        iat: now,
        exp: now + 3600,
    };
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(private_key_pem.trim().as_bytes()).map_err(|e| {
        StudioError::Crypto(format!("Invalid service-account private key (need PKCS8 PEM): {e}"))
    })?;
    let assertion = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &claims,
        &key,
    )
    .map_err(|e| StudioError::Crypto(format!("Failed to sign Google JWT: {e}")))?;

    let client = reqwest::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", assertion.as_str()),
        ])
        .send()
        .await?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(StudioError::Network(classify_gmail_error(status.as_u16(), &body)));
    }
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| StudioError::Network(format!("Token response: {e}")))?;
    parsed
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| StudioError::Network("Google token response had no access_token".into()))
}

fn classify_gmail_error(status: u16, body: &str) -> String {
    let lower = body.to_ascii_lowercase();
    if lower.contains("unauthorized_client") || lower.contains("invalid_grant") {
        return format!(
            "Delegation failed (HTTP {status}). Enable domain-wide delegation for this service account and authorize the gmail.send scope."
        );
    }
    if lower.contains("access_denied") || lower.contains("insufficient") {
        return format!(
            "Missing Gmail scope (HTTP {status}). Authorize https://www.googleapis.com/auth/gmail.send on the Workspace admin consent screen."
        );
    }
    if lower.contains("quota") || status == 429 {
        return format!("Gmail quota exhausted (HTTP {status}). Wait and retry.");
    }
    if status == 401 || status == 403 {
        return format!("Gmail rejected the credentials (HTTP {status}): {body}");
    }
    format!("Gmail API error (HTTP {status}): {body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_recipient_is_config_error() {
        let err = require_test_inputs("", "from@x.com", "-----BEGIN PRIVATE KEY-----").unwrap_err();
        assert!(err.to_string().contains("recipient"));
    }

    #[test]
    fn missing_from_is_config_error() {
        let err = require_test_inputs("to@x.com", "  ", "key").unwrap_err();
        assert!(err.to_string().contains("From address"));
    }

    #[test]
    fn missing_key_is_config_error() {
        let err = require_test_inputs("to@x.com", "from@x.com", "").unwrap_err();
        assert!(err.to_string().contains("private key"));
    }

    #[test]
    fn rate_limit_trips_on_sixth_call() {
        // Isolated from other tests by draining the queue first.
        {
            let mut times = TEST_SEND_TIMES.lock().expect("lock");
            times.clear();
        }
        for _ in 0..TEST_SEND_MAX {
            take_test_send_slot().expect("slot available");
        }
        let err = take_test_send_slot().unwrap_err();
        assert!(err.to_string().contains("Rate limit"));
        {
            let mut times = TEST_SEND_TIMES.lock().expect("lock");
            times.clear();
        }
    }
}
