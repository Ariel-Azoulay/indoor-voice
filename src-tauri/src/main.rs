#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|argument| argument == "--request-accessibility") {
        let trusted = indoor_voice_lib::request_accessibility_for_current_process();
        println!("{}", if trusted { "trusted" } else { "not-trusted" });
        std::process::exit(if trusted { 0 } else { 2 });
    }
    if std::env::args().any(|argument| argument == "--check-accessibility") {
        let trusted = indoor_voice_lib::accessibility_trusted_for_current_process();
        println!("{}", if trusted { "trusted" } else { "not-trusted" });
        std::process::exit(if trusted { 0 } else { 2 });
    }
    indoor_voice_lib::run();
}
