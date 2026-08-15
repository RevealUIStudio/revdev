//! Window presentment: refuse to look "up" when the operator cannot see Studio.
//!
//! On this machine the failure class was: `pnpm tauri:dev` created a GTK
//! window on a WSLg compositor whose Windows RDP client (msrdc) was down.
//! The process stayed running. The Start Menu app is a different Windows
//! install and does not load this source tree.
//!
//! Detection is pure so it can be locked in unit tests. The weston log
//! misspells "initialized" as "initalized"; match that string as written.

use tauri::{AppHandle, Manager, PhysicalPosition};

/// Why a WSL Studio window will not appear on the Windows desktop.
pub const WSL_UNPRESENTABLE: &str = "Studio cannot put a window on your desktop. \
WSLg's RDP display (msrdc) is not connected, so Linux GUI windows stay on a \
hidden 640x480 compositor. Repair WSLg, then launch this source tree again. \
The Windows Start Menu app is a separate install and will not pick up this tree.";

/// Last weston/RDP signal in a log: missing peer vs a live one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WestonRdpState {
    Missing,
    Live,
    Unknown,
}

pub fn weston_rdp_state(log: &str) -> WestonRdpState {
    let mut state = WestonRdpState::Unknown;
    for line in log.lines() {
        if line.contains("rdp_peer is not initalized") {
            state = WestonRdpState::Missing;
        } else if line.contains("rdp_rail_notify_app_list(): rdp_peer 0x") {
            state = WestonRdpState::Live;
        }
    }
    state
}

/// True when a WSL session cannot present a desktop window to Windows.
pub fn wsl_display_unpresentable(
    is_wsl: bool,
    monitor_width: u32,
    monitor_height: u32,
    weston_log: Option<&str>,
) -> bool {
    if !is_wsl {
        return false;
    }
    let stub = monitor_width <= 640 && monitor_height <= 480;
    let rdp_dead = matches!(
        weston_log.map(weston_rdp_state),
        Some(WestonRdpState::Missing)
    );
    stub || rdp_dead
}

/// Keep the window inside the monitor. If it is larger than the monitor,
/// pin it to the monitor origin so a later display resize can show it.
pub fn clamp_position(
    x: i32,
    y: i32,
    win_w: u32,
    win_h: u32,
    mon_x: i32,
    mon_y: i32,
    mon_w: u32,
    mon_h: u32,
) -> (i32, i32) {
    if mon_w == 0 || mon_h == 0 {
        return (x, y);
    }
    let max_x = mon_x + mon_w as i32 - win_w.min(mon_w) as i32;
    let max_y = mon_y + mon_h as i32 - win_h.min(mon_h) as i32;
    let nx = x.clamp(mon_x, max_x.max(mon_x));
    let ny = y.clamp(mon_y, max_y.max(mon_y));
    (nx, ny)
}

pub fn running_in_wsl() -> bool {
    std::env::var_os("WSL_DISTRO_NAME").is_some()
}

/// Center and clamp the main window, or refuse to start on an unpresentable WSL display.
pub fn present_main_window<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(());
    };

    if cfg!(debug_assertions) {
        let _ = win.set_title("RevealUI Studio (dev)");
    }

    let monitor =
        win.current_monitor()
            .map_err(|err| err.to_string())?
            .or(win.primary_monitor().map_err(|err| err.to_string())?);

    if let Some(monitor) = monitor {
        let size = monitor.size();
        let weston = std::fs::read_to_string("/mnt/wslg/weston.log").ok();
        if wsl_display_unpresentable(running_in_wsl(), size.width, size.height, weston.as_deref()) {
            return Err(WSL_UNPRESENTABLE.to_string());
        }

        let _ = win.center();
        if let (Ok(pos), Ok(outer)) = (win.outer_position(), win.outer_size()) {
            let mon_pos = monitor.position();
            let (x, y) = clamp_position(
                pos.x,
                pos.y,
                outer.width,
                outer.height,
                mon_pos.x,
                mon_pos.y,
                size.width,
                size.height,
            );
            if x != pos.x || y != pos.y {
                let _ = win.set_position(PhysicalPosition::new(x, y));
            }
        }
    }

    // Taskbar/titlebar must use the Circuit-R, not a cached Tauri cube.
    // Windows pins the shell icon to the AppUserModelID; set_icon updates
    // the running HWND, and notify_shell_icon_changed busts Explorer.
    let _ = win.set_icon(tauri::include_image!("icons/128x128.png"));
    notify_shell_icon_changed();

    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// Tell Explorer the app icon changed. No-op off Windows.
fn notify_shell_icon_changed() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::{
            SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_FLUSH, SHCNF_IDLIST,
        };
        unsafe {
            SHChangeNotify(
                SHCNE_ASSOCCHANGED,
                SHCNF_IDLIST | SHCNF_FLUSH,
                std::ptr::null(),
                std::ptr::null(),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_wsl_is_always_presentable() {
        assert!(!wsl_display_unpresentable(
            false,
            640,
            480,
            Some("CreateWndow(): rdp_peer is not initalized"),
        ));
    }

    #[test]
    fn wsl_stub_resolution_is_unpresentable() {
        assert!(wsl_display_unpresentable(true, 640, 480, None));
        assert!(wsl_display_unpresentable(true, 320, 240, None));
    }

    #[test]
    fn wsl_real_resolution_without_log_is_presentable() {
        assert!(!wsl_display_unpresentable(true, 1920, 1200, None));
    }

    #[test]
    fn weston_last_missing_peer_wins() {
        let log = "\
[18:20] CreateWndow(): rdp_peer is not initalized
[20:25] rdp_rail_notify_app_list(): rdp_peer 0x5a9bb49395b0
[20:27] CreateWndow(): rdp_peer is not initalized
";
        assert_eq!(weston_rdp_state(log), WestonRdpState::Missing);
        assert!(wsl_display_unpresentable(true, 1920, 1200, Some(log)));
    }

    #[test]
    fn weston_last_live_peer_wins() {
        let log = "\
[18:20] CreateWndow(): rdp_peer is not initalized
[20:25] rdp_rail_notify_app_list(): rdp_peer 0x5a9bb49395b0
";
        assert_eq!(weston_rdp_state(log), WestonRdpState::Live);
        assert!(!wsl_display_unpresentable(true, 1920, 1200, Some(log)));
    }

    #[test]
    fn clamp_moves_offscreen_coords_onto_the_monitor() {
        assert_eq!(
            clamp_position(-32730, -32709, 1100, 750, 0, 0, 1920, 1200),
            (0, 0)
        );
        assert_eq!(
            clamp_position(2000, 50, 1100, 750, 0, 0, 1920, 1200),
            (820, 50)
        );
    }

    #[test]
    fn clamp_pins_oversized_window_to_origin() {
        assert_eq!(clamp_position(86, 107, 1100, 750, 0, 0, 640, 480), (0, 0));
    }
}
