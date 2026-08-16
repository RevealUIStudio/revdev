//! Hide Windows console programs and launch WSL without `wsl.exe`.
//!
//! `wsl.exe`, `cmd.exe`, and `pwsh.exe` are console-subsystem binaries. They
//! flash a terminal unless CREATE_NO_WINDOW is set. Do not add
//! DETACHED_PROCESS: it can drop redirected stdin/stdout. Do not call
//! `CommandExt::show_window`: it is still unstable on the rustc CI uses.
//!
//! The Agent relay must not spawn `wsl.exe` at all. Use [`spawn_wsl_hidden`]
//! (`WslLaunch` in wslapi) so the Linux process starts with no console host.

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

/// Linux command line for the long-lived daemon relay. `$HOME` is expanded
/// inside WSL. Kept off the Windows gate so Linux CI can lock the wording.
pub fn relay_shell_command(socket_rel_path: &str) -> String {
    format!(r#"/bin/bash -c "exec \"$HOME/.local/bin/revdev-relay\" \"$HOME/{socket_rel_path}\"""#)
}

/// WSL child launched through `WslLaunch` (no `wsl.exe`, no console flash).
#[cfg(windows)]
pub struct HiddenWslChild {
    process: isize,
    stdin: Option<std::fs::File>,
    stdout: Option<std::fs::File>,
    stderr: Option<std::fs::File>,
}

#[cfg(windows)]
impl HiddenWslChild {
    pub fn take_stdin(&mut self) -> Result<std::fs::File, String> {
        self.stdin
            .take()
            .ok_or_else(|| "Relay spawn failed: stdin unavailable".to_string())
    }

    pub fn take_stdout(&mut self) -> Result<std::fs::File, String> {
        self.stdout
            .take()
            .ok_or_else(|| "Relay spawn failed: stdout unavailable".to_string())
    }

    pub fn take_stderr(&mut self) -> Option<std::fs::File> {
        self.stderr.take()
    }

    pub fn start_kill(&mut self) {
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::Threading::TerminateProcess;
        let handle = self.process as HANDLE;
        if !handle.is_null() {
            unsafe {
                TerminateProcess(handle, 1);
            }
        }
    }
}

#[cfg(windows)]
impl Drop for HiddenWslChild {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        self.start_kill();
        let handle = self.process as HANDLE;
        if !handle.is_null() {
            unsafe {
                CloseHandle(handle);
            }
        }
        self.process = 0;
    }
}

/// Start `command` in `distro` with piped stdio and no Windows console.
#[cfg(windows)]
pub fn spawn_wsl_hidden(distro: &str, command: &str) -> Result<HiddenWslChild, String> {
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{
        CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::SubsystemForLinux::{WslIsDistributionRegistered, WslLaunch};

    fn to_wide(s: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    unsafe fn make_pipe() -> Result<(HANDLE, HANDLE), String> {
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        let mut read = INVALID_HANDLE_VALUE;
        let mut write = INVALID_HANDLE_VALUE;
        if CreatePipe(&mut read, &mut write, &sa, 0) == 0 {
            return Err(format!(
                "Relay spawn failed: CreatePipe {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok((read, write))
    }

    unsafe fn dont_inherit(handle: HANDLE) -> Result<(), String> {
        if SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) == 0 {
            return Err(format!(
                "Relay spawn failed: SetHandleInformation {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    // Anonymous CreatePipe handles are not FILE_FLAG_OVERLAPPED. Do not wrap
    // them in tokio::fs::File; IOCP read/write fails or returns EOF. The
    // caller drives these with blocking std I/O (spawn_blocking).
    unsafe fn to_std(handle: HANDLE) -> std::fs::File {
        let owned = OwnedHandle::from_raw_handle(handle as _);
        std::fs::File::from(owned)
    }

    let distro_w = to_wide(distro);
    if unsafe { WslIsDistributionRegistered(distro_w.as_ptr()) } == 0 {
        return Err(format!(
            "Relay spawn failed: WSL distro '{distro}' is not registered"
        ));
    }

    let (stdin_r, stdin_w) = unsafe { make_pipe()? };
    let (stdout_r, stdout_w) = unsafe { make_pipe()? };
    let (stderr_r, stderr_w) = unsafe { make_pipe()? };

    if let Err(err) = unsafe {
        dont_inherit(stdin_w)
            .and(dont_inherit(stdout_r))
            .and(dont_inherit(stderr_r))
    } {
        unsafe {
            CloseHandle(stdin_r);
            CloseHandle(stdin_w);
            CloseHandle(stdout_r);
            CloseHandle(stdout_w);
            CloseHandle(stderr_r);
            CloseHandle(stderr_w);
        }
        return Err(err);
    }

    let cmd_w = to_wide(command);
    let mut process = INVALID_HANDLE_VALUE;
    let hr = unsafe {
        WslLaunch(
            distro_w.as_ptr(),
            cmd_w.as_ptr(),
            0,
            stdin_r,
            stdout_w,
            stderr_w,
            &mut process,
        )
    };

    unsafe {
        CloseHandle(stdin_r);
        CloseHandle(stdout_w);
        CloseHandle(stderr_w);
    }

    if hr < 0 || process.is_null() || process == INVALID_HANDLE_VALUE {
        unsafe {
            CloseHandle(stdin_w);
            CloseHandle(stdout_r);
            CloseHandle(stderr_r);
        }
        return Err(format!("Relay spawn failed: WslLaunch HRESULT 0x{hr:08X}"));
    }

    Ok(HiddenWslChild {
        process: process as isize,
        stdin: Some(unsafe { to_std(stdin_w) }),
        stdout: Some(unsafe { to_std(stdout_r) }),
        stderr: Some(unsafe { to_std(stderr_r) }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hide_std_accepts_a_command() {
        let mut cmd = std::process::Command::new("true");
        hide_std(&mut cmd);
    }

    #[test]
    fn relay_command_runs_bash_so_home_expands() {
        let cmd = relay_shell_command(".local/share/revealui/harness.sock");
        assert!(cmd.starts_with("/bin/bash -c "));
        assert!(cmd.contains("revdev-relay"));
        assert!(cmd.contains("$HOME/.local/share/revealui/harness.sock"));
    }
}
