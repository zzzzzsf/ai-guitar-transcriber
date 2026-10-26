// 原生消息框（§5.4：崩溃/诊断/更新提示全走系统 UI，不经前端）

use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_ICONWARNING, MB_OK, MB_YESNO,
};

pub const MB_INFO: u32 = MB_ICONINFORMATION;
pub const MB_WARN: u32 = MB_ICONWARNING;
pub const MB_ERROR: u32 = MB_ICONERROR;

/// 返回值：yes_no 模式下用户是否点了「是」
pub fn msg_box(icon: u32, title: &str, text: &str, yes_no: bool) -> bool {
    let t: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let x: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let flags = icon | if yes_no { MB_YESNO } else { MB_OK };
    unsafe { MessageBoxW(std::ptr::null_mut(), x.as_ptr(), t.as_ptr(), flags) == IDYES as i32 }
}
