mod auth;
mod integrations;
mod mcp;
mod models;
mod storage;

use crate::{auth::AuthState, models::{ContactEndpoint, HarnessState, LocalConversation, LocalMessage, OutboxItem, ReceiptItem, RuntimeSnapshot}, storage::Storage};
use std::{env, sync::{Arc, Mutex}};
use tauri::{Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

pub struct Runtime {
    storage: Storage,
    agents: Mutex<Vec<HarnessState>>,
    port: Mutex<u16>,
    auth: AuthState,
    web_url: String,
}

impl Runtime {
    fn new() -> anyhow::Result<Arc<Self>> {
        let dirs = directories::ProjectDirs::from("chat", "Parrot", "Parrot").ok_or_else(|| anyhow::anyhow!("Unable to locate Parrot data directory"))?;
        let storage = Storage::open(dirs.data_dir().to_owned())?;
        let agents = integrations::load_manifest(dirs.data_dir()).map(|m| m.agents).unwrap_or_else(integrations::detect_agents);
        Ok(Arc::new(Self { storage, agents: Mutex::new(agents), port: Mutex::new(9127), auth: AuthState(Mutex::new(None)), web_url: env::var("PARROT_WEB_URL").unwrap_or_else(|_| "https://parrot-web-five.vercel.app".into()) }))
    }
}

#[tauri::command]
fn runtime_snapshot(runtime: State<'_, Arc<Runtime>>) -> Result<RuntimeSnapshot, String> {
    Ok(RuntimeSnapshot {
        onboarded: runtime.storage.setting("onboarded").map_err(|e| e.to_string())?.as_deref() == Some("true"),
        authenticated: keyring::Entry::new("chat.parrot.desktop", "device-session").and_then(|e| e.get_password()).is_ok(),
        username: runtime.storage.setting("username").map_err(|e| e.to_string())?,
        display_name: runtime.storage.setting("display_name").map_err(|e| e.to_string())?,
        port: *runtime.port.lock().expect("port lock"), agents: runtime.agents.lock().expect("agents lock").clone(),
    })
}

#[tauri::command]
fn list_local_conversations(runtime: State<'_, Arc<Runtime>>) -> Result<Vec<LocalConversation>, String> { runtime.storage.conversations().map_err(|e| e.to_string()) }

#[tauri::command]
fn get_local_messages(runtime: State<'_, Arc<Runtime>>, conversation_id: String) -> Result<Vec<LocalMessage>, String> { runtime.storage.messages(&conversation_id, 100).map_err(|e| e.to_string()) }

#[tauri::command]
fn send_local_message(runtime: State<'_, Arc<Runtime>>, conversation_id: String, body: String, reply_to_id: Option<String>, reply_to_body: Option<String>) -> Result<LocalMessage, String> {
    let username = runtime.storage.setting("username").map_err(|e| e.to_string())?.unwrap_or_else(|| "you".into());
    runtime.storage.queue_message(&conversation_id, &body, &format!("@{username}"), reply_to_id.as_deref(), reply_to_body.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pending_outbox(runtime: State<'_, Arc<Runtime>>) -> Result<Vec<OutboxItem>, String> { runtime.storage.pending_outbox(50).map_err(|e| e.to_string()) }

#[tauri::command]
fn resolve_outbox(runtime: State<'_, Arc<Runtime>>, id: String, delivered: bool, error: Option<String>) -> Result<(), String> { runtime.storage.resolve_outbox(&id, delivered, error.as_deref()).map_err(|e| e.to_string()) }

#[tauri::command]
fn cache_cloud_conversations(runtime: State<'_, Arc<Runtime>>, items: Vec<LocalConversation>) -> Result<(), String> { runtime.storage.cache_conversations(&items).map_err(|e| e.to_string()) }

#[tauri::command]
fn cache_cloud_endpoints(runtime: State<'_, Arc<Runtime>>, items: Vec<ContactEndpoint>) -> Result<(), String> { runtime.storage.cache_endpoints(&items).map_err(|e| e.to_string()) }

#[tauri::command]
fn cache_cloud_messages(runtime: State<'_, Arc<Runtime>>, conversation_id: String, items: Vec<LocalMessage>) -> Result<(), String> { runtime.storage.cache_messages(&conversation_id, &items).map_err(|e| e.to_string()) }

#[tauri::command]
fn pending_receipts(runtime: State<'_, Arc<Runtime>>) -> Result<Vec<ReceiptItem>, String> { runtime.storage.pending_receipts(50).map_err(|e| e.to_string()) }

#[tauri::command]
fn resolve_receipt(runtime: State<'_, Arc<Runtime>>, id: String, delivered: bool) -> Result<(), String> { runtime.storage.resolve_receipt(&id, delivered).map_err(|e| e.to_string()) }

#[tauri::command]
fn begin_browser_auth(app: tauri::AppHandle, runtime: State<'_, Arc<Runtime>>) -> Result<(), String> {
    let url = auth::begin(&runtime.web_url, &runtime.auth).map_err(|e| e.to_string())?;
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn complete_onboarding(runtime: State<'_, Arc<Runtime>>, username: String, display_name: String) -> Result<(), String> {
    if username.len() < 2 || username.len() > 32 || !username.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') { return Err("Username must be 2-32 lowercase letters, numbers, or underscores".into()); }
    runtime.storage.set_setting("username", &username).and_then(|_| runtime.storage.set_setting("display_name", &display_name)).map_err(|e| e.to_string())
}

#[tauri::command]
fn configure_agents(runtime: State<'_, Arc<Runtime>>, harnesses: Vec<String>) -> Result<Vec<HarnessState>, String> {
    let executable = env::current_exe().map_err(|e| e.to_string())?.display().to_string();
    let states = integrations::configure(&harnesses, *runtime.port.lock().expect("port lock"), &executable, &runtime.storage.data_dir).map_err(|e| e.to_string())?;
    *runtime.agents.lock().expect("agents lock") = states.clone();
    Ok(states)
}

#[tauri::command]
fn enable_background(app: tauri::AppHandle, runtime: State<'_, Arc<Runtime>>) -> Result<(), String> {
    let _ = app.autolaunch().enable();
    runtime.storage.set_setting("onboarded", "true").map_err(|e| e.to_string())
}

#[tauri::command]
async fn refresh_cloud_token(runtime: State<'_, Arc<Runtime>>) -> Result<String, String> {
    auth::refresh(&runtime.web_url).await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) == Some("hook") {
        let harness = args.get(2).map(String::as_str).unwrap_or("codex");
        let runtime = tokio::runtime::Runtime::new().expect("hook runtime");
        if let Err(error) = runtime.block_on(mcp::hook(harness)) { eprintln!("Parrot hook unavailable: {error}"); }
        return;
    }
    if matches!(args.get(1).map(String::as_str), Some("doctor" | "connect" | "disconnect")) {
        let dirs = directories::ProjectDirs::from("chat", "Parrot", "Parrot").expect("Parrot data directory");
        let storage = Storage::open(dirs.data_dir().to_owned()).expect("Parrot local database");
        let port = storage.setting("runtime_port").ok().flatten().and_then(|value| value.parse().ok()).unwrap_or(9127);
        let harnesses = if args.len() > 2 { args[2..].to_vec() } else { vec!["codex".into(), "claude".into()] };
        let result = match args[1].as_str() {
            "doctor" => Ok(integrations::doctor(dirs.data_dir(), port)),
            "connect" => integrations::configure(&harnesses, port, &env::current_exe().expect("executable").display().to_string(), dirs.data_dir()).and_then(|value| Ok(serde_json::to_value(value)?)),
            "disconnect" => integrations::disconnect(&harnesses, dirs.data_dir()).and_then(|value| Ok(serde_json::to_value(value)?)),
            _ => unreachable!(),
        };
        match result { Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default()), Err(error) => { eprintln!("Parrot {} failed: {error}", args[1]); std::process::exit(1); } }
        return;
    }

    let runtime = Runtime::new().expect("initialize Parrot runtime");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| { if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); } }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .manage(runtime.clone())
        .invoke_handler(tauri::generate_handler![runtime_snapshot, list_local_conversations, get_local_messages, send_local_message, pending_outbox, resolve_outbox, cache_cloud_conversations, cache_cloud_endpoints, cache_cloud_messages, pending_receipts, resolve_receipt, begin_browser_auth, complete_onboarding, configure_agents, enable_background, refresh_cloud_token])
        .setup(move |app| {
            use tauri::{menu::{MenuBuilder, MenuItemBuilder}, tray::TrayIconBuilder};
            let show = MenuItemBuilder::with_id("show", "Show Parrot").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit Parrot").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;
            let mut tray = TrayIconBuilder::new().menu(&menu).tooltip("Parrot");
            if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
            tray.on_menu_event(|app, event| match event.id.as_ref() {
                "show" => if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); },
                "quit" => app.exit(0),
                _ => {},
            }).build(app)?;
            let runtime_for_server = runtime.clone();
            tauri::async_runtime::spawn(async move {
                match mcp::serve(runtime_for_server.clone(), 9127).await {
                    Ok(port) => {
                        *runtime_for_server.port.lock().expect("port lock") = port;
                        let _ = runtime_for_server.storage.set_setting("runtime_port", &port.to_string());
                        if port != 9127 {
                            if let Some(manifest) = integrations::load_manifest(&runtime_for_server.storage.data_dir) {
                                let harnesses = manifest.agents.into_iter().filter(|agent| agent.selected).map(|agent| agent.harness).collect::<Vec<_>>();
                                let _ = integrations::configure(&harnesses, port, &manifest.executable, &runtime_for_server.storage.data_dir);
                            }
                        }
                    },
                    Err(error) => eprintln!("Unable to start Parrot MCP runtime: {error}"),
                }
            });
            use tauri_plugin_deep_link::DeepLinkExt;
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                for url in urls {
                    if url.scheme() == "parrot" && url.host_str() == Some("auth") {
                        let handle = app_handle.clone();
                        let callback = url.to_string();
                        tauri::async_runtime::spawn(async move {
                            let runtime = handle.state::<Arc<Runtime>>();
                            match auth::exchange(&callback, &runtime.web_url, &runtime.auth).await {
                                Ok(_) => {
                                    let _ = runtime.storage.set_setting("authenticated", "true");
                                    let _ = handle.emit("parrot-auth-complete", ());
                                    if let Some(window) = handle.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
                                },
                                Err(error) => {
                                    eprintln!("Parrot authentication failed: {error}");
                                    let _ = handle.emit("parrot-auth-error", "Sign-in could not be completed.");
                                },
                            }
                        });
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| { if let tauri::WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); let _ = window.hide(); } })
        .run(tauri::generate_context!())
        .expect("error while running Parrot");
}
