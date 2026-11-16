mod ffmpeg;

use ffmpeg::{
    detect_silence, export_audio_only, export_cover_image, export_project_edl,
    export_subtitles_srt, export_trimmed_video, extract_waveform, Phrase, SilenceGap,
};

fn get_video_duration(path: &str) -> f64 {
    // 1. Try ffprobe format=duration
    if let Ok(output) = ffmpeg::new_command("ffprobe")
        .args(&[
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
    {
        let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if let Ok(dur) = s.parse::<f64>() {
            if dur > 0.0 {
                return dur;
            }
        }
    }

    // 2. Try ffprobe stream=duration
    if let Ok(output) = ffmpeg::new_command("ffprobe")
        .args(&[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
    {
        let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if let Ok(dur) = s.parse::<f64>() {
            if dur > 0.0 {
                return dur;
            }
        }
    }

    // 3. Fallback: Parse "Duration: 00:00:20.39" from `ffmpeg -i <path>`
    if let Ok(output) = ffmpeg::new_command("ffmpeg")
        .args(&["-hide_banner", "-i", path])
        .output()
    {
        let stderr = String::from_utf8_lossy(&output.stderr);
        for line in stderr.lines() {
            if let Some(pos) = line.find("Duration:") {
                let rest = line[pos + "Duration:".len()..].trim();
                let time_str = rest.split(',').next().unwrap_or("").trim();
                let parts: Vec<&str> = time_str.split(':').collect();
                if parts.len() == 3 {
                    let h: f64 = parts[0].trim().parse().unwrap_or(0.0);
                    let m: f64 = parts[1].trim().parse().unwrap_or(0.0);
                    let s: f64 = parts[2].trim().parse().unwrap_or(0.0);
                    let total = h * 3600.0 + m * 60.0 + s;
                    if total > 0.0 {
                        return total;
                    }
                }
            }
        }
    }

    0.0
}

#[tauri::command]
async fn detect_silence_cmd(
    path: String,
    threshold_db: f64,
    min_duration: f64,
) -> Result<Vec<SilenceGap>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        detect_silence(&path, threshold_db, min_duration)
    })
    .await
    .map_err(|e| format!("Не удалось найти паузы: {}", e))?
}

#[tauri::command]
async fn extract_waveform_cmd(path: String, points: usize) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || extract_waveform(&path, points))
        .await
        .map_err(|e| format!("Не удалось извлечь звуковую дорожку: {}", e))?
}

#[tauri::command]
async fn get_video_duration_cmd(path: String) -> Result<f64, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(get_video_duration(&path)))
        .await
        .map_err(|e| format!("Не удалось определить длительность: {}", e))?
}

#[tauri::command]
async fn transcribe_speech_cmd(
    path: String,
    model_size: Option<String>,
    language: Option<String>,
) -> Result<Vec<Phrase>, String> {
    let model = model_size.unwrap_or_else(|| "base".to_string());
    let lang = language.unwrap_or_else(|| "ru".to_string());
    tauri::async_runtime::spawn_blocking(move || ffmpeg::transcribe_speech(&path, &model, &lang))
        .await
        .map_err(|e| format!("Не удалось распознать речь: {}", e))?
}

#[tauri::command]
async fn select_video_file_cmd() -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Title = "Выберите видео"
$f.Filter = "Видео файлы (*.mp4;*.mov;*.mkv;*.webm)|*.mp4;*.mov;*.mkv;*.webm|Все файлы (*.*)|*.*"
$f.RestoreDirectory = $true
$f.Multiselect = $false
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.WriteLine($f.FileName)
}
"#;
        let output = ffmpeg::new_command("powershell")
            .args(&["-NoProfile", "-Command", script])
            .output()
            .ok()?;

        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn select_audio_file_cmd() -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Title = "Выберите фоновую музыку"
$f.Filter = "Аудио файлы (*.mp3;*.wav;*.aac;*.m4a;*.ogg;*.flac)|*.mp3;*.wav;*.aac;*.m4a;*.ogg;*.flac|Все файлы (*.*)|*.*"
$f.RestoreDirectory = $true
$f.Multiselect = $false
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.WriteLine($f.FileName)
}
"#;
        let output = ffmpeg::new_command("powershell")
            .args(&["-NoProfile", "-Command", script])
            .output()
            .ok()?;

        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn select_output_file_cmd(default_name: String) -> Option<String> {
    select_save_file_cmd(
        "Сохранить видео".to_string(),
        "MP4 Видео (*.mp4)|*.mp4".to_string(),
        default_name,
    )
    .await
}

