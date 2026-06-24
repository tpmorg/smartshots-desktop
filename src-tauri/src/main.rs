#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime},
};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{menu::{Menu, MenuItem}, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}, AppHandle, Emitter, Manager, PhysicalSize, Size, State};
use tauri_plugin_opener::OpenerExt;
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
    hide_to_tray_on_close: Arc<Mutex<bool>>,
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
fn list_recent_screenshots(max_items: Option<usize>, lookback_hours: Option<u64>) -> Result<Vec<String>, String> {
    let limit = max_items.unwrap_or(250).clamp(1, 2000);
    let lookback = lookback_hours.unwrap_or(168).clamp(1, 24 * 90);
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(lookback * 60 * 60))
        .ok_or_else(|| "invalid lookback value".to_string())?;

    let mut candidates: Vec<(SystemTime, PathBuf)> = Vec::new();
    for dir in default_screenshot_dirs() {
        if !dir.exists() {
            continue;
        }

        let entries = fs::read_dir(&dir).map_err(|e| format!("read_dir failed for {}: {}", dir.display(), e))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || !is_image_file(&path) {
                continue;
            }

            let Ok(metadata) = entry.metadata() else {
                continue;
            };

            let modified = metadata
                .modified()
                .or_else(|_| metadata.created())
                .unwrap_or(SystemTime::UNIX_EPOCH);

            if modified >= cutoff {
                candidates.push((modified, path));
            }
        }
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0));

    Ok(candidates
        .into_iter()
        .take(limit)
        .map(|(_, path)| path.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
fn get_screenshot_modified_ms(path: String) -> Result<Option<u64>, String> {
    let path_buf = PathBuf::from(path);
    if !path_buf.is_file() {
        return Ok(None);
    }

    let metadata = fs::metadata(&path_buf).map_err(|e| format!("metadata failed: {}", e))?;
    let modified = metadata
        .modified()
        .or_else(|_| metadata.created())
        .map_err(|e| format!("modified time failed: {}", e))?;
    let millis = modified
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| format!("invalid modified time: {}", e))?
        .as_millis() as u64;
    Ok(Some(millis))
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

    Ok("http://127.0.0.1:38965/auth/callback?platform=desktop&return_to=smartshots%3A%2F%2Fauth%2Fcallback".to_string())
}

#[tauri::command]
fn set_hide_to_tray_on_close(enabled: bool, state: State<'_, SharedState>) -> Result<(), String> {
    let mut setting = state
        .hide_to_tray_on_close
        .lock()
        .map_err(|_| "hide_to_tray_on_close lock poisoned")?;
    *setting = enabled;
    Ok(())
}

#[tauri::command]
fn open_website(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url("https://www.smartshotsai.com", None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    #[cfg(target_os = "macos")]
    let _ = app.set_dock_visibility(true);

    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
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
    let settings = MenuItem::with_id(app, "settings", "Open Smartshots", true, None::<&str>)?;
    let website = MenuItem::with_id(app, "website", "Go to Website", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings, &website, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(tauri::include_image!("icons/32x32.png"))
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "settings" => {
                    if let Some(window) = app.get_webview_window("main") {
                        #[cfg(target_os = "macos")]
                        let _ = app.set_dock_visibility(true);
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "website" => {
                    let _ = app.opener().open_url("https://www.smartshotsai.com", None::<&str>);
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?
        .set_show_menu_on_left_click(true)?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(SharedState {
            watcher: Arc::new(Mutex::new(WatcherState::default())),
            oauth_listener_started: Arc::new(Mutex::new(false)),
            hide_to_tray_on_close: Arc::new(Mutex::new(true)),
        })
        .setup(|app| {
            create_tray(app.handle())?;
            app.on_tray_icon_event(|_app_handle, event| {
                if let TrayIconEvent::Click {
                    button,
                    button_state,
                    ..
                } = event
                {
                    if button == MouseButton::Left && button_state == MouseButtonState::Up {
                        if let Some(window) = _app_handle.get_webview_window("main") {
                            #[cfg(target_os = "macos")]
                            let _ = _app_handle.set_dock_visibility(true);
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
            });
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let monitor_size = monitor.size();
                    let min_width = ((monitor_size.width as f64) * 0.4).round() as u32;
                    let min_height = ((monitor_size.height as f64) * 0.4).round() as u32;
                    let _ = window.set_min_size(Some(Size::Physical(PhysicalSize::new(
                        min_width.max(900),
                        min_height.max(700),
                    ))));
                }

                let window_for_close = window.clone();
                let hide_to_tray_state = app.state::<SharedState>().hide_to_tray_on_close.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let should_hide = hide_to_tray_state.lock().map(|v| *v).unwrap_or(true);
                        if should_hide {
                            api.prevent_close();
                            #[cfg(target_os = "macos")]
                            let _ = window_for_close.app_handle().set_dock_visibility(false);
                            let _ = window_for_close.hide();
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_default_screenshot_dirs,
            list_recent_screenshots,
            get_screenshot_modified_ms,
            start_screenshot_watcher,
            stop_screenshot_watcher,
            get_oauth_redirect_url,
            set_hide_to_tray_on_close,
            open_website,
            quit_app,
            show_main_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
