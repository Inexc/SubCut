import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Scissors,
  Eye,
  EyeOff,
  Download,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  FolderOpen,
  Volume2,
  Sliders,
  ZoomIn,
  ZoomOut,
  Clock,
  Sparkles,
  RotateCcw,
  Maximize2,
  Layers,
  Captions,
} from 'lucide-react'

// Data models
interface Phrase {
  id: string
  speaker: string
  startTime: number
  endTime: number
  text: string
  highlightWord?: string
}

interface SilenceGap {
  id: string
  startTime: number
  endTime: number
  duration: number
  isCut: boolean
}

type TimelineItem =
  | { type: 'phrase'; data: Phrase }
  | { type: 'silence'; data: SilenceGap }

const INITIAL_TRANSCRIPT: TimelineItem[] = [
  {
    type: 'phrase',
    data: {
      id: 'p-1',
      speaker: 'Спикер 1',
      startTime: 0.0,
      endTime: 3.45,
      text: 'Всем привет! Сегодня разберём, как быстро монтировать рилсы прямо по тексту.',
      highlightWord: 'быстро монтировать',
    },
  },
  {
    type: 'silence',
    data: {
      id: 's-1',
      startTime: 3.45,
      endTime: 4.85,
      duration: 1.4,
      isCut: false,
    },
  },
  {
    type: 'phrase',
    data: {
      id: 'p-2',
      speaker: 'Спикер 1',
      startTime: 4.85,
      endTime: 8.6,
      text: 'Обычно монтаж отнимает часы на поиск пауз и ручную нарезку дорожки.',
      highlightWord: 'отнимает часы',
    },
  },
  {
    type: 'silence',
    data: {
      id: 's-2',
      startTime: 8.6,
      endTime: 10.1,
      duration: 1.5,
      isCut: false,
    },
  },
  {
    type: 'phrase',
    data: {
      id: 'p-3',
      speaker: 'Спикер 1',
      startTime: 10.1,
      endTime: 14.3,
      text: 'SubCut автоматически находит всю тишину и вырезает её в один клик.',
      highlightWord: 'в один клик',
    },
  },
  {
    type: 'silence',
    data: {
      id: 's-3',
      startTime: 14.3,
      endTime: 16.0,
      duration: 1.7,
      isCut: false,
    },
  },
  {
    type: 'phrase',
    data: {
      id: 'p-4',
      speaker: 'Спикер 1',
      startTime: 16.0,
      endTime: 20.4,
      text: 'А динамические субтитры уже сгенерированы и готовы к публикации.',
      highlightWord: 'динамические субтитры',
    },
  },
]

