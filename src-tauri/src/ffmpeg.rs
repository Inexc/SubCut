use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Word {
    pub word: String,
    #[serde(rename = "startTime")]
    pub start_time: f64,
    #[serde(rename = "endTime")]
    pub end_time: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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

/// Helper to calculate keep intervals with speech edge padding (120ms decay / 100ms onset)
/// Correctly handles empty cuts, overlapping cuts, out of bounds cuts, and NaN values.
/// Preserves true video boundaries without creating micro-slivers at 0.0 or total_duration.
pub fn calculate_keep_intervals(cut_intervals: &[(f64, f64)], total_duration: f64) -> Vec<(f64, f64)> {
    if !total_duration.is_finite() || total_duration <= 0.05 {
        return Vec::new();
    }

    const PAD_OUT: f64 = 0.12; // preserve voice decay tail
    const PAD_IN: f64 = 0.10;  // preserve breath onset

    // 1. Sanitize and sort raw cuts
    let mut valid_cuts = Vec::new();
    for &(start, end) in cut_intervals {
        if !start.is_finite() || !end.is_finite() {
            continue;
        }
        let clamped_start = start.clamp(0.0, total_duration);
        let clamped_end = end.clamp(0.0, total_duration);
        if clamped_end > clamped_start {
            valid_cuts.push((clamped_start, clamped_end));
        }
    }
    valid_cuts.sort_by(|a, b| a.0.total_cmp(&b.0));

    // 2. Merge overlapping raw cuts
    let mut merged_raw: Vec<(f64, f64)> = Vec::new();
    for (start, end) in valid_cuts {
        if let Some(last) = merged_raw.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged_raw.push((start, end));
    }

    // 3. Apply padding to create effective cut intervals.
    // Boundary protection:
    // If cut starts at 0.0, do not pad with PAD_OUT (there is no speech tail before 0.0).
    // If cut ends at total_duration, do not pad with PAD_IN (there is no speech onset after video end).
    let mut eff_cuts: Vec<(f64, f64)> = Vec::new();
    for (cut_start, cut_end) in merged_raw {
        let eff_start = if cut_start <= 0.05 {
            0.0
        } else {
            (cut_start + PAD_OUT).min(cut_end)
        };
        let eff_end = if cut_end >= total_duration - 0.05 {
            total_duration
        } else {
            (cut_end - PAD_IN).max(eff_start)
        };

        if eff_end - eff_start > 0.04 {
            if let Some(last) = eff_cuts.last_mut() {
                if eff_start <= last.1 {
                    last.1 = last.1.max(eff_end);
                    continue;
                }
            }
            eff_cuts.push((eff_start, eff_end));
        }
    }

    // 4. Invert cuts into keep intervals
    let mut keep_intervals = Vec::new();
    let mut current_pos = 0.0;

    for (cut_start, cut_end) in eff_cuts {
        if cut_start > current_pos + 0.04 {
            keep_intervals.push((current_pos, cut_start));
        }
        current_pos = current_pos.max(cut_end);
    }

    if current_pos < total_duration - 0.04 {
        keep_intervals.push((current_pos, total_duration));
    }

    keep_intervals
}

/// Maps a timestamp from the original unedited video into the edited video timeline
pub fn map_original_to_trimmed(t: f64, keep_intervals: &[(f64, f64)]) -> f64 {
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
}

/// Helper to format seconds as ASS timestamp format (H:MM:SS.cs)
pub fn format_ass_time(seconds: f64) -> String {
    let s = seconds.max(0.0);
    let total_cs = (s * 100.0).round() as u64;
    let cs = total_cs % 100;
    let total_sec = total_cs / 100;
    let sec = total_sec % 60;
    let total_min = total_sec / 60;
    let m = total_min % 60;
    let h = total_min / 60;
    format!("{}:{:02}:{:02}.{:02}", h, m, sec, cs)
}

/// Helper to format seconds as SRT timestamp format (HH:MM:SS,mmm)
pub fn format_srt_time(seconds: f64) -> String {
    let s = seconds.max(0.0);
    let total_ms = (s * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_sec = total_ms / 1000;
    let sec = total_sec % 60;
    let total_min = total_sec / 60;
    let m = total_min % 60;
    let h = total_min / 60;
    format!("{:02}:{:02}:{:02},{:03}", h, m, sec, ms)
}

/// Helper to return FFmpeg video filter for visual color presets
pub fn build_color_filter(preset: &str) -> Option<&'static str> {
    match preset {
        "anime_punch" => Some("eq=saturation=1.25:contrast=1.12,unsharp=5:5:0.8:5:5:0.0"),
        "cinematic" => Some("eq=contrast=1.18:brightness=-0.03:saturation=0.95"),
        "crisp" => Some("unsharp=7:7:1.2:7:7:0.0"),
        _ => None,
    }
}

/// Helper to calculate target video bitrate for Telegram Compact preset (< 50 MB)
#[allow(dead_code)]
pub fn calculate_telegram_video_bitrate(duration_sec: f64, max_megabytes: f64) -> u32 {
    let dur = duration_sec.max(1.0);
    let target_bytes = max_megabytes * 1024.0 * 1024.0;
    let target_bits = target_bytes * 8.0;
    let audio_kbps = 128.0;
    let audio_bits = audio_kbps * 1000.0 * dur;
    let video_bits = (target_bits - audio_bits).max(100_000.0);
    let video_kbps = (video_bits / dur / 1000.0).round() as u32;
    // Clamp between 300 kbps and 4500 kbps for safe quality and size
    video_kbps.clamp(300, 4500)
}

/// Helper to format frame count as EDL timecode format (HH:MM:SS:FF)
pub fn frames_to_edl_tc(total_frames: u64, fps: f64) -> String {
    let fps_val = if fps > 0.0 { fps.round() as u64 } else { 30 };
    let fps_u = if fps_val > 0 { fps_val } else { 30 };
    let frames = total_frames % fps_u;
    let total_seconds = total_frames / fps_u;
    let s = total_seconds % 60;
    let total_minutes = total_seconds / 60;
    let m = total_minutes % 60;
    let h = total_minutes / 60;
    format!("{:02}:{:02}:{:02}:{:02}", h, m, s, frames)
}

/// Helper to format seconds as EDL timecode format (HH:MM:SS:FF)
#[allow(dead_code)]
pub fn seconds_to_edl_tc(seconds: f64, fps: f64) -> String {
    let fps_val = if fps > 0.0 { fps } else { 30.0 };
    let total_frames = (seconds.max(0.0) * fps_val).round() as u64;
    frames_to_edl_tc(total_frames, fps_val)
}

/// RAII Guard to ensure temp files are removed when out of scope
struct TempFileGuard<'a>(&'a Path);
impl<'a> Drop for TempFileGuard<'a> {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.0);
    }
}

