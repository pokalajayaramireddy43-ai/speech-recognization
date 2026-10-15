from flask import Flask, render_template, request, jsonify
import os
import re
import uuid
import subprocess
import traceback

import whisper


app = Flask(__name__)

# ============================================================
# PROJECT PATHS
# ============================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")

os.makedirs(UPLOAD_DIR, exist_ok=True)


# ============================================================
# FFMPEG
# ============================================================

FFMPEG_PATH = r"C:\ffmpeg\bin\ffmpeg.exe"


# ============================================================
# WHISPER MODEL
# ============================================================

speech_model = None


# ============================================================
# FILLER WORDS
# ============================================================

FILLER_WORDS = {
    "um",
    "uh",
    "umm",
    "uhh",
    "er",
    "erm",
    "like",
    "actually",
    "basically",
    "literally",
    "well",
    "so"
}


FILLER_PHRASES = {
    "you know"
}


# ============================================================
# NORMALIZE WORD
# ============================================================

def normalize_word(word):
    word = word.lower().strip()

    word = re.sub(
        r"^[^\w]+|[^\w]+$",
        "",
        word
    )

    return word


# ============================================================
# CHECK FFMPEG
# ============================================================

def check_ffmpeg():

    if not os.path.exists(FFMPEG_PATH):
        raise FileNotFoundError(
            "FFmpeg was not found at: "
            + FFMPEG_PATH
        )

    return True


# ============================================================
# CONVERT AUDIO TO WAV
# ============================================================

def run_ffmpeg_to_wav(input_path, output_path):

    check_ffmpeg()

    command = [
        FFMPEG_PATH,
        "-y",
        "-i",
        input_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-sample_fmt",
        "s16",
        output_path
    ]

    print("\nRunning FFmpeg...")
    print("Input:", input_path)
    print("Output:", output_path)

    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )

    if result.returncode != 0:

        print("\nFFMPEG ERROR:")
        print(result.stderr)

        raise RuntimeError(
            "FFmpeg could not convert the audio.\n\n"
            + result.stderr[-2000:]
        )

    if not os.path.exists(output_path):

        raise RuntimeError(
            "FFmpeg finished, but the WAV file was not created."
        )

    print("FFmpeg conversion successful.")

    return output_path


# ============================================================
# EXTRACT WORD TIMESTAMPS
# ============================================================

def clean_words(result):

    words = []

    for segment in result.get("segments", []):

        segment_words = segment.get("words", [])

        for word_info in segment_words:

            text = word_info.get("word", "").strip()

            if not text:
                continue

            start = float(
                word_info.get(
                    "start",
                    segment.get("start", 0)
                )
            )

            end = float(
                word_info.get(
                    "end",
                    segment.get("end", start)
                )
            )

            words.append({
                "word": text,
                "start": round(start, 3),
                "end": round(end, 3)
            })

    return words


# ============================================================
# FALLBACK WORD TIMESTAMPS
# ============================================================

def segment_words_fallback(result):

    words = []

    for segment in result.get("segments", []):

        text = segment.get("text", "").strip()

        if not text:
            continue

        segment_start = float(
            segment.get("start", 0)
        )

        segment_end = float(
            segment.get("end", segment_start)
        )

        tokens = text.split()

        if not tokens:
            continue

        duration = max(
            segment_end - segment_start,
            0.1
        )

        step = duration / len(tokens)

        for index, token in enumerate(tokens):

            start = segment_start + (
                index * step
            )

            end = segment_start + (
                (index + 1) * step
            )

            words.append({
                "word": token,
                "start": round(start, 3),
                "end": round(end, 3)
            })

    return words


# ============================================================
# DETECT FILLERS
# ============================================================

def detect_fillers(words, result):

    fillers = []

    # --------------------------------------------------------
    # Individual filler words
    # --------------------------------------------------------

    for item in words:

        normalized = normalize_word(
            item["word"]
        )

        if normalized in FILLER_WORDS:

            fillers.append({
                "word": item["word"],
                "time": round(
                    float(item["start"]),
                    2
                )
            })

    # --------------------------------------------------------
    # "you know"
    # --------------------------------------------------------

    for segment in result.get("segments", []):

        text = segment.get("text", "")

        lower_text = text.lower()

        match = re.search(
            r"\byou\s+know\b",
            lower_text
        )

        if match:

            segment_start = float(
                segment.get("start", 0)
            )

            segment_end = float(
                segment.get(
                    "end",
                    segment_start
                )
            )

            if len(lower_text) > 0:

                position = (
                    match.start()
                    / len(lower_text)
                )

                estimated_time = (
                    segment_start
                    + (
                        segment_end
                        - segment_start
                    )
                    * position
                )

            else:

                estimated_time = segment_start

            fillers.append({
                "word": "you know",
                "time": round(
                    estimated_time,
                    2
                )
            })

    return fillers


