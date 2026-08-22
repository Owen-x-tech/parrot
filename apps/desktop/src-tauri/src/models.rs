use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessState {
    pub harness: String,
    pub status: String,
    pub config_path: Option<String>,
    pub message: String,
    pub selected: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub onboarded: bool,
    pub authenticated: bool,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub port: u16,
    pub agents: Vec<HarnessState>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConversation {
    pub id: String,
    pub peer_name: String,
    pub peer_handle: String,
    pub preview: String,
    pub updated_at: String,
    pub unread: i64,
    pub peer_kind: String,
    pub can_compose: bool,
    pub participant_handles: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMessage {
    pub id: String,
    pub sender_handle: String,
    pub body: String,
    pub created_at: String,
    pub direction: String,
    pub state: String,
    pub reply_to_body: Option<String>,
    pub recipient_handle: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactEndpoint {
    pub id: String,
    pub name: String,
    pub handle: String,
    pub kind: String,
    pub scope: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentManifest {
    pub runtime_port: u16,
    pub executable: String,
    pub agents: Vec<HarnessState>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxItem {
    pub id: String,
    pub conversation_id: String,
    pub body: String,
    pub client_nonce: String,
    pub sender_handle: String,
    pub recipient_identity_id: Option<String>,
    pub attempts: i64,
    pub reply_to_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptItem { pub id: String, pub conversation_id: String, pub identity_handle: String, pub message_id: String, pub state: String }
