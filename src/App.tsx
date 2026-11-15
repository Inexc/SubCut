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
  SlidersHorizontal,
  Sparkles,
  Type,
  X,
  RefreshCw,
  FileText,
  Clapperboard,
  Zap,
  Globe,
} from 'lucide-react'

interface Word {
  word: string
  startTime: number
  endTime: number
}

interface Phrase {
  id: string
  speaker: string
  startTime: number
  endTime: number
  text: string
  words?: Word[]
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
      text: 'Привет! В этом видео покажем монтаж речи прямо по тексту.',
      words: [
        { word: 'Привет!', startTime: 0.0, endTime: 0.5 },
        { word: 'В', startTime: 0.5, endTime: 0.7 },
        { word: 'этом', startTime: 0.7, endTime: 1.0 },
        { word: 'видео', startTime: 1.0, endTime: 1.4 },
        { word: 'покажем', startTime: 1.4, endTime: 1.9 },
        { word: 'монтаж', startTime: 1.9, endTime: 2.4 },
        { word: 'речи', startTime: 2.4, endTime: 2.8 },
        { word: 'по тексту.', startTime: 2.8, endTime: 3.45 },
      ],
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
      text: 'Не нужно вручную резать таймлайн и искать паузы между словами.',
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
      text: 'SubCut находит тишину и удаляет лишнее.',
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
      text: 'Субтитры готовы — остаётся проверить результат.',
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
  if (!seconds || isNaN(seconds) || seconds < 0) return '00:00.0'
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
  const [analyzingStatus, setAnalyzingStatus] = useState<string>('')
  const [isExporting, setIsExporting] = useState<boolean>(false)
  const [searchQuery, setSearchQuery] = useState<string>('')

