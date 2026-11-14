import { useState, useRef, useEffect } from 'react'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
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
  RotateCcw,
  Search,
} from 'lucide-react'

interface Phrase {
  id: string
  speaker: string
  startTime: number
  endTime: number
  text: string
}

interface SilenceGap {
  id: string
  startTime: number
  endTime: number
  duration: number
  isCut: boolean
}

type ScriptItem =
  | { type: 'phrase'; data: Phrase }
  | { type: 'silence'; data: SilenceGap }

const INITIAL_SCRIPT: ScriptItem[] = [
  {
    type: 'phrase',
    data: {
      id: 'p-1',
      speaker: 'Спикер',
      startTime: 0.0,
      endTime: 3.45,
      text: 'Всем привет! Сегодня разберём, как быстро монтировать рилсы прямо по тексту.',
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
      speaker: 'Спикер',
      startTime: 4.85,
      endTime: 8.6,
      text: 'Обычно монтаж отнимает часы на поиск пауз и ручную нарезку дорожки.',
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
      speaker: 'Спикер',
      startTime: 10.1,
      endTime: 14.3,
      text: 'SubCut автоматически находит всю тишину и вырезает её в один клик.',
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
      speaker: 'Спикер',
      startTime: 16.0,
      endTime: 20.4,
      text: 'А динамические субтитры уже сгенерированы и готовы к публикации.',
    },
  },
]

