import sys
import json
import os
import warnings

# Suppress library warnings so stdout remains pure JSON
warnings.filterwarnings("ignore")

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

def chunk_words_into_cues(words, speaker='Спикер', max_words=5):
    """
    Splits word-level timestamps into short dynamic subtitle cues
    (split by punctuation . ! ? …, clause punctuation , ; : —,
    breath pauses >= 350ms, and max 4-6 words per cue).
    """
    if not words:
        return []

    # Clean and order words monotonically
    cleaned = []
    last_t = 0.0
    for w in words:
        cw = w['word'].strip()
        if not cw:
            continue
        ws = max(last_t, round(w['startTime'], 2))
        we = max(ws + 0.05, round(w['endTime'], 2))
        last_t = ws
        cleaned.append({
            'word': cw,
            'startTime': ws,
            'endTime': we
        })

    if not cleaned:
        return []

    def is_sentence_end(w):
        clean = w.rstrip('"\'»)”]')
        return clean.endswith(('.', '!', '?', '…'))

    def is_clause_end(w):
        clean = w.rstrip('"\'»)”]')
        return clean.endswith((',', ';', ':', '—', '-'))

    cues = []
    current_words = []
    n = len(cleaned)

    for i in range(n):
        w = cleaned[i]
        current_words.append(w)
        is_last = (i == n - 1)
        should_break = is_last

        if not is_last:
            next_w = cleaned[i + 1]
            pause_to_next = next_w['startTime'] - w['endTime']
            remaining = n - (i + 1)

            if is_sentence_end(w['word']):
                should_break = True
            elif pause_to_next >= 0.35 and len(current_words) >= 1:
                should_break = True
            elif is_clause_end(w['word']) and len(current_words) >= 3:
                should_break = True
            elif len(current_words) >= max_words:
                if remaining == 1 and len(current_words) < max_words + 1 and not is_sentence_end(next_w['word']):
                    should_break = False
                else:
                    should_break = True

        if should_break and current_words:
            c_start = current_words[0]['startTime']
            raw_end = current_words[-1]['endTime']
            if not is_last:
                next_start = cleaned[i + 1]['startTime']
                c_end = max(round(c_start + 0.05, 2), min(raw_end, next_start))
            else:
                c_end = max(round(c_start + 0.20, 2), raw_end)

            c_text = ' '.join(cw['word'] for cw in current_words)
            cues.append({
                'speaker': speaker,
                'startTime': round(c_start, 2),
                'endTime': round(c_end, 2),
                'text': c_text,
                'words': list(current_words)
            })
            current_words = []

    # Final pass: guarantee strict monotonicity between consecutive cues
    for idx in range(len(cues) - 1):
        if cues[idx]['endTime'] > cues[idx + 1]['startTime']:
            cues[idx]['endTime'] = cues[idx + 1]['startTime']

    return cues

def transcribe(video_path, model_name='base', language='ru'):
    import faster_whisper
    # Use selected model (e.g. tiny, base, small) with INT8 quantization and word-level timestamps
    model = faster_whisper.WhisperModel(model_name, device='cpu', compute_type='int8')
    
    transcribe_kwargs = {
        'beam_size': 1,
        'word_timestamps': True,
        'condition_on_previous_text': False,
    }
    
    lang = language.strip().lower() if language else 'ru'
    if lang in ('auto', 'none', ''):
        # Auto detect language
        pass
    else:
        transcribe_kwargs['language'] = lang
        if lang == 'ru':
            transcribe_kwargs['initial_prompt'] = 'Русская речь, субтитры, диалог, четкие фразы.'

    segments, info = model.transcribe(video_path, **transcribe_kwargs)
    
    results = []
    idx = 1
    for s in segments:
        text = s.text.strip()
        if not text:
            continue
            
        words = []
        if s.words:
            for w in s.words:
                clean_w = w.word.strip()
                if clean_w:
                    words.append({
                        'word': clean_w,
                        'startTime': round(w.start, 2),
                        'endTime': round(w.end, 2)
                    })
        
        # If no word timestamps, synthesize words across segment duration
        if not words:
            tokens = text.split()
            if tokens:
                dur = max(0.2, s.end - s.start)
                total_chars = max(1, sum(len(t) for t in tokens))
                cur_t = s.start
                for tidx, tok in enumerate(tokens):
                    tok_dur = max(0.08, dur * (len(tok) / total_chars))
                    w_end = s.end if tidx == len(tokens) - 1 else cur_t + tok_dur
                    words.append({
                        'word': tok,
                        'startTime': round(cur_t, 2),
                        'endTime': round(w_end, 2)
                    })
                    cur_t = w_end

        cues = chunk_words_into_cues(words, speaker='Спикер', max_words=5)
        for cue in cues:
            cue['id'] = f'p-{idx}'
            results.append(cue)
            idx += 1
            
    return results

if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.stdout.buffer.write(b'[]')
        sys.exit(0)
        
    path = sys.argv[1]
    if not os.path.exists(path):
        sys.stderr.write(f'File not found: {path}\n')
        sys.stdout.buffer.write(b'[]')
        sys.exit(0)

    model_name = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2].strip() else 'base'
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3].strip() else 'ru'
    try:
        data = transcribe(path, model_name, language)
        output_bytes = json.dumps(data, ensure_ascii=False).encode('utf-8')
        sys.stdout.buffer.write(output_bytes)
    except Exception as e:
        sys.stderr.write(f'Whisper error: {e}\n')
        sys.stdout.buffer.write(b'[]')
        sys.exit(1)