  // Settings State
  const [silenceThreshold, setSilenceThreshold] = useState<number>(-30.0)
  const [minSilenceDuration, setMinSilenceDuration] = useState<number>(0.5)
  const [pauseMode, setPauseMode] = useState<'smart' | 'volume'>('smart')
  const [whisperModel, setWhisperModel] = useState<string>('base')
  const [speechLanguage, setSpeechLanguage] = useState<string>('ru')
  const [burnSubtitles, setBurnSubtitles] = useState<boolean>(true)
  const [subtitlePreset, setSubtitlePreset] = useState<'hormozi' | 'classic' | 'box'>('hormozi')
  const [hardwareAccel, setHardwareAccel] = useState<'auto' | 'nvenc' | 'cpu'>('auto')
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false)
  const [isExportMenuOpen, setIsExportMenuOpen] = useState<boolean>(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const isSkippingRef = useRef<boolean>(false)
  const lastSkippedIdRef = useRef<string | null>(null)

  // Derived stats
  const silences = items.filter((i): i is { type: 'silence'; data: SilenceGap } => i.type === 'silence')
  const activeCuts = silences.filter((s) => s.data.isCut)
  const cutDuration = activeCuts.reduce((acc, s) => acc + s.data.duration, 0)
  const remainingDuration = Math.max(0, totalDuration - cutDuration)

  // Active phrase calculation
  const phraseList = items.filter((i): i is { type: 'phrase'; data: Phrase } => i.type === 'phrase')
  const activePhraseIndex = phraseList.findIndex((p, idx) => {
    const nextPhrase = phraseList[idx + 1]
    const maxEnd = nextPhrase ? Math.min(p.data.endTime + 0.35, nextPhrase.data.startTime) : p.data.endTime + 0.35
    return currentTime >= p.data.startTime && currentTime <= maxEnd
  })
  const activePhrase = activePhraseIndex >= 0 ? phraseList[activePhraseIndex] : null

  // Calculate pause gaps directly from speech timestamps
  const calculateSpeechGaps = (
    phrasesList: Phrase[],
    videoDuration: number,
    minDuration: number
  ): SilenceGap[] => {
    const gaps: SilenceGap[] = []
    let lastEnd = 0.0
    let idx = 1

    const sorted = [...phrasesList].sort((a, b) => a.startTime - b.startTime)

    for (const p of sorted) {
      const gapDuration = p.startTime - lastEnd
      if (gapDuration >= minDuration) {
        gaps.push({
          id: `silence-${idx++}`,
          startTime: Number(lastEnd.toFixed(2)),
          endTime: Number(p.startTime.toFixed(2)),
          duration: Number(gapDuration.toFixed(2)),
          isCut: false,
        })
      }
      lastEnd = Math.max(lastEnd, p.endTime)
    }

    if (videoDuration - lastEnd >= minDuration) {
      const endGap = videoDuration - lastEnd
      gaps.push({
        id: `silence-${idx++}`,
        startTime: Number(lastEnd.toFixed(2)),
        endTime: Number(videoDuration.toFixed(2)),
        duration: Number(endGap.toFixed(2)),
        isCut: false,
      })
    }

    return gaps
  }

  // Open Video File
  const handleOpenFile = async () => {
    try {
      const selected = await invoke<string | null>('select_video_file_cmd')
      if (!selected) return

      setIsAnalyzing(true)
      setFilePath(selected)
      setVideoSrc(convertFileSrc(selected))

      // 1. Get real duration
      setAnalyzingStatus('Чтение видео...')
      let dur = 0
      try {
        dur = await invoke<number>('get_video_duration_cmd', { path: selected })
      } catch (err) {
        console.warn('Duration probe warning:', err)
      }
      if (dur && dur > 0) {
        setTotalDuration(dur)
      }

      // 2. Detect pauses via FFmpeg
      setAnalyzingStatus('Поиск пауз...')
      let detectedGaps: SilenceGap[] = []
      try {
        detectedGaps = await invoke<SilenceGap[]>('detect_silence_cmd', {
          path: selected,
          thresholdDb: silenceThreshold,
          minDuration: minSilenceDuration,
        })
      } catch (err) {
        console.warn('Silence detect warning:', err)
      }

      // 3. Extract real waveform peaks
      setAnalyzingStatus('Построение аудиоволны...')
      try {
        const peaks = await invoke<number[]>('extract_waveform_cmd', {
          path: selected,
          points: 140,
        })
        if (peaks && peaks.length > 0) {
          setWaveform(peaks)
        }
      } catch (err) {
        console.warn('Waveform extract warning:', err)
      }

      // 4. Transcribe speech using Whisper AI
      setAnalyzingStatus('Распознавание речи...')
      let phrases: Phrase[] = []
      try {
        phrases = await invoke<Phrase[]>('transcribe_speech_cmd', {
          path: selected,
          modelSize: whisperModel,
          language: speechLanguage,
        })
      } catch (wErr) {
        console.warn('Whisper transcription warning:', wErr)
      }

      const effectiveDuration = dur > 0 ? dur : totalDuration

      let finalGaps = detectedGaps
      if (pauseMode === 'smart' && phrases.length > 0) {
        finalGaps = calculateSpeechGaps(phrases, effectiveDuration, minSilenceDuration)
      } else if (finalGaps.length === 0 && phrases.length > 0) {
        finalGaps = calculateSpeechGaps(phrases, effectiveDuration, minSilenceDuration)
      }

      const allEvents: { time: number; item: ScriptItem }[] = []

      finalGaps.forEach((gap) => {
        allEvents.push({ time: gap.startTime, item: { type: 'silence', data: gap } })
      })

      if (phrases && phrases.length > 0) {
        phrases.forEach((phrase) => {
          allEvents.push({ time: phrase.startTime, item: { type: 'phrase', data: phrase } })
        })
      } else {
        let cur = 0
        finalGaps.forEach((gap, idx) => {
          if (gap.startTime > cur + 0.1) {
            allEvents.push({
              time: cur,
              item: {
                type: 'phrase',
                data: {
                  id: `p-${idx + 1}`,
                  speaker: 'Спикер',
                  startTime: cur,
                  endTime: gap.startTime,
                  text: `Речь (${formatTime(cur)} — ${formatTime(gap.startTime)})`,
                },
              },
            })
          }
          cur = gap.endTime
        })
        if (cur < effectiveDuration - 0.1) {
          allEvents.push({
            time: cur,
            item: {
              type: 'phrase',
              data: {
                id: `p-${finalGaps.length + 1}`,
                speaker: 'Спикер',
                startTime: cur,
                endTime: effectiveDuration,
                text: `Речь (${formatTime(cur)} — ${formatTime(effectiveDuration)})`,
              },
            },
          })
        }
      }

      allEvents.sort((a, b) => a.time - b.time)
      if (allEvents.length > 0) {
        setItems(allEvents.map((e) => e.item))
      }
      seekTo(0)
    } catch (err) {
      alert(`Ошибка открытия файла: ${err}`)
    } finally {
      setIsAnalyzing(false)
      setAnalyzingStatus('')
    }
  }

  // Recalculate silences when threshold or min duration changed
  const handleRecalculateSilences = async () => {
    if (!filePath) return
    try {
      setIsAnalyzing(true)
      setAnalyzingStatus('Обновление пауз...')

      const currentPhrases = items
        .filter((i): i is { type: 'phrase'; data: Phrase } => i.type === 'phrase')
        .map((p) => p.data)

      let finalGaps: SilenceGap[] = []
      if (pauseMode === 'smart' && currentPhrases.length > 0) {
        finalGaps = calculateSpeechGaps(currentPhrases, totalDuration, minSilenceDuration)
      } else {
        const detectedGaps = await invoke<SilenceGap[]>('detect_silence_cmd', {
          path: filePath,
          thresholdDb: silenceThreshold,
          minDuration: minSilenceDuration,
        })
        if (detectedGaps.length === 0 && currentPhrases.length > 0) {
          finalGaps = calculateSpeechGaps(currentPhrases, totalDuration, minSilenceDuration)
        } else {
          finalGaps = detectedGaps
        }
      }

      const allEvents: { time: number; item: ScriptItem }[] = []
      finalGaps.forEach((gap) => {
        allEvents.push({ time: gap.startTime, item: { type: 'silence', data: gap } })
      })

      if (currentPhrases.length > 0) {
        currentPhrases.forEach((phrase) => {
          allEvents.push({ time: phrase.startTime, item: { type: 'phrase', data: phrase } })
        })
      }

      allEvents.sort((a, b) => a.time - b.time)
      if (allEvents.length > 0) {
        setItems(allEvents.map((e) => e.item))
      }
    } catch (err) {
      alert(`Не удалось обновить паузы: ${err}`)
    } finally {
      setIsAnalyzing(false)
      setAnalyzingStatus('')
    }
  }

  // Re-transcribe speech with selected model and language
  const handleRetranscribeSpeech = async () => {
    if (!filePath) return
    try {
      setIsAnalyzing(true)
      setAnalyzingStatus('Распознавание речи...')
      const phrases = await invoke<Phrase[]>('transcribe_speech_cmd', {
        path: filePath,
        modelSize: whisperModel,
        language: speechLanguage,
      })

      let finalGaps: SilenceGap[] = []
      if (pauseMode === 'smart' && phrases.length > 0) {
        finalGaps = calculateSpeechGaps(phrases, totalDuration, minSilenceDuration)
      } else {
        const currentSilences = items
          .filter((i): i is { type: 'silence'; data: SilenceGap } => i.type === 'silence')
          .map((s) => s.data)
        if (currentSilences.length === 0 && phrases.length > 0) {
          finalGaps = calculateSpeechGaps(phrases, totalDuration, minSilenceDuration)
        } else {
          finalGaps = currentSilences
        }
      }

      const allEvents: { time: number; item: ScriptItem }[] = []
      finalGaps.forEach((gap) => {
        allEvents.push({ time: gap.startTime, item: { type: 'silence', data: gap } })
      })

      if (phrases && phrases.length > 0) {
        phrases.forEach((phrase) => {
          allEvents.push({ time: phrase.startTime, item: { type: 'phrase', data: phrase } })
        })
      }

      allEvents.sort((a, b) => a.time - b.time)
      if (allEvents.length > 0) {
        setItems(allEvents.map((e) => e.item))
      }
    } catch (err) {
      alert(`Не удалось распознать речь: ${err}`)
    } finally {
      setIsAnalyzing(false)
      setAnalyzingStatus('')
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
    const clamped = Math.max(0, Math.min(totalDuration || 0, time))
    setCurrentTime(clamped)
    lastSkippedIdRef.current = null
    isSkippingRef.current = false
    if (videoRef.current) {
      videoRef.current.currentTime = clamped
    }
  }

  // Real-time Auto-Skip Cut Silences during playback
  const handleTimeUpdate = () => {
    if (!videoRef.current) return
    const t = videoRef.current.currentTime
    setCurrentTime(t)

    if (videoRef.current.seeking || isSkippingRef.current) return

    const PAD_OUT = 0.12 // 120ms natural voice decay tail
    const PAD_IN = 0.10  // 100ms natural voice onset

    const currentCut = items.find(
      (item): item is { type: 'silence'; data: SilenceGap } => {
        if (item.type !== 'silence' || !item.data.isCut) return false
        const effStart = item.data.startTime <= 0.05 ? 0.0 : item.data.startTime + PAD_OUT
        const effEnd = item.data.endTime >= totalDuration - 0.05 ? totalDuration : item.data.endTime - PAD_IN
        return effEnd > effStart + 0.04 && t >= effStart && t < effEnd
      }
    )

    if (currentCut) {
      if (lastSkippedIdRef.current !== currentCut.data.id) {
        isSkippingRef.current = true
        lastSkippedIdRef.current = currentCut.data.id

        const effEnd = currentCut.data.endTime >= totalDuration - 0.05
          ? totalDuration
          : currentCut.data.endTime - PAD_IN
        const targetTime = Math.min(totalDuration, effEnd + 0.01)

        if (targetTime >= totalDuration) {
          videoRef.current.currentTime = totalDuration
          videoRef.current.pause()
          setIsPlaying(false)
          isSkippingRef.current = false
        } else {
          videoRef.current.currentTime = targetTime
          setTimeout(() => {
            isSkippingRef.current = false
          }, 40)
        }
      }
    } else {
      lastSkippedIdRef.current = null
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

  // Update text and keep word-level synchronization aligned
  const handleTextChange = (id: string, newText: string) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.type === 'phrase' && item.data.id === id) {
          const rawWords = newText.trim().split(/\s+/).filter(Boolean)
          let updatedWords = item.data.words ? [...item.data.words] : []

          if (rawWords.length === 0) {
            updatedWords = []
          } else if (updatedWords.length === rawWords.length) {
            // Update words in-place preserving exact speech timestamps
            updatedWords = updatedWords.map((w, idx) => ({
              ...w,
              word: rawWords[idx],
            }))
          } else {
            // Re-distribute timestamps across newly edited words
            const span = Math.max(0.05, item.data.endTime - item.data.startTime)
            const count = rawWords.length
            updatedWords = rawWords.map((w, idx) => ({
              word: w,
              startTime: Number((item.data.startTime + (idx / count) * span).toFixed(2)),
              endTime: Number((item.data.startTime + ((idx + 1) / count) * span).toFixed(2)),
            }))
          }

          return {
            ...item,
            data: {
              ...item.data,
              text: newText,
              words: updatedWords,
            },
          }
        }
        return item
      })
    )
  }

  // Export 1: Trimmed MP4 video
  const handleExportMP4 = async () => {
    try {
      if (!filePath) {
        alert('Сначала выберите видеофайл')
        return
      }

      const cuts = items
        .filter((i): i is { type: 'silence'; data: SilenceGap } => i.type === 'silence' && i.data.isCut)
        .map((s) => [s.data.startTime, s.data.endTime])
        .filter(([start, end]) => end > start)

      const phrasesToExport = items
        .filter((i): i is { type: 'phrase'; data: Phrase } => i.type === 'phrase')
        .map((p) => p.data)

      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, '') || 'cut'
      const defaultName = `${baseName}_cut.mp4`

      const outputPath = await invoke<string | null>('select_save_file_cmd', {
        title: 'Сохранить видео',
        filter: 'MP4 Видео (*.mp4)|*.mp4',
        defaultName,
      })
      if (!outputPath) return

      setIsExporting(true)
      setIsExportMenuOpen(false)
      await invoke('export_trimmed_video_cmd', {
        inputPath: filePath,
        cuts,
        outputPath,
        totalDuration,
        burnSubtitles,
        subtitlePreset,
        phrases: phrasesToExport,
        hardwareAccel,
      })
      alert(`Видео сохранено:\n${outputPath}`)
    } catch (err) {
      alert(`Ошибка экспорта: ${err}`)
    } finally {
      setIsExporting(false)
    }
  }

  // Export 2: Standalone .SRT subtitles
  const handleExportSRT = async () => {
    try {
      if (!filePath) {
        alert('Сначала выберите видеофайл')
        return
      }

      const cuts = items
        .filter((i): i is { type: 'silence'; data: SilenceGap } => i.type === 'silence' && i.data.isCut)
        .map((s) => [s.data.startTime, s.data.endTime])
        .filter(([start, end]) => end > start)

      const phrasesToExport = items
        .filter((i): i is { type: 'phrase'; data: Phrase } => i.type === 'phrase')
        .map((p) => p.data)

      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, '') || 'subcut'
      const defaultName = `${baseName}_subtitles.srt`

      const outputPath = await invoke<string | null>('select_save_file_cmd', {
        title: 'Сохранить субтитры .SRT',
        filter: 'SRT Субтитры (*.srt)|*.srt',
        defaultName,
      })
      if (!outputPath) return

      setIsExportMenuOpen(false)
      await invoke('export_subtitles_srt_cmd', {
        outputPath,
        cuts,
        totalDuration,
        phrases: phrasesToExport,
      })
      alert(`Субтитры сохранены:\n${outputPath}`)
    } catch (err) {
      alert(`Ошибка экспорта субтитров: ${err}`)
    }
  }

  // Export 3: EDL Project for Premiere Pro / DaVinci Resolve
  const handleExportEDL = async () => {
    try {
      if (!filePath) {
        alert('Сначала выберите видеофайл')
        return
      }

      const cuts = items
        .filter((i): i is { type: 'silence'; data: SilenceGap } => i.type === 'silence' && i.data.isCut)
        .map((s) => [s.data.startTime, s.data.endTime])
        .filter(([start, end]) => end > start)

      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, '') || 'subcut'
      const defaultName = `${baseName}_project.edl`

      const outputPath = await invoke<string | null>('select_save_file_cmd', {
        title: 'Экспорт проекта EDL',
        filter: 'CMX 3600 EDL (*.edl)|*.edl',
        defaultName,
      })
      if (!outputPath) return

      setIsExportMenuOpen(false)
      await invoke('export_project_edl_cmd', {
        outputPath,
        inputPath: filePath,
        cuts,
        totalDuration,
        fps: 30.0,
      })
      alert(
        `Проект EDL экспортирован:\n${outputPath}\n\nИмпорт в Premiere Pro или DaVinci Resolve:\nFile → Import → Timeline`
      )
    } catch (err) {
      alert(`Ошибка экспорта EDL: ${err}`)
    }
  }

  // Timeline click scrub
  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || totalDuration <= 0) return
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

  const fileName = filePath ? filePath.split(/[\\/]/).pop() : 'Выберите видео'

  return (
    <div className="flex flex-col h-screen w-screen bg-zinc-950 text-zinc-100 font-sans select-none overflow-hidden">
      
      {/* 1. TOP APP BAR (44px) */}
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
            title="Выбрать видео"
          >
            <FolderOpen className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
            <span className="font-mono truncate">
              {isAnalyzing ? (analyzingStatus || 'Анализ видео...') : fileName}
            </span>
          </button>

          {/* Quick Metrics */}
          <div className="hidden sm:flex items-center gap-2 text-xs font-mono text-zinc-500">
            <span>{formatTime(totalDuration)}</span>
            <span>•</span>
            <span className="text-zinc-400">Паузы: {silences.length}</span>
            {cutDuration > 0 && (
              <>
                <span>•</span>
                <span className="text-emerald-400 font-medium">-{cutDuration.toFixed(1)} с</span>
              </>
            )}
          </div>
        </div>

        {/* Right: Actions & Subtitle Preset / Settings */}
        <div className="flex items-center gap-2">
          
          {/* Subtitles Quick Toggle */}
          <button
            onClick={() => setBurnSubtitles(!burnSubtitles)}
            className={`h-7 px-2.5 rounded text-xs font-medium border flex items-center gap-1.5 transition ${
              burnSubtitles
                ? 'bg-zinc-800 text-zinc-200 border-zinc-600'
                : 'bg-zinc-900/60 text-zinc-500 border-zinc-800 hover:text-zinc-300'
            }`}
            title="Субтитры"
          >
            <Type className="w-3.5 h-3.5" />
            <span className="hidden lg:inline">Субтитры</span>
            {burnSubtitles && (
              <span className="text-[10px] font-mono px-1 py-0.2 rounded bg-zinc-700 text-amber-300 uppercase">
                {subtitlePreset}
              </span>
            )}
          </button>

          {/* Settings Modal Button */}
          <button
            onClick={() => setIsSettingsOpen(!isSettingsOpen)}
            className={`h-7 px-2.5 rounded text-xs font-medium border flex items-center gap-1.5 transition ${
              isSettingsOpen
                ? 'bg-zinc-700 text-white border-zinc-500'
                : 'bg-zinc-800/50 hover:bg-zinc-800 text-zinc-300 border-zinc-700/60'
            }`}
            title="Настройки монтажа и субтитров"
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-400" />
            <span className="hidden md:inline">Настройки</span>
          </button>

          <div className="h-3.5 w-px bg-zinc-800" />

          {/* Pause Visibility Toggle */}
          <button
            onClick={() => setShowPauses(!showPauses)}
            className="h-7 px-2.5 rounded text-xs font-medium bg-zinc-800/50 hover:bg-zinc-800 border border-zinc-700/60 text-zinc-300 flex items-center gap-1.5 transition"
            title="Показать или скрыть паузы в тексте"
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
              <span>Восстановить</span>
            </button>
          ) : (
            <button
              onClick={handleCutAll}
              className="h-7 px-2.5 rounded text-xs font-medium bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-red-300 hover:text-red-200 flex items-center gap-1.5 transition"
            >
              <Scissors className="w-3 h-3 text-red-400" />
              <span>Вырезать все</span>
            </button>
          )}

          {/* Export Dropdown */}
          <div className="relative">
            <button
              onClick={() => setIsExportMenuOpen(!isExportMenuOpen)}
              disabled={isExporting || isAnalyzing}
              className="h-7 px-3 rounded text-xs font-semibold bg-zinc-100 hover:bg-white text-zinc-950 flex items-center gap-1.5 transition shadow-sm disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isExporting ? 'Экспорт...' : 'Экспорт'}</span>
            </button>

            {/* Export Menu Dropdown */}
            {isExportMenuOpen && (
              <div className="absolute right-0 top-8 w-56 bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl py-1.5 z-40 text-xs animate-in fade-in duration-100">
                <button
                  onClick={handleExportMP4}
                  className="w-full px-3 py-2 text-left hover:bg-zinc-800/80 flex items-center gap-2.5 text-zinc-200 transition"
                >
                  <Zap className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  <div>
                    <div className="font-medium text-white">Видео MP4</div>
                    <div className="text-[10px] text-zinc-400">Монтаж с субтитрами</div>
                  </div>
                </button>

                <div className="h-px bg-zinc-800 my-1" />

                <button
                  onClick={handleExportSRT}
                  className="w-full px-3 py-2 text-left hover:bg-zinc-800/80 flex items-center gap-2.5 text-zinc-200 transition"
                >
                  <FileText className="w-4 h-4 text-amber-400 flex-shrink-0" />
                  <div>
                    <div className="font-medium">Субтитры SRT</div>
                    <div className="text-[10px] text-zinc-400">Таймкоды для плееров</div>
                  </div>
                </button>

                <button
                  onClick={handleExportEDL}
                  className="w-full px-3 py-2 text-left hover:bg-zinc-800/80 flex items-center gap-2.5 text-zinc-200 transition"
                >
                  <Clapperboard className="w-4 h-4 text-sky-400 flex-shrink-0" />
                  <div>
                    <div className="font-medium">Таймлайн EDL</div>
                    <div className="text-[10px] text-zinc-400">Premiere Pro и DaVinci</div>
                  </div>
                </button>
              </div>
            )}
          </div>

        </div>
      </header>

      {/* 2. MAIN SPLIT: Video Left / Clean Script Right */}
      <div className="flex-1 flex overflow-hidden relative" onClick={() => isExportMenuOpen && setIsExportMenuOpen(false)}>
        
        {/* LEFT PANE: Video Player */}
        <section className="w-[50%] lg:w-[48%] border-r border-zinc-800/80 bg-zinc-950 flex flex-col justify-between p-4">
          
          {/* Framed Video Container */}
          <div className="relative flex-1 flex items-center justify-center min-h-0">
            <div className="relative aspect-[9/16] h-full max-h-[520px] bg-black rounded-lg border border-zinc-800/80 overflow-hidden shadow-2xl flex flex-col justify-between select-none">
              
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
                  <span className="text-xs font-medium text-zinc-300">Нажмите для выбора видео</span>
                  <span className="text-[11px] font-mono text-zinc-500 mt-1">MP4, MOV, MKV, WebM</span>
                </div>
              )}

              {/* Subtitle Overlay */}
              {burnSubtitles && activePhrase && (
                <div className="absolute inset-x-0 bottom-8 px-4 text-center pointer-events-none z-10 transition-all">
                  {subtitlePreset === 'hormozi' ? (
                    <div className="inline-block px-3 py-1.5 rounded bg-black/85 border border-black/60 shadow-2xl drop-shadow-[0_4px_10px_rgba(0,0,0,0.95)] max-w-[90%]">
                      {activePhrase.data.words && activePhrase.data.words.length > 0 ? (
                        activePhrase.data.words.map((w, wIdx) => {
                          const nextWord = activePhrase.data.words![wIdx + 1]
                          const wordEnd = nextWord ? Math.min(w.endTime + 0.15, nextWord.startTime) : w.endTime + 0.2
                          const isWordActive = currentTime >= w.startTime && currentTime <= wordEnd
                          return (
                            <span
                              key={wIdx}
                              className={`inline-block px-1 font-black text-sm md:text-base tracking-wide uppercase transition-all duration-75 ${
                                isWordActive
                                  ? 'text-amber-300 scale-110 drop-shadow-[0_0_8px_rgba(252,211,77,0.8)]'
                                  : 'text-white'
                              }`}
                            >
                              {w.word}
                            </span>
                          )
                        })
                      ) : (
                        <span className="text-white font-black text-sm md:text-base tracking-wide uppercase">
                          {activePhrase.data.text}
                        </span>
                      )}
                    </div>
                  ) : subtitlePreset === 'box' ? (
                    <span className="inline-block px-3.5 py-1.5 rounded-md bg-black/85 backdrop-blur-sm text-zinc-100 font-semibold text-xs md:text-sm border border-zinc-750/80 shadow-lg">
                      {activePhrase.data.text}
                    </span>
                  ) : (
                    <span className="inline-block px-3 py-1.5 text-white font-bold text-sm md:text-base leading-tight drop-shadow-[0_2px_4px_rgba(0,0,0,0.95)]">
                      {activePhrase.data.text}
                    </span>
                  )}
                </div>
              )}

              {/* Timecode badge */}
              <div className="absolute top-2.5 right-2.5 pointer-events-none z-10">
                <span className="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded bg-black/70 text-zinc-400 backdrop-blur-sm">
                  {formatTime(currentTime)}
                </span>
              </div>
            </div>
          </div>

          {/* Transport Bar */}
          <div className="flex items-center justify-between pt-3 mt-2 border-t border-zinc-900 text-xs">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => seekTo(0)}
                className="w-7 h-7 rounded hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200 flex items-center justify-center transition"
                title="В начало"
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
                title="Вперёд на 5 с"
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
                Итог: <strong className="text-emerald-400 font-normal">{formatTime(remainingDuration)}</strong>
              </span>
            </div>
          </div>

        </section>

        {/* RIGHT PANE: Script & Text */}
        <section className="flex-1 bg-zinc-900/40 flex flex-col justify-between overflow-hidden">
          
          {/* Header & Search */}
          <div className="h-10 px-4 border-b border-zinc-800/80 bg-zinc-900/60 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                Текст и паузы
              </span>
            </div>
            
            <div className="relative w-48">
              <Search className="w-3 h-3 absolute left-2 top-2 text-zinc-500" />
              <input
                type="text"
                placeholder="Поиск по тексту..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-7 pl-6 pr-2 rounded bg-zinc-950/80 border border-zinc-800 text-[11px] text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700"
              />
            </div>
          </div>

          {/* Script Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            
            <div className="text-xs text-zinc-500 font-mono mb-2 flex items-center justify-between">
              <span>Клик по таймкоду — переход, по паузе — вырезать или оставить.</span>
              <span className="text-[11px] text-zinc-400 font-medium">Whisper: {whisperModel} · {speechLanguage.toUpperCase()}</span>
            </div>

            {items.map((item) => {
              if (item.type === 'phrase') {
                const isActive = activePhrase?.data.id === item.data.id
                const matchesSearch = searchQuery.trim() === '' || item.data.text.toLowerCase().includes(searchQuery.toLowerCase())
                if (!matchesSearch) return null

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

              // Silence Item
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
                      title="Кликните, чтобы вырезать или оставить паузу"
                    >
                      <span>Пауза {item.data.duration.toFixed(1)} с</span>
                      <span className="text-[10px] font-sans font-medium px-1 rounded bg-black/40">
                        {item.data.isCut ? 'вырезана' : 'вырезать'}
                      </span>
                    </span>
                  </div>
                )
              }

              return null
            })}

          </div>

        </section>

        {/* SETTINGS MODAL */}
        {isSettingsOpen && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-30 flex items-center justify-center p-4">
            <div className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-6 space-y-5 animate-in fade-in duration-150">
              
              {/* Header */}
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-300">
                    <SlidersHorizontal className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-zinc-100">Настройки</h2>
                    <p className="text-[11px] text-zinc-400">Параметры монтажа, субтитров и кодека</p>
                  </div>
                </div>
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="w-7 h-7 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Body Controls */}
              <div className="space-y-4 text-xs">
                
                {/* 1. Subtitle Style Preset */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200 flex items-center gap-1.5">
                      <Type className="w-3.5 h-3.5 text-amber-400" />
                      <span>Стиль субтитров</span>
                    </label>
                    <span className="font-mono text-zinc-400 uppercase">{subtitlePreset}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'hormozi' as const, title: 'Караоке', desc: 'Подсветка активного слова' },
                      { id: 'classic' as const, title: 'Классический', desc: 'Белый текст с контуром' },
                      { id: 'box' as const, title: 'Плашка', desc: 'Полупрозрачный фон' },
                    ].map((st) => (
                      <button
                        key={st.id}
                        onClick={() => setSubtitlePreset(st.id)}
                        className={`p-2 rounded border text-left transition ${
                          subtitlePreset === st.id
                            ? 'bg-zinc-100 text-zinc-950 border-white'
                            : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        <div className="font-semibold text-[11px]">{st.title}</div>
                        <div className={`text-[10px] ${subtitlePreset === st.id ? 'text-zinc-700' : 'text-zinc-500'}`}>
                          {st.desc}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="h-px bg-zinc-800 my-2" />

                {/* 2. GPU Hardware Acceleration */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200 flex items-center gap-1.5">
                      <Zap className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Аппаратное ускорение (GPU)</span>
                    </label>
                    <span className="font-mono text-emerald-400 font-medium">NVIDIA NVENC</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'auto' as const, label: 'Авто' },
                      { id: 'nvenc' as const, label: 'NVIDIA NVENC' },
                      { id: 'cpu' as const, label: 'CPU (libx264)' },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => setHardwareAccel(opt.id)}
                        className={`h-7 rounded border font-mono text-[11px] transition ${
                          hardwareAccel === opt.id
                            ? 'bg-zinc-100 text-zinc-950 border-white font-medium'
                            : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-zinc-500">
                    NVENC ускоряет экспорт на видеокартах NVIDIA.
                  </p>
                </div>

                <div className="h-px bg-zinc-800 my-2" />

                {/* 3. Pause Detection Mode */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200 flex items-center gap-1.5">
                      <Scissors className="w-3.5 h-3.5 text-red-400" />
                      <span>Поиск пауз</span>
                    </label>
                    <span className="font-mono text-zinc-400 text-xs">
                      {pauseMode === 'smart' ? 'По речи (Whisper)' : 'По громкости (FFmpeg)'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { val: 'smart', label: 'По речи (Whisper)', desc: 'Паузы между словами, подходит для видео с музыкой' },
                      { val: 'volume', label: 'По громкости', desc: 'Участки тише заданного порога, для записей без музыки' },
                    ].map((opt) => (
                      <button
                        key={opt.val}
                        onClick={() => setPauseMode(opt.val as 'smart' | 'volume')}
                        className={`p-2.5 rounded border text-left transition ${
                          pauseMode === opt.val
                            ? 'bg-zinc-100 text-zinc-950 border-white'
                            : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        <div className="text-xs font-semibold">{opt.label}</div>
                        <div className={`text-[10px] mt-0.5 leading-snug ${pauseMode === opt.val ? 'text-zinc-700' : 'text-zinc-500'}`}>
                          {opt.desc}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* 4. Silence Threshold (dB) */}
                {pauseMode === 'volume' && (
                  <div className="space-y-1.5 animate-in fade-in duration-100">
                    <div className="flex items-center justify-between">
                      <label className="font-medium text-zinc-200">Порог громкости</label>
                      <span className="font-mono text-zinc-400">{silenceThreshold} dB</span>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {[
                        { val: -22, label: '-22 dB (шумный фон)' },
                        { val: -25, label: '-25 dB (умеренный шум)' },
                        { val: -30, label: '-30 dB (стандарт)' },
                        { val: -35, label: '-35 dB (тихая комната)' },
                      ].map((opt) => (
                        <button
                          key={opt.val}
                          onClick={() => setSilenceThreshold(opt.val)}
                          className={`h-7 rounded border font-mono text-[11px] transition ${
                            silenceThreshold === opt.val
                              ? 'bg-zinc-100 text-zinc-950 border-white font-medium'
                              : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* 5. Minimum Silence Duration */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200">Минимальная пауза</label>
                    <span className="font-mono text-zinc-400">{minSilenceDuration} с</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { val: 0.3, label: '0.3 с (короткие)' },
                      { val: 0.5, label: '0.5 с (стандарт)' },
                      { val: 0.8, label: '0.8 с (умеренные)' },
                      { val: 1.0, label: '1.0 с (длинные)' },
                    ].map((opt) => (
                      <button
                        key={opt.val}
                        onClick={() => setMinSilenceDuration(opt.val)}
                        className={`h-7 rounded border font-mono text-[11px] transition ${
                          minSilenceDuration === opt.val
                            ? 'bg-zinc-100 text-zinc-950 border-white font-medium'
                            : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Recalculate CTA */}
                {filePath && (
                  <button
                    onClick={() => {
                      handleRecalculateSilences()
                      setIsSettingsOpen(false)
                    }}
                    disabled={isAnalyzing}
                    className="w-full h-8 rounded bg-zinc-800 hover:bg-zinc-750 border border-zinc-700 text-zinc-200 flex items-center justify-center gap-2 font-medium transition text-xs"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isAnalyzing ? 'animate-spin' : ''}`} />
                    <span>Обновить паузы</span>
                  </button>
                )}

                <div className="h-px bg-zinc-800 my-2" />

                {/* 5. Whisper Model Selection */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                      <span>Модель Whisper</span>
                    </label>
                    <span className="font-mono text-zinc-400">{whisperModel}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { val: 'tiny', label: 'tiny (быстрая)' },
                      { val: 'base', label: 'base (стандартная)' },
                      { val: 'small', label: 'small (точная)' },
                    ].map((opt) => (
                      <button
                        key={opt.val}
                        onClick={() => setWhisperModel(opt.val)}
                        className={`h-8 px-2 rounded border text-[11px] transition ${
                          whisperModel === opt.val
                            ? 'bg-zinc-100 text-zinc-950 border-white font-medium'
                            : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 6. Whisper Language Selection */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200 flex items-center gap-1.5">
                      <Globe className="w-3.5 h-3.5 text-blue-400" />
                      <span>Язык речи</span>
                    </label>
                    <span className="font-mono text-blue-400 font-semibold">{speechLanguage.toUpperCase()}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { val: 'ru', label: 'Русский (ru)' },
                      { val: 'auto', label: 'Авто (auto)' },
                      { val: 'en', label: 'English (en)' },
                    ].map((opt) => (
                      <button
                        key={opt.val}
                        onClick={() => setSpeechLanguage(opt.val)}
                        className={`h-8 px-2 rounded border text-[11px] transition ${
                          speechLanguage === opt.val
                            ? 'bg-zinc-100 text-zinc-950 border-white font-medium'
                            : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-zinc-400">
                    Язык исходной речи для точного распознавания.
                  </p>
                </div>

                {/* Re-transcribe Speech CTA */}
                {filePath && (
                  <button
                    onClick={() => {
                      handleRetranscribeSpeech()
                      setIsSettingsOpen(false)
                    }}
                    disabled={isAnalyzing}
                    className="w-full h-8 rounded bg-zinc-800 hover:bg-zinc-750 border border-zinc-700 text-zinc-200 flex items-center justify-center gap-2 font-medium transition text-xs"
                  >
                    <Sparkles className={`w-3.5 h-3.5 text-amber-400 ${isAnalyzing ? 'animate-spin' : ''}`} />
                    <span>Распознать заново</span>
                  </button>
                )}

              </div>

              {/* Footer */}
              <div className="flex justify-end pt-3 border-t border-zinc-800">
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="h-8 px-4 rounded bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-semibold transition"
                >
                  Готово
                </button>
              </div>

            </div>
          </div>
        )}

        {/* FULLSCREEN PROGRESS OVERLAYS */}
        {isAnalyzing && (
          <div className="absolute inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-2xl flex items-center gap-4 max-w-md w-full animate-in fade-in duration-150">
              <RefreshCw className="w-6 h-6 text-amber-400 animate-spin flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-zinc-100 uppercase tracking-wide">
                  Обработка видео
                </div>
                <div className="text-xs text-zinc-400 mt-1 truncate">
                  {analyzingStatus || 'Обработка...'}
                </div>
              </div>
            </div>
          </div>
        )}

        {isExporting && (
          <div className="absolute inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-2xl flex items-center gap-4 max-w-md w-full animate-in fade-in duration-150">
              <Zap className="w-6 h-6 text-emerald-400 animate-pulse flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-zinc-100 uppercase tracking-wide">
                  Экспорт видео
                </div>
                <div className="text-xs text-zinc-400 mt-1">
                  {hardwareAccel === 'cpu' ? 'Кодирование на CPU...' : 'Кодирование на GPU (NVENC)...'}
                </div>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* 3. BOTTOM TIMELINE (Height 112px) */}
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
          {/* Waveform Bars */}
          <div className="absolute inset-0 flex items-center justify-between px-2 pointer-events-none">
            {waveform.map((peak, idx) => (
              <div
                key={idx}
                className="w-[2px] bg-zinc-400 rounded-full"
                style={{ height: `${Math.max(8, peak * 0.7)}%` }}
              />
            ))}
          </div>

          {/* Silence Overlay Zones */}
          {totalDuration > 0 && silences.map((silence) => {
            const left = Math.min(100, Math.max(0, (silence.data.startTime / totalDuration) * 100))
            const width = Math.min(100 - left, Math.max(0, (silence.data.duration / totalDuration) * 100))
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
                title={`Пауза ${silence.data.duration.toFixed(1)} с (клик — вырезать/оставить)`}
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
            className="absolute top-0 bottom-0 w-px bg-red-500 z-30 pointer-events-none"
            style={{ left: `${totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0}%` }}
          >
            <div className="w-2.5 h-2.5 bg-red-500 rotate-45 -ml-[4px] -top-1 absolute shadow-sm" />
          </div>
        </div>

        {/* Timeline Bottom Legend */}
        <div className="h-6 px-4 bg-zinc-900 border-t border-zinc-800/50 flex items-center justify-between text-[10px] font-mono text-zinc-500">
          <div className="flex items-center gap-3">
            <span>Пробел — воспроизведение/пауза</span>
            <span>•</span>
            <span className="text-zinc-400">← / → — переход на 2 с</span>
          </div>
          <div className="flex items-center gap-2">
            <span>Паузы: {pauseMode === 'smart' ? 'по речи' : `по громкости (${silenceThreshold} dB)`}</span>
            <span>•</span>
            <span>Мин. пауза: {minSilenceDuration} с</span>
            <span>•</span>
            <span className="text-emerald-400 font-medium">GPU: NVENC</span>
          </div>
        </div>

      </footer>

    </div>
  )
}