// 120 dense default waveform points
const DEFAULT_WAVEFORM = Array.from({ length: 120 }, (_, i) => {
  const isPause = (i >= 20 && i <= 28) || (i >= 50 && i <= 60) || (i >= 85 && i <= 95)
  if (isPause) return 6 + (i % 3) * 2
  return 20 + Math.sin(i * 0.4) * 35 + Math.cos(i * 0.9) * 25
})

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 10)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${ms}`
}

export default function App() {
  const [items, setItems] = useState<ScriptItem[]>(INITIAL_SCRIPT)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [videoSrc, setVideoSrc] = useState<string | null>(null)
  const [totalDuration, setTotalDuration] = useState<number>(20.4)
  const [currentTime, setCurrentTime] = useState<number>(0)
  const [isPlaying, setIsPlaying] = useState<boolean>(false)
  const [showPauses, setShowPauses] = useState<boolean>(true)
  const [waveform, setWaveform] = useState<number[]>(DEFAULT_WAVEFORM)
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false)
  const [isExporting, setIsExporting] = useState<boolean>(false)
  const [searchQuery, setSearchQuery] = useState<string>('')

  const videoRef = useRef<HTMLVideoElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)

  // Derived stats
  const silences = items.filter((i): i is { type: 'silence'; data: SilenceGap } => i.type === 'silence')
  const activeCuts = silences.filter((s) => s.data.isCut)
  const cutDuration = activeCuts.reduce((acc, s) => acc + s.data.duration, 0)
  const remainingDuration = Math.max(0, totalDuration - cutDuration)

  // Find active phrase for subtitle overlay
  const activePhrase = items.find(
    (item): item is { type: 'phrase'; data: Phrase } =>
      item.type === 'phrase' &&
      currentTime >= item.data.startTime &&
      currentTime <= item.data.endTime
  )

  // Open Video File
  const handleOpenFile = async () => {
    try {
      const selected = await invoke<string | null>('select_video_file_cmd')
      if (!selected) return

      setIsAnalyzing(true)
      setFilePath(selected)
      setVideoSrc(convertFileSrc(selected))

      // 1. Get real duration
      const dur = await invoke<number>('get_video_duration_cmd', { path: selected })
      if (dur && dur > 0) {
        setTotalDuration(dur)
      }

      // 2. Detect pauses via FFmpeg
      const detectedGaps = await invoke<SilenceGap[]>('detect_silence_cmd', {
        path: selected,
        thresholdDb: -30.0,
        minDuration: 0.5,
      })

      // 3. Extract real waveform peaks
      const peaks = await invoke<number[]>('extract_waveform_cmd', {
        path: selected,
        points: 140,
      })
      if (peaks && peaks.length > 0) {
        setWaveform(peaks)
      }

      // 4. Construct script items between silences
      const newItems: ScriptItem[] = []
      let cur = 0
      detectedGaps.forEach((gap, idx) => {
        if (gap.startTime > cur + 0.1) {
          newItems.push({
            type: 'phrase',
            data: {
              id: `p-${idx + 1}`,
              speaker: 'Спикер',
              startTime: cur,
              endTime: gap.startTime,
              text: `Фрагмент ${idx + 1} речи спикера. Кликните для редактирования субтитров.`,
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
            id: `p-${detectedGaps.length + 1}`,
            speaker: 'Спикер',
            startTime: cur,
            endTime: dur,
            text: `Фрагмент ${detectedGaps.length + 1} речи спикера.`,
          },
        })
      }

      if (newItems.length > 0) {
        setItems(newItems)
      }
      seekTo(0)
    } catch (err) {
      alert(`Ошибка анализа видео: ${err}`)
    } finally {
      setIsAnalyzing(false)
    }
  }

  // Play / Pause toggle
  const togglePlay = () => {
    if (!videoRef.current) return
    if (isPlaying) {
      videoRef.current.pause()
      setIsPlaying(false)
    } else {
      videoRef.current.play().catch(console.error)
      setIsPlaying(true)
    }
  }

  // Seek video
  const seekTo = (time: number) => {
    const clamped = Math.max(0, Math.min(totalDuration, time))
    setCurrentTime(clamped)
    if (videoRef.current) {
      videoRef.current.currentTime = clamped
    }
  }

  // Real-time Auto-Skip Cut Silences during playback
  const handleTimeUpdate = () => {
    if (!videoRef.current) return
    const t = videoRef.current.currentTime
    setCurrentTime(t)

    // Check if current time falls inside a cut silence
    const currentCut = items.find(
      (item): item is { type: 'silence'; data: SilenceGap } =>
        item.type === 'silence' && item.data.isCut && t >= item.data.startTime && t < item.data.endTime
    )

    if (currentCut) {
      videoRef.current.currentTime = currentCut.data.endTime
    }
  }

  // Toggle single silence cut
  const toggleSilenceCut = (id: string) => {
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

  // Cut all silences
  const handleCutAll = () => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.type === 'silence') {
          return { ...item, data: { ...item.data, isCut: true } }
        }
        return item
      })
    )
  }

  // Restore all silences
  const handleRestoreAll = () => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.type === 'silence') {
          return { ...item, data: { ...item.data, isCut: false } }
        }
        return item
      })
    )
  }

  // Update text
  const handleTextChange = (id: string, newText: string) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.type === 'phrase' && item.data.id === id) {
          return { ...item, data: { ...item.data, text: newText } }
        }
        return item
      })
    )
  }

  // Export trimmed video
  const handleExport = async () => {
    try {
      if (!filePath) {
        alert('Сначала откройте видеофайл')
        return
      }

      const cuts = items
        .filter((i): i is { type: 'silence'; data: SilenceGap } => i.type === 'silence' && i.data.isCut)
        .map((s) => [s.data.startTime, s.data.endTime])

      const defaultName = `subcut_${filePath.split(/[\\/]/).pop()}`
      const outputPath = await invoke<string | null>('select_output_file_cmd', { defaultName })
      if (!outputPath) return

      setIsExporting(true)
      await invoke('export_trimmed_video_cmd', {
        inputPath: filePath,
        cuts,
        outputPath,
        totalDuration,
      })
      alert(`Видео успешно смонтировано:\n${outputPath}`)
    } catch (err) {
      alert(`Ошибка экспорта: ${err}`)
    } finally {
      setIsExporting(false)
    }
  }

  // Timeline click scrub
  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current) return
    const rect = timelineRef.current.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const pct = Math.max(0, Math.min(1, clickX / rect.width))
    seekTo(pct * totalDuration)
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault()
        seekTo(currentTime - 2)
      } else if (e.code === 'ArrowRight') {
        e.preventDefault()
        seekTo(currentTime + 2)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isPlaying, currentTime, totalDuration])

  const fileName = filePath ? filePath.split(/[\\/]/).pop() : 'Нажмите чтобы выбрать видео'

  return (
    <div className="flex flex-col h-screen w-screen bg-zinc-950 text-zinc-100 font-sans select-none overflow-hidden">
      
      {/* 1. TOP APP BAR: Minimal, Quiet, No Clutter (44px) */}
      <header className="h-11 px-4 border-b border-zinc-800/80 bg-zinc-900/60 flex items-center justify-between flex-shrink-0 z-20">
        
        {/* Left: Branding & Open File */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-300">
              <Scissors className="w-3.5 h-3.5" />
            </div>
            <span className="text-xs font-semibold tracking-tight text-zinc-200">SubCut</span>
          </div>

          <div className="h-3.5 w-px bg-zinc-800" />

          {/* Clickable File Selector */}
          <button
            onClick={handleOpenFile}
            disabled={isAnalyzing}
            className="flex items-center gap-2 h-7 px-2.5 rounded bg-zinc-800/60 hover:bg-zinc-800 border border-zinc-700/60 text-xs text-zinc-300 hover:text-white transition max-w-sm truncate"
            title="Выбрать другое видео"
          >
            <FolderOpen className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
            <span className="font-mono truncate">
              {isAnalyzing ? 'Анализ через FFmpeg...' : fileName}
            </span>
          </button>

          {/* Quick Metrics */}
          <div className="hidden sm:flex items-center gap-2 text-xs font-mono text-zinc-500">
            <span>{formatTime(totalDuration)}</span>
            <span>•</span>
            <span className="text-zinc-400">Пауз: {silences.length}</span>
            {cutDuration > 0 && (
              <>
                <span>•</span>
                <span className="text-emerald-400 font-medium">-{cutDuration.toFixed(1)}с</span>
              </>
            )}
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          {/* Pause Toggle */}
          <button
            onClick={() => setShowPauses(!showPauses)}
            className="h-7 px-2.5 rounded text-xs font-medium bg-zinc-800/50 hover:bg-zinc-800 border border-zinc-700/60 text-zinc-300 flex items-center gap-1.5 transition"
            title="Показать/скрыть паузы"
          >
            {showPauses ? <Eye className="w-3.5 h-3.5 text-zinc-400" /> : <EyeOff className="w-3.5 h-3.5 text-zinc-500" />}
            <span className="hidden md:inline">Паузы</span>
          </button>

          {/* Batch Cut/Restore Action */}
          {activeCuts.length === silences.length && silences.length > 0 ? (
            <button
              onClick={handleRestoreAll}
              className="h-7 px-2.5 rounded text-xs font-medium bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 flex items-center gap-1.5 transition"
            >
              <RotateCcw className="w-3 h-3 text-zinc-400" />
              <span>Восстановить паузы</span>
            </button>
          ) : (
            <button
              onClick={handleCutAll}
              className="h-7 px-2.5 rounded text-xs font-medium bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-red-300 hover:text-red-200 flex items-center gap-1.5 transition"
            >
              <Scissors className="w-3 h-3 text-red-400" />
              <span>Вырезать все паузы</span>
            </button>
          )}

          {/* Primary Export */}
          <button
            onClick={handleExport}
            disabled={isExporting || isAnalyzing}
            className="h-7 px-3 rounded text-xs font-semibold bg-zinc-100 hover:bg-white text-zinc-950 flex items-center gap-1.5 transition shadow-sm disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{isExporting ? 'Экспорт...' : 'Экспорт'}</span>
          </button>
        </div>
      </header>

      {/* 2. MAIN SPLIT: Proportional Video Left / Clean Script Right */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* LEFT PANE: Video Player Surface */}
        <section className="w-[50%] lg:w-[48%] border-r border-zinc-800/80 bg-zinc-950 flex flex-col justify-between p-4">
          
          {/* Framed Video Container (9:16 or native aspect ratio, nicely centered) */}
          <div className="relative flex-1 flex items-center justify-center min-h-0">
            <div className="relative aspect-[9/16] h-full max-h-[520px] bg-black rounded-lg border border-zinc-800/80 overflow-hidden shadow-2xl flex flex-col justify-between select-none">
              
              {/* Real Video Element or Fallback */}
              {videoSrc ? (
                <video
                  ref={videoRef}
                  src={videoSrc}
                  className="w-full h-full object-cover"
                  playsInline
                  onLoadedMetadata={(e) => {
                    const d = e.currentTarget.duration
                    if (d && !isNaN(d) && d > 0) {
                      setTotalDuration(d)
                    }
                  }}
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                />
              ) : (
                <div
                  onClick={handleOpenFile}
                  className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center cursor-pointer hover:bg-zinc-900/40 transition group"
                >
                  <div className="w-12 h-12 rounded-full bg-zinc-900 border border-zinc-800 group-hover:border-zinc-700 flex items-center justify-center text-zinc-400 mb-3 transition">
                    <FolderOpen className="w-5 h-5" />
                  </div>
                  <span className="text-xs font-medium text-zinc-300">Нажмите чтобы загрузить видео</span>
                  <span className="text-[11px] font-mono text-zinc-500 mt-1">MP4, MOV, MKV</span>
                </div>
              )}

              {/* Live Subtitle Overlay Styled Like High-Retention Reels */}
              {activePhrase && (
                <div className="absolute inset-x-0 bottom-8 px-4 text-center pointer-events-none z-10">
                  <span className="inline-block px-3 py-1.5 rounded bg-black/75 text-white font-extrabold text-sm md:text-base leading-tight tracking-wide uppercase drop-shadow-[0_2px_4px_rgba(0,0,0,0.95)]">
                    {activePhrase.data.text}
                  </span>
                </div>
              )}

              {/* Timecode badge in player corner */}
              <div className="absolute top-2.5 right-2.5 pointer-events-none z-10">
                <span className="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded bg-black/70 text-zinc-400 backdrop-blur-sm">
                  {formatTime(currentTime)}
                </span>
              </div>
            </div>
          </div>

          {/* Transport Bar (Clean, Centered, Proportional) */}
          <div className="flex items-center justify-between pt-3 mt-2 border-t border-zinc-900 text-xs">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => seekTo(0)}
                className="w-7 h-7 rounded hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200 flex items-center justify-center transition"
                title="В начало (Home)"
              >
                <SkipBack className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={togglePlay}
                className="h-7 px-3 rounded bg-zinc-100 hover:bg-white text-zinc-950 font-medium flex items-center gap-1.5 transition shadow-sm"
              >
                {isPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                <span className="text-xs">{isPlaying ? 'Пауза' : 'Старт'}</span>
              </button>
              <button
                onClick={() => seekTo(currentTime + 5)}
                className="w-7 h-7 rounded hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200 flex items-center justify-center transition"
                title="Вперёд на 5 сек"
              >
                <SkipForward className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex items-center gap-3 font-mono text-[11px]">
              <span className="text-zinc-400">
                <strong className="text-zinc-200 font-normal">{formatTime(currentTime)}</strong> / {formatTime(totalDuration)}
              </span>
              <span className="text-zinc-600">|</span>
              <span className="text-zinc-400">
                Чистое: <strong className="text-emerald-400 font-normal">{formatTime(remainingDuration)}</strong>
              </span>
            </div>
          </div>

        </section>

        {/* RIGHT PANE: Clean Narrative Script (Like Notion / Descript — Zero Card Clutter!) */}
        <section className="flex-1 bg-zinc-900/40 flex flex-col justify-between overflow-hidden">
          
          {/* Header & Search */}
          <div className="h-10 px-4 border-b border-zinc-800/80 bg-zinc-900/60 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                Скрипт и редакция текста
              </span>
            </div>
            
            <div className="relative w-48">
              <Search className="w-3 h-3 absolute left-2 top-2 text-zinc-500" />
              <input
                type="text"
                placeholder="Поиск слова..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-7 pl-6 pr-2 rounded bg-zinc-950/80 border border-zinc-800 text-[11px] text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700"
              />
            </div>
          </div>

          {/* Script Body (Clean Typography, Natural Text Flow) */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            
            <div className="text-xs text-zinc-500 font-mono mb-2">
              Кликните по любому слову чтобы перейти в плеере. Паузы тишины встроены в текст.
            </div>

            {items.map((item) => {
              if (item.type === 'phrase') {
                const isActive = currentTime >= item.data.startTime && currentTime <= item.data.endTime
                
                return (
                  <div
                    key={item.data.id}
                    className={`group transition-all rounded p-2 -mx-2 ${
                      isActive ? 'bg-zinc-800/40 ring-1 ring-zinc-700' : 'hover:bg-zinc-900/40'
                    }`}
                  >
                    {/* Timecode badge */}
                    <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-500 mb-1">
                      <span
                        onClick={() => seekTo(item.data.startTime)}
                        className="cursor-pointer hover:text-zinc-300 hover:underline"
                      >
                        {formatTime(item.data.startTime)} — {formatTime(item.data.endTime)}
                      </span>
                    </div>

                    {/* Clean Editable Text Paragraph */}
                    <textarea
                      rows={2}
                      value={item.data.text}
                      onChange={(e) => handleTextChange(item.data.id, e.target.value)}
                      className="w-full bg-transparent text-sm leading-relaxed text-zinc-200 font-sans resize-none focus:outline-none focus:bg-zinc-950 focus:p-1.5 focus:rounded border border-transparent focus:border-zinc-700 transition-all"
                    />
                  </div>
                )
              }

              // Silence Item — Rendered as a Clean Minimal Inline Pill, NOT a Giant Red Box!
              if (item.type === 'silence') {
                if (!showPauses && item.data.isCut) return null

                return (
                  <div key={item.data.id} className="py-1 flex items-center gap-2">
                    <span
                      onClick={() => toggleSilenceCut(item.data.id)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono cursor-pointer transition select-none ${
                        item.data.isCut
                          ? 'bg-zinc-900 text-zinc-500 line-through border border-zinc-800 hover:bg-zinc-850'
                          : 'bg-red-950/40 text-red-300 border border-red-900/60 hover:bg-red-900/40'
                      }`}
                      title="Кликните чтобы вырезать или оставить паузу"
                    >
                      <span>⏸ Пауза {item.data.duration.toFixed(1)}с</span>
                      <span className="text-[10px] font-sans font-medium px-1 rounded bg-black/40">
                        {item.data.isCut ? 'вырезано' : 'вырезать ✂'}
                      </span>
                    </span>
                  </div>
                )
              }

              return null
            })}

          </div>

        </section>

      </div>

      {/* 3. BOTTOM TIMELINE: Single Continuous Pro Track (Height 100px) */}
      <footer className="h-28 border-t border-zinc-800/80 bg-zinc-900/80 flex flex-col justify-between select-none flex-shrink-0 z-20">
        
        {/* Time ruler ticks */}
        <div className="h-5 px-3 flex justify-between items-center text-[10px] font-mono text-zinc-500 border-b border-zinc-800/40">
          <span>00:00</span>
          <span>00:05</span>
          <span>00:10</span>
          <span>00:15</span>
          <span>{formatTime(totalDuration)}</span>
        </div>

        {/* Master Audio Track Canvas */}
        <div
          ref={timelineRef}
          onClick={handleTimelineClick}
          className="relative flex-1 bg-zinc-950 cursor-pointer overflow-hidden flex items-center"
        >
          {/* Continuous Dense Waveform Bars */}
          <div className="absolute inset-0 flex items-center justify-between px-2 pointer-events-none">
            {waveform.map((peak, idx) => (
              <div
                key={idx}
                className="w-[2px] bg-zinc-400 rounded-full transition-all"
                style={{ height: `${Math.max(8, peak * 0.7)}%` }}
              />
            ))}
          </div>

          {/* Silence Overlay Zones on the Waveform */}
          {silences.map((silence) => {
            const left = (silence.data.startTime / totalDuration) * 100
            const width = (silence.data.duration / totalDuration) * 100
            const isCut = silence.data.isCut

            return (
              <div
                key={silence.data.id}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleSilenceCut(silence.data.id)
                }}
                style={{ left: `${left}%`, width: `${width}%` }}
                className={`absolute top-0 bottom-0 flex items-center justify-center transition-all ${
                  isCut
                    ? 'bg-zinc-950/85 border-x border-zinc-800 opacity-60'
                    : 'bg-red-950/35 border-x border-red-700/80 hover:bg-red-950/50'
                }`}
                title={`Пауза: ${silence.data.duration.toFixed(1)}с. Кликните чтобы вырезать`}
              >
                <span
                  className={`text-[9px] font-mono px-1 py-0.5 rounded shadow-sm ${
                    isCut
                      ? 'bg-zinc-900 text-zinc-500 line-through'
                      : 'bg-red-950 text-red-300 border border-red-800/80'
                  }`}
                >
                  {isCut ? '✂' : `${silence.data.duration.toFixed(1)}с`}
                </span>
              </div>
            )
          })}

          {/* Precision 1px Red Playhead Needle */}
          <div
            className="absolute top-0 bottom-0 w-px bg-red-500 z-30 pointer-events-none transition-all duration-75"
            style={{ left: `${(currentTime / totalDuration) * 100}%` }}
          >
            <div className="w-2.5 h-2.5 bg-red-500 rotate-45 -ml-[4px] -top-1 absolute shadow-sm" />
          </div>
        </div>

        {/* Timeline Bottom Legend */}
        <div className="h-6 px-4 bg-zinc-900 border-t border-zinc-800/50 flex items-center justify-between text-[10px] font-mono text-zinc-500">
          <div className="flex items-center gap-3">
            <span>Клик по таймлайну: переместить курсор</span>
            <span>•</span>
            <span>Пробел: Старт/Пауза</span>
          </div>
          <div>
            <span>FFmpeg: silencedetect=-30dB</span>
          </div>
        </div>

      </footer>

    </div>
  )
}
