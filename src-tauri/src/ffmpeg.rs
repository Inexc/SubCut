use serde::{Deserialize, Serialize};
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[allow(dead_code)]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Creates a Command with CREATE_NO_WINDOW on Windows to prevent any console window popup
pub fn new_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SilenceGap {
    pub id: String,
    #[serde(rename = "startTime")]
    pub start_time: f64,
    #[serde(rename = "endTime")]
    pub end_time: f64,
    pub duration: f64,
    #[serde(rename = "isCut")]
    pub is_cut: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Word {
    pub word: String,
    #[serde(rename = "startTime")]
    pub start_time: f64,
    #[serde(rename = "endTime")]
    pub end_time: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Phrase {
    pub id: String,
    pub speaker: String,
    #[serde(rename = "startTime")]
    pub start_time: f64,
    #[serde(rename = "endTime")]
    pub end_time: f64,
    pub text: String,
    #[serde(default)]
    pub words: Vec<Word>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

/// Helper to calculate keep intervals with 120ms/100ms smooth speech padding
pub fn calculate_keep_intervals(cut_intervals: &[(f64, f64)], total_duration: f64) -> Vec<(f64, f64)> {
    const PAD_OUT: f64 = 0.12; // preserve voice decay tail
    const PAD_IN: f64 = 0.10;  // preserve breath onset

    let mut keep_intervals = Vec::new();
    let mut current_pos = 0.0;

    let mut sorted_cuts = cut_intervals.to_vec();
    sorted_cuts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

    for &(cut_start, cut_end) in &sorted_cuts {
        let eff_start = (cut_start + PAD_OUT).min(cut_end);
        let eff_end = (cut_end - PAD_IN).max(eff_start);

        if eff_end - eff_start > 0.08 {
            if eff_start > current_pos + 0.05 {
                keep_intervals.push((current_pos, eff_start));
            }
            current_pos = current_pos.max(eff_end);
        }
    }

    if current_pos < total_duration - 0.05 {
        keep_intervals.push((current_pos, total_duration));
    }

    keep_intervals
}

/// Helper to format seconds as ASS timestamp format (H:MM:SS.cs)
fn format_ass_time(seconds: f64) -> String {
    let s = seconds.max(0.0);
    let h = (s / 3600.0).floor() as u32;
    let m = ((s % 3600.0) / 60.0).floor() as u32;
    let sec = (s % 60.0).floor() as u32;
    let cs = ((s % 1.0) * 100.0).round() as u32;
    format!("{}:{:02}:{:02}.{:02}", h, m, sec, cs)
}

/// Helper to format seconds as SRT timestamp format (HH:MM:SS,mmm)
fn format_srt_time(seconds: f64) -> String {
    let s = seconds.max(0.0);
    let h = (s / 3600.0).floor() as u32;
    let m = ((s % 3600.0) / 60.0).floor() as u32;
    let sec = (s % 60.0).floor() as u32;
    let ms = ((s % 1.0) * 1000.0).round() as u32;
    format!("{:02}:{:02}:{:02},{:03}", h, m, sec, ms)
}

/// Helper to format seconds as EDL timecode format (HH:MM:SS:FF)
fn seconds_to_edl_tc(seconds: f64, fps: f64) -> String {
    let fps_val = if fps > 0.0 { fps } else { 30.0 };
    let total_frames = (seconds * fps_val).round() as u64;
    let frames = total_frames % (fps_val.round() as u64);
    let total_seconds = total_frames / (fps_val.round() as u64);
    let s = total_seconds % 60;
    let total_minutes = total_seconds / 60;
    let m = total_minutes % 60;
    let h = total_minutes / 60;
    format!("{:02}:{:02}:{:02}:{:02}", h, m, s, frames)
}

/// Generates an ASS subtitle file with configurable style presets (Hormozi, Classic, Box)
pub fn generate_ass_subtitles(
    phrases: &[Phrase],
    keep_intervals: &[(f64, f64)],
    output_path: &str,
    preset: &str,
) -> Result<(), String> {
    let map_time = |t: f64| -> f64 {
        let mut out_time = 0.0;
        for &(k_start, k_end) in keep_intervals {
            if t < k_start {
                return out_time;
            } else if t <= k_end {
                return out_time + (t - k_start);
            } else {
                out_time += k_end - k_start;
            }
        }
        out_time
    };

    let mut ass = String::new();
    ass.push_str("[Script Info]\n");
    ass.push_str("ScriptType: v4.00+\n");
    ass.push_str("PlayResX: 1080\n");
    ass.push_str("PlayResY: 1920\n\n");

    ass.push_str("[V4+ Styles]\n");
    ass.push_str("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n");

    match preset {
        "hormozi" => {
            // Hormozi Style: Bold, Yellow Karaoke Primary, White Secondary, 4.5px Black Outline
            ass.push_str("Style: Default,Arial,58,&H0000FFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4.5,1.0,2,40,40,240,1\n\n");
        }
        "box" => {
            // Box Minimal: Semi-transparent dark background box
            ass.push_str("Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,3,2.0,0,2,40,40,180,1\n\n");
        }
        _ => {
            // Classic Clean: White with clean 3.5px black outline
            ass.push_str("Style: Default,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3.5,1.5,2,40,40,200,1\n\n");
        }
    }

    ass.push_str("[Events]\n");
    ass.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    for (i, p) in phrases.iter().enumerate() {
        let text = p.text.trim();
        if text.is_empty() {
            continue;
        }
        let start = map_time(p.start_time);
        let mut end = map_time(p.end_time);

        // Ensure at least 0.5s readability unless next phrase starts sooner
        if let Some(next_p) = phrases.get(i + 1) {
            let next_start = map_time(next_p.start_time);
            if next_start > start + 0.05 {
                end = end.max(start + 0.5).min(next_start - 0.05);
            }
        } else {
            end = end.max(start + 0.5);
        }

        if end > start + 0.08 {
            let event_text = if preset == "hormozi" && !p.words.is_empty() {
                // Word-by-word karaoke highlight for Hormozi preset
                let mut line = String::new();
                for w in &p.words {
                    let w_start = map_time(w.start_time);
                    let w_end = map_time(w.end_time);
                    let dur_cs = (((w_end - w_start).max(0.04)) * 100.0).round() as u32;
                    let clean_w = w.word.to_uppercase().replace('{', "(").replace('}', ")");
                    line.push_str(&format!("{{\\k{}}}{} ", dur_cs, clean_w));
                }
                line.trim_end().to_string()
            } else if preset == "hormozi" {
                text.to_uppercase().replace('{', "(").replace('}', ")").replace('\n', "\\N")
            } else {
                text.replace('{', "(").replace('}', ")").replace('\n', "\\N")
            };

            ass.push_str(&format!(
                "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
                format_ass_time(start),
                format_ass_time(end),
                event_text
            ));
        }
    }

    std::fs::write(output_path, ass.as_bytes())
        .map_err(|e| format!("Не удалось создать файл субтитров: {}", e))?;

    Ok(())
}

/// Exports standalone .SRT subtitles file with mapped cut timestamps
pub fn export_subtitles_srt(
    phrases: &[Phrase],
    cut_intervals: &[(f64, f64)],
    total_duration: f64,
    output_path: &str,
) -> Result<(), String> {
    let keep_intervals = calculate_keep_intervals(cut_intervals, total_duration);

    let map_time = |t: f64| -> f64 {
        let mut out_time = 0.0;
        for &(k_start, k_end) in &keep_intervals {
            if t < k_start {
                return out_time;
            } else if t <= k_end {
                return out_time + (t - k_start);
            } else {
                out_time += k_end - k_start;
            }
        }
        out_time
    };

    let mut srt = String::new();
    let mut index = 1;

    for (i, p) in phrases.iter().enumerate() {
        let text = p.text.trim();
        if text.is_empty() {
            continue;
        }
        let start = map_time(p.start_time);
        let mut end = map_time(p.end_time);

        // Ensure at least 0.5s readability unless next phrase starts sooner
        if let Some(next_p) = phrases.get(i + 1) {
            let next_start = map_time(next_p.start_time);
            if next_start > start + 0.05 {
                end = end.max(start + 0.5).min(next_start - 0.05);
            }
        } else {
            end = end.max(start + 0.5);
        }

        if end > start + 0.08 {
            srt.push_str(&format!(
                "{}\n{} --> {}\n{}\n\n",
                index,
                format_srt_time(start),
                format_srt_time(end),
                text
            ));
            index += 1;
        }
    }

    std::fs::write(output_path, srt.as_bytes())
        .map_err(|e| format!("Не удалось сохранить файл субтитров .SRT: {}", e))?;

    Ok(())
}

/// Exports standard CMX 3600 EDL for Premiere Pro / DaVinci Resolve / Final Cut Pro
pub fn export_project_edl(
    input_path: &str,
    cut_intervals: &[(f64, f64)],
    total_duration: f64,
    output_path: &str,
    fps: f64,
) -> Result<(), String> {
    let keep_intervals = calculate_keep_intervals(cut_intervals, total_duration);

    let clip_filename = std::path::Path::new(input_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("clip.mov");

    let mut edl = String::new();
    edl.push_str("TITLE: SubCut Project\n");
    edl.push_str("FCM: NON-DROP FRAME\n\n");

    let mut rec_current = 0.0;

    for (i, &(src_in, src_out)) in keep_intervals.iter().enumerate() {
        let dur = src_out - src_in;
        let rec_in = rec_current;
        let rec_out = rec_current + dur;
        rec_current = rec_out;

        let src_in_tc = seconds_to_edl_tc(src_in, fps);
        let src_out_tc = seconds_to_edl_tc(src_out, fps);
        let rec_in_tc = seconds_to_edl_tc(rec_in, fps);
        let rec_out_tc = seconds_to_edl_tc(rec_out, fps);

        let event_num = format!("{:03}", (i + 1).min(999));
        edl.push_str(&format!(
            "{}  AX       AA/V  C        {} {} {} {}\n",
            event_num, src_in_tc, src_out_tc, rec_in_tc, rec_out_tc
        ));
        edl.push_str(&format!("* FROM CLIP NAME: {}\n\n", clip_filename));
    }

    std::fs::write(output_path, edl.as_bytes())
        .map_err(|e| format!("Не удалось сохранить файл проекта EDL: {}", e))?;

    Ok(())
}

/// Detects silence intervals using FFmpeg silencedetect audio filter
pub fn detect_silence(
    path: &str,
    threshold_db: f64,
    min_duration: f64,
) -> Result<Vec<SilenceGap>, String> {
    let filter = format!("silencedetect=noise={}dB:d={}", threshold_db, min_duration);
    let output = new_command("ffmpeg")
        .args(&[
            "-hide_banner",
            "-vn",
            "-i",
            path,
            "-af",
            &filter,
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|e| format!("Не удалось запустить FFmpeg: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut gaps = Vec::new();
    let mut cur_start: Option<f64> = None;
    let mut index = 1;

    for line in stderr.lines() {
        if let Some(pos) = line.find("silence_start:") {
            let num_str = line[pos + "silence_start:".len()..].trim();
            if let Some(token) = num_str.split_whitespace().next() {
                if let Ok(val) = token.parse::<f64>() {
                    cur_start = Some(val);
                }
            }
        } else if let Some(pos) = line.find("silence_end:") {
            let after = &line[pos + "silence_end:".len()..];
            let parts: Vec<&str> = after.split('|').collect();
            let end_val = parts[0]
                .trim()
                .split_whitespace()
                .next()
                .unwrap_or("0")
                .parse::<f64>()
                .unwrap_or(0.0);

            let mut dur_val = 0.0;
            if parts.len() > 1 && parts[1].contains("silence_duration:") {
                let dur_str = parts[1].split("silence_duration:").nth(1).unwrap_or("").trim();
                dur_val = dur_str
                    .split_whitespace()
                    .next()
                    .unwrap_or("0")
                    .parse::<f64>()
                    .unwrap_or(0.0);
            }

            let start = cur_start.unwrap_or(end_val - dur_val);
            gaps.push(SilenceGap {
                id: format!("s-{}", index),
                start_time: (start * 100.0).round() / 100.0,
                end_time: (end_val * 100.0).round() / 100.0,
                duration: (dur_val * 100.0).round() / 100.0,
                is_cut: false,
            });
            index += 1;
            cur_start = None;
        }
    }

    Ok(gaps)
}

/// Extracts downsampled RMS waveform peaks (0..100) for UI Canvas
pub fn extract_waveform(path: &str, points: usize) -> Result<Vec<u8>, String> {
    let output = new_command("ffmpeg")
        .args(&[
            "-hide_banner",
            "-vn",
            "-i",
            path,
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "s16le",
            "-",
        ])
        .output()
        .map_err(|e| format!("Не удалось извлечь аудио: {}", e))?;

    let bytes = output.stdout;
    if bytes.len() < 2 {
        return Ok(vec![10; points]);
    }

    let samples_count = bytes.len() / 2;
    let mut samples = Vec::with_capacity(samples_count);
    for chunk in bytes.chunks_exact(2) {
        let val = i16::from_le_bytes([chunk[0], chunk[1]]);
        samples.push(val.abs() as f32);
    }

    let chunk_size = (samples.len() / points).max(1);
    let mut peaks = Vec::with_capacity(points);

    for i in 0..points {
        let start = i * chunk_size;
        let end = ((i + 1) * chunk_size).min(samples.len());
        if start >= samples.len() {
            peaks.push(5);
            continue;
        }
        let slice = &samples[start..end];
        let sum_sq: f32 = slice.iter().map(|&s| s * s).sum();
        let rms = (sum_sq / slice.len() as f32).sqrt();
        let scaled = ((rms / 12000.0) * 100.0).clamp(4.0, 100.0) as u8;
        peaks.push(scaled);
    }

    Ok(peaks)
}

/// Cuts video without quality degradation using filter_complex concat
/// Applies audio micro-crossfades (25ms) and speech edge padding (0.12s out / 0.10s in)
/// Supports GPU NVENC acceleration and styled subtitle burn-in. (Zoom has been completely removed)
pub fn export_trimmed_video(
    input_path: &str,
    cut_intervals: &[(f64, f64)],
    output_path: &str,
    total_duration: f64,
    burn_subtitles: bool,
    subtitle_preset: &str,
    phrases: &[Phrase],
    hardware_accel: &str,
) -> Result<(), String> {
    let keep_intervals = calculate_keep_intervals(cut_intervals, total_duration);

    if keep_intervals.is_empty() {
        return Err("Все фрагменты видео вырезаны".into());
    }

    // Subtitle file generation (if enabled)
    let temp_ass_path = format!("{}.temp_subtitles.ass", output_path);
    let should_burn = burn_subtitles && !phrases.is_empty();

    if should_burn {
        generate_ass_subtitles(phrases, &keep_intervals, &temp_ass_path, subtitle_preset)?;
    }

    // Build filter_complex string with 25ms audio micro-fades (NO ZOOM)
    let mut filter_complex = String::new();
    let mut concat_inputs = String::new();

    for (i, &(start, end)) in keep_intervals.iter().enumerate() {
        let dur = end - start;
        let fade_len = (dur * 0.15).min(0.025); // 25ms fade

        filter_complex.push_str(&format!(
            "[0:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS[v{}];",
            start, end, i
        ));
        filter_complex.push_str(&format!(
            "[0:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS,afade=t=in:st=0:d={:.3},afade=t=out:st={:.3}:d={:.3}[a{}];",
            start, end, fade_len, (dur - fade_len).max(0.0), fade_len, i
        ));
        concat_inputs.push_str(&format!("[v{}][a{}]", i, i));
    }

    if should_burn {
        filter_complex.push_str(&format!(
            "{}concat=n={}:v=1:a=1[concatv][outa];",
            concat_inputs,
            keep_intervals.len()
        ));
        let escaped_ass = temp_ass_path.replace('\\', "/").replace(':', "\\:");
        filter_complex.push_str(&format!("[concatv]subtitles='{}'[outv]", escaped_ass));
    } else {
        filter_complex.push_str(&format!(
            "{}concat=n={}:v=1:a=1[outv][outa]",
            concat_inputs,
            keep_intervals.len()
        ));
    }

    // Select Video Encoder (GPU NVENC vs CPU libx264)
    let use_nvenc = hardware_accel == "nvenc" || hardware_accel == "auto";

    let mut base_args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-i".to_string(),
        input_path.to_string(),
        "-filter_complex".to_string(),
        filter_complex.clone(),
        "-map".to_string(),
        "[outv]".to_string(),
        "-map".to_string(),
        "[outa]".to_string(),
    ];

    if use_nvenc {
        base_args.extend(vec![
            "-c:v".to_string(),
            "h264_nvenc".to_string(),
            "-preset".to_string(),
            "p4".to_string(),
            "-cq".to_string(),
            "20".to_string(),
        ]);
    } else {
        base_args.extend(vec![
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "fast".to_string(),
            "-crf".to_string(),
            "18".to_string(),
        ]);
    }

    base_args.extend(vec![
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "192k".to_string(),
        output_path.to_string(),
    ]);

    let mut output = new_command("ffmpeg").args(&base_args).output();

    // If NVENC failed and auto was selected, try CPU fallback
    if use_nvenc && (output.is_err() || !output.as_ref().unwrap().status.success()) {
        let cpu_args = vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-i".to_string(),
            input_path.to_string(),
            "-filter_complex".to_string(),
            filter_complex,
            "-map".to_string(),
            "[outv]".to_string(),
            "-map".to_string(),
            "[outa]".to_string(),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "fast".to_string(),
            "-crf".to_string(),
            "18".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "192k".to_string(),
            output_path.to_string(),
        ];
        output = new_command("ffmpeg").args(&cpu_args).output();
    }

    // Clean up temporary ASS file
    if should_burn {
        let _ = std::fs::remove_file(&temp_ass_path);
    }

    let output = output.map_err(|e| format!("Ошибка выполнения FFmpeg: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg завершился с ошибкой: {}", err));
    }

    Ok(())
}

/// Transcribes speech using faster-whisper INT8 helper with configurable model, language, and word timestamps
pub fn transcribe_speech(path: &str, model_size: &str, language: &str) -> Result<Vec<Phrase>, String> {
    let script_path = concat!(env!("CARGO_MANIFEST_DIR"), "\\transcribe.py");
    let output = new_command("python")
        .env("PYTHONIOENCODING", "utf-8")
        .args(&[script_path, path, model_size, language])
        .output()
        .map_err(|e| format!("Не удалось вызвать Whisper: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let phrases: Vec<Phrase> = serde_json::from_str(stdout.trim()).unwrap_or_default();
    Ok(phrases)
}
