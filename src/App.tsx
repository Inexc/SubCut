import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react'
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
  Image as ImageIcon,
  Music,
  Send,
  Palette,
  Smartphone,
  Monitor,
  ChevronDown,
} from 'lucide-react'

export type ColorPreset = 'none' | 'anime_punch' | 'cinematic' | 'crisp'
export type TransitionSmoothing = 'smooth' | 'dynamic'

export function getColorFilterStyle(preset: ColorPreset): string {
  switch (preset) {
    case 'anime_punch':
      return 'saturate(1.25) contrast(1.12)'
    case 'cinematic':
      return 'contrast(1.18) brightness(0.97) saturate(0.95)'
    case 'crisp':
      return 'contrast(1.06) brightness(1.02)'
    default:
      return 'none'
  }
}

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

function isSentenceEnd(w: string): boolean {
  const clean = w.replace(/["'»)”\]]+$/g, '')
  return clean.endsWith('.') || clean.endsWith('!') || clean.endsWith('?') || clean.endsWith('…')
}

function isClauseEnd(w: string): boolean {
  const clean = w.replace(/["'»)”\]]+$/g, '')
  return clean.endsWith(',') || clean.endsWith(';') || clean.endsWith(':') || clean.endsWith('—') || clean.endsWith('-')
}

/**
 * Splits a speech phrase into short dynamic subtitle cues
 * (by punctuation . ! ? …, clause punctuation , ; : —,
 * breath pauses >= 350ms, and max 4-6 words per cue).
 */
export function chunkPhrase(phrase: Phrase, maxWords: number = 5): Phrase[] {
  const text = phrase.text.trim()
  if (!text) return []

  let words: Word[] = []
  if (phrase.words && phrase.words.length > 0) {
    let lastT = phrase.startTime
    words = phrase.words
      .filter((w) => w.word.trim().length > 0)
      .map((w) => {
        const ws = Math.max(lastT, Number(w.startTime.toFixed(2)))
        const we = Math.max(ws + 0.05, Number(w.endTime.toFixed(2)))
        lastT = ws
        return {
          word: w.word.trim(),
          startTime: ws,
          endTime: we,
        }
      })
  } else {
    const tokens = text.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return []
    const dur = Math.max(0.1, phrase.endTime - phrase.startTime)
    const totalChars = Math.max(1, tokens.reduce((acc, t) => acc + t.length, 0))
    let curTime = phrase.startTime
    words = tokens.map((tok, idx) => {
      const tokDur = Math.max(0.08, dur * (tok.length / totalChars))
      const wEnd = idx === tokens.length - 1 ? Math.max(curTime + tokDur, phrase.endTime) : curTime + tokDur
      const res = {
        word: tok,
        startTime: Number(curTime.toFixed(2)),
        endTime: Number(wEnd.toFixed(2)),
      }
      curTime = wEnd
      return res
    })
  }

  if (words.length === 0) return []

  const cues: Phrase[] = []
  let currentWords: Word[] = []
  const n = words.length

  for (let i = 0; i < n; i++) {
    const word = words[i]
    currentWords.push(word)

    const isLast = i === n - 1
    let shouldBreak = isLast

    if (!isLast) {
      const nextWord = words[i + 1]
      const pauseToNext = nextWord.startTime - word.endTime
      const remaining = n - (i + 1)

      if (isSentenceEnd(word.word)) {
        shouldBreak = true
      } else if (pauseToNext >= 0.35 && currentWords.length >= 1) {
        shouldBreak = true
      } else if (isClauseEnd(word.word) && currentWords.length >= 3) {
        shouldBreak = true
      } else if (currentWords.length >= maxWords) {
        if (remaining === 1 && currentWords.length < maxWords + 1 && !isSentenceEnd(nextWord.word)) {
          shouldBreak = false
        } else {
          shouldBreak = true
        }
      }
    }

    if (shouldBreak && currentWords.length > 0) {
      const cStart = currentWords[0].startTime
      const rawEnd = currentWords[currentWords.length - 1].endTime
      const cEnd = !isLast
        ? Math.max(Number((cStart + 0.05).toFixed(2)), Math.min(rawEnd, words[i + 1].startTime))
        : Math.max(Number((cStart + 0.20).toFixed(2)), rawEnd)

      const cText = currentWords.map((cw) => cw.word).join(' ')
      cues.push({
        id: `${phrase.id}-c${cues.length + 1}`,
        speaker: phrase.speaker || 'Спикер',
        startTime: Number(cStart.toFixed(2)),
        endTime: Number(cEnd.toFixed(2)),
        text: cText,
        words: [...currentWords],
      })
      currentWords = []
    }
  }

  // Ensure consecutive cues strictly never overlap
  for (let idx = 0; idx < cues.length - 1; idx++) {
    if (cues[idx].endTime > cues[idx + 1].startTime) {
      cues[idx].endTime = cues[idx + 1].startTime
    }
  }

  return cues
}

export function chunkPhrases(phrases: Phrase[]): Phrase[] {
  const result: Phrase[] = []
  for (const p of phrases) {
    const chunked = chunkPhrase(p, 5)
    if (chunked.length === 0) {
      if (p.text.trim()) result.push(p)
    } else {
      result.push(...chunked)
    }
  }
  for (let idx = 0; idx < result.length - 1; idx++) {
    if (result[idx].endTime > result[idx + 1].startTime) {
      result[idx].endTime = result[idx + 1].startTime
    }
  }
  return result.map((cue, idx) => ({
    ...cue,
    id: `p-${idx + 1}`,
  }))
}

const INITIAL_SCRIPT: ScriptItem[] = [
  {
    type: 'phrase',
    data: {
      id: 'p-1',
      speaker: 'Спикер',
      startTime: 0.0,
      endTime: 0.5,
      text: 'Привет!',
      words: [{ word: 'Привет!', startTime: 0.0, endTime: 0.5 }],
    },
  },
  {
    type: 'phrase',
    data: {
      id: 'p-2',
      speaker: 'Спикер',
      startTime: 0.5,
      endTime: 1.9,
      text: 'В этом видео покажем',
      words: [
        { word: 'В', startTime: 0.5, endTime: 0.7 },
        { word: 'этом', startTime: 0.7, endTime: 1.0 },
        { word: 'видео', startTime: 1.0, endTime: 1.4 },
        { word: 'покажем', startTime: 1.4, endTime: 1.9 },
      ],
    },
  },
  {
    type: 'phrase',
    data: {
      id: 'p-3',
      speaker: 'Спикер',
      startTime: 1.9,
      endTime: 3.45,
      text: 'монтаж речи по тексту.',
      words: [
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
      id: 'p-4',
      speaker: 'Спикер',
      startTime: 4.85,
      endTime: 6.8,
      text: 'Не нужно вручную резать',
      words: [
        { word: 'Не', startTime: 4.85, endTime: 5.1 },
        { word: 'нужно', startTime: 5.1, endTime: 5.6 },
        { word: 'вручную', startTime: 5.6, endTime: 6.2 },
        { word: 'резать', startTime: 6.2, endTime: 6.8 },
      ],
    },
  },
  {
    type: 'phrase',
    data: {
      id: 'p-5',
      speaker: 'Спикер',
      startTime: 6.8,
      endTime: 8.6,
      text: 'и искать паузы.',
      words: [
        { word: 'и', startTime: 6.8, endTime: 7.1 },
        { word: 'искать', startTime: 7.1, endTime: 7.8 },
        { word: 'паузы.', startTime: 7.8, endTime: 8.6 },
      ],
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
      id: 'p-6',
      speaker: 'Спикер',
      startTime: 10.1,
      endTime: 12.2,
      text: 'SubCut находит тишину',
      words: [
        { word: 'SubCut', startTime: 10.1, endTime: 10.8 },
        { word: 'находит', startTime: 10.8, endTime: 11.5 },
        { word: 'тишину', startTime: 11.5, endTime: 12.2 },
      ],
    },
  },
  {
    type: 'phrase',
    data: {
      id: 'p-7',
      speaker: 'Спикер',
      startTime: 12.2,
      endTime: 14.3,
      text: 'и удаляет лишнее.',
      words: [
        { word: 'и', startTime: 12.2, endTime: 12.6 },
        { word: 'удаляет', startTime: 12.6, endTime: 13.4 },
        { word: 'лишнее.', startTime: 13.4, endTime: 14.3 },
      ],
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
      id: 'p-8',
      speaker: 'Спикер',
      startTime: 16.0,
      endTime: 18.2,
      text: 'Субтитры уже готовы,',
      words: [
        { word: 'Субтитры', startTime: 16.0, endTime: 16.9 },
        { word: 'уже', startTime: 16.9, endTime: 17.4 },
        { word: 'готовы,', startTime: 17.4, endTime: 18.2 },
      ],
    },
  },
  {
    type: 'phrase',
    data: {
      id: 'p-9',
      speaker: 'Спикер',
      startTime: 18.2,
      endTime: 20.4,
      text: 'остаётся проверить результат.',
      words: [
        { word: 'остаётся', startTime: 18.2, endTime: 19.0 },
        { word: 'проверить', startTime: 19.0, endTime: 19.7 },
        { word: 'результат.', startTime: 19.7, endTime: 20.4 },
      ],
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

interface AutoResizeTextareaProps {
  value: string
  onChange: (val: string) => void
  className?: string
  placeholder?: string
}

function AutoResizeTextarea({ value, onChange, className, placeholder }: AutoResizeTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  useLayoutEffect(() => {
    adjustHeight()
  }, [value, adjustHeight])

  useEffect(() => {
    window.addEventListener('resize', adjustHeight)
    return () => window.removeEventListener('resize', adjustHeight)
  }, [adjustHeight])

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => {
        onChange(e.target.value)
      }}
      rows={1}
      placeholder={placeholder}
      className={className}
      style={{ fieldSizing: 'content' } as React.CSSProperties}
    />
  )
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
  const [subtitleSize, setSubtitleSize] = useState<number>(54)
  const [subtitlePosition, setSubtitlePosition] = useState<'bottom' | 'center' | 'top'>('bottom')
  const [isSubtitleMenuOpen, setIsSubtitleMenuOpen] = useState<boolean>(false)
  const [hardwareAccel, setHardwareAccel] = useState<'auto' | 'nvenc' | 'cpu'>('auto')
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false)
  const [isExportMenuOpen, setIsExportMenuOpen] = useState<boolean>(false)

  // Framing & Visual Presets
  const [framingMode, setFramingMode] = useState<'original' | 'blur_9_16'>('original')
  const [colorPreset, setColorPreset] = useState<ColorPreset>('none')

  // Cover Generator Modal State
  const [isCoverModalOpen, setIsCoverModalOpen] = useState<boolean>(false)
  const [coverTime, setCoverTime] = useState<number>(0)
  const [coverTitle, setCoverTitle] = useState<string>('')
  const [coverTitleStyle, setCoverTitleStyle] = useState<'hormozi' | 'neon' | 'clean' | 'none'>('hormozi')
  const [coverFraming, setCoverFraming] = useState<'original' | 'blur_9_16'>('blur_9_16')
  const [coverColor, setCoverColor] = useState<ColorPreset>('none')

  // Background Music & Auto-Ducking State
  const [bgMusicPath, setBgMusicPath] = useState<string | null>(null)
  const [bgMusicVolume, setBgMusicVolume] = useState<number>(0.15)
  const [autoDucking, setAutoDucking] = useState<boolean>(true)
  const [duckingPreset, setDuckingPreset] = useState<'soft' | 'medium' | 'hard'>('medium')

  // Transition Smoothing State ('smooth' = 120ms/100ms / 40ms fades; 'dynamic' = 70ms / 20ms fades)
  const [transitionSmoothing, setTransitionSmoothing] = useState<TransitionSmoothing>('smooth')

  const smoothingPadding = useMemo(() => {
    if (transitionSmoothing === 'dynamic') {
      return { padOut: 0.07, padIn: 0.07, fadeMs: 20 }
    }
    return { padOut: 0.12, padIn: 0.10, fadeMs: 40 }
  }, [transitionSmoothing])

  const videoRef = useRef<HTMLVideoElement>(null)
  const bgVideoRef = useRef<HTMLVideoElement>(null)
  const bgAudioRef = useRef<HTMLAudioElement>(null)
  const coverVideoRef = useRef<HTMLVideoElement>(null)
  const coverBgRef = useRef<HTMLVideoElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const isSkippingRef = useRef<boolean>(false)
  const skippedCutIdRef = useRef<number | null>(null)
  const fadeAnimationRef = useRef<number | null>(null)
  const seekFallbackTimerRef = useRef<number | null>(null)
  const rafIdRef = useRef<number | null>(null)

  // Derived stats
  const silences = items.filter((i): i is { type: 'silence'; data: SilenceGap } => i.type === 'silence')
  const activeCuts = silences.filter((s) => s.data.isCut)
  const cutDuration = activeCuts.reduce((acc, s) => acc + s.data.duration, 0)
  const remainingDuration = Math.max(0, totalDuration - cutDuration)

  // Kept intervals calculation matching backend calculate_keep_intervals_with_smoothing
  const keepIntervals = useMemo(() => {
    if (!totalDuration || totalDuration <= 0.05) return []

    const PAD_OUT = smoothingPadding.padOut
    const PAD_IN = smoothingPadding.padIn

    // 1. Sanitize and sort raw cuts
    const validCuts = items
      .filter((i): i is { type: 'silence'; data: SilenceGap } => i.type === 'silence' && i.data.isCut)
      .map((s) => [
        Math.max(0, Math.min(totalDuration, s.data.startTime)),
        Math.max(0, Math.min(totalDuration, s.data.endTime)),
      ])
      .filter(([start, end]) => isFinite(start) && isFinite(end) && end > start + 0.04)
      .sort((a, b) => a[0] - b[0])

    // 2. Merge overlapping cuts
    const mergedCuts: [number, number][] = []
    for (const [start, end] of validCuts) {
      const last = mergedCuts[mergedCuts.length - 1]
      if (last && start <= last[1]) {
        last[1] = Math.max(last[1], end)
      } else {
        mergedCuts.push([start, end])
      }
    }

    // 3. Apply edge padding
    const effectiveCuts: [number, number][] = []
    for (const [start, end] of mergedCuts) {
      const effStart = start <= 0.05 ? 0.0 : start + PAD_OUT
      const effEnd = end >= totalDuration - 0.05 ? totalDuration : end - PAD_IN
      if (effEnd > effStart + 0.04) {
        effectiveCuts.push([effStart, effEnd])
      }
    }

    // 4. Invert cuts to get keep intervals
    const keep: [number, number][] = []
    let cur = 0.0
    for (const [cutStart, cutEnd] of effectiveCuts) {
      if (cutStart > cur + 0.04) {
        keep.push([cur, cutStart])
      }
      cur = Math.max(cur, cutEnd)
    }
    if (cur < totalDuration - 0.04) {
      keep.push([cur, totalDuration])
    }
    return keep
  }, [items, totalDuration, smoothingPadding])

  // Derived cut zones to skip, strictly matching keepIntervals
  const skipCuts = useMemo(() => {
    if (!keepIntervals || keepIntervals.length === 0 || !totalDuration || totalDuration <= 0.05) {
      return []
    }
    const cuts: { id: number; start: number; end: number; targetTime: number }[] = []

    // 1. Initial cut before the first kept interval (if any)
    const firstStart = keepIntervals[0][0]
    if (firstStart > 0.04) {
      cuts.push({
        id: 0,
        start: 0.0,
        end: firstStart,
        targetTime: firstStart,
      })
    }

    // 2. Cut gaps between consecutive kept intervals
    for (let i = 0; i < keepIntervals.length - 1; i++) {
      const curEnd = keepIntervals[i][1]
      const nextStart = keepIntervals[i + 1][0]
      if (nextStart > curEnd + 0.04) {
        cuts.push({
          id: cuts.length,
          start: curEnd,
          end: nextStart,
          targetTime: nextStart,
        })
      }
    }

    // 3. Trailing cut after the last kept interval (if any)
    const lastEnd = keepIntervals[keepIntervals.length - 1][1]
    if (lastEnd < totalDuration - 0.04) {
      cuts.push({
        id: cuts.length,
        start: lastEnd,
        end: totalDuration,
        targetTime: totalDuration,
      })
    }

    return cuts
  }, [keepIntervals, totalDuration])

  // Map original unedited timestamp to trimmed playback timestamp (matching Rust map_original_to_trimmed)
  const mapOriginalToTrimmed = useCallback(
    (t: number) => {
      if (keepIntervals.length === 0) return t
      let outTime = 0.0
      for (const [kStart, kEnd] of keepIntervals) {
        if (t < kStart) {
          return outTime
        } else if (t <= kEnd) {
          return outTime + (t - kStart)
        } else {
          outTime += kEnd - kStart
        }
      }
      return outTime
    },
    [keepIntervals]
  )

  // Track name for background music
  const bgMusicName = useMemo(() => {
    if (!bgMusicPath) return ''
    return bgMusicPath.split(/[\\/]/).pop() || bgMusicPath
  }, [bgMusicPath])

  // Select audio file for background music
  const handleSelectBgMusic = async () => {
    try {
      const selected = await invoke<string | null>('select_audio_file_cmd')
      if (selected) {
        setBgMusicPath(selected)
      }
    } catch (err) {
      alert(`Ошибка выбора аудиофайла: ${err}`)
    }
  }

  // Clear background music
  const handleClearBgMusic = () => {
    setBgMusicPath(null)
    if (bgAudioRef.current) {
      bgAudioRef.current.pause()
      bgAudioRef.current.currentTime = 0
    }
  }

  // Active phrase cue calculation (disappears when finished, advances in sync with speech)
  const phraseList = useMemo(
    () => items.filter((i): i is { type: 'phrase'; data: Phrase } => i.type === 'phrase'),
    [items]
  )
  const activePhraseIndex = phraseList.findIndex((p, idx) => {
    const nextPhrase = phraseList[idx + 1]
    const cueEnd = nextPhrase
      ? Math.min(p.data.endTime + 0.12, nextPhrase.data.startTime)
      : p.data.endTime + 0.12
    return (
      currentTime >= p.data.startTime &&
      currentTime <= cueEnd &&
      (!nextPhrase || currentTime < nextPhrase.data.startTime)
    )
  })
  const activePhrase = activePhraseIndex >= 0 ? phraseList[activePhraseIndex] : null

  // Auto-scroll transcript editor to follow speech during playback
  const activePhraseCardRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (isPlaying && activePhraseCardRef.current) {
      activePhraseCardRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      })
    }
  }, [activePhrase?.data.id, isPlaying])

  // Target background music volume considering ducking depth
  const duckingFactor = duckingPreset === 'soft' ? 0.32 : duckingPreset === 'hard' ? 0.12 : 0.20
  const isDucked = autoDucking && !!activePhrase
  const targetBgVolume = Math.max(0, Math.min(1, isDucked ? bgMusicVolume * duckingFactor : bgMusicVolume))

  // Real-time preview Auto-Ducking: smoothly attenuate music during speech phrases
  const prevBgPathRef = useRef<string | null>(null)
  useEffect(() => {
    if (!bgAudioRef.current || !bgMusicPath) return

    // When selecting or changing audio track, initialize volume immediately
    if (prevBgPathRef.current !== bgMusicPath) {
      prevBgPathRef.current = bgMusicPath
      bgAudioRef.current.volume = targetBgVolume
      return
    }

    let animId: number
    const startVol = bgAudioRef.current.volume
    if (Math.abs(startVol - targetBgVolume) < 0.005) {
      bgAudioRef.current.volume = targetBgVolume
      return
    }

    const startTime = performance.now()
    const rampDuration = 160 // 160ms smooth ducking ramp

    const step = (now: number) => {
      const elapsed = now - startTime
      const progress = Math.min(1, elapsed / rampDuration)
      const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress
      const nextVol = startVol + (targetBgVolume - startVol) * eased
      if (bgAudioRef.current) {
        bgAudioRef.current.volume = Math.max(0, Math.min(1, nextVol))
      }
      if (progress < 1) {
        animId = requestAnimationFrame(step)
      }
    }

    animId = requestAnimationFrame(step)
    return () => cancelAnimationFrame(animId)
  }, [targetBgVolume, bgMusicPath])

  // Evenly sampled phrases across duration for quick cover keyframe badges
  const sampledCoverPhrases = useMemo(() => {
    if (phraseList.length <= 10) return phraseList
    const step = phraseList.length / 10
    const res: typeof phraseList = []
    for (let i = 0; i < 10; i++) {
      const idx = Math.min(phraseList.length - 1, Math.floor(i * step))
      if (!res.some((item) => item.data.id === phraseList[idx].data.id)) {
        res.push(phraseList[idx])
      }
    }
    return res
  }, [phraseList])

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
        const rawPhrases = await invoke<Phrase[]>('transcribe_speech_cmd', {
          path: selected,
          modelSize: whisperModel,
          language: speechLanguage,
        })
        phrases = chunkPhrases(rawPhrases)
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
      const rawPhrases = await invoke<Phrase[]>('transcribe_speech_cmd', {
        path: filePath,
        modelSize: whisperModel,
        language: speechLanguage,
      })
      const phrases = chunkPhrases(rawPhrases)

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
      bgVideoRef.current?.pause()
      bgAudioRef.current?.pause()
      setIsPlaying(false)
    } else {
      videoRef.current.play().catch(console.error)
      bgVideoRef.current?.play().catch(() => {})
      if (bgMusicPath && bgAudioRef.current) {
        bgAudioRef.current.play().catch(() => {})
      }
      setIsPlaying(true)
    }
  }

  // Seek video
  const seekTo = (time: number) => {
    const clamped = Math.max(0, Math.min(totalDuration || 0, time))
    setCurrentTime(clamped)
    isSkippingRef.current = false
    skippedCutIdRef.current = null
    if (seekFallbackTimerRef.current) {
      window.clearTimeout(seekFallbackTimerRef.current)
      seekFallbackTimerRef.current = null
    }
    if (fadeAnimationRef.current) {
      cancelAnimationFrame(fadeAnimationRef.current)
      fadeAnimationRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.muted = false
      videoRef.current.volume = 1.0
      videoRef.current.currentTime = clamped
    }
    if (bgVideoRef.current && framingMode === 'blur_9_16') {
      bgVideoRef.current.currentTime = clamped
    }
    if (bgAudioRef.current && bgAudioRef.current.duration) {
      const trimmedT = mapOriginalToTrimmed(clamped)
      bgAudioRef.current.currentTime = trimmedT % bgAudioRef.current.duration
    }
  }

  // Cover modal time scrubbing
  const updateCoverTime = (time: number) => {
    const clamped = Math.max(0, Math.min(totalDuration || 0, time))
    setCoverTime(clamped)
    if (coverVideoRef.current) {
      coverVideoRef.current.currentTime = clamped
    }
    if (coverBgRef.current) {
      coverBgRef.current.currentTime = clamped
    }
  }

  useEffect(() => {
    if (isCoverModalOpen) {
      if (coverVideoRef.current) coverVideoRef.current.currentTime = coverTime
      if (coverBgRef.current) coverBgRef.current.currentTime = coverTime
    }
  }, [isCoverModalOpen])

  // Seamless lookahead skip handler (checks at 60 fps / RAF frequency)
  const checkSkip = useCallback(() => {
    const video = videoRef.current
    if (!video || !isPlaying) return

    const t = video.currentTime

    // If currently performing a seek or waiting for decoder, do nothing
    if (isSkippingRef.current || video.seeking) {
      return
    }

    // Release skip latch once playback has safely entered the kept segment
    if (skippedCutIdRef.current !== null) {
      const skippedCut = skipCuts.find((c) => c.id === skippedCutIdRef.current)
      if (!skippedCut || t >= skippedCut.targetTime + 0.03 || t < skippedCut.start - 0.1) {
        skippedCutIdRef.current = null
      }
    }

    // Lookahead of 20ms to anticipate cut before playing stale silence
    const LOOKAHEAD = 0.020
    const checkTime = t + LOOKAHEAD

    for (const cut of skipCuts) {
      if (skippedCutIdRef.current === cut.id) continue

      if (checkTime >= cut.start && t < cut.end) {
        isSkippingRef.current = true
        skippedCutIdRef.current = cut.id

        if (fadeAnimationRef.current) {
          cancelAnimationFrame(fadeAnimationRef.current)
          fadeAnimationRef.current = null
        }
        if (seekFallbackTimerRef.current) {
          window.clearTimeout(seekFallbackTimerRef.current)
        }

        // Soft micro-fade: immediately silence audio before seek to eliminate clicks/pops
        video.volume = 0.0
        video.muted = true

        if (cut.targetTime >= totalDuration - 0.04) {
          video.currentTime = totalDuration
          video.pause()
          bgVideoRef.current?.pause()
          bgAudioRef.current?.pause()
          setIsPlaying(false)
          isSkippingRef.current = false
          video.muted = false
          video.volume = 1.0
        } else {
          video.currentTime = cut.targetTime

          // Fallback safety timeout if browser fails to fire 'seeked' within 800ms
          seekFallbackTimerRef.current = window.setTimeout(() => {
            if (videoRef.current) {
              videoRef.current.muted = false
              videoRef.current.volume = 1.0
            }
            isSkippingRef.current = false
          }, 800)
        }
        break
      }
    }
  }, [isPlaying, skipCuts, totalDuration])

  // High-frequency RAF loop for smooth 60fps cut lookahead detection
  useEffect(() => {
    if (!isPlaying) {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      return
    }

    let active = true
    const loop = () => {
      if (!active) return
      checkSkip()
      rafIdRef.current = requestAnimationFrame(loop)
    }
    rafIdRef.current = requestAnimationFrame(loop)

    return () => {
      active = false
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [isPlaying, checkSkip])

  // Real-time timecode and auxiliary sync updates during playback
  const handleTimeUpdate = () => {
    if (!videoRef.current) return
    const t = videoRef.current.currentTime
    setCurrentTime(t)

    // Background music drift check (only if drift > 0.8s)
    if (bgAudioRef.current && bgAudioRef.current.duration) {
      const expAudio = mapOriginalToTrimmed(t) % bgAudioRef.current.duration
      if (Math.abs(bgAudioRef.current.currentTime - expAudio) > 0.8) {
        bgAudioRef.current.currentTime = expAudio
      }
    }
  }

  // Handle video seeked event: restore audio cleanly with soft micro-fade-in
  const handleVideoSeeked = () => {
    const video = videoRef.current
    if (!video) return

    if (seekFallbackTimerRef.current) {
      window.clearTimeout(seekFallbackTimerRef.current)
      seekFallbackTimerRef.current = null
    }

    isSkippingRef.current = false

    // Smooth 30ms audio micro-fade-in to eliminate pops/clicks on resume
    video.muted = false
    video.volume = 0.0

    if (fadeAnimationRef.current) {
      cancelAnimationFrame(fadeAnimationRef.current)
    }

    const fadeStart = performance.now()
    const fadeDuration = 30 // 30ms soft micro-fade

    const rampVolume = (now: number) => {
      const elapsed = now - fadeStart
      const progress = Math.min(1.0, elapsed / fadeDuration)
      if (videoRef.current) {
        videoRef.current.volume = progress
      }
      if (progress < 1.0) {
        fadeAnimationRef.current = requestAnimationFrame(rampVolume)
      } else {
        fadeAnimationRef.current = null
      }
    }
    fadeAnimationRef.current = requestAnimationFrame(rampVolume)

    // Synchronize background music only if drift is significant
    if (bgAudioRef.current && bgAudioRef.current.duration) {
      const trimmedT = mapOriginalToTrimmed(video.currentTime)
      const curBgT = bgAudioRef.current.currentTime
      const targetBgT = trimmedT % bgAudioRef.current.duration
      if (Math.abs(curBgT - targetBgT) > 0.4) {
        bgAudioRef.current.currentTime = targetBgT
      }
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

  // Export 1: Trimmed MP4 video (current settings)
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
        framingMode,
        colorPreset,
        targetBitrateKbps: null,
        bgMusicPath,
        bgMusicVolume,
        autoDucking,
        duckingPreset,
        subtitleSize,
        subtitlePosition,
        transitionSmoothing,
      })
      alert(`Видео сохранено:\n${outputPath}`)
    } catch (err) {
      alert(`Ошибка экспорта: ${err}`)
    } finally {
      setIsExporting(false)
    }
  }

  // Export 1-Click: Instagram Reels & Shorts (1080x1920 HQ with blurred background)
  const handleExportReels = async () => {
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

      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, '') || 'reels'
      const defaultName = `${baseName}_reels_1080x1920.mp4`

      const outputPath = await invoke<string | null>('select_save_file_cmd', {
        title: 'Экспорт для Instagram Reels и Shorts',
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
        burnSubtitles: true,
        subtitlePreset,
        phrases: phrasesToExport,
        hardwareAccel,
        framingMode: 'blur_9_16',
        colorPreset,
        targetBitrateKbps: null,
        bgMusicPath,
        bgMusicVolume,
        autoDucking,
        duckingPreset,
        subtitleSize,
        subtitlePosition,
        transitionSmoothing,
      })
      alert(`Видео для Reels/Shorts успешно сохранено:\n${outputPath}`)
    } catch (err) {
      alert(`Ошибка экспорта для Reels: ${err}`)
    } finally {
      setIsExporting(false)
    }
  }

  // Export 1-Click: Telegram Compact (< 50 MB)
  const handleExportTelegram = async () => {
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

      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, '') || 'telegram'
      const defaultName = `${baseName}_telegram_under50mb.mp4`

      const targetBitrate = await invoke<number>('calculate_telegram_video_bitrate_cmd', {
        durationSec: remainingDuration,
        maxMegabytes: 46.0,
      })

      const outputPath = await invoke<string | null>('select_save_file_cmd', {
        title: 'Экспорт для Telegram (< 50 МБ)',
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
        framingMode,
        colorPreset,
        targetBitrateKbps: targetBitrate,
        bgMusicPath,
        bgMusicVolume,
        autoDucking,
        duckingPreset,
        subtitleSize,
        subtitlePosition,
        transitionSmoothing,
      })
      alert(`Компактное видео для Telegram сохранено:\n${outputPath}`)
    } catch (err) {
      alert(`Ошибка экспорта для Telegram: ${err}`)
    } finally {
      setIsExporting(false)
    }
  }

  // Export 1-Click: Audio only (MP3 320 kbps)
  const handleExportAudioOnly = async () => {
    try {
      if (!filePath) {
        alert('Сначала выберите видеофайл')
        return
      }

      const cuts = items
        .filter((i): i is { type: 'silence'; data: SilenceGap } => i.type === 'silence' && i.data.isCut)
        .map((s) => [s.data.startTime, s.data.endTime])
        .filter(([start, end]) => end > start)

      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, '') || 'audio'
      const defaultName = bgMusicPath ? `${baseName}_audio_mix.mp3` : `${baseName}_clean_voice.mp3`

      const outputPath = await invoke<string | null>('select_save_file_cmd', {
        title: 'Экспорт аудио MP3 (320 kbps)',
        filter: 'MP3 Аудио (*.mp3)|*.mp3',
        defaultName,
      })
      if (!outputPath) return

      setIsExporting(true)
      setIsExportMenuOpen(false)
      await invoke('export_audio_only_cmd', {
        inputPath: filePath,
        cuts,
        outputPath,
        totalDuration,
        bitrateKbps: 320,
        bgMusicPath,
        bgMusicVolume,
        autoDucking,
        duckingPreset,
        transitionSmoothing,
      })
      alert(`Аудиофайл успешно сохранён:\n${outputPath}`)
    } catch (err) {
      alert(`Ошибка экспорта аудио: ${err}`)
    } finally {
      setIsExporting(false)
    }
  }

  // Export Cover Image
  const handleExportCover = async () => {
    try {
      if (!filePath) {
        alert('Сначала выберите видеофайл')
        return
      }

      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, '') || 'cover'
      const defaultName = `${baseName}_cover_${Math.round(coverTime)}s.png`

      const outputPath = await invoke<string | null>('select_save_file_cmd', {
        title: 'Сохранить обложку для Reels/Shorts',
        filter: 'PNG Изображение (*.png)|*.png|JPEG Изображение (*.jpg)|*.jpg',
        defaultName,
      })
      if (!outputPath) return

      setIsExporting(true)
      await invoke('export_cover_image_cmd', {
        inputPath: filePath,
        time: coverTime,
        outputPath,
        framingMode: coverFraming,
        colorPreset: coverColor,
        titleText: coverTitleStyle !== 'none' && coverTitle.trim() ? coverTitle.trim() : null,
        titleStyle: coverTitleStyle,
      })
      alert(`Обложка сохранена:\n${outputPath}`)
      setIsCoverModalOpen(false)
    } catch (err) {
      alert(`Ошибка сохранения обложки: ${err}`)
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
        transitionSmoothing,
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
        transitionSmoothing,
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
      if (e.code === 'Escape') {
        if (isSubtitleMenuOpen) {
          setIsSubtitleMenuOpen(false)
          return
        }
        if (isExportMenuOpen) {
          setIsExportMenuOpen(false)
          return
        }
        if (isSettingsOpen) {
          setIsSettingsOpen(false)
          return
        }
        if (isCoverModalOpen) {
          setIsCoverModalOpen(false)
          return
        }
      }
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
  }, [isPlaying, currentTime, totalDuration, isSubtitleMenuOpen, isExportMenuOpen, isSettingsOpen, isCoverModalOpen])

  const fileName = filePath ? filePath.split(/[\\/]/).pop() : 'Выберите видео'

  return (
    <div className="flex flex-col h-screen w-screen bg-zinc-950 text-zinc-100 font-sans select-none overflow-hidden">
      
      {/* 1. STUDIO APP BAR (52px) */}
      <header className="h-13 py-2 px-4 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-xl flex items-center justify-between flex-shrink-0 z-20">
        
        {/* Left: Branding & File Info */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 p-[1px] shadow-sm flex-shrink-0">
              <div className="w-full h-full bg-zinc-950 rounded-[7px] flex items-center justify-center text-white">
                <Scissors className="w-4 h-4 text-zinc-100" />
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold tracking-tight text-white">SubCut</span>
              <span className="text-[10px] font-mono uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-800">
                Studio
              </span>
            </div>
          </div>

          <div className="h-4 w-px bg-zinc-800" />

          {/* Clickable File Selector */}
          <button
            onClick={handleOpenFile}
            disabled={isAnalyzing}
            className="flex items-center gap-2 h-8 px-3 rounded-lg bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-xs font-medium text-zinc-200 hover:text-white transition max-w-xs truncate shadow-sm disabled:opacity-50"
            title="Выбрать видео для монтажа"
          >
            <FolderOpen className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
            <span className="font-mono truncate">
              {isAnalyzing ? (analyzingStatus || 'Анализ видео...') : fileName}
            </span>
          </button>

          {/* Clean File Info Metrics Pill */}
          {filePath && (
            <div className="hidden lg:flex items-center gap-2 px-2.5 h-8 rounded-lg bg-zinc-900/60 border border-zinc-800/80 text-xs font-mono tabular-nums text-zinc-400">
              <span className="text-zinc-200 font-medium">{formatTime(totalDuration)}</span>
              <span className="text-zinc-700">•</span>
              <span>{phraseList.length} фраз</span>
              <span className="text-zinc-700">•</span>
              <span>{silences.length} пауз</span>
              {cutDuration > 0 && (
                <>
                  <span className="text-zinc-700">•</span>
                  <span className="text-emerald-400 font-semibold">-{cutDuration.toFixed(1)} с</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Center: Framing, Colors & Subtitles Toolbar */}
        <div className="hidden md:flex items-center gap-2">
          {/* Framing mode segmented control */}
          <div className="flex items-center p-0.5 rounded-lg bg-zinc-900/90 border border-zinc-800 shadow-sm">
            <button
              onClick={() => setFramingMode('original')}
              className={`h-7 px-2.5 rounded-md text-xs font-medium transition flex items-center gap-1.5 ${
                framingMode === 'original'
                  ? 'bg-zinc-800 text-zinc-100 shadow-sm font-semibold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="Оригинальный формат кадра"
            >
              <Monitor className="w-3.5 h-3.5" />
              <span>Оригинал</span>
            </button>
            <button
              onClick={() => setFramingMode('blur_9_16')}
              className={`h-7 px-2.5 rounded-md text-xs font-medium transition flex items-center gap-1.5 ${
                framingMode === 'blur_9_16'
                  ? 'bg-indigo-950/80 text-indigo-200 border border-indigo-700/70 shadow-sm font-semibold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="9:16 с размытием фона для Reels/Shorts"
            >
              <Smartphone className="w-3.5 h-3.5 text-indigo-400" />
              <span>9:16 Reels</span>
            </button>
          </div>

          {/* Color Presets segmented control */}
          <div className="flex items-center p-0.5 rounded-lg bg-zinc-900/90 border border-zinc-800 shadow-sm">
            <Palette className="w-3.5 h-3.5 text-zinc-400 ml-2 mr-1" />
            {[
              { id: 'none' as const, label: 'Ориг' },
              { id: 'anime_punch' as const, label: 'Anime' },
              { id: 'cinematic' as const, label: 'Кино' },
              { id: 'crisp' as const, label: 'Чётко' },
            ].map((cp) => (
              <button
                key={cp.id}
                onClick={() => setColorPreset(cp.id)}
                className={`h-7 px-2 rounded-md text-xs font-medium transition ${
                  colorPreset === cp.id
                    ? 'bg-zinc-800 text-zinc-100 font-semibold shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {cp.label}
              </button>
            ))}
          </div>

          {/* Subtitles Quick Toggle & Popover */}
          <div className="relative">
            <div
              className={`h-8 rounded-lg border flex items-center transition shadow-sm ${
                burnSubtitles
                  ? 'bg-zinc-800 text-zinc-100 border-zinc-700'
                  : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
              }`}
            >
              <button
                onClick={() => {
                  const nextVal = !burnSubtitles
                  setBurnSubtitles(nextVal)
                  if (!nextVal) setIsSubtitleMenuOpen(false)
                }}
                className="h-full px-2.5 flex items-center gap-1.5 text-xs font-medium hover:text-white transition"
                title={burnSubtitles ? 'Отключить субтитры' : 'Включить субтитры'}
              >
                <Type className={`w-3.5 h-3.5 ${burnSubtitles ? 'text-amber-400' : 'text-zinc-500'}`} />
                <span>Субтитры</span>
              </button>
              {burnSubtitles && (
                <button
                  onClick={() => {
                    setIsSubtitleMenuOpen(!isSubtitleMenuOpen)
                    setIsExportMenuOpen(false)
                  }}
                  className="h-full px-2 border-l border-zinc-700/80 hover:bg-zinc-700/50 flex items-center gap-1.5 text-xs font-medium transition text-amber-300"
                  title="Настроить субтитры: размер, стиль, положение"
                >
                  <span>
                    {subtitlePreset === 'hormozi' ? 'Караоке' : subtitlePreset === 'box' ? 'Плашка' : 'Классик'}
                  </span>
                  <span className="font-mono tabular-nums text-[11px] opacity-80">
                    {subtitleSize}px
                  </span>
                  <ChevronDown className="w-3 h-3 text-zinc-400 shrink-0" />
                </button>
              )}
            </div>

            {/* Subtitle Quick Popover Backdrop */}
            {isSubtitleMenuOpen && burnSubtitles && (
              <div
                className="fixed inset-0 z-30 bg-transparent"
                onClick={() => setIsSubtitleMenuOpen(false)}
              />
            )}

            {/* Subtitle Quick Popover */}
            {isSubtitleMenuOpen && burnSubtitles && (
              <div
                className="absolute right-0 top-full mt-1.5 w-80 bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl p-3.5 z-40 text-xs animate-in fade-in duration-100 space-y-3"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                  <span className="font-semibold text-zinc-100 flex items-center gap-2">
                    <Type className="w-3.5 h-3.5 text-amber-400" />
                    Оформление субтитров
                  </span>
                  <button
                    onClick={() => setIsSubtitleMenuOpen(false)}
                    className="w-6 h-6 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center transition"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Style */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-zinc-400">Стиль отображения</label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { id: 'hormozi' as const, title: 'Караоке' },
                      { id: 'classic' as const, title: 'Классик' },
                      { id: 'box' as const, title: 'Плашка' },
                    ].map((st) => (
                      <button
                        key={st.id}
                        onClick={() => setSubtitlePreset(st.id)}
                        className={`py-1.5 px-2 rounded-md border text-center transition font-medium text-xs ${
                          subtitlePreset === st.id
                            ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm font-semibold'
                            : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {st.title}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Font Size */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] font-medium text-zinc-400">Размер шрифта</label>
                    <span className="font-mono text-xs text-amber-300 font-semibold tabular-nums">{subtitleSize} px</span>
                  </div>
                  {/* Preset Pills */}
                  <div className="grid grid-cols-4 gap-1.5">
                    {[
                      { size: 42, label: '42', title: 'Компактный (42px)' },
                      { size: 54, label: '54', title: 'Стандарт (54px)' },
                      { size: 66, label: '66', title: 'Крупный (66px)' },
                      { size: 78, label: '78', title: 'Огромный (78px)' },
                    ].map((sz) => (
                      <button
                        key={sz.size}
                        onClick={() => setSubtitleSize(sz.size)}
                        title={sz.title}
                        className={`py-1 rounded-md border text-center font-mono text-xs tabular-nums transition ${
                          subtitleSize === sz.size
                            ? 'bg-amber-400 text-zinc-950 border-amber-300 font-bold shadow-sm'
                            : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {sz.label}
                      </button>
                    ))}
                  </div>
                  {/* Slider */}
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-[10px] text-zinc-500 font-mono tabular-nums">36</span>
                    <input
                      type="range"
                      min={36}
                      max={90}
                      step={2}
                      value={subtitleSize}
                      onChange={(e) => setSubtitleSize(Number(e.target.value))}
                      className="flex-1 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-amber-400"
                    />
                    <span className="text-[10px] text-zinc-500 font-mono tabular-nums">90</span>
                  </div>
                </div>

                {/* Vertical Position */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-zinc-400">Положение в кадре</label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { id: 'bottom' as const, label: 'Снизу' },
                      { id: 'center' as const, label: 'По центру' },
                      { id: 'top' as const, label: 'Сверху' },
                    ].map((pos) => (
                      <button
                        key={pos.id}
                        onClick={() => setSubtitlePosition(pos.id)}
                        className={`py-1.5 px-2 rounded-md border text-center transition font-medium text-xs ${
                          subtitlePosition === pos.id
                            ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm font-semibold'
                            : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {pos.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Studio Tools & Primary CTA Export */}
        <div className="flex items-center gap-2">
          
          {/* Background Music Button */}
          <button
            onClick={() => {
              if (!bgMusicPath) {
                handleSelectBgMusic()
              } else {
                setIsSettingsOpen(true)
              }
            }}
            className={`h-8 px-2.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition shadow-sm ${
              bgMusicPath
                ? 'bg-indigo-950/80 text-indigo-200 border-indigo-700/80 hover:bg-indigo-900/60'
                : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border-zinc-800'
            }`}
            title={bgMusicPath ? `Фоновая музыка: ${bgMusicName} (${Math.round(bgMusicVolume * 100)}%)` : 'Выбрать фоновую музыку'}
          >
            <Music className={`w-3.5 h-3.5 ${bgMusicPath ? 'text-indigo-400' : 'text-zinc-400'}`} />
            <span className="hidden sm:inline">Музыка</span>
            {bgMusicPath && (
              <span className="text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded bg-indigo-900/80 text-indigo-200 font-semibold">
                {Math.round(bgMusicVolume * 100)}%
              </span>
            )}
          </button>

          {/* Smart Cover Generator Button */}
          <button
            onClick={() => {
              if (isPlaying && videoRef.current) {
                videoRef.current.pause()
                bgVideoRef.current?.pause()
                setIsPlaying(false)
              }
              if (!coverTitle) {
                const punchy = phraseList.find((p) => p.data.text.length >= 8 && p.data.text.length <= 50) || phraseList[0]
                if (punchy) setCoverTitle(punchy.data.text)
              }
              updateCoverTime(currentTime)
              setIsCoverModalOpen(true)
            }}
            disabled={!filePath || isAnalyzing}
            className="h-8 px-2.5 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white flex items-center gap-1.5 transition disabled:opacity-40 shadow-sm"
            title="Генератор обложки для Reels и Shorts"
          >
            <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
            <span className="hidden sm:inline">Обложка</span>
          </button>

          {/* Settings Modal Button */}
          <button
            onClick={() => {
              setIsSettingsOpen(!isSettingsOpen)
              setIsSubtitleMenuOpen(false)
              setIsExportMenuOpen(false)
            }}
            className={`h-8 px-2.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition shadow-sm ${
              isSettingsOpen
                ? 'bg-zinc-700 text-white border-zinc-500'
                : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border-zinc-800'
            }`}
            title="Параметры монтажа и субтитров"
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-400" />
            <span className="hidden xl:inline">Параметры</span>
          </button>

          <div className="h-4 w-px bg-zinc-800 mx-0.5" />

          {/* Distinct Primary CTA: Export Dropdown */}
          <div className="relative">
            {isExportMenuOpen && (
              <div
                className="fixed inset-0 z-30 bg-transparent"
                onClick={() => setIsExportMenuOpen(false)}
              />
            )}
            <button
              onClick={() => {
                setIsExportMenuOpen(!isExportMenuOpen)
                setIsSubtitleMenuOpen(false)
              }}
              disabled={isExporting || isAnalyzing}
              className="h-8 px-3.5 rounded-lg text-xs font-semibold bg-white hover:bg-zinc-100 text-zinc-950 flex items-center gap-1.5 transition shadow-md shadow-white/5 border border-white/20 active:scale-[0.98] disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>{isExporting ? 'Экспорт...' : 'Экспорт'}</span>
              <ChevronDown className="w-3.5 h-3.5 text-zinc-700 -mr-0.5" />
            </button>

            {/* Export Menu Dropdown */}
            {isExportMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-72 bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl py-2 z-40 text-xs animate-in fade-in duration-100">
                <button
                  onClick={handleExportReels}
                  className="w-full px-3.5 py-2.5 text-left hover:bg-zinc-800/80 flex items-center gap-3 text-zinc-200 transition"
                >
                  <Sparkles className="w-4 h-4 text-pink-400 flex-shrink-0" />
                  <div>
                    <div className="font-semibold text-white">Reels и Shorts (1080×1920)</div>
                    <div className="text-[11px] text-zinc-400">9:16 с размытием фона и субтитрами</div>
                  </div>
                </button>

                <button
                  onClick={handleExportTelegram}
                  className="w-full px-3.5 py-2.5 text-left hover:bg-zinc-800/80 flex items-center gap-3 text-zinc-200 transition"
                >
                  <Send className="w-4 h-4 text-sky-400 flex-shrink-0" />
                  <div>
                    <div className="font-semibold text-white">Telegram (&lt; 50 МБ)</div>
                    <div className="text-[11px] text-zinc-400">Сжатие до 48 МБ без потери качества</div>
                  </div>
                </button>

                <button
                  onClick={handleExportAudioOnly}
                  className="w-full px-3.5 py-2.5 text-left hover:bg-zinc-800/80 flex items-center gap-3 text-zinc-200 transition"
                >
                  <Music className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  <div>
                    <div className="font-semibold text-white">Аудиодорожка (MP3 320 кбит/с)</div>
                    <div className="text-[11px] text-zinc-400">Экспорт сведённого звука без пауз</div>
                  </div>
                </button>

                <button
                  onClick={handleExportMP4}
                  className="w-full px-3.5 py-2.5 text-left hover:bg-zinc-800/80 flex items-center gap-3 text-zinc-200 transition"
                >
                  <Zap className="w-4 h-4 text-amber-400 flex-shrink-0" />
                  <div>
                    <div className="font-semibold text-zinc-200">Мастер-видео (MP4)</div>
                    <div className="text-[11px] text-zinc-400">Экспорт с текущими параметрами</div>
                  </div>
                </button>

                <div className="h-px bg-zinc-800 my-1.5" />

                <button
                  onClick={handleExportSRT}
                  className="w-full px-3.5 py-2 text-left hover:bg-zinc-800/80 flex items-center gap-3 text-zinc-200 transition"
                >
                  <FileText className="w-4 h-4 text-zinc-400 flex-shrink-0" />
                  <div>
                    <div className="font-medium">Субтитры SRT</div>
                    <div className="text-[11px] text-zinc-400">Файл таймкодов для внешних плееров</div>
                  </div>
                </button>

                <button
                  onClick={handleExportEDL}
                  className="w-full px-3.5 py-2 text-left hover:bg-zinc-800/80 flex items-center gap-3 text-zinc-200 transition"
                >
                  <Clapperboard className="w-4 h-4 text-zinc-400 flex-shrink-0" />
                  <div>
                    <div className="font-medium">Таймлайн EDL</div>
                    <div className="text-[11px] text-zinc-400">Импорт в Premiere Pro и DaVinci Resolve</div>
                  </div>
                </button>
              </div>
            )}
          </div>

        </div>
      </header>

      {/* 2. MAIN SPLIT: Video Left / Clean Script Right */}
      <div
        className="flex-1 flex overflow-hidden relative"
        onClick={() => {
          if (isExportMenuOpen) setIsExportMenuOpen(false)
          if (isSubtitleMenuOpen) setIsSubtitleMenuOpen(false)
        }}
      >
        
        {/* LEFT PANE: Video Player Stage */}
        <section className="w-[50%] lg:w-[48%] border-r border-zinc-800/80 bg-zinc-950 flex flex-col justify-between p-4 flex-shrink-0 relative overflow-hidden">
          
          {/* Ambient backdrop glow behind stage */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-gradient-to-tr from-indigo-500/10 via-purple-500/5 to-amber-500/10 rounded-full blur-3xl pointer-events-none -z-0" />

          {/* Framed Video Container */}
          <div className="relative flex-1 flex items-center justify-center min-h-0 z-10 w-full">
            <div
              className={`relative ${
                framingMode === 'blur_9_16' ? 'aspect-[9/16] h-full max-h-full' : 'w-full h-full max-h-full'
              } bg-black/95 rounded-2xl border border-zinc-800/90 ring-1 ring-white/10 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.95)] flex items-center justify-center select-none overflow-hidden`}
            >
              
              {videoSrc ? (
                <>
                  {/* Blurred background video when 9:16 blur mode is active */}
                  {framingMode === 'blur_9_16' && (
                    <video
                      ref={bgVideoRef}
                      src={videoSrc}
                      muted
                      playsInline
                      className="absolute inset-0 w-full h-full object-cover filter blur-2xl scale-125 opacity-70 pointer-events-none"
                      style={{ filter: `blur(20px) ${getColorFilterStyle(colorPreset)}` }}
                    />
                  )}

                  <video
                    ref={videoRef}
                    src={videoSrc}
                    className={`max-h-full max-w-full ${
                      framingMode === 'blur_9_16' ? 'w-full h-full object-contain relative z-10' : 'object-contain'
                    }`}
                    style={{ filter: getColorFilterStyle(colorPreset) }}
                    playsInline
                    onLoadedMetadata={(e) => {
                      const d = e.currentTarget.duration
                      if (d && !isNaN(d) && d > 0) {
                        setTotalDuration(d)
                      }
                    }}
                    onTimeUpdate={handleTimeUpdate}
                    onPlay={() => {
                      setIsPlaying(true)
                      bgVideoRef.current?.play().catch(() => {})
                      if (bgMusicPath && bgAudioRef.current) {
                        bgAudioRef.current.play().catch(() => {})
                      }
                    }}
                    onPause={() => {
                      setIsPlaying(false)
                      bgVideoRef.current?.pause()
                      bgAudioRef.current?.pause()
                      if (bgVideoRef.current && videoRef.current && framingMode === 'blur_9_16') {
                        bgVideoRef.current.currentTime = videoRef.current.currentTime
                      }
                    }}
                    onSeeked={handleVideoSeeked}
                    onEnded={() => {
                      setIsPlaying(false)
                      bgVideoRef.current?.pause()
                      bgAudioRef.current?.pause()
                    }}
                  />

                  {/* Synchronized preview background music */}
                  {bgMusicPath && (
                    <audio
                      ref={bgAudioRef}
                      src={convertFileSrc(bgMusicPath)}
                      loop
                      preload="auto"
                      onLoadedMetadata={(e) => {
                        e.currentTarget.volume = targetBgVolume
                        if (videoRef.current && e.currentTarget.duration) {
                          const trimmedT = mapOriginalToTrimmed(videoRef.current.currentTime)
                          e.currentTarget.currentTime = trimmedT % e.currentTarget.duration
                        }
                      }}
                    />
                  )}

                  {/* Background Music Status Badge */}
                  {bgMusicPath && (
                    <div className="absolute top-3 left-3 z-20 flex items-center gap-2 px-2.5 py-1 rounded-md bg-black/75 backdrop-blur-md border border-zinc-700/70 text-xs font-mono tabular-nums text-zinc-200 shadow-md pointer-events-none">
                      <Music className={`w-3.5 h-3.5 ${isPlaying ? 'text-indigo-400 animate-pulse' : 'text-zinc-400'}`} />
                      <span className="max-w-[120px] truncate">{bgMusicName}</span>
                      <span className="text-zinc-600">•</span>
                      <span className="text-indigo-300 font-semibold">{Math.round(bgMusicVolume * 100)}%</span>
                      {autoDucking && activePhrase && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-sans font-medium uppercase tracking-wider">
                          Ducked
                        </span>
                      )}
                    </div>
                  )}
                </>
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

              {/* Subtitle Overlay (Disappears during silence, shows 1 short cue at a time synced with speech) */}
              {burnSubtitles && (activePhrase || (!videoSrc && (isSubtitleMenuOpen || isSettingsOpen))) && (() => {
                const phraseData = activePhrase?.data || {
                  id: 'preview',
                  speaker: 'Спикер',
                  startTime: 0,
                  endTime: 2,
                  text: 'Пример оформления субтитров',
                  words: [
                    { word: 'Пример', startTime: 0, endTime: 0.6 },
                    { word: 'оформления', startTime: 0.7, endTime: 1.3 },
                    { word: 'субтитров', startTime: 1.4, endTime: 2.0 },
                  ],
                }
                const isPreview = !activePhrase

                return (
                  <div
                    className={`absolute inset-x-0 ${
                      subtitlePosition === 'top'
                        ? 'top-8'
                        : subtitlePosition === 'center'
                        ? 'top-1/2 -translate-y-1/2'
                        : 'bottom-8'
                    } px-4 text-center pointer-events-none z-10 transition-all duration-150`}
                  >
                    {subtitlePreset === 'hormozi' ? (
                      <div
                        className="inline-block px-4 py-2 rounded-xl bg-black/85 backdrop-blur-sm border border-black/70 shadow-2xl max-w-[85%] text-balance"
                        style={{ fontSize: `${Math.max(13, Math.round(subtitleSize * 0.32))}px`, lineHeight: 1.3 }}
                      >
                        {phraseData.words && phraseData.words.length > 0 ? (
                          phraseData.words.map((w, wIdx) => {
                            const nextWord = phraseData.words![wIdx + 1]
                            const wordEnd = nextWord ? Math.min(w.endTime + 0.15, nextWord.startTime) : w.endTime + 0.2
                            const isWordActive = !isPreview
                              ? (currentTime >= w.startTime && currentTime <= wordEnd)
                              : (wIdx === 0)
                            return (
                              <span
                                key={wIdx}
                                className={`inline-block mx-0.5 px-1 font-black tracking-wide uppercase transition-colors duration-75 ${
                                  isWordActive
                                    ? 'text-amber-300 scale-105 drop-shadow-[0_0_12px_rgba(252,211,77,0.9)]'
                                    : 'text-white'
                                }`}
                              >
                                {w.word}
                              </span>
                            )
                          })
                        ) : (
                          <span className="text-white font-black tracking-wide uppercase">
                            {phraseData.text}
                          </span>
                        )}
                      </div>
                    ) : subtitlePreset === 'box' ? (
                      <div
                        className="inline-block px-4 py-2 rounded-xl bg-black/80 backdrop-blur-sm text-zinc-100 font-semibold border border-zinc-700/80 shadow-2xl max-w-[85%] text-balance"
                        style={{ fontSize: `${Math.max(13, Math.round(subtitleSize * 0.32))}px`, lineHeight: 1.3 }}
                      >
                        {phraseData.text}
                      </div>
                    ) : (
                      <div
                        className="inline-block px-4 py-1.5 text-white font-bold max-w-[85%] text-balance"
                        style={{
                          fontSize: `${Math.max(13, Math.round(subtitleSize * 0.32))}px`,
                          lineHeight: 1.3,
                          textShadow: '0 2px 4px rgba(0,0,0,0.95), 0 0 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,1)',
                        }}
                      >
                        {phraseData.text}
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* Timecode badge */}
              <div className="absolute top-3 right-3 pointer-events-none z-10">
                <span className="text-xs font-mono tabular-nums font-medium px-2.5 py-1 rounded-md bg-black/75 text-zinc-200 backdrop-blur-md border border-zinc-700/70 shadow-md">
                  {formatTime(currentTime)}
                </span>
              </div>
            </div>
          </div>

          {/* Floating Transport Bar */}
          <div className="pt-3 mt-2 border-t border-zinc-900/80 flex items-center justify-between text-xs flex-shrink-0 z-10">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => seekTo(0)}
                className="w-8 h-8 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-zinc-200 flex items-center justify-center transition shadow-sm"
                title="В начало (Home)"
              >
                <SkipBack className="w-4 h-4" />
              </button>
              <button
                onClick={() => seekTo(currentTime - 2)}
                className="h-8 px-2.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-zinc-200 flex items-center gap-1 font-mono text-xs tabular-nums transition shadow-sm"
                title="Назад на 2 сек (←)"
              >
                <span>-2с</span>
              </button>
              
              {/* Primary circular play/pause button */}
              <button
                onClick={togglePlay}
                className="h-9 w-24 rounded-full bg-white hover:bg-zinc-100 text-zinc-950 font-semibold flex items-center justify-center gap-2 transition shadow-md active:scale-95 mx-1"
                title="Воспроизведение / Пауза (Пробел)"
              >
                {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
                <span className="text-xs">{isPlaying ? 'Пауза' : 'Старт'}</span>
              </button>

              <button
                onClick={() => seekTo(currentTime + 2)}
                className="h-8 px-2.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-zinc-200 flex items-center gap-1 font-mono text-xs tabular-nums transition shadow-sm"
                title="Вперёд на 2 сек (→)"
              >
                <span>+2с</span>
              </button>
              <button
                onClick={() => seekTo(totalDuration)}
                className="w-8 h-8 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-zinc-200 flex items-center justify-center transition shadow-sm"
                title="В конец (End)"
              >
                <SkipForward className="w-4 h-4" />
              </button>
            </div>

            {/* Timecode display */}
            <div className="flex items-center gap-2 font-mono tabular-nums text-xs">
              <span className="px-2.5 py-1 rounded-md bg-zinc-900 border border-zinc-800/80 text-zinc-300">
                <strong className="text-white font-semibold">{formatTime(currentTime)}</strong>
                <span className="text-zinc-600 mx-1">/</span>
                <span className="text-zinc-400">{formatTime(totalDuration)}</span>
              </span>
              {cutDuration > 0 && (
                <span className="hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-950/40 border border-emerald-800/50 text-emerald-300 text-xs">
                  Итог: <strong>{formatTime(remainingDuration)}</strong>
                </span>
              )}
            </div>
          </div>

        </section>

        {/* RIGHT PANE: Transcript Stage (Скрипт) */}
        <section className="flex-1 bg-zinc-900/40 flex flex-col overflow-hidden">
          
          {/* Header & Search */}
          <div className="h-13 py-2 px-4 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur-xl flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2.5">
              <FileText className="w-4 h-4 text-zinc-400" />
              <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">
                Скрипт
              </span>
              <span className="text-xs font-mono tabular-nums px-2.5 py-0.5 rounded-full bg-zinc-800/80 text-zinc-400 border border-zinc-700/60">
                {phraseList.length} фраз • {silences.length} пауз
              </span>
            </div>
            
            <div className="flex items-center gap-2">
              {/* Pause Visibility Toggle */}
              <button
                onClick={() => setShowPauses(!showPauses)}
                className={`h-8 px-2.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition shadow-sm ${
                  showPauses
                    ? 'bg-zinc-800 text-zinc-200 border-zinc-700'
                    : 'bg-zinc-900 text-zinc-500 border-zinc-800'
                }`}
                title="Показать или скрыть паузы в тексте"
              >
                {showPauses ? <Eye className="w-3.5 h-3.5 text-zinc-400" /> : <EyeOff className="w-3.5 h-3.5 text-zinc-500" />}
                <span className="hidden sm:inline">Паузы</span>
              </button>

              {/* Batch Cut/Restore Action */}
              {activeCuts.length === silences.length && silences.length > 0 ? (
                <button
                  onClick={handleRestoreAll}
                  className="h-8 px-2.5 rounded-lg text-xs font-medium bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 flex items-center gap-1.5 transition shadow-sm"
                  title="Восстановить все паузы"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-zinc-400" />
                  <span className="hidden sm:inline">Восстановить</span>
                </button>
              ) : (
                <button
                  onClick={handleCutAll}
                  className="h-8 px-2.5 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-red-300 hover:text-red-200 flex items-center gap-1.5 transition shadow-sm"
                  title="Вырезать все найденные паузы"
                >
                  <Scissors className="w-3.5 h-3.5 text-red-400" />
                  <span className="hidden sm:inline">Вырезать всё</span>
                </button>
              )}

              {/* Search in transcript */}
              <div className="relative w-48 sm:w-56">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Поиск по тексту..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full h-8 pl-8 pr-7 rounded-lg bg-zinc-950/80 border border-zinc-800 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 transition"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="w-4 h-4 absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 flex items-center justify-center"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Subheader Status Bar */}
          <div className="h-8 px-4 border-b border-zinc-800/60 bg-zinc-950/50 flex items-center justify-between text-xs font-sans text-zinc-400 flex-shrink-0">
            <div className="flex items-center gap-1.5 text-zinc-400">
              <Zap className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              <span>Клик по фразе — переход, по паузе — вырезка</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs font-mono tabular-nums text-zinc-400">
              <span>Whisper: <strong className="text-zinc-200 font-medium">{whisperModel}</strong></span>
              <span className="text-zinc-600">•</span>
              <span><strong className="text-zinc-200 font-medium">{speechLanguage.toUpperCase()}</strong></span>
            </div>
          </div>

          {/* Script Body */}
          <div className="flex-1 overflow-y-auto p-4 md:p-5 space-y-2.5">

            {(() => {
              const isSearching = searchQuery.trim() !== ''
              const matchingPhrases = phraseList.filter((p) =>
                p.data.text.toLowerCase().includes(searchQuery.toLowerCase().trim())
              )

              if (isSearching && matchingPhrases.length === 0) {
                return (
                  <div className="flex flex-col items-center justify-center p-10 text-center text-zinc-500 select-none">
                    <Search className="w-8 h-8 mb-2.5 text-zinc-600" />
                    <div className="text-sm font-medium text-zinc-400">Ничего не найдено</div>
                    <div className="text-xs text-zinc-500 mt-1">По запросу «{searchQuery}» фразы отсутствуют</div>
                  </div>
                )
              }

              return items.map((item) => {
                if (item.type === 'phrase') {
                  const isActive = activePhrase?.data.id === item.data.id
                  const matchesSearch = !isSearching || item.data.text.toLowerCase().includes(searchQuery.toLowerCase().trim())
                  if (!matchesSearch) return null

                  return (
                    <div
                      key={item.data.id}
                      ref={isActive ? activePhraseCardRef : undefined}
                      className={`group transition-all rounded-xl p-3 border ${
                        isActive
                          ? 'bg-zinc-900/95 border-amber-400/50 border-l-4 border-l-amber-400 shadow-lg shadow-amber-950/20 ring-1 ring-amber-400/30'
                          : 'bg-zinc-900/40 border-zinc-800/80 hover:bg-zinc-900/70 hover:border-zinc-700/80'
                      }`}
                    >
                      {/* Header: Speaker Tag, Timecode Jump, Duration, Active Badge */}
                      <div
                        onClick={() => seekTo(item.data.startTime)}
                        className="flex items-center justify-between text-xs mb-2 select-none cursor-pointer"
                        title="Нажмите для перехода к фразе"
                      >
                        <div className="flex items-center gap-2">
                          <div className="inline-flex items-center gap-1.5 px-2.5 h-6 rounded-full bg-zinc-800/90 border border-zinc-700/60 text-xs font-sans font-medium text-zinc-200 shadow-sm">
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />
                            <span>{item.data.speaker || 'Спикер'}</span>
                          </div>

                          <button
                            type="button"
                            onClick={() => seekTo(item.data.startTime)}
                            className="inline-flex items-center gap-1.5 px-2 h-6 rounded-md bg-zinc-800/50 hover:bg-zinc-800 border border-zinc-700/50 hover:border-zinc-600 text-xs font-mono tabular-nums text-zinc-300 hover:text-white transition shadow-sm"
                            title="Перейти к началу фразы"
                          >
                            <Play className="w-2.5 h-2.5 fill-current text-indigo-400 shrink-0" />
                            <span>{formatTime(item.data.startTime)} – {formatTime(item.data.endTime)}</span>
                          </button>

                          <span className="text-xs font-mono tabular-nums text-zinc-400">
                            ({(item.data.endTime - item.data.startTime).toFixed(1)} с)
                          </span>
                        </div>

                        {isActive && (
                          <div className="inline-flex items-center gap-1.5 px-2.5 h-6 rounded-full bg-amber-400/10 border border-amber-400/30 text-amber-300 text-xs font-sans font-medium shadow-sm">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
                            <span>В эфире</span>
                          </div>
                        )}
                      </div>

                      {/* Clean Auto-Resizing Editable Text */}
                      <AutoResizeTextarea
                        value={item.data.text}
                        onChange={(newText) => handleTextChange(item.data.id, newText)}
                        className="w-full bg-zinc-950/40 hover:bg-zinc-950/60 focus:bg-zinc-950 px-3 py-2 rounded-lg border border-transparent hover:border-zinc-800/80 focus:border-zinc-700 text-sm md:text-base leading-relaxed text-zinc-100 font-sans resize-none focus:outline-none transition-colors selection:bg-zinc-800 overflow-hidden"
                        placeholder="Введите текст субтитров..."
                      />
                    </div>
                  )
                }

                if (item.type === 'silence') {
                  if (isSearching) return null
                  if (!showPauses && item.data.isCut) return null

                  const isCut = item.data.isCut
                  return (
                    <div key={item.data.id} className="relative flex items-center justify-center my-2 select-none">
                      <div className="absolute inset-0 flex items-center" aria-hidden="true">
                        <div
                          className={`w-full border-t transition-colors ${
                            isCut ? 'border-zinc-800/80 border-dashed' : 'border-zinc-800'
                          }`}
                        />
                      </div>

                      <button
                        type="button"
                        onClick={() => toggleSilenceCut(item.data.id)}
                        className={`relative inline-flex items-center gap-2 px-3.5 h-7 rounded-full text-xs font-mono tabular-nums transition shadow-sm ${
                          isCut
                            ? 'bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 hover:border-zinc-700'
                            : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-red-900/60 hover:border-red-800'
                        }`}
                        title={isCut ? 'Пауза вырезана. Нажмите, чтобы восстановить.' : 'Пауза остаётся в видео. Нажмите, чтобы вырезать.'}
                      >
                        <Scissors className={`w-3.5 h-3.5 shrink-0 ${isCut ? 'text-zinc-500' : 'text-red-400'}`} />
                        <span className={isCut ? 'text-zinc-500 line-through' : 'text-zinc-300 font-medium'}>
                          Пауза {item.data.duration.toFixed(1)} с
                        </span>
                        <span
                          className={`text-[11px] font-sans font-medium px-2 py-0.5 rounded-full uppercase tracking-wider ${
                            isCut ? 'bg-zinc-800 text-zinc-400' : 'bg-red-950 text-red-300 border border-red-800/60'
                          }`}
                        >
                          {isCut ? 'Вырезана' : 'Вырезать'}
                        </span>
                      </button>
                    </div>
                  )
                }

                return null
              })
            })()}

          </div>

        </section>

        {/* SETTINGS MODAL */}
        {isSettingsOpen && (
          <div className="absolute inset-0 bg-black/70 backdrop-blur-md z-40 flex items-center justify-center p-4">
            <div className="w-full max-w-xl max-h-[90vh] bg-zinc-900 border border-zinc-700/80 rounded-2xl shadow-2xl p-6 flex flex-col animate-in fade-in duration-150">
              
              {/* Header */}
              <div className="flex items-center justify-between pb-3.5 border-b border-zinc-800 flex-shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-200 shadow-sm">
                    <SlidersHorizontal className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-zinc-100">Параметры проекта</h2>
                    <p className="text-[11px] text-zinc-400">Настройки монтажа, субтитров и звуковой дорожки</p>
                  </div>
                </div>
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="w-8 h-8 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Body Controls */}
              <div className="space-y-4 text-xs overflow-y-auto pr-1 flex-1 py-3">
                
                {/* 1. Framing Mode */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200 flex items-center gap-2">
                      <Smartphone className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Формат кадра</span>
                    </label>
                    <span className="font-sans text-xs text-zinc-400">
                      {framingMode === 'blur_9_16' ? '9:16 с размытием фона' : 'Оригинал'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      onClick={() => setFramingMode('original')}
                      className={`p-2.5 rounded-lg border text-left transition ${
                        framingMode === 'original'
                          ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm'
                          : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      <div className="font-semibold text-xs">Оригинальный формат</div>
                      <div className={`text-[11px] mt-0.5 ${framingMode === 'original' ? 'text-zinc-700' : 'text-zinc-500'}`}>
                        Без изменения соотношения сторон
                      </div>
                    </button>
                    <button
                      onClick={() => setFramingMode('blur_9_16')}
                      className={`p-2.5 rounded-lg border text-left transition ${
                        framingMode === 'blur_9_16'
                          ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm'
                          : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      <div className="font-semibold text-xs">9:16 с размытием фона</div>
                      <div className={`text-[11px] mt-0.5 ${framingMode === 'blur_9_16' ? 'text-zinc-700' : 'text-zinc-500'}`}>
                        Вертикальный формат для Reels и Shorts
                      </div>
                    </button>
                  </div>
                </div>

                <div className="h-px bg-zinc-800 my-2" />

                {/* 2. Visual Color Preset */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200 flex items-center gap-2">
                      <Palette className="w-3.5 h-3.5 text-purple-400" />
                      <span>Цветовой фильтр</span>
                    </label>
                    <span className="font-sans text-xs text-zinc-400">
                      {colorPreset === 'anime_punch' ? 'Anime Punch' : colorPreset === 'cinematic' ? 'Кино' : colorPreset === 'crisp' ? 'Чёткость' : 'Оригинал'}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { id: 'none' as const, title: 'Оригинал', desc: 'Без фильтра' },
                      { id: 'anime_punch' as const, title: 'Anime Punch', desc: 'Сочные цвета' },
                      { id: 'cinematic' as const, title: 'Кино', desc: 'Контраст' },
                      { id: 'crisp' as const, title: 'Чёткость', desc: 'Для экранов' },
                    ].map((cp) => (
                      <button
                        key={cp.id}
                        onClick={() => setColorPreset(cp.id)}
                        className={`p-2.5 rounded-lg border text-left transition ${
                          colorPreset === cp.id
                            ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm'
                            : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        <div className="font-semibold text-xs">{cp.title}</div>
                        <div className={`text-[10px] mt-0.5 ${colorPreset === cp.id ? 'text-zinc-700' : 'text-zinc-500'}`}>
                          {cp.desc}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="h-px bg-zinc-800 my-2" />

                {/* 3. Subtitle Customization */}
                <div className="space-y-3 bg-zinc-950/60 p-3.5 rounded-xl border border-zinc-800">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200 flex items-center gap-2">
                      <Type className="w-3.5 h-3.5 text-amber-400" />
                      <span>Субтитры</span>
                    </label>
                    <span className="font-sans text-xs text-amber-300 font-medium">
                      {subtitlePreset === 'hormozi' ? 'Караоке' : subtitlePreset === 'box' ? 'Плашка' : 'Классик'} · <span className="font-mono tabular-nums">{subtitleSize}px</span> · {subtitlePosition === 'bottom' ? 'снизу' : subtitlePosition === 'center' ? 'центр' : 'сверху'}
                    </span>
                  </div>

                  {/* 3.1 Style Preset */}
                  <div className="space-y-1.5">
                    <span className="text-[11px] text-zinc-400">Стиль оформления</span>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { id: 'hormozi' as const, title: 'Караоке', desc: 'Подсветка активного слова' },
                        { id: 'classic' as const, title: 'Классический', desc: 'Белый текст с контуром' },
                        { id: 'box' as const, title: 'Плашка', desc: 'Полупрозрачный фон' },
                      ].map((st) => (
                        <button
                          key={st.id}
                          onClick={() => setSubtitlePreset(st.id)}
                          className={`p-2.5 rounded-lg border text-left transition ${
                            subtitlePreset === st.id
                              ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm'
                              : 'bg-zinc-900/80 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                          }`}
                        >
                          <div className="font-semibold text-xs">{st.title}</div>
                          <div className={`text-[10px] mt-0.5 ${subtitlePreset === st.id ? 'text-zinc-700' : 'text-zinc-500'}`}>
                            {st.desc}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 3.2 Font Size */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-zinc-400">Размер шрифта</span>
                      <span className="font-mono text-xs text-amber-300 font-semibold tabular-nums">{subtitleSize} px</span>
                    </div>
                    {/* Preset Buttons */}
                    <div className="grid grid-cols-4 gap-2">
                      {[
                        { size: 42, title: 'Компактный', desc: '42 px' },
                        { size: 54, title: 'Стандарт', desc: '54 px' },
                        { size: 66, title: 'Крупный', desc: '66 px' },
                        { size: 78, title: 'Огромный', desc: '78 px' },
                      ].map((sz) => (
                        <button
                          key={sz.size}
                          onClick={() => setSubtitleSize(sz.size)}
                          className={`p-2 rounded-lg border text-center transition ${
                            subtitleSize === sz.size
                              ? 'bg-amber-400 text-zinc-950 border-amber-300 shadow-sm'
                              : 'bg-zinc-900/80 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                          }`}
                        >
                          <div className="font-semibold text-xs">{sz.title}</div>
                          <div className={`text-[10px] font-mono tabular-nums ${subtitleSize === sz.size ? 'text-zinc-900 font-bold' : 'text-zinc-500'}`}>
                            {sz.desc}
                          </div>
                        </button>
                      ))}
                    </div>
                    {/* Slider */}
                    <div className="flex items-center gap-2 pt-1">
                      <span className="text-[10px] text-zinc-500 font-mono tabular-nums">36</span>
                      <input
                        type="range"
                        min={36}
                        max={90}
                        step={2}
                        value={subtitleSize}
                        onChange={(e) => setSubtitleSize(Number(e.target.value))}
                        className="flex-1 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-amber-400"
                      />
                      <span className="text-[10px] text-zinc-500 font-mono tabular-nums">90</span>
                    </div>
                  </div>

                  {/* 3.3 Position */}
                  <div className="space-y-1.5">
                    <span className="text-[11px] text-zinc-400">Расположение по вертикали</span>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { id: 'bottom' as const, title: 'Снизу', desc: 'Для Shorts и Reels' },
                        { id: 'center' as const, title: 'По центру', desc: 'В центре кадра' },
                        { id: 'top' as const, title: 'Сверху', desc: 'В верхней трети' },
                      ].map((pos) => (
                        <button
                          key={pos.id}
                          onClick={() => setSubtitlePosition(pos.id)}
                          className={`p-2.5 rounded-lg border text-left transition ${
                            subtitlePosition === pos.id
                              ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm'
                              : 'bg-zinc-900/80 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                          }`}
                        >
                          <div className="font-semibold text-xs">{pos.title}</div>
                          <div className={`text-[10px] mt-0.5 ${subtitlePosition === pos.id ? 'text-zinc-700' : 'text-zinc-500'}`}>
                            {pos.desc}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="h-px bg-zinc-800 my-2" />

                {/* 4. Background Music & Auto-Ducking */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200 flex items-center gap-2">
                      <Music className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Фоновая музыка</span>
                    </label>
                    {bgMusicPath ? (
                      <span className="font-mono text-xs text-indigo-400 font-medium tabular-nums">
                        {Math.round(bgMusicVolume * 100)}% {autoDucking ? `(Авто: ${duckingPreset === 'soft' ? '-10' : duckingPreset === 'hard' ? '-18' : '-14'} dB)` : ''}
                      </span>
                    ) : (
                      <span className="text-[11px] text-zinc-500">Не выбрана</span>
                    )}
                  </div>

                  {!bgMusicPath ? (
                    <button
                      onClick={handleSelectBgMusic}
                      className="w-full h-9 rounded-lg bg-indigo-950/40 hover:bg-indigo-900/50 border border-indigo-700/60 hover:border-indigo-500 text-indigo-200 flex items-center justify-center gap-2 text-xs font-medium transition shadow-sm"
                    >
                      <Music className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Выбрать фоновую музыку</span>
                    </button>
                  ) : (
                    <div className="space-y-2.5 bg-zinc-950/70 p-3 rounded-xl border border-zinc-800">
                      {/* Track Info & Actions */}
                      <div className="flex items-center justify-between gap-2 bg-zinc-900/90 px-3 py-2 rounded-lg border border-zinc-800">
                        <div className="flex items-center gap-2 min-w-0">
                          <Music className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                          <span className="text-xs font-mono text-zinc-200 truncate" title={bgMusicPath}>
                            {bgMusicName}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={handleSelectBgMusic}
                            className="text-[11px] text-zinc-400 hover:text-zinc-200 underline px-1 transition"
                            title="Выбрать другой файл"
                          >
                            Заменить
                          </button>
                          <button
                            onClick={handleClearBgMusic}
                            className="w-6 h-6 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-red-400 flex items-center justify-center transition"
                            title="Удалить трек"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Music Volume Slider */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-zinc-400">Громкость музыки</span>
                          <span className="font-mono text-zinc-200 tabular-nums">{Math.round(bgMusicVolume * 100)}%</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={bgMusicVolume}
                          onChange={(e) => setBgMusicVolume(parseFloat(e.target.value))}
                          className="w-full accent-indigo-500 bg-zinc-800 h-1.5 rounded-lg cursor-pointer"
                        />
                        <div className="flex justify-between text-[10px] text-zinc-600 font-mono tabular-nums">
                          <span>0%</span>
                          <span>15% (по умолчанию)</span>
                          <span>100%</span>
                        </div>
                      </div>

                      {/* Auto-Ducking Toggle & Presets */}
                      <div className="pt-2 border-t border-zinc-800 space-y-2">
                        <label className="flex items-start gap-2.5 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={autoDucking}
                            onChange={(e) => setAutoDucking(e.target.checked)}
                            className="mt-0.5 accent-indigo-500 rounded cursor-pointer"
                          />
                          <div>
                            <div className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
                              <span>Авто-приглушение (Auto-Ducking)</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 font-normal">
                                Речь на первом плане
                              </span>
                            </div>
                            <p className="text-[11px] text-zinc-400 leading-snug mt-0.5">
                              Музыка автоматически стихает при речи и плавно возвращается на паузах
                            </p>
                          </div>
                        </label>

                        {autoDucking && (
                          <div className="pl-6 space-y-1.5 animate-in fade-in duration-100">
                            <span className="text-[11px] text-zinc-400">Глубина приглушения:</span>
                            <div className="grid grid-cols-3 gap-2">
                              {[
                                { id: 'soft' as const, label: 'Мягкое (-10 dB)', desc: 'Легкий спад' },
                                { id: 'medium' as const, label: 'Стандарт (-14 dB)', desc: 'Сбалансированно' },
                                { id: 'hard' as const, label: 'Глубокое (-18 dB)', desc: 'Максимум голоса' },
                              ].map((dp) => (
                                <button
                                  key={dp.id}
                                  onClick={() => setDuckingPreset(dp.id)}
                                  className={`p-2 rounded-lg border text-left transition ${
                                    duckingPreset === dp.id
                                      ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm'
                                      : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                                  }`}
                                >
                                  <div className="font-semibold text-[11px]">{dp.label}</div>
                                  <div className={`text-[10px] mt-0.5 ${duckingPreset === dp.id ? 'text-zinc-700' : 'text-zinc-500'}`}>
                                    {dp.desc}
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="h-px bg-zinc-800 my-2" />

                {/* 5. GPU Hardware Acceleration */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200 flex items-center gap-2">
                      <Zap className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Аппаратное ускорение (GPU)</span>
                    </label>
                    <span className="font-mono text-emerald-400 font-medium text-xs">
                      {hardwareAccel === 'nvenc' ? 'NVIDIA NVENC' : hardwareAccel === 'cpu' ? 'CPU (libx264)' : 'Автоматически'}
                    </span>
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
                        className={`h-8 rounded-lg border font-mono text-xs transition ${
                          hardwareAccel === opt.id
                            ? 'bg-zinc-100 text-zinc-950 border-white font-medium shadow-sm'
                            : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-zinc-500">
                    NVENC ускоряет экспорт на видеокартах NVIDIA.
                  </p>
                </div>

                <div className="h-px bg-zinc-800 my-2" />

                {/* 6. Pause Detection Mode */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200 flex items-center gap-2">
                      <Scissors className="w-3.5 h-3.5 text-red-400" />
                      <span>Поиск пауз</span>
                    </label>
                    <span className="font-sans text-zinc-400 text-xs">
                      {pauseMode === 'smart' ? 'По речи (Whisper)' : 'По громкости (FFmpeg)'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    {[
                      { val: 'smart', label: 'По речи (Whisper)', desc: 'Паузы между словами, подходит для видео с музыкой' },
                      { val: 'volume', label: 'По громкости', desc: 'Участки тише заданного порога, для записей без музыки' },
                    ].map((opt) => (
                      <button
                        key={opt.val}
                        onClick={() => setPauseMode(opt.val as 'smart' | 'volume')}
                        className={`p-2.5 rounded-lg border text-left transition ${
                          pauseMode === opt.val
                            ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm'
                            : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        <div className="text-xs font-semibold">{opt.label}</div>
                        <div className={`text-[11px] mt-0.5 leading-snug ${pauseMode === opt.val ? 'text-zinc-700' : 'text-zinc-500'}`}>
                          {opt.desc}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Silence Threshold (dB) */}
                {pauseMode === 'volume' && (
                  <div className="space-y-1.5 animate-in fade-in duration-100">
                    <div className="flex items-center justify-between">
                      <label className="font-medium text-zinc-200">Порог громкости</label>
                      <span className="font-mono text-zinc-400 tabular-nums">{silenceThreshold} dB</span>
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
                          className={`h-8 rounded-lg border font-mono text-[11px] tabular-nums transition ${
                            silenceThreshold === opt.val
                              ? 'bg-zinc-100 text-zinc-950 border-white font-medium shadow-sm'
                              : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Minimum Silence Duration */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200">Минимальная пауза</label>
                    <span className="font-mono text-zinc-400 tabular-nums">{minSilenceDuration} с</span>
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
                        className={`h-8 rounded-lg border font-mono text-[11px] tabular-nums transition ${
                          minSilenceDuration === opt.val
                            ? 'bg-zinc-100 text-zinc-950 border-white font-medium shadow-sm'
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
                    className="w-full h-9 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 flex items-center justify-center gap-2 font-medium transition text-xs shadow-sm"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isAnalyzing ? 'animate-spin' : ''}`} />
                    <span>Пересчитать паузы</span>
                  </button>
                )}

                <div className="h-px bg-zinc-800 my-2" />

                {/* 7. Transition Smoothing */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200 flex items-center gap-2">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Сглаживание склеек</span>
                    </label>
                    <span className="font-sans text-zinc-400 text-xs">
                      {transitionSmoothing === 'smooth' ? 'Мягкое (120 мс)' : 'Динамичное (70 мс)'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      onClick={() => setTransitionSmoothing('smooth')}
                      className={`p-2.5 rounded-lg border text-left transition ${
                        transitionSmoothing === 'smooth'
                          ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm'
                          : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      <div className="text-xs font-semibold">Мягкое</div>
                      <div className={`text-[11px] mt-0.5 leading-snug ${transitionSmoothing === 'smooth' ? 'text-zinc-700' : 'text-zinc-500'}`}>
                        Натуральный диалог, микро-фейды 40мс, запас речи 120мс
                      </div>
                    </button>
                    <button
                      onClick={() => setTransitionSmoothing('dynamic')}
                      className={`p-2.5 rounded-lg border text-left transition ${
                        transitionSmoothing === 'dynamic'
                          ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm'
                          : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      <div className="text-xs font-semibold">Динамичное</div>
                      <div className={`text-[11px] mt-0.5 leading-snug ${transitionSmoothing === 'dynamic' ? 'text-zinc-700' : 'text-zinc-500'}`}>
                        Быстрый темп для рилс, 70мс
                      </div>
                    </button>
                  </div>
                </div>

                <div className="h-px bg-zinc-800 my-2" />

                {/* 8. Whisper Model Selection */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200 flex items-center gap-2">
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
                        className={`h-8 px-2 rounded-lg border text-xs transition ${
                          whisperModel === opt.val
                            ? 'bg-zinc-100 text-zinc-950 border-white font-medium shadow-sm'
                            : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 8. Whisper Language Selection */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-zinc-200 flex items-center gap-2">
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
                        className={`h-8 px-2 rounded-lg border text-xs transition ${
                          speechLanguage === opt.val
                            ? 'bg-zinc-100 text-zinc-950 border-white font-medium shadow-sm'
                            : 'bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-zinc-400">
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
                    className="w-full h-9 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 flex items-center justify-center gap-2 font-medium transition text-xs shadow-sm"
                  >
                    <Sparkles className={`w-3.5 h-3.5 text-amber-400 ${isAnalyzing ? 'animate-spin' : ''}`} />
                    <span>Распознать заново</span>
                  </button>
                )}

              </div>

              {/* Footer */}
              <div className="flex justify-end pt-3.5 border-t border-zinc-800 flex-shrink-0 mt-2">
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="h-9 px-5 rounded-lg bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-semibold transition shadow-sm"
                >
                  Готово
                </button>
              </div>

            </div>
          </div>
        )}

        {/* SMART COVER / POSTER GENERATOR MODAL */}
        {isCoverModalOpen && (
          <div className="absolute inset-0 bg-black/80 backdrop-blur-md z-40 flex items-center justify-center p-4">
            <div className="w-full max-w-4xl bg-zinc-900 border border-zinc-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] animate-in fade-in duration-150">
              
              {/* Modal Header */}
              <div className="h-12 px-5 border-b border-zinc-800 flex items-center justify-between flex-shrink-0 bg-zinc-900/80">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-indigo-950/80 border border-indigo-800/80 flex items-center justify-center text-indigo-300 shadow-sm">
                    <ImageIcon className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-zinc-100">Генератор обложки для Reels и Shorts</h2>
                    <p className="text-[11px] text-zinc-400">Экспорт стоп-кадра с типографикой для публикации</p>
                  </div>
                </div>
                <button
                  onClick={() => setIsCoverModalOpen(false)}
                  className="w-8 h-8 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
                
                {/* Left Column: 9:16 Live Poster Preview */}
                <div className="md:col-span-5 flex flex-col items-center">
                  <div className="text-xs font-medium text-zinc-400 mb-2 flex items-center justify-between w-full max-w-[260px]">
                    <span>Предпросмотр 9:16</span>
                    <span className="font-mono text-zinc-400 tabular-nums">{formatTime(coverTime)}</span>
                  </div>

                  <div className="relative aspect-[9/16] w-full max-w-[260px] bg-black rounded-xl border border-zinc-700/80 overflow-hidden shadow-2xl flex flex-col justify-between select-none">
                    {videoSrc ? (
                      <>
                        {coverFraming === 'blur_9_16' && (
                          <video
                            ref={coverBgRef}
                            src={videoSrc}
                            muted
                            playsInline
                            className="absolute inset-0 w-full h-full object-cover filter blur-2xl scale-125 opacity-75 pointer-events-none"
                            style={{ filter: `blur(20px) ${getColorFilterStyle(coverColor)}` }}
                          />
                        )}
                        <video
                          ref={coverVideoRef}
                          src={videoSrc}
                          muted
                          playsInline
                          className={`w-full h-full object-contain ${coverFraming === 'blur_9_16' ? 'relative z-10' : ''}`}
                          style={{ filter: getColorFilterStyle(coverColor) }}
                        />
                      </>
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-xs">
                        Нет видео
                      </div>
                    )}

                    {/* Styled Title Overlay */}
                    {coverTitleStyle !== 'none' && coverTitle.trim() && (
                      <div className="absolute inset-x-3 bottom-10 z-20 text-center">
                        {coverTitleStyle === 'hormozi' ? (
                          <div className="inline-block px-3.5 py-2 rounded-xl bg-black/85 border border-amber-400/50 shadow-2xl drop-shadow-[0_4px_12px_rgba(0,0,0,1)] max-w-[94%]">
                            <span className="text-amber-300 font-black text-sm uppercase tracking-wider drop-shadow-[0_2px_8px_rgba(0,0,0,1)] break-words leading-tight">
                              {coverTitle}
                            </span>
                          </div>
                        ) : coverTitleStyle === 'neon' ? (
                          <div className="inline-block px-3.5 py-2 rounded-xl bg-black/85 border border-cyan-400/60 shadow-[0_0_20px_rgba(6,182,212,0.45)] max-w-[94%]">
                            <span className="text-cyan-300 font-extrabold text-sm uppercase tracking-wider drop-shadow-[0_0_12px_rgba(34,211,238,0.95)] break-words leading-tight">
                              {coverTitle}
                            </span>
                          </div>
                        ) : (
                          <div className="inline-block px-3.5 py-2 rounded-xl bg-black/60 backdrop-blur-sm shadow-xl max-w-[94%]">
                            <span className="text-white font-bold text-sm drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)] break-words leading-tight">
                              {coverTitle}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Timecode Badge */}
                    <div className="absolute top-3 right-3 z-20">
                      <span className="text-xs font-mono tabular-nums font-medium px-2 py-1 rounded-md bg-black/75 text-zinc-300 backdrop-blur-md border border-zinc-700/70 shadow-md">
                        {formatTime(coverTime)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Right Column: Controls */}
                <div className="md:col-span-7 space-y-4 text-xs">
                  
                  {/* 1. Keyframe Scrubber */}
                  <div className="space-y-2 bg-zinc-950/60 p-3.5 rounded-xl border border-zinc-800">
                    <div className="flex items-center justify-between">
                      <label className="font-semibold text-zinc-200">Выбор кадра</label>
                      <span className="font-mono text-indigo-400 font-medium tabular-nums">
                        {formatTime(coverTime)} / {formatTime(totalDuration)}
                      </span>
                    </div>

                    <input
                      type="range"
                      min={0}
                      max={totalDuration || 1}
                      step={0.1}
                      value={coverTime}
                      onChange={(e) => updateCoverTime(parseFloat(e.target.value))}
                      className="w-full accent-indigo-500 bg-zinc-800 h-1.5 rounded cursor-pointer"
                    />

                    {/* Quick speech phrase badges */}
                    {sampledCoverPhrases.length > 0 && (
                      <div className="pt-1.5 space-y-1.5">
                        <div className="text-[11px] text-zinc-400">Фразы из аудиодорожки:</div>
                        <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto pr-1">
                          {sampledCoverPhrases.map((p) => {
                            const isSelected = Math.abs(coverTime - p.data.startTime) < 0.8
                            return (
                              <button
                                key={p.data.id}
                                onClick={() => {
                                  updateCoverTime(p.data.startTime)
                                  setCoverTitle(p.data.text)
                                }}
                                className={`px-2.5 py-1 rounded-md text-[11px] font-mono tabular-nums border transition text-left truncate max-w-full ${
                                  isSelected
                                    ? 'bg-indigo-950/90 text-indigo-200 border-indigo-700 shadow-sm'
                                    : 'bg-zinc-900/70 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                                }`}
                              >
                                <span className="text-zinc-500 mr-1.5">{formatTime(p.data.startTime)}</span>
                                <span>{p.data.text.slice(0, 32)}{p.data.text.length > 32 ? '...' : ''}</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 2. Title Text Input */}
                  <div className="space-y-1.5 bg-zinc-950/60 p-3.5 rounded-xl border border-zinc-800">
                    <div className="flex items-center justify-between">
                      <label className="font-semibold text-zinc-200">Заголовок на обложке</label>
                      <button
                        onClick={() => {
                          const match = phraseList.find((p) => coverTime >= p.data.startTime && coverTime <= p.data.endTime + 0.4)
                          if (match) setCoverTitle(match.data.text)
                        }}
                        className="text-[11px] text-amber-400 hover:text-amber-300 transition flex items-center gap-1"
                      >
                        <Sparkles className="w-3 h-3" />
                        <span>Вставить фразу из кадра</span>
                      </button>
                    </div>
                    <input
                      type="text"
                      value={coverTitle}
                      onChange={(e) => setCoverTitle(e.target.value)}
                      placeholder="Введите цепляющий заголовок для публикации..."
                      className="w-full h-8 px-3 rounded-lg bg-zinc-900 border border-zinc-700 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 transition"
                    />
                  </div>

                  {/* 3. Title Style Preset */}
                  <div className="space-y-1.5 bg-zinc-950/60 p-3.5 rounded-xl border border-zinc-800">
                    <label className="font-semibold text-zinc-200">Стиль заголовка</label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {[
                        { id: 'hormozi' as const, title: 'Hormozi', desc: 'Золото + обводка' },
                        { id: 'neon' as const, title: 'Неон', desc: 'Свечение' },
                        { id: 'clean' as const, title: 'Классика', desc: 'Белый с тенью' },
                        { id: 'none' as const, title: 'Без текста', desc: 'Чистый кадр' },
                      ].map((st) => (
                        <button
                          key={st.id}
                          onClick={() => setCoverTitleStyle(st.id)}
                          className={`p-2.5 rounded-lg border text-left transition ${
                            coverTitleStyle === st.id
                              ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm'
                              : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                          }`}
                        >
                          <div className="font-semibold text-xs">{st.title}</div>
                          <div className={`text-[10px] mt-0.5 ${coverTitleStyle === st.id ? 'text-zinc-700' : 'text-zinc-500'}`}>
                            {st.desc}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 4. Framing & Color Presets for Cover */}
                  <div className="grid grid-cols-2 gap-3">
                    {/* Framing */}
                    <div className="space-y-1.5 bg-zinc-950/60 p-3 rounded-xl border border-zinc-800">
                      <label className="text-[11px] font-semibold text-zinc-300">Формат кадра</label>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          onClick={() => setCoverFraming('blur_9_16')}
                          className={`h-7 rounded-md border text-[11px] font-medium transition ${
                            coverFraming === 'blur_9_16'
                              ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm'
                              : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                          }`}
                        >
                          9:16 размытие
                        </button>
                        <button
                          onClick={() => setCoverFraming('original')}
                          className={`h-7 rounded-md border text-[11px] font-medium transition ${
                            coverFraming === 'original'
                              ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm'
                              : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                          }`}
                        >
                          Оригинал
                        </button>
                      </div>
                    </div>

                    {/* Color */}
                    <div className="space-y-1.5 bg-zinc-950/60 p-3 rounded-xl border border-zinc-800">
                      <label className="text-[11px] font-semibold text-zinc-300">Цветовой фильтр</label>
                      <div className="grid grid-cols-4 gap-1">
                        {[
                          { id: 'none' as const, label: 'Ориг' },
                          { id: 'anime_punch' as const, label: 'Anime' },
                          { id: 'cinematic' as const, label: 'Кино' },
                          { id: 'crisp' as const, label: 'Чётко' },
                        ].map((cp) => (
                          <button
                            key={cp.id}
                            onClick={() => setCoverColor(cp.id)}
                            className={`h-7 rounded-md border text-[10px] font-medium transition ${
                              coverColor === cp.id
                                ? 'bg-zinc-100 text-zinc-950 border-white shadow-sm'
                                : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                            }`}
                          >
                            {cp.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* 5. Save Action */}
                  <div className="pt-1">
                    <button
                      onClick={handleExportCover}
                      disabled={isExporting}
                      className="w-full h-9 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs flex items-center justify-center gap-2 transition shadow-lg shadow-indigo-950/40 disabled:opacity-50"
                    >
                      <Download className="w-4 h-4" />
                      <span>{isExporting ? 'Сохранение обложки...' : 'Сохранить обложку (PNG / JPG)'}</span>
                    </button>
                  </div>

                </div>

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
      <footer className="h-28 border-t border-zinc-800 bg-zinc-900/90 backdrop-blur flex flex-col justify-between select-none flex-shrink-0 z-20">
        
        {/* Dynamic time ruler ticks with exact percentage positioning and tick marks */}
        <div className="relative h-5 border-b border-zinc-800/50 text-[10px] font-mono tabular-nums text-zinc-500 overflow-hidden">
          {[0, 0.25, 0.5, 0.75, 1].map((pct, idx) => {
            const isFirst = idx === 0
            const isLast = idx === 4
            return (
              <div
                key={pct}
                style={{ left: `${pct * 100}%` }}
                className={`absolute top-0 bottom-0 flex flex-col justify-between ${
                  isFirst
                    ? 'left-0 translate-x-2 items-start'
                    : isLast
                    ? 'left-full -translate-x-full pr-2 items-end'
                    : '-translate-x-1/2 items-center'
                }`}
              >
                <span className={isLast ? 'text-zinc-400 font-medium' : ''}>
                  {formatTime(totalDuration * pct)}
                </span>
                <div className="w-px h-1.5 bg-zinc-700/80" />
              </div>
            )
          })}
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
                className="w-[2px] bg-zinc-400/80 rounded-full"
                style={{ height: `${Math.max(8, peak * 0.7)}%` }}
              />
            ))}
          </div>

          {/* Silence Overlay Zones with pattern */}
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
                    ? 'bg-silence-pattern border-x border-zinc-800 opacity-70'
                    : 'bg-red-950/40 border-x border-red-700/80 hover:bg-red-950/60'
                }`}
                title={`Пауза ${silence.data.duration.toFixed(1)} с (клик — вырезать/оставить)`}
              >
                <span
                  className={`text-[9px] font-mono tabular-nums px-1.5 py-0.5 rounded shadow-sm ${
                    isCut
                      ? 'bg-zinc-900/90 text-zinc-400 line-through border border-zinc-800'
                      : 'bg-red-950 text-red-300 border border-red-800/80 font-medium'
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
        <div className="h-6 px-4 bg-zinc-900/95 border-t border-zinc-800/60 flex items-center justify-between text-xs font-sans text-zinc-400">
          <div className="flex items-center gap-3">
            <span>Пробел — воспроизведение/пауза</span>
            <span className="text-zinc-600">•</span>
            <span className="text-zinc-300">← / → — переход на 2 с</span>
          </div>
          <div className="flex items-center gap-2">
            <span>Паузы: {pauseMode === 'smart' ? 'по речи' : `по громкости (${silenceThreshold} dB)`}</span>
            <span className="text-zinc-600">•</span>
            <span>Мин. пауза: <span className="font-mono tabular-nums">{minSilenceDuration} с</span></span>
            <span className="text-zinc-600">•</span>
            <span className="text-emerald-400 font-medium font-mono">GPU: NVENC</span>
          </div>
        </div>

      </footer>

    </div>
  )
}
