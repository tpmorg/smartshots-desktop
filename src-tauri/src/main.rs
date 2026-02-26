#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{menu::{Menu, MenuItem}, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}, AppHandle, Emitter, Manager, State};
use url::form_urlencoded;

#[derive(Default)]
struct WatcherState {
    is_running: bool,
    stop_sender: Option<std::sync::mpsc::Sender<()>>,
}

#[derive(Clone)]
struct SharedState {
    watcher: Arc<Mutex<WatcherState>>,
    oauth_listener_started: Arc<Mutex<bool>>,
}

#[derive(Serialize, Clone)]
struct ScreenshotEvent {
    path: String,
}

#[derive(Serialize, Clone)]
struct OAuthCallbackPayload {
    url: String,
}

#[tauri::command]
fn get_default_screenshot_dirs() -> Vec<String> {
    default_screenshot_dirs()
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
fn start_screenshot_watcher(app: AppHandle, state: State<'_, SharedState>) -> Result<(), String> {
    let mut watcher_state = state.watcher.lock().map_err(|_| "watcher lock poisoned")?;
    if watcher_state.is_running {
        return Ok(());
    }

    let dirs = default_screenshot_dirs();
    if dirs.is_empty() {
        return Err("No screenshot directories found".to_string());
    }

    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    watcher_state.is_running = true;
    watcher_state.stop_sender = Some(stop_tx);

    thread::spawn(move || {
        if let Err(err) = run_watcher_thread(app, dirs, stop_rx) {
            eprintln!("watcher failed: {err}");
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_screenshot_watcher(state: State<'_, SharedState>) -> Result<(), String> {
    let mut watcher_state = state.watcher.lock().map_err(|_| "watcher lock poisoned")?;

    if let Some(stop_tx) = watcher_state.stop_sender.take() {
        let _ = stop_tx.send(());
    }

    watcher_state.is_running = false;
    Ok(())
}

#[tauri::command]
fn get_oauth_redirect_url(app: AppHandle, state: State<'_, SharedState>) -> Result<String, String> {
    let mut started = state
        .oauth_listener_started
        .lock()
        .map_err(|_| "oauth listener lock poisoned")?;

    if !*started {
        *started = true;
        thread::spawn(move || {
            if let Err(err) = run_oauth_callback_listener(app) {
                eprintln!("oauth callback listener failed: {err}");
            }
        });
    }

    Ok("http://127.0.0.1:38965/auth/callback".to_string())
}

fn run_watcher_thread(
    app: AppHandle,
    dirs: Vec<PathBuf>,
    stop_rx: std::sync::mpsc::Receiver<()>,
) -> anyhow::Result<()> {
    let (event_tx, event_rx) = std::sync::mpsc::channel::<notify::Result<Event>>();

    let mut watcher = RecommendedWatcher::new(
        move |res| {
            let _ = event_tx.send(res);
        },
        Config::default(),
    )?;

    for dir in &dirs {
        if dir.exists() {
            watcher.watch(dir, RecursiveMode::NonRecursive)?;
        }
    }

    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        match event_rx.recv_timeout(Duration::from_millis(300)) {
            Ok(Ok(event)) => {
                if is_relevant_screenshot_event(&event) {
                    for path in event.paths {
                        if !is_image_file(&path) {
                            continue;
                        }
                        let payload = ScreenshotEvent {
                            path: path.to_string_lossy().to_string(),
                        };
                        let _ = app.emit("screenshot-created", payload);
                    }
                }
            }
            Ok(Err(err)) => {
                eprintln!("watch event error: {err}");
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    Ok(())
}

fn is_relevant_screenshot_event(event: &Event) -> bool {
    matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_))
}

fn is_image_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };

    let lower_name = name.to_lowercase();
    if lower_name.starts_with('.') {
        return false;
    }

    let extension_match = lower_name.ends_with(".png")
        || lower_name.ends_with(".jpg")
        || lower_name.ends_with(".jpeg")
        || lower_name.ends_with(".webp");

    if !extension_match {
        return false;
    }

    lower_name.contains("screenshot") || lower_name.contains("screen shot")
}

fn default_screenshot_dirs() -> Vec<PathBuf> {
    let mut dirs_out = Vec::new();

    if cfg!(target_os = "macos") {
        if let Some(desktop) = dirs::desktop_dir() {
            dirs_out.push(desktop);
        }
    }

    if cfg!(target_os = "windows") {
        if let Some(pictures) = dirs::picture_dir() {
            dirs_out.push(pictures.join("Screenshots"));
        }
    }

    dirs_out
}

fn run_oauth_callback_listener(app: AppHandle) -> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:38965")?;

    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(s) => s,
            Err(err) => {
                eprintln!("oauth listener stream error: {err}");
                continue;
            }
        };

        let mut first_line = String::new();
        {
            let mut reader = BufReader::new(&mut stream);
            let _ = reader.read_line(&mut first_line);
        }

        if let Some(path_and_query) = parse_http_get_path(&first_line) {
            if path_and_query.starts_with("/auth/callback") {
                let callback_url = format!("http://127.0.0.1:38965{path_and_query}");
                let payload = OAuthCallbackPayload { url: callback_url };
                let _ = app.emit("oauth-callback-url", payload);
            }

            if let Some(captured_url) = extract_capture_url(path_and_query) {
                let payload = OAuthCallbackPayload { url: captured_url };
                let _ = app.emit("oauth-callback-url", payload);
            }
        }

        let response = b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><html><body><h3>Smartshots sign-in complete.</h3><p>You can close this tab.</p><script>(function(){if(window.location.hash&&window.location.hash.length>1){var u=encodeURIComponent(window.location.href);fetch('/__capture?u='+u).catch(function(){});}})();</script></body></html>";
        let _ = stream.write_all(response);
        let _ = stream.flush();
    }

    Ok(())
}

fn parse_http_get_path(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if !trimmed.starts_with("GET ") {
        return None;
    }
    let rest = &trimmed[4..];
    let end = rest.find(" HTTP/")?;
    Some(&rest[..end])
}

fn extract_capture_url(path_and_query: &str) -> Option<String> {
    if !path_and_query.starts_with("/__capture?") {
        return None;
    }

    let query = path_and_query.split_once('?')?.1;
    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        if key == "u" {
            return Some(value.into_owned());
        }
    }
    None
}

fn create_tray(app: &AppHandle) -> Result<(), tauri::Error> {
    let open = MenuItem::with_id(app, "open", "Open Smartshots", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "open" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let is_visible = window.is_visible().unwrap_or(true);
                    if is_visible {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(SharedState {
            watcher: Arc::new(Mutex::new(WatcherState::default())),
            oauth_listener_started: Arc::new(Mutex::new(false)),
        })
        .setup(|app| {
            create_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_default_screenshot_dirs,
            start_screenshot_watcher,
            stop_screenshot_watcher,
            get_oauth_redirect_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
