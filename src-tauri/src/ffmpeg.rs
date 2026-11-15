use serde::{Deserialize, Serialize};
use std::process::Command;

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
pub struct Phrase {
    pub id: String,
    pub speaker: String,
    #[serde(rename = "startTime")]
    pub start_time: f64,
    #[serde(rename = "endTime")]
    pub end_time: f64,
    pub text: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
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

/// Generates an ASS subtitle file with clean TikTok/Reels style:
/// bold font, high-contrast outline, centered at the bottom third
pub fn generate_ass_subtitles(
    phrases: &[Phrase],
    keep_intervals: &[(f64, f64)],
    output_path: &str,
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
    // Style: Arial Bold 54pt, Pure White text, solid Black outline (3.5px), soft shadow, bottom-center alignment (2), 220px bottom margin
    ass.push_str("Style: Default,Arial,54,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3.5,1.5,2,40,40,220,1\n\n");

    ass.push_str("[Events]\n");
    ass.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    for p in phrases {
        let text = p.text.trim();
        if text.is_empty() {
            continue;
        }
        let start = map_time(p.start_time);
        let end = map_time(p.end_time);
        if end > start + 0.12 {
            let clean_text = text.replace('{', "(").replace('}', ")").replace('\n', "\\N");
            ass.push_str(&format!(
                "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
                format_ass_time(start),
                format_ass_time(end),
                clean_text
            ));
        }
    }

    std::fs::write(output_path, ass.as_bytes())
        .map_err(|e| format!("Не удалось создать файл субтитров: {}", e))?;

    Ok(())
}

/// Detects silence intervals using FFmpeg silencedetect audio filter
pub fn detect_silence(
    path: &str,
    threshold_db: f64,
    min_duration: f64,
) -> Result<Vec<SilenceGap>, String> {
    let filter = format!("silencedetect=noise={}dB:d={}", threshold_db, min_duration);
    let output = Command::new("ffmpeg")
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
    let output = Command::new("ffmpeg")
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
        // Scale to 0..100 with minimum floor of 4
        let scaled = ((rms / 12000.0) * 100.0).clamp(4.0, 100.0) as u8;
        peaks.push(scaled);
    }

    Ok(peaks)
}

/// Cuts video without re-encoding quality degradation using filter_complex concat
/// Applies audio micro-crossfades (25ms) and speech edge padding (0.12s out / 0.10s in)
/// Supports optional alternating Punch-In Zoom (106%) and hardcoded Subtitles burn-in.
pub fn export_trimmed_video(
    input_path: &str,
    cut_intervals: &[(f64, f64)],
    output_path: &str,
    total_duration: f64,
    punch_in_zoom: bool,
    burn_subtitles: bool,
    phrases: &[Phrase],
) -> Result<(), String> {
    // 1. Calculate keep intervals with smooth edge padding
    const PAD_OUT: f64 = 0.12; // preserve voice decay tail
    const PAD_IN: f64 = 0.10;  // preserve breath/consonant onset

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

    if keep_intervals.is_empty() {
        return Err("Все фрагменты видео вырезаны".into());
    }

    // 2. Subtitle file generation (if enabled)
    let temp_ass_path = format!("{}.temp_subtitles.ass", output_path);
    let should_burn = burn_subtitles && !phrases.is_empty();

    if should_burn {
        generate_ass_subtitles(phrases, &keep_intervals, &temp_ass_path)?;
    }

    // 3. Build filter_complex string with 25ms audio micro-fades and optional punch-in zoom
    let mut filter_complex = String::new();
    let mut concat_inputs = String::new();

    for (i, &(start, end)) in keep_intervals.iter().enumerate() {
        let dur = end - start;
        let fade_len = (dur * 0.15).min(0.025); // 25ms fade

        // Alternate zoom on odd clips (106% punch-in zoom)
        let zoom_filter = if punch_in_zoom && i % 2 == 1 {
            ",scale=ceil(iw*1.06/2)*2:ceil(ih*1.06/2)*2,crop=trunc(in_w/1.06/2)*2:trunc(in_h/1.06/2)*2,setsar=1"
        } else {
            ",setsar=1"
        };

        filter_complex.push_str(&format!(
            "[0:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS{}[v{}];",
            start, end, zoom_filter, i
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

    // 4. Execute FFmpeg
    let output = Command::new("ffmpeg")
        .args(&[
            "-y",
            "-hide_banner",
            "-i",
            input_path,
            "-filter_complex",
            &filter_complex,
            "-map",
            "[outv]",
            "-map",
            "[outa]",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            output_path,
        ])
        .output();

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

/// Transcribes speech using faster-whisper INT8 helper with configurable model
pub fn transcribe_speech(path: &str, model_size: &str) -> Result<Vec<Phrase>, String> {
    let script_path = concat!(env!("CARGO_MANIFEST_DIR"), "\\transcribe.py");
    let output = Command::new("python")
        .env("PYTHONIOENCODING", "utf-8")
        .args(&[script_path, path, model_size])
        .output()
        .map_err(|e| format!("Не удалось вызвать Whisper: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let phrases: Vec<Phrase> = serde_json::from_str(stdout.trim()).unwrap_or_default();
    Ok(phrases)
}
