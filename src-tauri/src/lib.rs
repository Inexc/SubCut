mod ffmpeg;

use ffmpeg::{detect_silence, export_trimmed_video, extract_waveform, SilenceGap};
use std::process::Command;

#[tauri::command]
fn detect_silence_cmd(
    path: String,
    threshold_db: f64,
    min_duration: f64,
) -> Result<Vec<SilenceGap>, String> {
    detect_silence(&path, threshold_db, min_duration)
}

#[tauri::command]
fn extract_waveform_cmd(path: String, points: usize) -> Result<Vec<u8>, String> {
    extract_waveform(&path, points)
}

#[tauri::command]
fn get_video_duration_cmd(path: String) -> Result<f64, String> {
    // 1. Try ffprobe format=duration
    if let Ok(output) = Command::new("ffprobe")
        .args(&[
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &path,
        ])
        .output()
    {
        let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if let Ok(dur) = s.parse::<f64>() {
            if dur > 0.0 {
                return Ok(dur);
            }
        }
    }

    // 2. Try ffprobe stream=duration
    if let Ok(output) = Command::new("ffprobe")
        .args(&[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &path,
        ])
        .output()
    {
        let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if let Ok(dur) = s.parse::<f64>() {
            if dur > 0.0 {
                return Ok(dur);
            }
        }
    }

    // 3. Fallback: Parse "Duration: 00:00:20.39" from `ffmpeg -i <path>`
    if let Ok(output) = Command::new("ffmpeg")
        .args(&["-hide_banner", "-i", &path])
        .output()
    {
        let stderr = String::from_utf8_lossy(&output.stderr);
        for line in stderr.lines() {
            if let Some(pos) = line.find("Duration:") {
                let rest = &line[pos + "Duration:".len()..].trim();
                let time_str = rest.split(',').next().unwrap_or("").trim();
                let parts: Vec<&str> = time_str.split(':').collect();
                if parts.len() == 3 {
                    let h: f64 = parts[0].trim().parse().unwrap_or(0.0);
                    let m: f64 = parts[1].trim().parse().unwrap_or(0.0);
                    let s: f64 = parts[2].trim().parse().unwrap_or(0.0);
                    let total = h * 3600.0 + m * 60.0 + s;
                    if total > 0.0 {
                        return Ok(total);
                    }
                }
            }
        }
    }

    // Fallback safe duration
    Ok(10.0)
}

#[tauri::command]
fn transcribe_speech_cmd(path: String) -> Result<Vec<ffmpeg::Phrase>, String> {
    ffmpeg::transcribe_speech(&path)
}

#[tauri::command]
fn select_video_file_cmd() -> Option<String> {
    let script = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Title = "Выберите видео для монтажа в SubCut"
$f.Filter = "Видео файлы (*.mp4;*.mov;*.mkv;*.webm)|*.mp4;*.mov;*.mkv;*.webm|Все файлы (*.*)|*.*"
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.WriteLine($f.FileName)
}
"#;
    let output = Command::new("powershell")
        .args(&["-NoProfile", "-Command", script])
        .output()
        .ok()?;

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[tauri::command]
fn select_output_file_cmd(default_name: String) -> Option<String> {
    let script = format!(
        r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.SaveFileDialog
$f.Title = "Сохранить готовое видео SubCut"
$f.FileName = "{}"
$f.Filter = "MP4 Видео (*.mp4)|*.mp4"
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
    [Console]::Out.WriteLine($f.FileName)
}}
"#,
        default_name
    );
    let output = Command::new("powershell")
        .args(&["-NoProfile", "-Command", &script])
        .output()
        .ok()?;

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[tauri::command]
fn export_trimmed_video_cmd(
    input_path: String,
    cuts: Vec<(f64, f64)>,
    output_path: String,
    total_duration: f64,
) -> Result<(), String> {
    export_trimmed_video(&input_path, &cuts, &output_path, total_duration)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            detect_silence_cmd,
            extract_waveform_cmd,
            get_video_duration_cmd,
            transcribe_speech_cmd,
            select_video_file_cmd,
            select_output_file_cmd,
            export_trimmed_video_cmd
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
