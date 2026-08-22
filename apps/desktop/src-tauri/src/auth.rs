use anyhow::{Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::Rng;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::Mutex;

#[derive(Clone)]
pub struct PendingAuth { pub state: String, pub verifier: String }
pub struct AuthState(pub Mutex<Option<PendingAuth>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeResponse { device_session_token: String, firebase_custom_token: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshResponse { firebase_custom_token: String }

fn random_urlsafe() -> String { let mut bytes = [0u8; 32]; rand::rng().fill_bytes(&mut bytes); URL_SAFE_NO_PAD.encode(bytes) }

pub fn begin(web_url: &str, state: &AuthState) -> Result<String> {
    let verifier = random_urlsafe();
    let auth_state = random_urlsafe();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    *state.0.lock().expect("auth lock") = Some(PendingAuth { state: auth_state.clone(), verifier });
    Ok(format!("{web_url}/connect?state={}&code_challenge={}&redirect_uri=parrot%3A%2F%2Fauth%2Fcallback", url::form_urlencoded::byte_serialize(auth_state.as_bytes()).collect::<String>(), url::form_urlencoded::byte_serialize(challenge.as_bytes()).collect::<String>()))
}

pub async fn exchange(callback: &str, web_url: &str, state: &AuthState) -> Result<String> {
    let url = url::Url::parse(callback)?;
    let code = url.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.into_owned()).context("Missing auth code")?;
    let returned_state = url.query_pairs().find(|(k, _)| k == "state").map(|(_, v)| v.into_owned()).context("Missing auth state")?;
    let pending = state.0.lock().expect("auth lock").take().context("No authentication is pending")?;
    if pending.state != returned_state { anyhow::bail!("Authentication state mismatch"); }
    let response: ExchangeResponse = reqwest::Client::new().post(format!("{web_url}/api/desktop-auth/exchange"))
        .json(&serde_json::json!({ "code": code, "verifier": pending.verifier }))
        .send().await?.error_for_status()?.json().await?;
    keyring::Entry::new("chat.parrot.desktop", "device-session")?.set_password(&response.device_session_token)?;
    Ok(response.firebase_custom_token)
}

pub async fn refresh(web_url: &str) -> Result<String> {
    let device_token = keyring::Entry::new("chat.parrot.desktop", "device-session")?.get_password()?;
    let response: RefreshResponse = reqwest::Client::new().post(format!("{web_url}/api/desktop-auth/session"))
        .bearer_auth(device_token).send().await?.error_for_status()?.json().await?;
    Ok(response.firebase_custom_token)
}
