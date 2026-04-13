---
name: youtube-transcript
description: Extract transcripts from YouTube videos using youtube-transcript-api (free, no API key needed for most videos). Use when asked to transcribe, summarize, or analyze a YouTube video, or when video content would help answer a question.
---

# YouTube Transcript Extraction

## CLI Usage

```bash
# Basic — extract English transcript
youtube-transcript-api <video_id>

# Specify language
youtube-transcript-api <video_id> --languages de en

# Output as JSON
youtube-transcript-api <video_id> --format json

# Exclude auto-generated or manually-created captions
youtube-transcript-api <video_id> --exclude-auto-generated
youtube-transcript-api <video_id> --exclude-manually-created
```

**Get the video ID** from the URL: `https://www.youtube.com/watch?v=VIDEO_ID` or `https://youtu.be/VIDEO_ID`.

## Python API (for scripts)

```python
from youtube_transcript_api import YouTubeTranscriptApi

transcript = YouTubeTranscriptApi().fetch('<video_id>')
for snippet in transcript:
    print(f"[{snippet.start:.0f}s] {snippet.text}")
```

## Notes

- Works on most videos that have captions (manual or auto-generated)
- Videos without any captions will fail — try the video page directly to check
- No API key required
- Use `--languages` to specify preferred languages in order (e.g. `--languages en es`)
