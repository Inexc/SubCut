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

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
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
pub fn export_trimmed_video(
    input_path: &str,
    cut_intervals: &[(f64, f64)],
    output_path: &str,
    total_duration: f64,
) -> Result<(), String> {
    // 1. Calculate keep intervals from cut intervals
    let mut keep_intervals = Vec::new();
    let mut current_pos = 0.0;

    let mut sorted_cuts = cut_intervals.to_vec();
    sorted_cuts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

    for &(cut_start, cut_end) in &sorted_cuts {
        if cut_start > current_pos + 0.05 {
            keep_intervals.push((current_pos, cut_start));
        }
        current_pos = current_pos.max(cut_end);
    }

    if current_pos < total_duration - 0.05 {
        keep_intervals.push((current_pos, total_duration));
    }

    if keep_intervals.is_empty() {
        return Err("Все фрагменты видео вырезаны".into());
    }

    // 2. Build filter_complex string
    let mut filter_complex = String::new();
    let mut concat_inputs = String::new();

    for (i, &(start, end)) in keep_intervals.iter().enumerate() {
        filter_complex.push_str(&format!(
            "[0:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS[v{}];",
            start, end, i
        ));
        filter_complex.push_str(&format!(
            "[0:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS[a{}];",
            start, end, i
        ));
        concat_inputs.push_str(&format!("[v{}][a{}]", i, i));
    }

    filter_complex.push_str(&format!(
        "{}concat=n={}:v=1:a=1[outv][outa]",
        concat_inputs,
        keep_intervals.len()
    ));

    // 3. Execute FFmpeg
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
        .output()
        .map_err(|e| format!("Ошибка выполнения FFmpeg: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg завершился с ошибкой: {}", err));
    }

    Ok(())
}
