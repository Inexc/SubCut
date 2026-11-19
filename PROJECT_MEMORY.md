# SubCut — Project Memory & Architecture Ledger

**Location**: `D:\GitHub\SubCut\PROJECT_MEMORY.md`  
**Version**: `0.1.0-alpha`  
**Stack**: Tauri v2 (`@tauri-apps/api`, `@tauri-apps/plugin-shell`, `tauri-plugin-dialog`, `tauri-plugin-fs`), Rust 1.80+ (MSVC), React 18, TypeScript 5.6, Vite, Tailwind CSS, Lucide React, FFmpeg (with NVENC hardware acceleration), faster-whisper INT8.  
**Repository**: [https://github.com/Inexc/SubCut.git](https://github.com/Inexc/SubCut.git) (closed commercial distribution via Telegram `@inexc` / `@inexcdemo`).

---

## 1. System Architecture & Component Mapping

### 1.1 Backend (`src-tauri/`)
- `src-tauri/src/main.rs`: Entry point initializing Tauri plugins, state, and command handlers.
- `src-tauri/src/lib.rs`: Core command routing (`export_video`, `probe_video`, `detect_silence_ai`, `export_edl`, `export_cover`, etc.).
- `src-tauri/src/ffmpeg.rs`: Robust FFmpeg pipeline handling:
  - Video probe (`ffprobe` wrapper for resolution, fps, duration, audio streams).
  - Silence detection (hybrid: dB volume threshold or Whisper word alignment).
  - Smart jump-cut concatenations with 120ms safety breathing padding and 40ms crossfade/microfade to prevent clicks.
  - Subtitle burning (ASS/SRT filter injection).
  - 9:16 vertical canvas auto-generation with blurred background (`scale=1080:1920:force_original_aspect_ratio=increase,boxblur=20:5`).
  - Audio auto-ducking for background music during voice speech.
  - NVENC hardware acceleration detection with automatic fallback to `libx264`.
- `src-tauri/Cargo.toml`: Tauri v2 configuration, serde, tokio, walkdir, tempfile. 31 unit tests passing.

### 1.2 Frontend (`src/`)
- `src/App.tsx`: Studio UI controller:
  - Timeline scrubbing and multi-track audio waveform visualization.
  - Descript-style transcript cards with word-level click scrubbing.
  - Dynamic subtitle chunking: `chunkAllWords(phrases, maxWords)` supporting 3 modes:
    - `fast`: 2–3 words per screen (viral Hormozi style).
    - `sentence`: 4–6 words per screen (Reels/Shorts standard sentence chunking).
    - `standard`: original full Whisper phrase lines.
  - 9:16 vertical video player bezel with ambient radial backdrop glow.
  - Commercial glassmorphism aesthetic (obsidian canvas `#08090d`, floating frosted glass pills, glowing gradient CTA export buttons).
- `src/index.css`: Tailwind CSS imports, obsidian color variables, custom scrollbars, and keyframe animations (`@keyframes karaoke-glow`).

---

## 2. Key Decisions & Rationale
1. **Dynamic Subtitle Density**: Direct response to user & Telegram community feedback (`Dimas Klop`). Raw Whisper output dumped 30+ word run-on paragraphs on screen. Implemented client-side smart chunking based on word-level timestamps (`start`, `end`, `word`) without needing re-transcription.
2. **UI Commercial Overhaul**: Transitioned from a prototype layout to a polished SaaS dark studio (CapCut / Linear / Submagic tier) using Obsidian glass styling, glowing active states, and mobile preview bezels.
3. **Closed Binary Model**: In accordance with user's business strategy, GitHub holds the public showcase, technical documentation, and screenshots, directing buyers to Telegram (`@inexc`). No precompiled `.exe` binaries are exposed in Git history or GitHub releases.

---

## 3. Current Verification Status
- **Rust Unit Tests**: 31 / 31 passing (`cargo test`).
- **Frontend Build**: Vite + TypeScript check passing.
- **Git State**: Clean commit sync to `origin/master` and `origin/main`.

---

## 4. Pending / Next Steps
- Finalize and verify clean binary build using MSVC linker.
- Monitor feedback from Telegram channel `@inexcdemo`.
