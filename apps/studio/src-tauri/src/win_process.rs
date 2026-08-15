//! Windows console programs (`wsl.exe`, `cmd.exe`, `pwsh.exe`) open a visible
//! terminal unless CREATE_NO_WINDOW is set. Do not add DETACHED_PROCESS here:
//! it can drop redirected stdin/stdout, which the WSL relay needs.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn hide_std(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

#[cfg_attr(unix, allow(dead_code))]
pub fn hide_tokio(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hide_std_accepts_a_command() {
        let mut cmd = std::process::Command::new("true");
        hide_std(&mut cmd);
    }
}
