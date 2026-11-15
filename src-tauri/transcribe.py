import sys
import json
import os

def transcribe(video_path):
    import faster_whisper
    # Use tiny or base model (fast and accurate on CPU)
    model = faster_whisper.WhisperModel('base', device='cpu', compute_type='int8')
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
        print(json.dumps([]))
        sys.exit(0)
        
    path = sys.argv[1]
    try:
        data = transcribe(path)
        print(json.dumps(data, ensure_ascii=False))
    except Exception as e:
        sys.stderr.write(f'Whisper error: {e}\n')
        print(json.dumps([]))
