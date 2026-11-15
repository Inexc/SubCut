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
        if text:
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
            results.append({
                'id': f'p-{idx}',
                'speaker': 'Спикер',
                'startTime': round(s.start, 2),
                'endTime': round(s.end, 2),
                'text': text,
                'words': words
            })
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