#[tauri::command]
async fn select_save_file_cmd(title: String, filter: String, default_name: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.SaveFileDialog
$f.Title = $env:SUBCUT_DIALOG_TITLE
$f.FileName = $env:SUBCUT_DIALOG_NAME
$f.Filter = $env:SUBCUT_DIALOG_FILTER
$f.RestoreDirectory = $true
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.WriteLine($f.FileName)
}
"#;
        let output = ffmpeg::new_command("powershell")
            .args(&["-NoProfile", "-Command", script])
            .env("SUBCUT_DIALOG_TITLE", &title)
            .env("SUBCUT_DIALOG_NAME", &default_name)
            .env("SUBCUT_DIALOG_FILTER", &filter)
            .output()
            .ok()?;

        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn export_trimmed_video_cmd(
    input_path: String,
    cuts: Vec<(f64, f64)>,
    output_path: String,
    total_duration: f64,
    burn_subtitles: bool,
    subtitle_preset: String,
    phrases: Vec<Phrase>,
    hardware_accel: String,
    framing_mode: Option<String>,
    color_preset: Option<String>,
    target_bitrate_kbps: Option<u32>,
    bg_music_path: Option<String>,
    bg_music_volume: Option<f64>,
    auto_ducking: Option<bool>,
    ducking_preset: Option<String>,
    subtitle_size: Option<u32>,
    subtitle_position: Option<String>,
    transition_smoothing: Option<String>,
) -> Result<(), String> {
    let framing = framing_mode.unwrap_or_else(|| "original".to_string());
    let color = color_preset.unwrap_or_else(|| "none".to_string());
    let bg_vol = bg_music_volume.unwrap_or(0.15);
    let ducking = auto_ducking.unwrap_or(true);
    let sub_pos = subtitle_position;
    let smoothing = transition_smoothing;
    tauri::async_runtime::spawn_blocking(move || {
        export_trimmed_video(
            &input_path,
            &cuts,
            &output_path,
            total_duration,
            burn_subtitles,
            &subtitle_preset,
            &phrases,
            &hardware_accel,
            &framing,
            &color,
            target_bitrate_kbps,
            bg_music_path.as_deref(),
            bg_vol,
            ducking,
            ducking_preset.as_deref(),
            subtitle_size,
            sub_pos.as_deref(),
            smoothing.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Не удалось смонтировать видео: {}", e))?
}

#[tauri::command]
async fn calculate_telegram_video_bitrate_cmd(
    duration_sec: f64,
    max_megabytes: Option<f64>,
) -> Result<u32, String> {
    let mb = max_megabytes.unwrap_or(46.0);
    Ok(ffmpeg::calculate_telegram_video_bitrate(duration_sec, mb))
}

#[tauri::command]
async fn export_cover_image_cmd(
    input_path: String,
    time: f64,
    output_path: String,
    framing_mode: Option<String>,
    color_preset: Option<String>,
    title_text: Option<String>,
    title_style: Option<String>,
) -> Result<(), String> {
    let framing = framing_mode.unwrap_or_else(|| "original".to_string());
    let color = color_preset.unwrap_or_else(|| "none".to_string());
    tauri::async_runtime::spawn_blocking(move || {
        export_cover_image(
            &input_path,
            time,
            &output_path,
            &framing,
            &color,
            title_text.as_deref(),
            title_style.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Не удалось сохранить обложку: {}", e))?
}

#[tauri::command]
async fn export_audio_only_cmd(
    input_path: String,
    cuts: Vec<(f64, f64)>,
    output_path: String,
    total_duration: f64,
    bitrate_kbps: Option<u32>,
    bg_music_path: Option<String>,
    bg_music_volume: Option<f64>,
    auto_ducking: Option<bool>,
    ducking_preset: Option<String>,
    transition_smoothing: Option<String>,
) -> Result<(), String> {
    let br = bitrate_kbps.unwrap_or(320);
    let bg_vol = bg_music_volume.unwrap_or(0.15);
    let ducking = auto_ducking.unwrap_or(true);
    let smoothing = transition_smoothing;
    tauri::async_runtime::spawn_blocking(move || {
        export_audio_only(
            &input_path,
            &cuts,
            total_duration,
            &output_path,
            br,
            bg_music_path.as_deref(),
            bg_vol,
            ducking,
            ducking_preset.as_deref(),
            smoothing.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Не удалось экспортировать аудио: {}", e))?
}

#[tauri::command]
async fn export_subtitles_srt_cmd(
    output_path: String,
    cuts: Vec<(f64, f64)>,
    total_duration: f64,
    phrases: Vec<Phrase>,
    transition_smoothing: Option<String>,
) -> Result<(), String> {
    let smoothing = transition_smoothing;
    tauri::async_runtime::spawn_blocking(move || {
        export_subtitles_srt(&phrases, &cuts, total_duration, &output_path, smoothing.as_deref())
    })
    .await
    .map_err(|e| format!("Не удалось экспортировать субтитры: {}", e))?
}

#[tauri::command]
async fn export_project_edl_cmd(
    output_path: String,
    input_path: String,
    cuts: Vec<(f64, f64)>,
    total_duration: f64,
    fps: Option<f64>,
    transition_smoothing: Option<String>,
) -> Result<(), String> {
    let fps_val = fps.unwrap_or(30.0);
    let smoothing = transition_smoothing;
    tauri::async_runtime::spawn_blocking(move || {
        export_project_edl(&input_path, &cuts, total_duration, &output_path, fps_val, smoothing.as_deref())
    })
    .await
    .map_err(|e| format!("Не удалось экспортировать проект EDL: {}", e))?
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
            select_audio_file_cmd,
            select_output_file_cmd,
            select_save_file_cmd,
            calculate_telegram_video_bitrate_cmd,
            export_trimmed_video_cmd,
            export_cover_image_cmd,
            export_audio_only_cmd,
            export_subtitles_srt_cmd,
            export_project_edl_cmd
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
