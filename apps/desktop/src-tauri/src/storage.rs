use crate::models::{ContactEndpoint, LocalConversation, LocalMessage, OutboxItem, ReceiptItem};
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, sync::Mutex};

pub struct Storage {
    connection: Mutex<Connection>,
    pub data_dir: PathBuf,
}

impl Storage {
    pub fn open(data_dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&data_dir)?;
        let connection = Connection::open(data_dir.join("parrot.sqlite3"))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS conversations (
               id TEXT PRIMARY KEY, peer_name TEXT NOT NULL, peer_handle TEXT NOT NULL,
               peer_kind TEXT NOT NULL, preview TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
               unread INTEGER NOT NULL DEFAULT 0, recipient_identity_id TEXT,
               can_compose INTEGER NOT NULL DEFAULT 1,
               participant_handles TEXT NOT NULL DEFAULT '[]'
             );
             CREATE TABLE IF NOT EXISTS messages (
               id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_handle TEXT NOT NULL,
               body TEXT NOT NULL, created_at TEXT NOT NULL, direction TEXT NOT NULL,
               state TEXT NOT NULL, reply_to_body TEXT, recipient_handle TEXT,
               FOREIGN KEY(conversation_id) REFERENCES conversations(id)
             );
             CREATE TABLE IF NOT EXISTS outbox (
               id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, body TEXT NOT NULL,
               client_nonce TEXT NOT NULL UNIQUE, attempts INTEGER NOT NULL DEFAULT 0,
               next_attempt_at TEXT NOT NULL, last_error TEXT, reply_to_id TEXT
             );
             CREATE TABLE IF NOT EXISTS receipt_outbox (
               id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, identity_handle TEXT NOT NULL,
               message_id TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
               next_attempt_at TEXT NOT NULL, last_error TEXT
             );
             CREATE TABLE IF NOT EXISTS endpoints (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL UNIQUE,
               kind TEXT NOT NULL, scope TEXT NOT NULL
             );"
        )?;
        let has_recipient = {
            let mut statement = connection.prepare("PRAGMA table_info(messages)")?;
            let columns = statement.query_map([], |row| row.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
            columns.iter().any(|column| column == "recipient_handle")
        };
        if !has_recipient { connection.execute("ALTER TABLE messages ADD COLUMN recipient_handle TEXT", [])?; }
        let has_reply = {
            let mut statement = connection.prepare("PRAGMA table_info(outbox)")?;
            let columns = statement.query_map([], |row| row.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
            columns.iter().any(|column| column == "reply_to_id")
        };
        if !has_reply { connection.execute("ALTER TABLE outbox ADD COLUMN reply_to_id TEXT", [])?; }
        let has_can_compose = {
            let mut statement = connection.prepare("PRAGMA table_info(conversations)")?;
            let columns = statement.query_map([], |row| row.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
            columns.iter().any(|column| column == "can_compose")
        };
        if !has_can_compose { connection.execute("ALTER TABLE conversations ADD COLUMN can_compose INTEGER NOT NULL DEFAULT 1", [])?; }
        let has_participant_handles = {
            let mut statement = connection.prepare("PRAGMA table_info(conversations)")?;
            let columns = statement.query_map([], |row| row.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
            columns.iter().any(|column| column == "participant_handles")
        };
        if !has_participant_handles { connection.execute("ALTER TABLE conversations ADD COLUMN participant_handles TEXT NOT NULL DEFAULT '[]'", [])?; }
        Ok(Self { connection: Mutex::new(connection), data_dir })
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        let connection = self.connection.lock().expect("storage lock");
        Ok(connection.query_row("SELECT value FROM settings WHERE key=?1", [key], |row| row.get(0)).optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.connection.lock().expect("storage lock").execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn conversations(&self) -> Result<Vec<LocalConversation>> {
        let connection = self.connection.lock().expect("storage lock");
        let mut statement = connection.prepare(
            "SELECT id,peer_name,peer_handle,preview,updated_at,unread,peer_kind,can_compose,participant_handles FROM conversations ORDER BY updated_at DESC"
        )?;
        let items = statement.query_map([], |row| Ok(LocalConversation {
            id: row.get(0)?, peer_name: row.get(1)?, peer_handle: row.get(2)?, preview: row.get(3)?,
            updated_at: row.get(4)?, unread: row.get(5)?, peer_kind: row.get(6)?, can_compose: row.get(7)?,
            participant_handles: serde_json::from_str(&row.get::<_, String>(8)?).unwrap_or_default(),
        }))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(items)
    }

    pub fn conversations_for_handle(&self, handle: &str) -> Result<Vec<LocalConversation>> {
        Ok(self.conversations()?.into_iter().filter_map(|mut conversation| {
            conversation.participant_handles.iter().any(|participant| participant == handle).then(|| {
                // can_compose is a desktop-GUI concern. A bound agent endpoint can
                // always compose in a conversation where it is a participant.
                conversation.can_compose = true;
                conversation
            })
        }).collect())
    }

    pub fn cache_endpoints(&self, items: &[ContactEndpoint]) -> Result<()> {
        let connection = self.connection.lock().expect("storage lock");
        let transaction = connection.unchecked_transaction()?;
        transaction.execute("DELETE FROM endpoints", [])?;
        for item in items {
            transaction.execute(
                "INSERT INTO endpoints(id,name,handle,kind,scope) VALUES(?1,?2,?3,?4,?5)",
                params![item.id,item.name,item.handle,item.kind,item.scope],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn endpoints_for_handle(&self, sender_handle: &str) -> Result<Vec<ContactEndpoint>> {
        let connection = self.connection.lock().expect("storage lock");
        let mut statement = connection.prepare(
            "SELECT id,name,handle,kind,scope FROM endpoints WHERE handle<>?1 ORDER BY scope DESC,name COLLATE NOCASE,handle"
        )?;
        let items = statement.query_map([sender_handle], |row| Ok(ContactEndpoint {
            id: row.get(0)?, name: row.get(1)?, handle: row.get(2)?, kind: row.get(3)?, scope: row.get(4)?,
        }))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(items)
    }

    pub fn conversation_includes_handle(&self, conversation_id: &str, handle: &str) -> Result<bool> {
        let connection = self.connection.lock().expect("storage lock");
        let participants = connection.query_row("SELECT participant_handles FROM conversations WHERE id=?1", [conversation_id], |row| row.get::<_, String>(0)).optional()?;
        Ok(participants.and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok()).is_some_and(|items| items.iter().any(|participant| participant == handle)))
    }

    pub fn messages(&self, conversation_id: &str, limit: usize) -> Result<Vec<LocalMessage>> {
        let connection = self.connection.lock().expect("storage lock");
        let mut statement = connection.prepare(
            "SELECT id,sender_handle,body,created_at,direction,state,reply_to_body FROM messages WHERE conversation_id=?1 ORDER BY rowid DESC LIMIT ?2"
        )?;
        let mapped = statement.query_map(params![conversation_id, limit as i64], |row| Ok(LocalMessage {
            id: row.get(0)?, sender_handle: row.get(1)?, body: row.get(2)?, created_at: row.get(3)?,
            direction: row.get(4)?, state: row.get(5)?, reply_to_body: row.get(6)?, recipient_handle: None,
        }))?;
        let mut items = mapped.collect::<rusqlite::Result<Vec<_>>>()?;
        items.reverse();
        Ok(items)
    }

    pub fn queue_message(&self, conversation_id: &str, body: &str, sender_handle: &str, reply_to_id: Option<&str>, reply_to_body: Option<&str>) -> Result<LocalMessage> {
        if body.trim().is_empty() || body.as_bytes().len() > 16 * 1024 { anyhow::bail!("Message must contain 1 to 16384 UTF-8 bytes"); }
        let id = uuid::Uuid::new_v4().to_string();
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let connection = self.connection.lock().expect("storage lock");
        let participants = connection.query_row("SELECT participant_handles FROM conversations WHERE id=?1", [conversation_id], |row| row.get::<_, String>(0)).optional()?;
        let Some(participants) = participants else { anyhow::bail!("Conversation not found"); };
        let participants = serde_json::from_str::<Vec<String>>(&participants).unwrap_or_default();
        if !participants.is_empty() && !participants.iter().any(|participant| participant == sender_handle) {
            anyhow::bail!("The sending identity is not part of this conversation");
        }
        let transaction = connection.unchecked_transaction()?;
        transaction.execute("INSERT INTO messages(id,conversation_id,sender_handle,body,created_at,direction,state,reply_to_body) VALUES(?1,?2,?3,?4,?5,'outgoing','pending',?6)", params![id, conversation_id, sender_handle, body.trim(), now, reply_to_body])?;
        transaction.execute("INSERT INTO outbox(id,conversation_id,body,client_nonce,next_attempt_at,reply_to_id) VALUES(?1,?2,?3,?4,?5,?6)", params![id, conversation_id, body.trim(), nonce, now, reply_to_id])?;
        transaction.execute("UPDATE conversations SET preview=?1,updated_at=?2 WHERE id=?3", params![body.trim(), now, conversation_id])?;
        transaction.commit()?;
        Ok(LocalMessage { id, sender_handle: sender_handle.to_owned(), body: body.trim().to_owned(), created_at: "Now".into(), direction: "outgoing".into(), state: "pending".into(), reply_to_body: reply_to_body.map(str::to_owned), recipient_handle: None })
    }

    pub fn queue_message_to_endpoint(&self, recipient_handle: &str, body: &str, sender_handle: &str, reply_to_id: Option<&str>) -> Result<LocalMessage> {
        if body.trim().is_empty() || body.as_bytes().len() > 16 * 1024 { anyhow::bail!("Message must contain 1 to 16384 UTF-8 bytes"); }
        if recipient_handle == sender_handle { anyhow::bail!("Choose a different Parrot endpoint"); }
        let connection = self.connection.lock().expect("storage lock");
        let sender = connection.query_row(
            "SELECT id FROM endpoints WHERE handle=?1 AND scope='self'", [sender_handle], |row| row.get::<_, String>(0)
        ).optional()?.ok_or_else(|| anyhow::anyhow!("Parrot's endpoint directory has not synced this agent yet"))?;
        let recipient = connection.query_row(
            "SELECT id,name,kind FROM endpoints WHERE handle=?1", [recipient_handle],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        ).optional()?.ok_or_else(|| anyhow::anyhow!("No visible Parrot endpoint matches {recipient_handle}"))?;
        let mut identities = [sender, recipient.0.clone()];
        identities.sort();
        let conversation_id = format!("conversation_{:x}", Sha256::digest(identities.join(":").as_bytes()));
        let participant_handles = serde_json::to_string(&[sender_handle, recipient_handle])?;
        let id = uuid::Uuid::new_v4().to_string();
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let transaction = connection.unchecked_transaction()?;
        transaction.execute(
            "INSERT INTO conversations(id,peer_name,peer_handle,peer_kind,preview,updated_at,unread,recipient_identity_id,can_compose,participant_handles)
             VALUES(?1,?2,?3,?4,?5,?6,0,?7,0,?8)
             ON CONFLICT(id) DO UPDATE SET peer_name=excluded.peer_name,peer_handle=excluded.peer_handle,peer_kind=excluded.peer_kind,preview=excluded.preview,updated_at=excluded.updated_at,recipient_identity_id=excluded.recipient_identity_id,participant_handles=excluded.participant_handles",
            params![conversation_id,recipient.1,recipient_handle,recipient.2,body.trim(),now,recipient.0,participant_handles],
        )?;
        transaction.execute(
            "INSERT INTO messages(id,conversation_id,sender_handle,recipient_handle,body,created_at,direction,state) VALUES(?1,?2,?3,?4,?5,?6,'outgoing','pending')",
            params![id,conversation_id,sender_handle,recipient_handle,body.trim(),now],
        )?;
        transaction.execute(
            "INSERT INTO outbox(id,conversation_id,body,client_nonce,next_attempt_at,reply_to_id) VALUES(?1,?2,?3,?4,?5,?6)",
            params![id,conversation_id,body.trim(),nonce,now,reply_to_id],
        )?;
        transaction.commit()?;
        Ok(LocalMessage { id, sender_handle: sender_handle.to_owned(), body: body.trim().to_owned(), created_at: "Now".into(), direction: "outgoing".into(), state: "pending".into(), reply_to_body: None, recipient_handle: Some(recipient_handle.to_owned()) })
    }

    pub fn pending_for_handle(&self, handle: &str, limit: usize) -> Result<Vec<LocalMessage>> {
        let connection = self.connection.lock().expect("storage lock");
        let mut statement = connection.prepare(
            "SELECT m.id,m.sender_handle,m.body,m.created_at,m.direction,m.state,m.reply_to_body
             FROM messages m
             WHERE m.recipient_handle=?1 AND m.state='accepted'
             ORDER BY m.created_at LIMIT ?2"
        )?;
        let mapped = statement.query_map(params![handle, limit as i64], |row| Ok(LocalMessage {
            id: row.get(0)?, sender_handle: row.get(1)?, body: row.get(2)?, created_at: row.get(3)?, direction: row.get(4)?, state: row.get(5)?, reply_to_body: row.get(6)?, recipient_handle: Some(handle.to_owned()),
        }))?;
        let items = mapped.collect::<rusqlite::Result<Vec<_>>>()?;
        for item in &items {
            connection.execute("UPDATE messages SET state='seen' WHERE id=?1", [&item.id]).context("marking agent injection")?;
            let receipt_id = format!("{}:{}:seen", handle, item.id);
            connection.execute("INSERT OR IGNORE INTO receipt_outbox(id,conversation_id,identity_handle,message_id,state,next_attempt_at) SELECT ?1,conversation_id,?2,id,'seen',?3 FROM messages WHERE id=?4", params![receipt_id, handle, chrono::Utc::now().to_rfc3339(), item.id])?;
        }
        Ok(items)
    }

    pub fn cache_conversations(&self, items: &[LocalConversation]) -> Result<()> {
        let connection = self.connection.lock().expect("storage lock");
        let transaction = connection.unchecked_transaction()?;
        for item in items {
            let participant_handles = serde_json::to_string(&item.participant_handles)?;
            transaction.execute(
                "INSERT INTO conversations(id,peer_name,peer_handle,peer_kind,preview,updated_at,unread,can_compose,participant_handles) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
                 ON CONFLICT(id) DO UPDATE SET peer_name=excluded.peer_name,peer_handle=excluded.peer_handle,peer_kind=excluded.peer_kind,preview=excluded.preview,updated_at=excluded.updated_at,unread=excluded.unread,can_compose=excluded.can_compose,participant_handles=excluded.participant_handles",
                params![item.id,item.peer_name,item.peer_handle,item.peer_kind,item.preview,item.updated_at,item.unread,item.can_compose,participant_handles],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn cache_messages(&self, conversation_id: &str, items: &[LocalMessage]) -> Result<()> {
        let connection = self.connection.lock().expect("storage lock");
        let transaction = connection.unchecked_transaction()?;
        for item in items {
            // A successful outbox item keeps its UUID-shaped optimistic row so
            // MCP history remains available before this cloud snapshot arrives.
            // Replace exactly one matching optimistic row with the authoritative
            // server message (whose deterministic id starts with `message_`).
            transaction.execute(
                "DELETE FROM messages WHERE id=(
                   SELECT id FROM messages
                   WHERE conversation_id=?1 AND id NOT LIKE 'message_%' AND state='accepted'
                     AND direction='outgoing' AND sender_handle=?2 AND body=?3
                   ORDER BY created_at LIMIT 1
                 )",
                params![conversation_id,item.sender_handle,item.body],
            )?;
            transaction.execute(
            "INSERT INTO messages(id,conversation_id,sender_handle,body,created_at,direction,state,reply_to_body,recipient_handle) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET body=excluded.body,created_at=excluded.created_at,direction=excluded.direction,recipient_handle=excluded.recipient_handle,state=CASE WHEN messages.state IN ('delivered','seen') THEN messages.state ELSE excluded.state END",
            params![item.id,conversation_id,item.sender_handle,item.body,item.created_at,item.direction,item.state,item.reply_to_body,item.recipient_handle],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn pending_outbox(&self, limit: usize) -> Result<Vec<OutboxItem>> {
        let connection = self.connection.lock().expect("storage lock");
        let mut statement = connection.prepare(
            "SELECT o.id,o.conversation_id,o.body,o.client_nonce,m.sender_handle,c.recipient_identity_id,o.attempts,o.reply_to_id
             FROM outbox o JOIN messages m ON m.id=o.id JOIN conversations c ON c.id=o.conversation_id
             WHERE o.next_attempt_at <= ?1 ORDER BY o.next_attempt_at LIMIT ?2"
        )?;
        let mapped = statement.query_map(params![chrono::Utc::now().to_rfc3339(), limit as i64], |row| Ok(OutboxItem {
            id: row.get(0)?, conversation_id: row.get(1)?, body: row.get(2)?, client_nonce: row.get(3)?, sender_handle: row.get(4)?, recipient_identity_id: row.get(5)?, attempts: row.get(6)?, reply_to_id: row.get(7)?,
        }))?;
        Ok(mapped.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn resolve_outbox(&self, id: &str, delivered: bool, error: Option<&str>) -> Result<()> {
        let connection = self.connection.lock().expect("storage lock");
        if delivered {
            let transaction = connection.unchecked_transaction()?;
            transaction.execute("DELETE FROM outbox WHERE id=?1", [id])?;
            transaction.execute("UPDATE messages SET state='accepted' WHERE id=?1", [id])?;
            transaction.commit()?;
        } else {
            let attempts: i64 = connection.query_row("SELECT attempts FROM outbox WHERE id=?1", [id], |row| row.get(0))?;
            let delay_seconds = 2_i64.pow((attempts + 1).min(8) as u32);
            let retry_at = chrono::Utc::now() + chrono::Duration::seconds(delay_seconds);
            connection.execute("UPDATE outbox SET attempts=attempts+1,next_attempt_at=?1,last_error=?2 WHERE id=?3", params![retry_at.to_rfc3339(), error.unwrap_or("network unavailable"), id])?;
        }
        Ok(())
    }

    pub fn pending_receipts(&self, limit: usize) -> Result<Vec<ReceiptItem>> {
        let connection = self.connection.lock().expect("storage lock");
        let mut statement = connection.prepare("SELECT id,conversation_id,identity_handle,message_id,state FROM receipt_outbox WHERE next_attempt_at<=?1 ORDER BY next_attempt_at LIMIT ?2")?;
        let rows = statement.query_map(params![chrono::Utc::now().to_rfc3339(), limit as i64], |row| Ok(ReceiptItem { id: row.get(0)?, conversation_id: row.get(1)?, identity_handle: row.get(2)?, message_id: row.get(3)?, state: row.get(4)? }))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn resolve_receipt(&self, id: &str, delivered: bool) -> Result<()> {
        let connection = self.connection.lock().expect("storage lock");
        if delivered { connection.execute("DELETE FROM receipt_outbox WHERE id=?1", [id])?; }
        else { connection.execute("UPDATE receipt_outbox SET attempts=attempts+1,next_attempt_at=?1 WHERE id=?2", params![(chrono::Utc::now()+chrono::Duration::seconds(10)).to_rfc3339(), id])?; }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_settings() {
        let temp = tempfile::tempdir().unwrap();
        let store = Storage::open(temp.path().to_owned()).unwrap();
        store.set_setting("username", "owen").unwrap();
        assert_eq!(store.setting("username").unwrap().as_deref(), Some("owen"));
    }

    #[test]
    fn retries_outbox_with_idempotent_nonce() {
        let temp = tempfile::tempdir().unwrap();
        let store = Storage::open(temp.path().to_owned()).unwrap();
        store.connection.lock().unwrap().execute(
            "INSERT INTO conversations(id,peer_name,peer_handle,peer_kind,preview,updated_at) VALUES('c','Maya','@maya','person','','now')", [],
        ).unwrap();
        let message = store.queue_message("c", "hello", "@owen/codex", None, None).unwrap();
        let pending = store.pending_outbox(10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].sender_handle, "@owen/codex");
        store.resolve_outbox(&message.id, true, None).unwrap();
        assert!(store.pending_outbox(10).unwrap().is_empty());
        assert_eq!(store.messages("c", 10).unwrap()[0].state, "accepted");
        store.cache_messages("c", &[LocalMessage {
            id: "message_server".into(), sender_handle: "@owen/codex".into(), body: "hello".into(), created_at: "later".into(),
            direction: "outgoing".into(), state: "accepted".into(), reply_to_body: None, recipient_handle: Some("@maya".into()),
        }]).unwrap();
        let history = store.messages("c", 10).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, "message_server");
    }

    #[test]
    fn delivers_same_owner_agent_messages() {
        let temp = tempfile::tempdir().unwrap();
        let store = Storage::open(temp.path().to_owned()).unwrap();
        store.connection.lock().unwrap().execute(
            "INSERT INTO conversations(id,peer_name,peer_handle,peer_kind,preview,updated_at,can_compose) VALUES('relay','Codex to Claude','@owen/claude','agent','','now',0)", [],
        ).unwrap();
        store.connection.lock().unwrap().execute(
            "INSERT INTO messages(id,conversation_id,sender_handle,recipient_handle,body,created_at,direction,state) VALUES('m','relay','@owen/codex','@owen/claude','handoff','now','outgoing','accepted')", [],
        ).unwrap();
        let messages = store.pending_for_handle("@owen/claude", 10).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].sender_handle, "@owen/codex");
    }

    #[test]
    fn preserves_cloud_order_instead_of_sorting_display_times() {
        let temp = tempfile::tempdir().unwrap();
        let store = Storage::open(temp.path().to_owned()).unwrap();
        let connection = store.connection.lock().unwrap();
        connection.execute(
            "INSERT INTO conversations(id,peer_name,peer_handle,peer_kind,preview,updated_at) VALUES('c','Relay','@owen/claude','agent','','now')", [],
        ).unwrap();
        connection.execute(
            "INSERT INTO messages(id,conversation_id,sender_handle,body,created_at,direction,state) VALUES('first','c','@owen/claude','older evening message','9:01 PM','incoming','accepted')", [],
        ).unwrap();
        connection.execute(
            "INSERT INTO messages(id,conversation_id,sender_handle,body,created_at,direction,state) VALUES('second','c','@owen/claude','newer afternoon message','3:39 PM','incoming','accepted')", [],
        ).unwrap();
        drop(connection);

        let messages = store.messages("c", 10).unwrap();
        assert_eq!(messages.iter().map(|message| message.id.as_str()).collect::<Vec<_>>(), vec!["first", "second"]);
    }

    #[test]
    fn agent_conversations_are_filtered_by_exact_participants() {
        let temp = tempfile::tempdir().unwrap();
        let store = Storage::open(temp.path().to_owned()).unwrap();
        let connection = store.connection.lock().unwrap();
        connection.execute(
            "INSERT INTO conversations(id,peer_name,peer_handle,peer_kind,preview,updated_at,participant_handles) VALUES('person-codex','Codex','@owen/codex','agent','','now','[\"@owen\",\"@owen/codex\"]')", [],
        ).unwrap();
        connection.execute(
            "INSERT INTO conversations(id,peer_name,peer_handle,peer_kind,preview,updated_at,can_compose,participant_handles) VALUES('relay','Codex to Claude','@owen/codex ↔ @owen/claude','agent','','now',0,'[\"@owen/codex\",\"@owen/claude\"]')", [],
        ).unwrap();
        drop(connection);

        let claude_conversations = store.conversations_for_handle("@owen/claude").unwrap();
        assert_eq!(claude_conversations.len(), 1);
        assert_eq!(claude_conversations[0].id, "relay");
        assert!(claude_conversations[0].can_compose);
        assert!(store.queue_message("person-codex", "wrong thread", "@owen/claude", None, None).is_err());
        assert!(store.queue_message("relay", "correct thread", "@owen/claude", None, None).is_ok());
    }

    #[test]
    fn agents_can_discover_and_queue_to_visible_endpoints() {
        let temp = tempfile::tempdir().unwrap();
        let store = Storage::open(temp.path().to_owned()).unwrap();
        store.cache_endpoints(&[
            ContactEndpoint { id: "agent-claude".into(), name: "Claude Code".into(), handle: "@owen/claude".into(), kind: "agent".into(), scope: "self".into() },
            ContactEndpoint { id: "person-jimmy".into(), name: "Aiden Gandhi".into(), handle: "@jimmy21".into(), kind: "person".into(), scope: "contact".into() },
            ContactEndpoint { id: "agent-andrew-claude".into(), name: "Claude Code".into(), handle: "@andrew/claude".into(), kind: "agent".into(), scope: "contact".into() },
        ]).unwrap();

        let endpoints = store.endpoints_for_handle("@owen/claude").unwrap();
        assert_eq!(endpoints.iter().map(|endpoint| endpoint.handle.as_str()).collect::<Vec<_>>(), vec!["@jimmy21", "@andrew/claude"]);
        let message = store.queue_message_to_endpoint("@andrew/claude", "hello Andrew's Claude", "@owen/claude", None).unwrap();
        assert_eq!(message.recipient_handle.as_deref(), Some("@andrew/claude"));

        let pending = store.pending_outbox(10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].sender_handle, "@owen/claude");
        assert_eq!(pending[0].recipient_identity_id.as_deref(), Some("agent-andrew-claude"));
        let conversations = store.conversations_for_handle("@owen/claude").unwrap();
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0].peer_handle, "@andrew/claude");
        assert!(conversations[0].can_compose);
    }
}