# ============================================================
# DETECT REPETITIONS
# ============================================================

def detect_repetitions(words):

    repetitions = []

    for i in range(1, len(words)):

        current = normalize_word(
            words[i]["word"]
        )

        previous = normalize_word(
            words[i - 1]["word"]
        )

        if not current or not previous:
            continue

        if current == previous:

            repetitions.append({
                "word": words[i]["word"],
                "time": round(
                    float(words[i]["start"]),
                    2
                )
            })

    return repetitions


# ============================================================
# DETECT LONG PAUSES
# ============================================================

def detect_pauses(result):

    pauses = []

    segments = result.get(
        "segments",
        []
    )

    for i in range(1, len(segments)):

        previous_end = float(
            segments[i - 1].get(
                "end",
                0
            )
        )

        current_start = float(
            segments[i].get(
                "start",
                previous_end
            )
        )

        gap = current_start - previous_end

        if gap >= 1.2:

            pauses.append({
                "start": round(
                    previous_end,
                    2
                ),
                "end": round(
                    current_start,
                    2
                ),
                "duration": round(
                    gap,
                    2
                )
            })

    return pauses


# ============================================================
# CALCULATE SCORES
# ============================================================

def calculate_scores(
    wpm,
    fillers,
    pauses,
    repetitions
):

    # --------------------------------------------------------
    # Pace score
    # Ideal conversational range:
    # approximately 120 - 160 WPM
    # --------------------------------------------------------

    if wpm <= 0:

        pace_score = 0

    elif 120 <= wpm <= 160:

        pace_score = 100

    elif 100 <= wpm < 120:

        pace_score = 85

    elif 160 < wpm <= 180:

        pace_score = 85

    elif 80 <= wpm < 100:

        pace_score = 70

    elif 180 < wpm <= 200:

        pace_score = 70

    else:

        pace_score = 55

    # --------------------------------------------------------
    # Fluency
    # --------------------------------------------------------

    fluency_score = 100

    fluency_score -= len(fillers) * 5
    fluency_score -= len(pauses) * 4
    fluency_score -= len(repetitions) * 6

    fluency_score = max(
        0,
        min(100, fluency_score)
    )

    # --------------------------------------------------------
    # Clarity
    # --------------------------------------------------------

    clarity_score = 100

    clarity_score -= len(repetitions) * 5
    clarity_score -= len(fillers) * 3

    clarity_score = max(
        0,
        min(100, clarity_score)
    )

    # --------------------------------------------------------
    # Overall
    # --------------------------------------------------------

    overall = round(
        (
            pace_score
            + fluency_score
            + clarity_score
        ) / 3
    )

    return {
        "pace": pace_score,
        "fluency": fluency_score,
        "clarity": clarity_score,
        "overall": overall
    }


# ============================================================
# BUILD FEEDBACK
# ============================================================

def build_feedback(
    wpm,
    fillers,
    pauses,
    repetitions
):

    feedback = []

    # --------------------------------------------------------
    # Pace
    # --------------------------------------------------------

    if wpm == 0:

        feedback.append(
            "Speech pace could not be calculated."
        )

    elif wpm < 100:

        feedback.append(
            "Your speaking pace is quite slow. "
            "Try connecting your ideas more smoothly."
        )

    elif wpm > 180:

        feedback.append(
            "Your speaking pace is quite fast. "
            "Try slowing down and adding natural pauses."
        )

    else:

        feedback.append(
            "Your speaking pace is in a comfortable range."
        )

    # --------------------------------------------------------
    # Fillers
    # --------------------------------------------------------

    if len(fillers) > 0:

        feedback.append(
            f"You used {len(fillers)} filler word"
            + (
                "s"
                if len(fillers) != 1
                else ""
            )
            + ". Replace fillers with a short silent pause."
        )

    else:

        feedback.append(
            "No obvious filler words were detected."
        )

    # --------------------------------------------------------
    # Repetitions
    # --------------------------------------------------------

    if len(repetitions) > 0:

        feedback.append(
            f"{len(repetitions)} repeated word"
            + (
                "s"
                if len(repetitions) != 1
                else ""
            )
            + " were detected. "
            "Pause briefly before continuing."
        )

    else:

        feedback.append(
            "No immediate repeated-word patterns were detected."
        )

    # --------------------------------------------------------
    # Pauses
    # --------------------------------------------------------

    if len(pauses) > 0:

        longest_pause = max(
            pause["duration"]
            for pause in pauses
        )

        feedback.append(
            f"{len(pauses)} long pause"
            + (
                "s"
                if len(pauses) != 1
                else ""
            )
            + f" detected. The longest was "
            f"{longest_pause:.1f} seconds."
        )

    else:

        feedback.append(
            "No unusually long pauses were detected."
        )

    return feedback