// Audio waveform synthetic peaks data
const WAVEFORM_POINTS = [
  35, 45, 70, 85, 95, 80, 60, 45, 65, 80, 75, 55, 30, // phrase 1
  8, 5, 6, 8, 5,                                      // silence 1
  50, 65, 90, 85, 70, 60, 80, 95, 90, 70, 50, 40,      // phrase 2
  6, 5, 6, 7, 5,                                      // silence 2
  40, 75, 90, 100, 85, 75, 90, 80, 60, 45,            // phrase 3
  7, 5, 8, 6, 5,                                      // silence 3
  55, 70, 85, 90, 75, 80, 95, 70, 60, 40, 20,         // phrase 4
]

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 100)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(2, '0')}`
}

export default function App() {
  const [items, setItems] = useState<TimelineItem[]>(INITIAL_TRANSCRIPT)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(2.15)
  const [showPauses, setShowPauses] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [zoomLevel, setZoomLevel] = useState(100)
  const [filePath, setFilePath] = useState('reels_creator_master_01.mp4')
  const [totalVideoDuration, setTotalVideoDuration] = useState(20.4)
  const [waveformPoints, setWaveformPoints] = useState<number[]>(WAVEFORM_POINTS)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isExporting, setIsExporting] = useState(false)

  // Silence calculations
  const silences = items.filter((i): i is { type: 'silence'; data: SilenceGap } => i.type === 'silence')
  const activeSilences = silences.filter((s) => !s.data.isCut)
  const totalSilenceDuration = activeSilences.reduce((acc, s) => acc + s.data.duration, 0)

  // Actions
  const handleOpenFile = async () => {
    try {
      const selected = await invoke<string | null>('select_video_file_cmd')
      if (!selected) return

      setIsAnalyzing(true)
      setFilePath(selected)

      const dur = await invoke<number>('get_video_duration_cmd', { path: selected })
      setTotalVideoDuration(dur)

      const detected = await invoke<SilenceGap[]>('detect_silence_cmd', {
        path: selected,
        thresholdDb: -30.0,
        minDuration: 0.5,
      })

      const peaks = await invoke<number[]>('extract_waveform_cmd', {
        path: selected,
        points: 120,
      })
      if (peaks && peaks.length > 0) {
        setWaveformPoints(peaks)
      }

      const newItems: TimelineItem[] = []
      let cur = 0
      detected.forEach((gap, idx) => {
        if (gap.startTime > cur + 0.1) {
          newItems.push({
            type: 'phrase',
            data: {
              id: `p-${idx + 1}`,
              speaker: 'Спикер 1',
              startTime: cur,
              endTime: gap.startTime,
              text: `[Фрагмент речи ${idx + 1}]`,
            },
          })
        }
        newItems.push({
          type: 'silence',
          data: gap,
        })
        cur = gap.endTime
      })

      if (cur < dur - 0.1) {
        newItems.push({
          type: 'phrase',
          data: {
            id: `p-${detected.length + 1}`,
            speaker: 'Спикер 1',
            startTime: cur,
            endTime: dur,
            text: `[Фрагмент речи ${detected.length + 1}]`,
          },
        })
      }

      if (newItems.length > 0) {
        setItems(newItems)
      }
      setCurrentTime(0)
    } catch (err) {
      alert(`Ошибка анализа видео через FFmpeg: ${err}`)
    } finally {
      setIsAnalyzing(false)
    }
  }

  const handleExportVideo = async () => {
    try {
      const cuts = items
        .filter((i): i is { type: 'silence'; data: SilenceGap } => i.type === 'silence' && i.data.isCut)
        .map((s) => [s.data.startTime, s.data.endTime])

      const defaultName = filePath ? `trimmed_${filePath.split(/[\\/]/).pop()}` : 'subcut_output.mp4'
      const outputPath = await invoke<string | null>('select_output_file_cmd', { defaultName })
      if (!outputPath) return

      setIsExporting(true)
      await invoke('export_trimmed_video_cmd', {
        inputPath: filePath,
        cuts,
        outputPath,
        totalDuration: totalVideoDuration,
      })
      alert(`Видео успешно смонтировано и сохранено в:\n${outputPath}`)
    } catch (err) {
      alert(`Ошибка экспорта: ${err}`)
    } finally {
      setIsExporting(false)
    }
  }

  const handleUpdatePhraseText = (id: string, newText: string) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.type === 'phrase' && item.data.id === id) {
          return {
            ...item,
            data: { ...item.data, text: newText },
          }
        }
        return item
      })
    )
  }

  // Actions
  const togglePlay = () => setIsPlaying(!isPlaying)

  const handleSeek = (time: number) => {
    setCurrentTime(Math.max(0, Math.min(totalVideoDuration, time)))
  }

  const handleCutSingleSilence = (id: string) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.type === 'silence' && item.data.id === id) {
          return {
            ...item,
            data: { ...item.data, isCut: !item.data.isCut },
          }
        }
        return item
      })
    )
  }

  const handleCutAllSilences = () => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.type === 'silence') {
          return {
            ...item,
            data: { ...item.data, isCut: true },
          }
        }
        return item
      })
    )
  }

  const handleRestoreAllSilences = () => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.type === 'silence') {
          return {
            ...item,
            data: { ...item.data, isCut: false },
          }
        }
        return item
      })
    )
  }

  const handleJumpToNextPhrase = () => {
    const nextPhrase = items.find(
      (item): item is { type: 'phrase'; data: Phrase } =>
        item.type === 'phrase' && item.data.startTime > currentTime
    )
    if (nextPhrase) {
      setCurrentTime(nextPhrase.data.startTime)
    } else {
      setCurrentTime(0)
    }
  }

  // Find active subtitle for current time
  const currentPhrase = items.find(
    (item): item is { type: 'phrase'; data: Phrase } =>
      item.type === 'phrase' &&
      currentTime >= item.data.startTime &&
      currentTime <= item.data.endTime
  )

  const activeSubtitle = currentPhrase ? currentPhrase.data.text : '...'

  return (
    <div className="flex flex-col h-screen w-screen bg-app text-text-main font-sans select-none overflow-hidden">
      {/* =========================================================================
          1. HEADER (h-12 / 48px)
          Strictly h-8 controls, no unicode emojis, TypeUI nested radius formula.
         ========================================================================= */}
      <header className="h-12 border-b border-subtle-border bg-card px-4 flex items-center justify-between z-20 flex-shrink-0">
        {/* Left: Branding & Active File Info */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-inner-btn bg-zinc-800 border border-subtle-border flex items-center justify-center text-zinc-100 shadow-sm">
              <Scissors className="w-4 h-4 text-zinc-200" />
            </div>
            <span className="font-bold text-sm tracking-tight text-text-main">
              SubCut
            </span>
            <span className="text-2xs font-mono font-medium px-1.5 py-0.5 rounded-inner-btn bg-zinc-800 text-zinc-400 border border-subtle-border">
              v0.1
            </span>
          </div>

          <div className="h-4 w-px bg-subtle-border mx-1" />

          {/* Breadcrumb / Path */}
          <div
            onClick={handleOpenFile}
            className="flex items-center gap-1.5 text-xs text-text-muted bg-app hover:bg-card-hover cursor-pointer px-2.5 h-8 rounded-inner-btn border border-subtle-border max-w-sm transition-colors"
            title="Нажмите, чтобы открыть видеофайл через Проводник"
          >
            <FolderOpen className="w-3.5 h-3.5 text-text-dim flex-shrink-0" />
            <span className="font-mono truncate">
              {isAnalyzing ? 'Анализ FFmpeg...' : filePath.split(/[\\/]/).pop()}
            </span>
          </div>

          {/* Format Badge */}
          <div className="h-8 px-2.5 rounded-inner-btn bg-zinc-800/80 border border-subtle-border flex items-center gap-1.5 text-2xs font-mono font-medium text-zinc-300">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
            1080×1920 60fps
          </div>
        </div>

        {/* Right: Actions Row (Strictly unified h-8 height) */}
        <div className="flex items-center gap-2">
          {/* Pause visibility toggle */}
          <button
            type="button"
            onClick={() => setShowPauses(!showPauses)}
            className={`h-8 px-3 rounded-inner-btn text-xs border flex items-center gap-1.5 transition-colors ${
              showPauses
                ? 'border-subtle-border bg-card-hover text-text-main hover:border-zinc-600'
                : 'border-subtle-border bg-app text-text-muted hover:text-text-main'
            }`}
            title="Переключить отображение пауз в списке и на таймлайне"
          >
            {showPauses ? (
              <Eye className="w-3.5 h-3.5 text-zinc-300" />
            ) : (
              <EyeOff className="w-3.5 h-3.5 text-text-dim" />
            )}
            <span>Паузы: {activeSilences.length}</span>
          </button>

          {/* Batch silence cutter */}
          {activeSilences.length > 0 ? (
            <button
              type="button"
              onClick={handleCutAllSilences}
              className="h-8 px-3 rounded-inner-btn text-xs font-medium border border-red-500/50 bg-red-950/25 hover:bg-red-950/50 text-red-300 flex items-center gap-1.5 transition-all shadow-sm active:scale-[0.98]"
              title="Вырезать все обнаруженные паузы"
            >
              <Scissors className="w-3.5 h-3.5 text-red-400" />
              <span>
                Вырезать все паузы (-{totalSilenceDuration.toFixed(1)} с)
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleRestoreAllSilences}
              className="h-8 px-3 rounded-inner-btn text-xs font-medium border border-subtle-border bg-zinc-800 hover:bg-zinc-700 text-zinc-300 flex items-center gap-1.5 transition-colors"
              title="Восстановить вырезанные паузы"
            >
              <RotateCcw className="w-3.5 h-3.5 text-zinc-400" />
              <span>Восстановить паузы</span>
            </button>
          )}

          {/* Primary export button */}
          <button
            type="button"
            onClick={handleExportVideo}
            disabled={isAnalyzing || isExporting}
            className="h-8 px-3.5 rounded-inner-btn text-xs font-semibold bg-zinc-100 hover:bg-white text-zinc-950 flex items-center gap-1.5 transition-colors shadow-sm active:scale-[0.98] disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5 text-zinc-950" />
            <span>{isExporting ? 'Экспорт...' : 'Экспорт MP4'}</span>
          </button>
        </div>
      </header>

      {/* =========================================================================
          2. MAIN SPLIT (Center Area: 60% Preview / 40% Transcript)
         ========================================================================= */}
      <div className="flex-1 flex overflow-hidden">
        {/* LEFT PANE (60%): Preview Monitor with 9:16 vertical reels */}
        <section className="w-[60%] flex flex-col border-r border-subtle-border bg-app">
          {/* Top preview toolbar */}
          <div className="h-8 px-3 border-b border-subtle-border bg-card/60 flex items-center justify-between text-2xs text-text-muted">
            <div className="flex items-center gap-2">
              <span className="font-mono text-zinc-400">9:16 Вертикальный холст</span>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-400">Масштаб: По размеру окна</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">
                Safe Zones: ON
              </span>
              <button
                type="button"
                className="w-6 h-6 rounded flex items-center justify-center hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
                title="Во весь экран"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Video canvas container */}
          <div className="flex-1 relative flex items-center justify-center p-4 bg-app overflow-hidden">
            {/* 9:16 Vertical Phone/Reels Frame */}
            <div className="relative aspect-[9/16] h-full max-h-[580px] bg-black rounded-outer-box border border-subtle-border shadow-2xl overflow-hidden flex flex-col justify-between">
              {/* Background simulated video frame */}
              <div className="absolute inset-0 bg-gradient-to-b from-zinc-900 via-zinc-950 to-black flex items-center justify-center">
                {/* Visual grid / camera overlay simulation */}
                <div className="absolute inset-4 border border-dashed border-white/10 rounded pointer-events-none" />
                
                {/* Speaker avatar silhouette & waveform visualizer */}
                <div className="flex flex-col items-center gap-3 z-0 opacity-80">
                  <div className="w-20 h-20 rounded-full bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center shadow-inner">
                    <Sparkles className="w-8 h-8 text-zinc-500" />
                  </div>
                  <div className="flex items-end gap-1 h-6">
                    <span className="w-1 bg-zinc-600 rounded-full animate-pulse h-3" />
                    <span className="w-1 bg-zinc-400 rounded-full animate-pulse h-6" />
                    <span className="w-1 bg-zinc-300 rounded-full animate-pulse h-4" />
                    <span className="w-1 bg-zinc-500 rounded-full animate-pulse h-5" />
                    <span className="w-1 bg-zinc-600 rounded-full animate-pulse h-2" />
                  </div>
                </div>
              </div>

              {/* Safe zone overlay (Reels UI mock margins) */}
              <div className="relative z-10 p-3 flex justify-between items-start pointer-events-none">
                <span className="text-2xs font-mono font-medium px-1.5 py-0.5 rounded bg-black/60 text-zinc-300 backdrop-blur-sm border border-white/10">
                  REC 1080P
                </span>
                <span className="text-2xs font-mono px-1.5 py-0.5 rounded bg-black/60 text-zinc-400 backdrop-blur-sm">
                  {formatTime(currentTime)}
                </span>
              </div>

              {/* Subtitle Overlay (Reels TikTok high-contrast styled caption) */}
              <div className="relative z-10 px-4 pb-14 flex justify-center">
                <div className="max-w-[88%] bg-black/85 backdrop-blur-md px-3.5 py-2 rounded-inner-btn border border-white/15 shadow-xl text-center">
                  <p className="text-sm font-bold tracking-tight text-white drop-shadow-md">
                    {activeSubtitle}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Transport Controls Bar (Bottom of preview panel) */}
          <div className="h-12 border-t border-subtle-border bg-card px-4 flex items-center justify-between flex-shrink-0">
            {/* Timecode display */}
            <div className="flex items-center gap-1.5 font-mono text-xs">
              <span className="text-zinc-100 font-semibold">{formatTime(currentTime)}</span>
              <span className="text-zinc-600">/</span>
              <span className="text-text-muted">{formatTime(totalVideoDuration)}</span>
            </div>

            {/* Transport controls (Strictly TypeUI nested radius: container 8px -> inner buttons 4px) */}
            <div className="p-1 rounded-outer-box border border-subtle-border bg-app flex items-center gap-1 shadow-inner">
              {/* To start */}
              <button
                type="button"
                onClick={() => handleSeek(0)}
                className="h-8 px-2.5 rounded-inner-btn hover:bg-card text-text-muted hover:text-text-main flex items-center justify-center transition-colors"
                title="В начало (Home)"
              >
                <SkipBack className="w-4 h-4" />
              </button>

              {/* Play / Pause toggle */}
              <button
                type="button"
                onClick={togglePlay}
                className="h-8 px-4 rounded-inner-btn bg-zinc-100 hover:bg-white text-zinc-950 font-medium flex items-center justify-center transition-all shadow-sm active:scale-95"
                title="Воспроизведение / Пауза (Space)"
              >
                {isPlaying ? (
                  <Pause className="w-4 h-4 fill-current" />
                ) : (
                  <Play className="w-4 h-4 fill-current translate-x-0.5" />
                )}
              </button>

              {/* Next phrase */}
              <button
                type="button"
                onClick={handleJumpToNextPhrase}
                className="h-8 px-2.5 rounded-inner-btn hover:bg-card text-text-muted hover:text-text-main flex items-center justify-center transition-colors"
                title="К следующей реплике (Tab)"
              >
                <SkipForward className="w-4 h-4" />
              </button>
            </div>

            {/* Quick volume & settings */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="h-8 px-2 rounded-inner-btn border border-subtle-border bg-app hover:bg-card text-text-muted hover:text-text-main flex items-center gap-1 text-xs transition-colors"
                title="Громкость"
              >
                <Volume2 className="w-3.5 h-3.5" />
                <span className="font-mono text-2xs">100%</span>
              </button>
              <button
                type="button"
                className="h-8 px-2 rounded-inner-btn border border-subtle-border bg-app hover:bg-card text-text-muted hover:text-text-main flex items-center gap-1 text-xs transition-colors"
                title="Скорость воспроизведения"
              >
                <span className="font-mono text-2xs font-medium">1.0×</span>
              </button>
            </div>
          </div>
        </section>

        {/* RIGHT PANE (40%): Transcription Panel with Phrases & Silence Pills */}
        <section className="w-[40%] flex flex-col bg-card">
          {/* Panel Header */}
          <div className="h-10 px-4 border-b border-subtle-border bg-card flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <Captions className="w-4 h-4 text-zinc-300" />
              <h2 className="text-xs font-semibold uppercase tracking-wider text-text-main">
                Транскрипция
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-2xs text-text-dim font-mono">
                4 фразы · {activeSilences.length} пауз
              </span>
            </div>
          </div>

          {/* Quick filter input row (Strictly unified h-8 height) */}
          <div className="p-3 border-b border-subtle-border bg-app/50 flex items-center gap-2 flex-shrink-0">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Поиск по словам..."
              className="h-8 px-3 flex-1 rounded-inner-btn bg-app border border-subtle-border text-xs text-text-main placeholder-text-dim focus:outline-none focus:border-zinc-500 transition-colors"
            />
            <button
              type="button"
              className="h-8 px-2.5 rounded-inner-btn border border-subtle-border bg-app hover:bg-card text-text-muted hover:text-text-main text-xs flex items-center gap-1 transition-colors"
              title="Фильтры спикеров"
            >
              <Sliders className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Scrollable list of transcript items */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {items.map((item) => {
              if (item.type === 'phrase') {
                const isActive =
                  currentTime >= item.data.startTime &&
                  currentTime <= item.data.endTime

                return (
                  <div
                    key={item.data.id}
                    onClick={() => handleSeek(item.data.startTime)}
                    className={`rounded-outer-box border p-3 transition-all cursor-pointer ${
                      isActive
                        ? 'border-zinc-500 bg-zinc-800/60 shadow-md'
                        : 'border-subtle-border bg-app hover:border-zinc-700/80 hover:bg-app/90'
                    }`}
                  >
                    {/* Meta row */}
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-2xs font-semibold text-zinc-300 bg-zinc-800 px-2 py-0.5 rounded-inner-btn border border-subtle-border">
                          {item.data.speaker}
                        </span>
                        <span className="font-mono text-2xs text-text-dim">
                          [{formatTime(item.data.startTime)} → {formatTime(item.data.endTime)}]
                        </span>
                      </div>
                      <span className="font-mono text-2xs text-text-dim">
                        {(item.data.endTime - item.data.startTime).toFixed(2)} с
                      </span>
                    </div>

                    {/* Phrase content text with live edit */}
                    <textarea
                      rows={2}
                      value={item.data.text}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => handleUpdatePhraseText(item.data.id, e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded p-1.5 text-xs text-zinc-200 font-sans focus:outline-none focus:border-zinc-500 resize-none transition-colors"
                    />
                  </div>
                )
              }

              // Silence gap item
              if (item.type === 'silence') {
                if (!showPauses && item.data.isCut) {
                  return null
                }

                return (
                  <div
                    key={item.data.id}
                    className={`rounded-outer-box border p-2 flex items-center justify-between transition-all ${
                      item.data.isCut
                        ? 'border-zinc-800/80 bg-zinc-950/40 opacity-50'
                        : 'border-silence-border bg-silence-pattern text-red-100 shadow-sm'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-5 h-5 rounded-inner-btn flex items-center justify-center ${
                          item.data.isCut ? 'bg-zinc-800 text-zinc-500' : 'bg-red-950 text-red-400 border border-red-500/40'
                        }`}
                      >
                        <Clock className="w-3 h-3" />
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-xs font-mono font-medium ${
                            item.data.isCut ? 'text-zinc-500 line-through' : 'text-red-200'
                          }`}
                        >
                          Пауза: {item.data.duration.toFixed(2)} с
                        </span>
                        <span className="text-2xs font-mono text-zinc-500">
                          ({formatTime(item.data.startTime)} - {formatTime(item.data.endTime)})
                        </span>
                      </div>
                    </div>

                    {/* Cut / Restore button (Strictly unified h-7 or h-8 in row) */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleCutSingleSilence(item.data.id)
                      }}
                      className={`h-7 px-2.5 rounded-inner-btn text-2xs font-medium flex items-center gap-1.5 transition-colors ${
                        item.data.isCut
                          ? 'border border-subtle-border bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
                          : 'border border-red-500/60 bg-red-950 hover:bg-red-900 text-red-100'
                      }`}
                    >
                      {item.data.isCut ? (
                        <>
                          <RotateCcw className="w-3 h-3 text-zinc-400" />
                          <span>Восстановить</span>
                        </>
                      ) : (
                        <>
                          <Scissors className="w-3 h-3 text-red-400" />
                          <span>Вырезать</span>
                        </>
                      )}
                    </button>
                  </div>
                )
              }

              return null
            })}
          </div>
        </section>
      </div>

      {/* =========================================================================
          3. BOTTOM TIMELINE (Master Timeline)
          Time ruler, video clips track, audio waveform track with silence hatches,
          and a 1px playhead.
         ========================================================================= */}
      <footer className="h-52 border-t border-subtle-border bg-card flex flex-col select-none flex-shrink-0 z-20">
        {/* Timeline toolbar (Unified h-8 row controls) */}
        <div className="h-8 px-4 border-b border-subtle-border bg-card flex items-center justify-between text-xs">
          <div className="flex items-center gap-3">
            <span className="font-semibold text-2xs uppercase tracking-wider text-text-muted flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-zinc-400" />
              Мастер-Таймлайн
            </span>
            <div className="h-3 w-px bg-subtle-border" />
            <span className="text-2xs font-mono text-text-dim">
              FPS: 60 · Длина: {formatTime(totalVideoDuration)}
            </span>
          </div>

          {/* Zoom & Track settings */}
          <div className="flex items-center gap-2">
            <div className="p-0.5 rounded-outer-box border border-subtle-border bg-app flex items-center gap-1">
              <button
                type="button"
                onClick={() => setZoomLevel((z) => Math.max(50, z - 25))}
                className="w-6 h-6 rounded-inner-btn flex items-center justify-center hover:bg-card text-text-muted hover:text-text-main transition-colors"
                title="Уменьшить масштаб"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="text-2xs font-mono px-1.5 text-zinc-400">{zoomLevel}%</span>
              <button
                type="button"
                onClick={() => setZoomLevel((z) => Math.min(200, z + 25))}
                className="w-6 h-6 rounded-inner-btn flex items-center justify-center hover:bg-card text-text-muted hover:text-text-main transition-colors"
                title="Увеличить масштаб"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Master Timeline Canvas Area */}
        <div
          className="flex-1 relative flex flex-col overflow-x-auto overflow-y-hidden bg-app cursor-crosshair"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const clickX = e.clientX - rect.left
            const progress = Math.max(0, Math.min(1, clickX / rect.width))
            handleSeek(progress * totalVideoDuration)
          }}
        >
          {/* Time ruler bar */}
          <div className="h-6 border-b border-subtle-border bg-zinc-950/80 flex items-center text-2xs font-mono text-zinc-500 relative px-2">
            {[0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20].map((sec) => {
              const leftPercent = (sec / totalVideoDuration) * 100
              return (
                <div
                  key={sec}
                  className="absolute flex flex-col items-start"
                  style={{ left: `${leftPercent}%` }}
                >
                  <span className="text-[10px] text-zinc-500">
                    {String(Math.floor(sec / 60)).padStart(2, '0')}:{String(sec % 60).padStart(2, '0')}
                  </span>
                  <div className="w-px h-1.5 bg-zinc-700 mt-0.5" />
                </div>
              )
            })}
          </div>

          {/* Timeline Tracks Container */}
          <div className="flex-1 flex flex-col justify-around p-2 gap-1.5 relative">
            {/* Track 1: Video Track */}
            <div className="h-8 rounded-outer-box bg-zinc-900 border border-subtle-border relative overflow-hidden flex items-center">
              <span className="absolute left-2 text-2xs font-mono text-zinc-400 z-10 select-none">
                VIDEO 1
              </span>
              {/* Segment representation */}
              <div className="absolute inset-0 flex">
                {items
                  .filter((i) => i.type === 'phrase')
                  .map((phrase, idx) => {
                    const left = (phrase.data.startTime / totalVideoDuration) * 100
                    const width =
                      ((phrase.data.endTime - phrase.data.startTime) /
                        totalVideoDuration) *
                      100
                    return (
                      <div
                        key={phrase.data.id}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        className="absolute h-full bg-zinc-800/80 border-r border-zinc-700/50 flex items-center justify-center text-2xs text-zinc-400 truncate px-1"
                      >
                        Клип {idx + 1}
                      </div>
                    )
                  })}
              </div>
            </div>

            {/* Track 2: Audio Waveform with Silence Hatches */}
            <div className="h-14 rounded-outer-box bg-zinc-900/90 border border-subtle-border relative overflow-hidden flex items-center">
              <span className="absolute left-2 top-1 text-2xs font-mono text-zinc-400 z-10 select-none">
                AUDIO (WAVEFORM)
              </span>

              {/* Synthesized / real waveform peaks */}
              <div className="absolute inset-0 flex items-center justify-between px-3 pt-2">
                {waveformPoints.map((peak, idx) => (
                  <div
                    key={idx}
                    className="w-1 bg-zinc-500/70 rounded-full"
                    style={{ height: `${Math.max(10, peak * 0.45)}px` }}
                  />
                ))}
              </div>

              {/* Silence Hatch Overlays */}
              {silences.map((silence) => {
                const left = (silence.data.startTime / totalVideoDuration) * 100
                const width = (silence.data.duration / totalVideoDuration) * 100
                const isCut = silence.data.isCut

                return (
                  <div
                    key={silence.data.id}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    className={`absolute top-0 bottom-0 flex flex-col items-center justify-center border-l border-r transition-all ${
                      isCut
                        ? 'border-zinc-800 bg-zinc-950/80 opacity-40'
                        : 'border-silence-border bg-silence-pattern'
                    }`}
                  >
                    {!isCut && (
                      <span className="text-[10px] font-mono font-medium text-red-200 bg-red-950/90 px-1 py-0.5 rounded border border-red-500/40">
                        {silence.data.duration.toFixed(1)}s
                      </span>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Track 3: Subtitles / Captions Track */}
            <div className="h-6 rounded-outer-box bg-zinc-900/70 border border-subtle-border relative overflow-hidden flex items-center">
              <span className="absolute left-2 text-2xs font-mono text-zinc-400 z-10 select-none">
                SUBTITLES
              </span>
              <div className="absolute inset-0 flex">
                {items
                  .filter((i) => i.type === 'phrase')
                  .map((phrase) => {
                    const left = (phrase.data.startTime / totalVideoDuration) * 100
                    const width =
                      ((phrase.data.endTime - phrase.data.startTime) /
                        totalVideoDuration) *
                      100
                    return (
                      <div
                        key={phrase.data.id}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        className="absolute h-full bg-zinc-700/50 border-r border-zinc-600/40 flex items-center px-1 text-[10px] text-zinc-300 truncate"
                      >
                        {phrase.data.text}
                      </div>
                    )
                  })}
              </div>
            </div>

            {/* 1px Playhead Line with Handle */}
            <div
              className="absolute top-0 bottom-0 w-px bg-red-500 z-30 pointer-events-none transition-all duration-75"
              style={{
                left: `${(currentTime / totalVideoDuration) * 100}%`,
              }}
            >
              {/* Playhead Head Marker */}
              <div className="w-3 h-3 bg-red-500 rotate-45 -ml-1.5 -top-1.5 absolute rounded-[1px] shadow-sm" />
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
