//! 平台相关的窗口/权限处理

#[cfg(target_os = "macos")]
mod imp {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    // NSScreenSaverWindowLevel：压在菜单栏和 Dock 之上
    const SCREEN_SAVER_LEVEL: isize = 1000;
    // NSWindowCollectionBehaviorCanJoinAllSpaces | FullScreenAuxiliary
    const COLLECTION_BEHAVIOR: usize = 1 | (1 << 8);

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub fn raise_overlay(window: &tauri::WebviewWindow) {
        let Ok(ptr) = window.ns_window() else { return };
        let ns = ptr as *mut AnyObject;
        if ns.is_null() {
            return;
        }
        unsafe {
            let _: () = msg_send![ns, setLevel: SCREEN_SAVER_LEVEL];
            let _: () = msg_send![ns, setCollectionBehavior: COLLECTION_BEHAVIOR];
            let _: () = msg_send![ns, setIgnoresMouseEvents: true];
        }
    }

    pub fn screen_permission() -> &'static str {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            "granted"
        } else {
            "denied"
        }
    }

    /// 触发系统授权弹窗（只在未授权时有效，用户拒绝过就不再弹）
    pub fn request_screen_permission() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }

    pub fn open_screen_settings() {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn();
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn raise_overlay(_window: &tauri::WebviewWindow) {}
    pub fn screen_permission() -> &'static str {
        "granted"
    }
    pub fn request_screen_permission() -> bool {
        true
    }
    pub fn open_screen_settings() {}
}

pub use imp::*;