# ============================================================
# HOME PAGE
# ============================================================

@app.route("/")
def index():

    return render_template(
        "index.html"
    )


# ============================================================
# ANALYZE SPEECH
# ============================================================

@app.route(
    "/analyze",
    methods=["POST"]
)
def analyze():

    print("\n")
    print("=" * 60)
    print("ANALYZE REQUEST RECEIVED")
    print("=" * 60)

    print(
        "Files received:",
        list(request.files.keys())
    )

    # --------------------------------------------------------
    # Check uploaded audio
    # --------------------------------------------------------

    if "audio" not in request.files:

        print(
            "ERROR: No 'audio' field received."
        )

        return jsonify({
            "success": False,
            "error": (
                "No audio file was received "
                "by the server."
            )
        }), 400

    file = request.files["audio"]

    print(
        "Filename:",
        file.filename
    )

    print(
        "Content type:",
        file.content_type
    )

    if not file.filename:

        print(
            "ERROR: Empty filename."
        )

        return jsonify({
            "success": False,
            "error": (
                "The uploaded audio has "
                "no filename."
            )
        }), 400

    # --------------------------------------------------------
    # Create temporary file names
    # --------------------------------------------------------

    file_id = str(
        uuid.uuid4()
    )

    extension = os.path.splitext(
        file.filename
    )[1].lower()

    if not extension:

        extension = ".webm"

    input_path = os.path.join(
        UPLOAD_DIR,
        file_id + extension
    )

    wav_path = os.path.join(
        UPLOAD_DIR,
        file_id + "_converted.wav"
    )

    try:

        # ----------------------------------------------------
        # Save uploaded audio
        # ----------------------------------------------------

        file.save(input_path)

        print(
            "Audio saved:",
            input_path
        )

        print(
            "Audio size:",
            os.path.getsize(input_path),
            "bytes"
        )

        # ----------------------------------------------------
        # Convert audio
        # ----------------------------------------------------

        print(
            "Converting audio with FFmpeg..."
        )

        run_ffmpeg_to_wav(
            input_path,
            wav_path
        )

        # ----------------------------------------------------
        # Load Whisper
        # ----------------------------------------------------

        global speech_model

        if speech_model is None:

            print(
                "Loading Whisper base model..."
            )

            speech_model = whisper.load_model(
                "base"
            )

            print(
                "Whisper model loaded."
            )

        # ----------------------------------------------------
        # Transcribe
        # ----------------------------------------------------

        print(
            "Starting Whisper transcription..."
        )

        result = speech_model.transcribe(
            wav_path,
            language="en",
            word_timestamps=True,
            fp16=False,
            temperature=0,
            condition_on_previous_text=False,
            initial_prompt=(
                "This is a speech practice "
                "recording. Preserve spoken "
                "filler words such as um, uh, "
                "umm, uhh, like, actually, "
                "basically, literally, well, "
                "so, you know. Preserve repeated "
                "words such as I I, the the, "
                "I think I think."
            )
        )

        print(
            "Whisper transcription completed."
        )

        # ----------------------------------------------------
        # Transcript
        # ----------------------------------------------------

        transcript = result.get(
            "text",
            ""
        ).strip()

        # ----------------------------------------------------
        # Word timestamps
        # ----------------------------------------------------

        words = clean_words(
            result
        )

        if not words:

            print(
                "Whisper did not provide "
                "word timestamps."
            )

            print(
                "Using segment fallback."
            )

            words = segment_words_fallback(
                result
            )

        # ----------------------------------------------------
        # Detect problems
        # ----------------------------------------------------

        fillers = detect_fillers(
            words,
            result
        )

        repetitions = detect_repetitions(
            words
        )

        pauses = detect_pauses(
            result
        )

        # ----------------------------------------------------
        # Duration
        # ----------------------------------------------------

        duration = 0.0

        segments = result.get(
            "segments",
            []
        )

        if segments:

            duration = max(
                float(
                    segment.get(
                        "end",
                        0
                    )
                )
                for segment in segments
            )

        # ----------------------------------------------------
        # Word count
        # ----------------------------------------------------

        word_count = len(words)

        # ----------------------------------------------------
        # WPM
        # ----------------------------------------------------

        if duration > 0:

            wpm = round(
                (
                    word_count
                    / duration
                ) * 60,
                1
            )

        else:

            wpm = 0

        # ----------------------------------------------------
        # Scores
        # ----------------------------------------------------

        scores = calculate_scores(
            wpm,
            fillers,
            pauses,
            repetitions
        )

        # ----------------------------------------------------
        # Feedback
        # ----------------------------------------------------

        feedback = build_feedback(
            wpm,
            fillers,
            pauses,
            repetitions
        )

        # ----------------------------------------------------
        # Temporal timeline
        # ----------------------------------------------------

        timeline = []

        # Fillers

        for item in fillers:

            timeline.append({
                "type": "filler",
                "label": item.get(
                    "word",
                    "filler"
                ),
                "time": round(
                    float(
                        item.get(
                            "time",
                            0
                        )
                    ),
                    2
                )
            })

        # Repetitions

        for item in repetitions:

            timeline.append({
                "type": "repetition",
                "label": item.get(
                    "word",
                    "repetition"
                ),
                "time": round(
                    float(
                        item.get(
                            "time",
                            0
                        )
                    ),
                    2
                )
            })

        # Pauses

        for item in pauses:

            timeline.append({
                "type": "pause",
                "label": "Long pause",
                "time": round(
                    float(
                        item.get(
                            "start",
                            0
                        )
                    ),
                    2
                ),
                "duration": round(
                    float(
                        item.get(
                            "duration",
                            0
                        )
                    ),
                    2
                )
            })

        # Sort events by time

        timeline.sort(
            key=lambda item: float(
                item.get(
                    "time",
                    0
                )
            )
        )

        # ----------------------------------------------------
        # Terminal debugging
        # ----------------------------------------------------

        print("\n")
        print("=" * 60)
        print("ANALYSIS RESULTS")
        print("=" * 60)

        print(
            "Transcript:",
            transcript
        )

        print(
            "Duration:",
            duration
        )

        print(
            "Word count:",
            word_count
        )

        print(
            "WPM:",
            wpm
        )

        print(
            "Fillers:",
            fillers
        )

        print(
            "Repetitions:",
            repetitions
        )

        print(
            "Pauses:",
            pauses
        )

        print(
            "Scores:",
            scores
        )

        print(
            "Timeline:",
            timeline
        )

        print(
            "=" * 60
        )

        # ----------------------------------------------------
        # Send result to frontend
        # ----------------------------------------------------

        return jsonify({

            "success": True,

            "duration": round(
                duration,
                2
            ),

            "transcript": transcript,

            "word_timestamps": words,

            "timeline": timeline,

            "metrics": {

                "wpm": wpm,

                "fillers": len(
                    fillers
                ),

                "pauses": len(
                    pauses
                ),

                "repetitions": len(
                    repetitions
                )
            },

            "rubric": {

                "pace": scores[
                    "pace"
                ],

                "fluency": scores[
                    "fluency"
                ],

                "clarity": scores[
                    "clarity"
                ],

                "overall": scores[
                    "overall"
                ]
            },

            "overall_score": scores[
                "overall"
            ],

            "feedback": feedback
        })

    # ========================================================
    # ERROR HANDLING
    # ========================================================

    except Exception as e:

        print("\n")
        print("=" * 60)
        print("ANALYSIS ERROR")
        print("=" * 60)

        print(
            "Error type:",
            type(e).__name__
        )

        print(
            "Error:",
            str(e)
        )

        traceback.print_exc()

        print(
            "=" * 60
        )

        return jsonify({

            "success": False,

            "error": str(e),

            "error_type": type(
                e
            ).__name__

        }), 500

    # ========================================================
    # DELETE TEMPORARY FILES
    # ========================================================

    finally:

        for path in [
            input_path,
            wav_path
        ]:

            try:

                if os.path.exists(path):

                    os.remove(path)

                    print(
                        "Deleted temporary file:",
                        path
                    )

            except Exception as cleanup_error:

                print(
                    "Could not delete:",
                    path
                )

                print(
                    cleanup_error
                )


# ============================================================
# RUN APPLICATION
# ============================================================

if __name__ == "__main__":

    print("\n")
    print("=" * 60)
    print("VOCALIS AI - SPEECH ANALYTICS")
    print("=" * 60)

    print(
        "Project folder:",
        BASE_DIR
    )

    print(
        "Upload folder:",
        UPLOAD_DIR
    )

    print(
        "FFmpeg:",
        FFMPEG_PATH
    )

    if os.path.exists(
        FFMPEG_PATH
    ):

        print(
            "FFmpeg status: OK"
        )

    else:

        print(
            "FFmpeg status: NOT FOUND"
        )

    print(
        "Starting Flask server..."
    )

    print(
        "Open: http://127.0.0.1:5000"
    )

    print(
        "=" * 60
    )

    app.run(
        debug=True,
        host="127.0.0.1",
        port=5000
    )