/// Generates an ASS subtitle file with configurable style presets (Hormozi, Classic, Box)
/// Automatically skips phrases or words that fall into cut-out sections.
pub fn generate_ass_subtitles(
    phrases: &[Phrase],
    keep_intervals: &[(f64, f64)],
    output_path: &str,
    preset: &str,
) -> Result<(), String> {
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

        let start = map_original_to_trimmed(p.start_time, keep_intervals);
        let end = map_original_to_trimmed(p.end_time, keep_intervals);

        // If the phrase fell completely inside a cut interval, do not emit it
        if end <= start + 0.04 {
            continue;
        }

        // Find the start of the next preserved phrase to prevent subtitle overlap
        let mut next_start_opt = None;
        for next_p in &phrases[(i + 1)..] {
            let ns = map_original_to_trimmed(next_p.start_time, keep_intervals);
            let ne = map_original_to_trimmed(next_p.end_time, keep_intervals);
            if ne > ns + 0.04 {
                next_start_opt = Some(ns);
                break;
            }
        }

        let mut display_end = end;
        if let Some(next_start) = next_start_opt {
            if next_start > start + 0.05 {
                display_end = display_end.max(start + 0.5).min(next_start - 0.05);
            }
        } else {
            display_end = display_end.max(start + 0.5);
        }

        if display_end > start + 0.05 {
            // Filter words that fall into kept video
            let active_words: Vec<_> = p
                .words
                .iter()
                .filter(|w| {
                    let ws = map_original_to_trimmed(w.start_time, keep_intervals);
                    let we = map_original_to_trimmed(w.end_time, keep_intervals);
                    we > ws + 0.02
                })
                .collect();

            let event_text = if preset == "hormozi" && !active_words.is_empty() {
                // Word-by-word karaoke highlight for Hormozi preset
                let mut line = String::new();
                let first_w_start = map_original_to_trimmed(active_words[0].start_time, keep_intervals);
                if first_w_start > start + 0.02 {
                    let lead_cs = ((first_w_start - start) * 100.0).round() as u32;
                    if lead_cs > 0 {
                        line.push_str(&format!("{{\\k{}}}", lead_cs));
                    }
                }
                for (w_i, w) in active_words.iter().enumerate() {
                    let w_start = map_original_to_trimmed(w.start_time, keep_intervals);
                    let w_end = map_original_to_trimmed(w.end_time, keep_intervals);
                    let dur_sec = if w_i + 1 < active_words.len() {
                        let next_start = map_original_to_trimmed(active_words[w_i + 1].start_time, keep_intervals);
                        if next_start > w_start {
                            (next_start - w_start).max(0.04)
                        } else {
                            (w_end - w_start).max(0.04)
                        }
                    } else {
                        (w_end - w_start).max(0.04)
                    };
                    let dur_cs = (dur_sec * 100.0).round() as u32;
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
                format_ass_time(display_end),
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

    let mut srt = String::new();
    let mut index = 1;

    for (i, p) in phrases.iter().enumerate() {
        let text = p.text.trim();
        if text.is_empty() {
            continue;
        }

        let start = map_original_to_trimmed(p.start_time, &keep_intervals);
        let end = map_original_to_trimmed(p.end_time, &keep_intervals);

        // Skip phrases that were cut out
        if end <= start + 0.04 {
            continue;
        }

        let mut next_start_opt = None;
        for next_p in &phrases[(i + 1)..] {
            let ns = map_original_to_trimmed(next_p.start_time, &keep_intervals);
            let ne = map_original_to_trimmed(next_p.end_time, &keep_intervals);
            if ne > ns + 0.04 {
                next_start_opt = Some(ns);
                break;
            }
        }

        let mut display_end = end;
        if let Some(next_start) = next_start_opt {
            if next_start > start + 0.05 {
                display_end = display_end.max(start + 0.5).min(next_start - 0.05);
            }
        } else {
            display_end = display_end.max(start + 0.5);
        }

        if display_end > start + 0.05 {
            srt.push_str(&format!(
                "{}\n{} --> {}\n{}\n\n",
                index,
                format_srt_time(start),
                format_srt_time(display_end),
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

    let clip_filename = Path::new(input_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("clip.mov");

    let mut edl = String::new();
    edl.push_str("TITLE: SubCut Project\n");
    edl.push_str("FCM: NON-DROP FRAME\n\n");

    let fps_val = if fps > 0.0 { fps } else { 30.0 };
    let mut rec_current_frames: u64 = 0;

    for (i, &(src_in, src_out)) in keep_intervals.iter().enumerate() {
        let src_in_frames = (src_in.max(0.0) * fps_val).round() as u64;
        let src_out_frames = (src_out.max(0.0) * fps_val).round() as u64;
        let frame_count = src_out_frames.saturating_sub(src_in_frames);
        if frame_count == 0 {
            continue;
        }

        let rec_in_frames = rec_current_frames;
        let rec_out_frames = rec_in_frames + frame_count;
        rec_current_frames = rec_out_frames;

        let src_in_tc = frames_to_edl_tc(src_in_frames, fps_val);
        let src_out_tc = frames_to_edl_tc(src_out_frames, fps_val);
        let rec_in_tc = frames_to_edl_tc(rec_in_frames, fps_val);
        let rec_out_tc = frames_to_edl_tc(rec_out_frames, fps_val);

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

/// Checks if an input video has an audio stream
pub fn has_audio_stream(path: &str) -> bool {
    if let Ok(output) = new_command("ffprobe")
        .args(&[
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout.trim().to_lowercase().contains("audio")
    } else {
        false
    }
}

/// Generates an ASS subtitle file for video cover/poster with configurable styles
pub fn generate_cover_ass(
    title: &str,
    style: &str,
    output_path: &str,
) -> Result<(), String> {
    let mut ass = String::new();
    ass.push_str("[Script Info]\n");
    ass.push_str("ScriptType: v4.00+\n");
    ass.push_str("PlayResX: 1080\n");
    ass.push_str("PlayResY: 1920\n\n");

    ass.push_str("[V4+ Styles]\n");
    ass.push_str("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n");

    match style {
        "neon" => {
            // Neon style: Cyan primary (&H00FFFF00), black outline, glowing cyan shadow (&H80FFE000)
            ass.push_str("Style: Default,Arial,66,&H00FFFF00,&H00FFFFFF,&H00000000,&H80FFE000,-1,0,0,0,100,100,0,0,1,5.0,5.0,2,60,60,380,1\n\n");
        }
        "clean" => {
            // Clean white with drop shadow
            ass.push_str("Style: Default,Arial,62,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4.0,2.5,2,60,60,380,1\n\n");
        }
        _ => {
            // Hormozi Style: Bold, Amber Primary (&H0000C8FF), 6px Black Outline, Strong Shadow
            ass.push_str("Style: Default,Arial,68,&H0000C8FF,&H00FFFFFF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,1,6.0,4.0,2,60,60,380,1\n\n");
        }
    }

    ass.push_str("[Events]\n");
    ass.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    let clean_text = if style == "clean" {
        title.replace('\\', "/").replace('{', "(").replace('}', ")").replace('\n', "\\N")
    } else {
        title.to_uppercase().replace('\\', "/").replace('{', "(").replace('}', ")").replace('\n', "\\N")
    };

    ass.push_str(&format!(
        "Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,{}\n",
        clean_text
    ));

    std::fs::write(output_path, ass.as_bytes())
        .map_err(|e| format!("Не удалось создать файл субтитров для обложки: {}", e))?;

    Ok(())
}

/// Extracts a high-res cover frame at specified timestamp with optional 9:16 background blur, color presets, and title overlay
pub fn export_cover_image(
    input_path: &str,
    time: f64,
    output_path: &str,
    framing_mode: &str,
    color_preset: &str,
    title_text: Option<&str>,
    title_style: Option<&str>,
) -> Result<(), String> {
    let mut filter_complex = String::new();
    let mut cur_v = "[0:v]".to_string();

    // 1. Framing mode (9:16 with background blur vs original)
    if framing_mode == "blur_9_16" {
        filter_complex.push_str(
            "[0:v]split=2[bg_in][fg_in];\
             [bg_in]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5[bg];\
             [fg_in]scale=1080:1920:force_original_aspect_ratio=decrease[fg];\
             [bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[framedv];"
        );
        cur_v = "[framedv]".to_string();
    }

    // 2. Color Preset
    if let Some(color_f) = build_color_filter(color_preset) {
        filter_complex.push_str(&format!("{}{}[colorv];", cur_v, color_f));
        cur_v = "[colorv]".to_string();
    }

    // 3. Title overlay (if title given and style != "none")
    let has_title = title_text.map_or(false, |t| !t.trim().is_empty())
        && title_style.map_or(false, |s| s != "none");

    let temp_file_name = format!(
        "subcut_cover_{}_{}.ass",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let temp_ass_path = std::env::temp_dir().join(temp_file_name);
    let _ass_guard = TempFileGuard(&temp_ass_path);

    if has_title {
        let title = title_text.unwrap().trim();
        let style = title_style.unwrap_or("hormozi");
        let temp_ass_str = temp_ass_path.to_string_lossy().to_string();
        generate_cover_ass(title, style, &temp_ass_str)?;

        let escaped_ass = temp_ass_str
            .replace('\\', "/")
            .replace(':', "\\:")
            .replace('\'', "'\\''");
        filter_complex.push_str(&format!("{}subtitles='{}'[outv]", cur_v, escaped_ass));
    } else if !filter_complex.is_empty() {
        filter_complex.push_str(&format!("{}null[outv]", cur_v));
    }

    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-ss".to_string(),
        format!("{:.3}", time.max(0.0)),
        "-i".to_string(),
        input_path.to_string(),
    ];

    if !filter_complex.is_empty() {
        args.extend(vec![
            "-filter_complex".to_string(),
            filter_complex,
            "-map".to_string(),
            "[outv]".to_string(),
        ]);
    }

    args.extend(vec![
        "-vframes".to_string(),
        "1".to_string(),
        "-update".to_string(),
        "1".to_string(),
        "-q:v".to_string(),
        "2".to_string(),
        output_path.to_string(),
    ]);

    let output = new_command("ffmpeg")
        .args(&args)
        .output()
        .map_err(|e| format!("Ошибка запуска FFmpeg: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg завершился с ошибкой: {}", err));
    }

    Ok(())
}

/// Exports audio-only trimmed track (MP3 320 kbps) without pauses
pub fn export_audio_only(
    input_path: &str,
    cut_intervals: &[(f64, f64)],
    total_duration: f64,
    output_path: &str,
    bitrate_kbps: u32,
) -> Result<(), String> {
    if !has_audio_stream(input_path) {
        return Err("В исходном видеофайле нет аудиодорожки для экспорта".into());
    }

    let keep_intervals = calculate_keep_intervals(cut_intervals, total_duration);
    if keep_intervals.is_empty() {
        return Err("Все фрагменты аудио вырезаны".into());
    }

    let mut filter_complex = String::new();
    let mut concat_inputs = String::new();

    for (i, &(start, end)) in keep_intervals.iter().enumerate() {
        let dur = end - start;
        let fade_len = (dur * 0.10).min(0.025);
        if fade_len >= 0.005 {
            filter_complex.push_str(&format!(
                "[0:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS,afade=t=in:st=0:d={:.3},afade=t=out:st={:.3}:d={:.3}[a{}];",
                start, end, fade_len, (dur - fade_len).max(0.0), fade_len, i
            ));
        } else {
            filter_complex.push_str(&format!(
                "[0:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS[a{}];",
                start, end, i
            ));
        }
        concat_inputs.push_str(&format!("[a{}]", i));
    }

    filter_complex.push_str(&format!(
        "{}concat=n={}:v=0:a=1[outa]",
        concat_inputs,
        keep_intervals.len()
    ));

    let args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-i".to_string(),
        input_path.to_string(),
        "-filter_complex".to_string(),
        filter_complex,
        "-map".to_string(),
        "[outa]".to_string(),
        "-c:a".to_string(),
        "libmp3lame".to_string(),
        "-b:a".to_string(),
        format!("{}k", bitrate_kbps.max(64)),
        output_path.to_string(),
    ];

    let output = new_command("ffmpeg")
        .args(&args)
        .output()
        .map_err(|e| format!("Ошибка запуска FFmpeg: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg завершился с ошибкой: {}", err));
    }

    Ok(())
}

/// Cuts video without quality degradation using filter_complex concat
/// Applies audio micro-crossfades and speech edge padding (0.12s out / 0.10s in)
/// Supports GPU NVENC acceleration, vertical 9:16 background blur, visual color presets,
/// target bitrate constraints, and styled subtitle burn-in.
pub fn export_trimmed_video(
    input_path: &str,
    cut_intervals: &[(f64, f64)],
    output_path: &str,
    total_duration: f64,
    burn_subtitles: bool,
    subtitle_preset: &str,
    phrases: &[Phrase],
    hardware_accel: &str,
    framing_mode: &str,
    color_preset: &str,
    target_bitrate_kbps: Option<u32>,
) -> Result<(), String> {
    let keep_intervals = calculate_keep_intervals(cut_intervals, total_duration);

    if keep_intervals.is_empty() {
        return Err("Все фрагменты видео вырезаны".into());
    }

    let has_audio = has_audio_stream(input_path);

    // Subtitle file generation (if enabled) in temporary directory
    let temp_file_name = format!(
        "subcut_subtitles_{}_{}.ass",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let temp_ass_path = std::env::temp_dir().join(temp_file_name);
    let _ass_guard = TempFileGuard(&temp_ass_path);
    let should_burn = burn_subtitles && !phrases.is_empty();

    if should_burn {
        let temp_ass_str = temp_ass_path.to_string_lossy().to_string();
        generate_ass_subtitles(phrases, &keep_intervals, &temp_ass_str, subtitle_preset)?;
    }

    // Build filter_complex string
    let mut filter_complex = String::new();
    let mut concat_inputs = String::new();

    for (i, &(start, end)) in keep_intervals.iter().enumerate() {
        let dur = end - start;

        filter_complex.push_str(&format!(
            "[0:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS[v{}];",
            start, end, i
        ));

        if has_audio {
            let fade_len = (dur * 0.10).min(0.025); // audio fade length
            if fade_len >= 0.005 {
                filter_complex.push_str(&format!(
                    "[0:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS,afade=t=in:st=0:d={:.3},afade=t=out:st={:.3}:d={:.3}[a{}];",
                    start, end, fade_len, (dur - fade_len).max(0.0), fade_len, i
                ));
            } else {
                filter_complex.push_str(&format!(
                    "[0:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS[a{}];",
                    start, end, i
                ));
            }
            concat_inputs.push_str(&format!("[v{}][a{}]", i, i));
        } else {
            concat_inputs.push_str(&format!("[v{}]", i));
        }
    }

    let audio_param = if has_audio { "a=1" } else { "a=0" };
    let audio_out_tag = if has_audio { "[outa]" } else { "" };

    filter_complex.push_str(&format!(
        "{}concat=n={}:v=1:{}[v_concat]{};",
        concat_inputs,
        keep_intervals.len(),
        audio_param,
        audio_out_tag
    ));

    let mut cur_v = "[v_concat]".to_string();

    // 1. Framing mode (9:16 blurred background)
    if framing_mode == "blur_9_16" {
        filter_complex.push_str(&format!(
            "{cur_v}split=2[bg_in][fg_in];\
             [bg_in]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5[bg];\
             [fg_in]scale=1080:1920:force_original_aspect_ratio=decrease[fg];\
             [bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v_framed];"
        ));
        cur_v = "[v_framed]".to_string();
    }

    // 2. Visual Color preset
    if let Some(color_f) = build_color_filter(color_preset) {
        filter_complex.push_str(&format!("{cur_v}{color_f}[v_color];"));
        cur_v = "[v_color]".to_string();
    }

    // 3. Subtitles burn-in
    if should_burn {
        let temp_ass_str = temp_ass_path.to_string_lossy().to_string();
        let escaped_ass = temp_ass_str
            .replace('\\', "/")
            .replace(':', "\\:")
            .replace('\'', "'\\''");
        filter_complex.push_str(&format!("{cur_v}subtitles='{}'[outv]", escaped_ass));
    } else {
        filter_complex.push_str(&format!("{cur_v}null[outv]"));
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
    ];

    if has_audio {
        base_args.extend(vec!["-map".to_string(), "[outa]".to_string()]);
    }

    if let Some(br) = target_bitrate_kbps {
        let max_rate = (br as f64 * 1.25) as u32;
        let buf_size = br * 2;
        if use_nvenc {
            base_args.extend(vec![
                "-c:v".to_string(),
                "h264_nvenc".to_string(),
                "-preset".to_string(),
                "p4".to_string(),
                "-b:v".to_string(),
                format!("{}k", br),
                "-maxrate".to_string(),
                format!("{}k", max_rate),
                "-bufsize".to_string(),
                format!("{}k", buf_size),
            ]);
        } else {
            base_args.extend(vec![
                "-c:v".to_string(),
                "libx264".to_string(),
                "-preset".to_string(),
                "fast".to_string(),
                "-b:v".to_string(),
                format!("{}k", br),
                "-maxrate".to_string(),
                format!("{}k", max_rate),
                "-bufsize".to_string(),
                format!("{}k", buf_size),
            ]);
        }
        if has_audio {
            base_args.extend(vec![
                "-c:a".to_string(),
                "aac".to_string(),
                "-b:a".to_string(),
                "128k".to_string(),
            ]);
        }
    } else {
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
        if has_audio {
            base_args.extend(vec![
                "-c:a".to_string(),
                "aac".to_string(),
                "-b:a".to_string(),
                "192k".to_string(),
            ]);
        }
    }

    if !has_audio {
        base_args.push("-an".to_string());
    }

    base_args.push(output_path.to_string());

    let mut output = new_command("ffmpeg").args(&base_args).output();

    // If NVENC failed and auto was selected, try CPU fallback
    if use_nvenc && hardware_accel == "auto" && (output.is_err() || !output.as_ref().unwrap().status.success()) {
        let mut cpu_args = vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-i".to_string(),
            input_path.to_string(),
            "-filter_complex".to_string(),
            filter_complex,
            "-map".to_string(),
            "[outv]".to_string(),
        ];
        if has_audio {
            cpu_args.extend(vec!["-map".to_string(), "[outa]".to_string()]);
        }
        if let Some(br) = target_bitrate_kbps {
            let max_rate = (br as f64 * 1.25) as u32;
            let buf_size = br * 2;
            cpu_args.extend(vec![
                "-c:v".to_string(),
                "libx264".to_string(),
                "-preset".to_string(),
                "fast".to_string(),
                "-b:v".to_string(),
                format!("{}k", br),
                "-maxrate".to_string(),
                format!("{}k", max_rate),
                "-bufsize".to_string(),
                format!("{}k", buf_size),
            ]);
            if has_audio {
                cpu_args.extend(vec![
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "128k".to_string(),
                ]);
            }
        } else {
            cpu_args.extend(vec![
                "-c:v".to_string(),
                "libx264".to_string(),
                "-preset".to_string(),
                "fast".to_string(),
                "-crf".to_string(),
                "18".to_string(),
            ]);
            if has_audio {
                cpu_args.extend(vec![
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "192k".to_string(),
                ]);
            }
        }
        if !has_audio {
            cpu_args.push("-an".to_string());
        }
        cpu_args.push(output_path.to_string());
        output = new_command("ffmpeg").args(&cpu_args).output();
    }

    let output = output.map_err(|e| format!("Ошибка запуска FFmpeg: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg завершился с ошибкой: {}", err));
    }

    Ok(())
}

/// Locates transcribe.py in the application or source tree
pub fn get_transcribe_script_path() -> PathBuf {
    if let Ok(mut exe) = std::env::current_exe() {
        exe.pop();
        let candidate = exe.join("transcribe.py");
        if candidate.exists() {
            return candidate;
        }
        let res_candidate = exe.join("resources").join("transcribe.py");
        if res_candidate.exists() {
            return res_candidate;
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "\\transcribe.py"))
}

/// Transcribes speech using faster-whisper INT8 helper with configurable model, language, and word timestamps
pub fn transcribe_speech(path: &str, model_size: &str, language: &str) -> Result<Vec<Phrase>, String> {
    let script_path = get_transcribe_script_path();
    if !script_path.exists() {
        return Err(format!(
            "Скрипт распознавания transcribe.py не найден: {}",
            script_path.display()
        ));
    }

    let output = new_command("python")
        .env("PYTHONIOENCODING", "utf-8")
        .args(&[
            script_path.to_string_lossy().as_ref(),
            path,
            model_size,
            language,
        ])
        .output()
        .map_err(|e| format!("Не удалось запустить Python для Whisper: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();

    if !trimmed.is_empty() {
        if let Ok(phrases) = serde_json::from_str::<Vec<Phrase>>(trimmed) {
            return Ok(phrases);
        }
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Ошибка Whisper: {}", stderr.trim()));
    }

    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_keep_intervals_no_cuts() {
        let cuts: Vec<(f64, f64)> = vec![];
        let keep = calculate_keep_intervals(&cuts, 20.0);
        assert_eq!(keep.len(), 1);
        assert_eq!(keep[0], (0.0, 20.0));
    }

    #[test]
    fn test_calculate_keep_intervals_single_cut() {
        // Cut 5.0 to 10.0 in a 20s clip.
        // With PAD_OUT = 0.12, PAD_IN = 0.10:
        // eff_start = 5.12, eff_end = 9.90.
        let cuts = vec![(5.0, 10.0)];
        let keep = calculate_keep_intervals(&cuts, 20.0);
        assert_eq!(keep.len(), 2);
        assert!((keep[0].0 - 0.0).abs() < 1e-4);
        assert!((keep[0].1 - 5.12).abs() < 1e-4);
        assert!((keep[1].0 - 9.90).abs() < 1e-4);
        assert!((keep[1].1 - 20.0).abs() < 1e-4);
    }

    #[test]
    fn test_calculate_keep_intervals_overlapping_cuts() {
        // Overlapping cuts: (4.0, 8.0) and (6.0, 12.0) should merge to (4.0, 12.0)
        let cuts = vec![(4.0, 8.0), (6.0, 12.0)];
        let keep = calculate_keep_intervals(&cuts, 20.0);
        assert_eq!(keep.len(), 2);
        assert!((keep[0].1 - 4.12).abs() < 1e-4);
        assert!((keep[1].0 - 11.90).abs() < 1e-4);
    }

    #[test]
    fn test_calculate_keep_intervals_out_of_bounds_and_nan() {
        let cuts = vec![
            (-5.0, 2.0),
            (f64::NAN, 5.0),
            (10.0, 10.0), // zero length
            (15.0, 30.0), // beyond total duration 20.0
        ];
        let keep = calculate_keep_intervals(&cuts, 20.0);
        assert!(!keep.is_empty());
        for &(s, e) in &keep {
            assert!(s >= 0.0 && e <= 20.0);
            assert!(e > s);
        }
    }

    #[test]
    fn test_map_original_to_trimmed() {
        // Kept intervals: [0.0, 5.0] and [10.0, 15.0] (5.0s to 10.0s cut out)
        let keep = vec![(0.0, 5.0), (10.0, 15.0)];

        // Before cut: mapped 1:1
        assert_eq!(map_original_to_trimmed(0.0, &keep), 0.0);
        assert_eq!(map_original_to_trimmed(3.0, &keep), 3.0);
        assert_eq!(map_original_to_trimmed(5.0, &keep), 5.0);

        // Inside cut: clamped to 5.0
        assert_eq!(map_original_to_trimmed(6.0, &keep), 5.0);
        assert_eq!(map_original_to_trimmed(8.0, &keep), 5.0);
        assert_eq!(map_original_to_trimmed(10.0, &keep), 5.0);

        // After cut: shifts by duration of chunk 1 (5.0)
        assert_eq!(map_original_to_trimmed(11.0, &keep), 6.0);
        assert_eq!(map_original_to_trimmed(15.0, &keep), 10.0);
    }

    #[test]
    fn test_format_timestamps() {
        assert_eq!(format_ass_time(0.0), "0:00:00.00");
        assert_eq!(format_ass_time(65.5), "0:01:05.50");
        assert_eq!(format_ass_time(3665.25), "1:01:05.25");

        assert_eq!(format_srt_time(0.0), "00:00:00,000");
        assert_eq!(format_srt_time(65.5), "00:01:05,500");
        assert_eq!(format_srt_time(3665.25), "01:01:05,250");

        assert_eq!(seconds_to_edl_tc(0.0, 30.0), "00:00:00:00");
        assert_eq!(seconds_to_edl_tc(1.5, 30.0), "00:00:01:15");
    }

    #[test]
    fn test_export_subtitles_srt_skips_cut_phrases() {
        let temp_dir = std::env::temp_dir();
        let srt_path = temp_dir.join("test_subcut_skip.srt");
        let srt_str = srt_path.to_string_lossy().to_string();

        let phrases = vec![
            Phrase {
                id: "p1".into(),
                speaker: "S".into(),
                start_time: 1.0,
                end_time: 3.0,
                text: "Первая фраза".into(),
                words: vec![],
            },
            Phrase {
                id: "p2".into(),
                speaker: "S".into(),
                start_time: 6.0,
                end_time: 8.0,
                text: "Вырезанная фраза".into(),
                words: vec![],
            },
            Phrase {
                id: "p3".into(),
                speaker: "S".into(),
                start_time: 11.0,
                end_time: 13.0,
                text: "Третья фраза".into(),
                words: vec![],
            },
        ];

        // Cut covers 5.0 to 10.0 entirely (which contains p2)
        let cuts = vec![(5.0, 10.0)];
        export_subtitles_srt(&phrases, &cuts, 20.0, &srt_str).unwrap();

        let content = std::fs::read_to_string(&srt_path).unwrap();
        let _ = std::fs::remove_file(&srt_path);

        assert!(content.contains("Первая фраза"));
        assert!(!content.contains("Вырезанная фраза"));
        assert!(content.contains("Третья фраза"));
    }

    #[test]
    fn test_calculate_keep_intervals_boundary_cuts() {
        // Cut at start: 0.0 to 4.0. Should NOT create a 0.0..0.12 sliver.
        let cuts_start = vec![(0.0, 4.0)];
        let keep_start = calculate_keep_intervals(&cuts_start, 20.0);
        assert_eq!(keep_start.len(), 1);
        assert!((keep_start[0].0 - 3.90).abs() < 1e-4);
        assert!((keep_start[0].1 - 20.0).abs() < 1e-4);

        // Cut at end: 16.0 to 20.0. Should NOT create a 19.90..20.0 sliver.
        let cuts_end = vec![(16.0, 20.0)];
        let keep_end = calculate_keep_intervals(&cuts_end, 20.0);
        assert_eq!(keep_end.len(), 1);
        assert!((keep_end[0].0 - 0.0).abs() < 1e-4);
        assert!((keep_end[0].1 - 16.12).abs() < 1e-4);
    }

    #[test]
    fn test_format_timestamp_rollover() {
        assert_eq!(format_ass_time(59.996), "0:01:00.00");
        assert_eq!(format_srt_time(59.9996), "00:01:00,000");
        assert_eq!(format_ass_time(3599.996), "1:00:00.00");
    }

    #[test]
    fn test_export_project_edl_frame_consistency() {
        let temp_dir = std::env::temp_dir();
        let edl_path = temp_dir.join("test_subcut.edl");
        let edl_str = edl_path.to_string_lossy().to_string();

        let cuts = vec![(4.0, 8.0)];
        export_project_edl("D:\\test\\sample.mp4", &cuts, 20.0, &edl_str, 30.0).unwrap();

        let content = std::fs::read_to_string(&edl_path).unwrap();
        let _ = std::fs::remove_file(&edl_path);

        assert!(content.contains("TITLE: SubCut Project"));
        assert!(content.contains("FROM CLIP NAME: sample.mp4"));
        assert!(content.contains("001  AX       AA/V  C"));
        assert!(content.contains("002  AX       AA/V  C"));
    }

    #[test]
    fn test_generate_ass_subtitles_hormozi_karaoke() {
        let temp_dir = std::env::temp_dir();
        let ass_path = temp_dir.join("test_hormozi.ass");
        let ass_str = ass_path.to_string_lossy().to_string();

        let phrases = vec![
            Phrase {
                id: "p1".into(),
                speaker: "S".into(),
                start_time: 1.0,
                end_time: 2.5,
                text: "Привет мир".into(),
                words: vec![
                    Word { word: "Привет".into(), start_time: 1.0, end_time: 1.5 },
                    Word { word: "мир".into(), start_time: 1.6, end_time: 2.5 },
                ],
            },
        ];

        let keep = vec![(0.0, 10.0)];
        generate_ass_subtitles(&phrases, &keep, &ass_str, "hormozi").unwrap();

        let content = std::fs::read_to_string(&ass_path).unwrap();
        let _ = std::fs::remove_file(&ass_path);

        assert!(content.contains(r"{\k"));
        assert!(content.contains("ПРИВЕТ"));
        assert!(content.contains("МИР"));
    }

    #[test]
    fn test_calculate_telegram_video_bitrate() {
        // 30 second video with 46 MB target -> should be clamped to 4500 max kbps
        let br_30 = calculate_telegram_video_bitrate(30.0, 46.0);
        assert_eq!(br_30, 4500);

        // 180 second (3 min) video with 46 MB target:
        // ~2015 kbps
        let br_180 = calculate_telegram_video_bitrate(180.0, 46.0);
        assert!(br_180 > 1950 && br_180 < 2100);

        // 600 second (10 min) video with 46 MB target:
        // ~515 kbps
        let br_600 = calculate_telegram_video_bitrate(600.0, 46.0);
        assert!(br_600 > 480 && br_600 < 550);

        // Very long video -> should not drop below 300 kbps minimum
        let br_long = calculate_telegram_video_bitrate(10000.0, 46.0);
        assert_eq!(br_long, 300);
    }

    #[test]
    fn test_build_color_filter() {
        assert_eq!(
            build_color_filter("anime_punch"),
            Some("eq=saturation=1.25:contrast=1.12,unsharp=5:5:0.8:5:5:0.0")
        );
        assert_eq!(
            build_color_filter("cinematic"),
            Some("eq=contrast=1.18:brightness=-0.03:saturation=0.95")
        );
        assert_eq!(
            build_color_filter("crisp"),
            Some("unsharp=7:7:1.2:7:7:0.0")
        );
        assert_eq!(build_color_filter("none"), None);
        assert_eq!(build_color_filter("unknown"), None);
    }

    #[test]
    fn test_generate_cover_ass_styles() {
        let temp_dir = std::env::temp_dir();

        // Hormozi uppercase with amber highlight
        let p_hormozi = temp_dir.join("test_cover_hormozi.ass");
        generate_cover_ass("лучший момент", "hormozi", &p_hormozi.to_string_lossy()).unwrap();
        let c_h = std::fs::read_to_string(&p_hormozi).unwrap();
        let _ = std::fs::remove_file(&p_hormozi);
        assert!(c_h.contains("ЛУЧШИЙ МОМЕНТ"));
        assert!(c_h.contains("&H0000C8FF")); // Amber primary
        assert!(c_h.contains("&HA0000000")); // Deep shadow

        // Neon style with glowing cyan shadow
        let p_neon = temp_dir.join("test_cover_neon.ass");
        generate_cover_ass("неоновый заголовок", "neon", &p_neon.to_string_lossy()).unwrap();
        let c_n = std::fs::read_to_string(&p_neon).unwrap();
        let _ = std::fs::remove_file(&p_neon);
        assert!(c_n.contains("НЕОНОВЫЙ ЗАГОЛОВОК"));
        assert!(c_n.contains("&H00FFFF00")); // Cyan primary
        assert!(c_n.contains("&H80FFE000")); // Glowing cyan shadow

        // Clean style
        let p_clean = temp_dir.join("test_cover_clean.ass");
        generate_cover_ass("Чистый текст", "clean", &p_clean.to_string_lossy()).unwrap();
        let c_c = std::fs::read_to_string(&p_clean).unwrap();
        let _ = std::fs::remove_file(&p_clean);
        assert!(c_c.contains("Чистый текст"));
        assert!(c_c.contains("&H00FFFFFF"));
    }

    #[test]
    fn test_export_audio_only_no_audio() {
        let res = export_audio_only("non_existent_file.mp4", &[(0.0, 1.0)], 10.0, "out.mp3", 320);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("нет аудиодорожки"));
    }
}
