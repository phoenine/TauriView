fn main() {
    println!("cargo:rerun-if-changed=../resources/dictionaries");
    println!("cargo:rerun-if-changed=../resources/tts");
    tauri_build::build()
}
