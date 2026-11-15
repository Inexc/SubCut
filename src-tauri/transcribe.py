import sys
import json
import os

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

def transcribe(video_path, model_name='base'):
    import faster_whisper
    # Use selected model (e.g. tiny, base, small) with INT8 quantization on CPU
    model = faster_whisper.WhisperModel(model_name, device='cpu', compute_type='int8')
    segments, info = model.transcribe(video_path, beam_size=1)
    
    results = []
    idx = 1
    for s in segments:
        text = s.text.strip()
        if text:
            results.append({
                'id': f'p-{idx}',
                'speaker': 'Спикер',
                'startTime': round(s.start, 2),
                'endTime': round(s.end, 2),
                'text': text
            })
            idx += 1
            
    return results

if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.stdout.buffer.write(b'[]')
        sys.exit(0)
        
    path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2].strip() else 'base'
    try:
        data = transcribe(path, model_name)
        output_bytes = json.dumps(data, ensure_ascii=False).encode('utf-8')
        sys.stdout.buffer.write(output_bytes)
    except Exception as e:
        sys.stderr.write(f'Whisper error: {e}\n')
        sys.stdout.buffer.write(b'[]')
