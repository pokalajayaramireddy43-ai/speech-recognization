document.addEventListener("DOMContentLoaded", () => {
    const recordBtn = document.getElementById("recordBtn");
    const stopBtn = document.getElementById("stopBtn");
    const audioFile = document.getElementById("audioFile");
    const recordingStatus = document.getElementById("recordingStatus");
    const audioPreview = document.getElementById("audioPreview");
    const analyzeBtn = document.getElementById("analyzeBtn");
    const loading = document.getElementById("loading");

    const dashboard = document.getElementById("dashboard");

    const overallScore = document.getElementById("overallScore");
    const scoreRingValue = document.getElementById("scoreRingValue");
    const scoreMessage = document.getElementById("scoreMessage");

    const wpm = document.getElementById("wpm");
    const fillers = document.getElementById("fillers");
    const pauses = document.getElementById("pauses");
    const repetitions = document.getElementById("repetitions");

    const fluencyBar = document.getElementById("fluencyBar");
    const fluencyScore = document.getElementById("fluencyScore");

    const paceBar = document.getElementById("paceBar");
    const paceScore = document.getElementById("paceScore");

    const clarityBar = document.getElementById("clarityBar");
    const clarityScore = document.getElementById("clarityScore");

    const timeline = document.getElementById("timeline");
    const timelineScale = document.getElementById("timelineScale");

    const transcript = document.getElementById("transcript");
    const feedback = document.getElementById("feedback");

    const practiceBtn = document.getElementById("practiceBtn");

    let mediaRecorder = null;
    let audioChunks = [];
    let recordedAudioBlob = null;
    let selectedAudioFile = null;
    let currentAudioUrl = null;

    /*
    ============================================================
    INITIAL STATE
    ============================================================
    */

    if (dashboard) {
        dashboard.hidden = true;
    }

    if (stopBtn) {
        stopBtn.disabled = true;
    }

    if (analyzeBtn) {
        analyzeBtn.disabled = true;
    }

    /*
    ============================================================
    HELPER FUNCTIONS
    ============================================================
    */

    function safeNumber(value, fallback = 0) {
        const number = Number(value);

        if (Number.isFinite(number)) {
            return number;
        }

        return fallback;
    }

    function clamp(value, min = 0, max = 100) {
        return Math.min(Math.max(value, min), max);
    }

    function formatTime(seconds) {
        const totalSeconds = Math.max(0, Math.floor(safeNumber(seconds)));

        const minutes = Math.floor(totalSeconds / 60);
        const remainingSeconds = totalSeconds % 60;

        return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
    }

    function formatNumber(value, decimals = 0) {
        const number = safeNumber(value);

        return number.toFixed(decimals);
    }

    function getEventTime(event) {
        if (!event) {
            return 0;
        }

        const possibleValues = [
            event.time,
            event.start,
            event.start_time,
            event.timestamp,
            event.seconds
        ];

        for (const value of possibleValues) {
            const number = Number(value);

            if (Number.isFinite(number)) {
                return Math.max(0, number);
            }
        }

        return 0;
    }

    function getEventEnd(event) {
        if (!event) {
            return getEventTime(event);
        }

        const start = getEventTime(event);

        const possibleEndValues = [
            event.end,
            event.end_time
        ];

        for (const value of possibleEndValues) {
            const number = Number(value);

            if (Number.isFinite(number)) {
                return Math.max(start, number);
            }
        }

        const duration = Number(event.duration);

        if (Number.isFinite(duration)) {
            return start + Math.max(0, duration);
        }

        return start;
    }

    function getEventType(event) {
        const type = String(event?.type || "").toLowerCase();

        if (type.includes("filler")) {
            return "filler";
        }

        if (type.includes("pause")) {
            return "pause";
        }

        if (type.includes("repetition") || type.includes("repeat")) {
            return "repetition";
        }

        return type || "event";
    }

    function getEventLabel(event) {
        if (!event) {
            return "Speech event";
        }

        if (event.label) {
            return String(event.label);
        }

        if (event.word) {
            return String(event.word);
        }

        return "Speech event";
    }

    function setLoading(isLoading) {
        if (loading) {
            loading.hidden = !isLoading;
        }

        if (analyzeBtn) {
            analyzeBtn.disabled = isLoading || !selectedAudioFile;
        }

        if (recordBtn) {
            recordBtn.disabled = isLoading;
        }

        if (audioFile) {
            audioFile.disabled = isLoading;
        }
    }

    function setStatus(message) {
        if (recordingStatus) {
            recordingStatus.textContent = message;
        }
    }

    /*
    ============================================================
    AUDIO PREVIEW
    ============================================================
    */

    function showAudioPreview(fileOrBlob) {
        if (!audioPreview || !fileOrBlob) {
            return;
        }

        if (currentAudioUrl) {
            URL.revokeObjectURL(currentAudioUrl);
            currentAudioUrl = null;
        }

        currentAudioUrl = URL.createObjectURL(fileOrBlob);

        audioPreview.src = currentAudioUrl;
        audioPreview.hidden = false;
        audioPreview.load();

        analyzeBtn.disabled = false;
    }

    /*
    ============================================================
    FILE UPLOAD
    ============================================================
    */

    if (audioFile) {
        audioFile.addEventListener("change", () => {
            const file = audioFile.files && audioFile.files[0];

            if (!file) {
                selectedAudioFile = null;

                if (analyzeBtn) {
                    analyzeBtn.disabled = true;
                }

                setStatus("No audio selected.");

                return;
            }

            selectedAudioFile = file;
            recordedAudioBlob = null;

            showAudioPreview(file);

            const sizeMB = file.size / (1024 * 1024);

            setStatus(
                `Audio selected: ${file.name} (${sizeMB.toFixed(2)} MB)`
            );
        });
    }

    /*
    ============================================================
    RECORDING
    ============================================================
    */

    if (recordBtn) {
        recordBtn.addEventListener("click", async () => {
            try {
                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    setStatus("Your browser does not support audio recording.");
                    return;
                }

                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: true
                });

                audioChunks = [];

                let mimeType = "";

                if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
                    mimeType = "audio/webm;codecs=opus";
                } else if (MediaRecorder.isTypeSupported("audio/webm")) {
                    mimeType = "audio/webm";
                }

                mediaRecorder = mimeType
                    ? new MediaRecorder(stream, { mimeType })
                    : new MediaRecorder(stream);

                mediaRecorder.ondataavailable = (event) => {
                    if (event.data && event.data.size > 0) {
                        audioChunks.push(event.data);
                    }
                };

                mediaRecorder.onstart = () => {
                    setStatus("Recording... Speak clearly.");

                    recordBtn.disabled = true;
                    stopBtn.disabled = false;
                    analyzeBtn.disabled = true;

                    if (audioFile) {
                        audioFile.disabled = true;
                    }
                };

                mediaRecorder.onstop = () => {
                    const finalType =
                        mediaRecorder.mimeType || "audio/webm";

                    recordedAudioBlob = new Blob(audioChunks, {
                        type: finalType
                    });

                    selectedAudioFile = new File(
                        [recordedAudioBlob],
                        "recorded_speech.webm",
                        {
                            type: finalType
                        }
                    );

                    showAudioPreview(recordedAudioBlob);

                    recordBtn.disabled = false;
                    stopBtn.disabled = true;
                    analyzeBtn.disabled = false;

                    if (audioFile) {
                        audioFile.disabled = false;
                    }

                    setStatus("Recording complete. Ready to analyze.");

                    stream.getTracks().forEach((track) => {
                        track.stop();
                    });
                };

                mediaRecorder.onerror = () => {
                    setStatus("Recording error. Please try again.");

                    recordBtn.disabled = false;
                    stopBtn.disabled = true;
                    analyzeBtn.disabled = true;

                    stream.getTracks().forEach((track) => {
                        track.stop();
                    });
                };

                mediaRecorder.start();

            } catch (error) {
                console.error("Recording error:", error);

                setStatus(
                    "Microphone permission was denied or recording failed."
                );
            }
        });
    }

    if (stopBtn) {
        stopBtn.addEventListener("click", () => {
            if (
                mediaRecorder &&
                mediaRecorder.state !== "inactive"
            ) {
                mediaRecorder.stop();
            }
        });
    }

    /*
    ============================================================
    ANALYZE AUDIO
    ============================================================
    */

    if (analyzeBtn) {
        analyzeBtn.addEventListener("click", async () => {
            if (!selectedAudioFile) {
                setStatus("Please upload or record audio first.");
                return;
            }

            const formData = new FormData();

            formData.append(
                "audio",
                selectedAudioFile,
                selectedAudioFile.name || "speech.webm"
            );

            setLoading(true);

            setStatus("Analyzing your speech...");

            try {
                const response = await fetch("/analyze", {
                    method: "POST",
                    body: formData
                });

                if (!response.ok) {
                    throw new Error(
                        `Server returned ${response.status}`
                    );
                }

                const data = await response.json();

                console.log("Analysis response:", data);

                if (!data.success) {
                    throw new Error(
                        data.error || "Speech analysis failed."
                    );
                }

                renderResults(data);

                if (dashboard) {
                    dashboard.hidden = false;

                    setTimeout(() => {
                        dashboard.scrollIntoView({
                            behavior: "smooth",
                            block: "start"
                        });
                    }, 100);
                }

                setStatus(
                    `Analysis complete — ${formatNumber(data.duration, 1)} seconds analyzed.`
                );

            } catch (error) {
                console.error("Analysis error:", error);

                setStatus(
                    `Analysis failed: ${error.message}`
                );

                alert(
                    "Speech analysis failed.\n\n" +
                    error.message +
                    "\n\nCheck the Flask terminal for more details."
                );

            } finally {
                setLoading(false);
            }
        });
    }

    /*
    ============================================================
    RENDER RESULTS
    ============================================================
    */

    function renderResults(data) {
        /*
        --------------------------------------------------------
        EXACT BACKEND STRUCTURE
        --------------------------------------------------------

        data.duration
        data.transcript
        data.word_timestamps
        data.timeline
        data.metrics
        data.rubric
        data.overall_score
        data.feedback
        --------------------------------------------------------
        */

        const rubric = data.rubric || {};
        const metrics = data.metrics || {};

        const overall = clamp(
            safeNumber(
                data.overall_score,
                safeNumber(rubric.overall, 0)
            )
        );

        const fluency = clamp(
            safeNumber(rubric.fluency, 0)
        );

        const pace = clamp(
            safeNumber(rubric.pace, 0)
        );

        const clarity = clamp(
            safeNumber(rubric.clarity, 0)
        );

        const speechWpm = safeNumber(metrics.wpm, 0);
        const fillerCount = safeNumber(metrics.fillers, 0);
        const pauseCount = safeNumber(metrics.pauses, 0);
        const repetitionCount = safeNumber(metrics.repetitions, 0);

        renderOverallScore(overall);

        renderMetricValues(
            speechWpm,
            fillerCount,
            pauseCount,
            repetitionCount
        );

        renderRubric(
            fluency,
            pace,
            clarity
        );

        renderTimeline(
            data.timeline || [],
            safeNumber(data.duration, 0)
        );

        renderTranscript(
            data.transcript || "",
            data.word_timestamps || [],
            data.timeline || []
        );

        renderFeedback(
            data.feedback || []
        );
    }

    /*
    ============================================================
    OVERALL SCORE
    ============================================================
    */

    function renderOverallScore(score) {
        const safeScore = clamp(score);

        if (overallScore) {
            overallScore.textContent = Math.round(safeScore);
        }

        if (scoreRingValue) {
            scoreRingValue.textContent = Math.round(safeScore);
        }

        const scoreRing =
            document.querySelector(".score-ring");

        if (scoreRing) {
            scoreRing.style.setProperty(
                "--score",
                safeScore
            );

            scoreRing.style.background =
                `conic-gradient(
                    var(--accent) 0%,
                    var(--accent-2) ${safeScore}%,
                    rgba(255,255,255,0.08) ${safeScore}%,
                    rgba(255,255,255,0.08) 100%
                )`;
        }

        if (scoreMessage) {
            if (safeScore >= 90) {
                scoreMessage.textContent =
                    "Excellent delivery. Keep refining your consistency.";
            } else if (safeScore >= 80) {
                scoreMessage.textContent =
                    "Strong delivery with a few areas to refine.";
            } else if (safeScore >= 70) {
                scoreMessage.textContent =
                    "Solid foundation. A few delivery habits are holding you back.";
            } else {
                scoreMessage.textContent =
                    "There are several delivery habits to work on. Use the timeline to practice.";
            }
        }
    }

    /*
    ============================================================
    METRICS
    ============================================================
    */

    function renderMetricValues(
        speechWpm,
        fillerCount,
        pauseCount,
        repetitionCount
    ) {
        if (wpm) {
            wpm.textContent = formatNumber(
                speechWpm,
                1
            );
        }

        if (fillers) {
            fillers.textContent = Math.round(
                fillerCount
            );
        }

        if (pauses) {
            pauses.textContent = Math.round(
                pauseCount
            );
        }

        if (repetitions) {
            repetitions.textContent = Math.round(
                repetitionCount
            );
        }
    }

    /*
    ============================================================
    RUBRIC
    ============================================================
    */

    function updateProgressBar(
        bar,
        scoreElement,
        value
    ) {
        const safeValue = clamp(value);

        if (bar) {
            bar.style.width = `${safeValue}%`;
        }

        if (scoreElement) {
            scoreElement.textContent =
                `${Math.round(safeValue)}/100`;
        }
    }

    function renderRubric(
        fluency,
        pace,
        clarity
    ) {
        updateProgressBar(
            fluencyBar,
            fluencyScore,
            fluency
        );

        updateProgressBar(
            paceBar,
            paceScore,
            pace
        );

        updateProgressBar(
            clarityBar,
            clarityScore,
            clarity
        );
    }

    /*
    ============================================================
    TIMELINE
    ============================================================
    */

    function renderTimeline(events, duration) {
        if (!timeline) {
            return;
        }

        const safeDuration = Math.max(
            safeNumber(duration, 0),
            0.01
        );

        const validEvents = Array.isArray(events)
            ? events
                .filter((event) => event)
                .map((event) => ({
                    ...event,
                    time: getEventTime(event),
                    end: getEventEnd(event)
                }))
                .filter((event) => event.time >= 0)
                .sort((a, b) => a.time - b.time)
            : [];

        timeline.innerHTML = "";

        if (timelineScale) {
            timelineScale.innerHTML = "";
        }

        /*
        --------------------------------------------------------
        TIMELINE SCALE
        --------------------------------------------------------
        */

        if (timelineScale) {
            const scalePoints = [
                0,
                0.25,
                0.5,
                0.75,
                1
            ];

            scalePoints.forEach((point) => {
                const marker =
                    document.createElement("span");

                marker.className =
                    "timeline-scale-marker";

                const seconds =
                    safeDuration * point;

                marker.textContent =
                    formatTime(seconds);

                marker.style.left =
                    `${point * 100}%`;

                if (point === 0) {
                    marker.style.transform =
                        "translateX(0)";
                } else if (point === 1) {
                    marker.style.transform =
                        "translateX(-100%)";
                } else {
                    marker.style.transform =
                        "translateX(-50%)";
                }

                timelineScale.appendChild(marker);
            });
        }

        /*
        --------------------------------------------------------
        NO EVENTS
        --------------------------------------------------------
        */

        if (validEvents.length === 0) {
            const empty =
                document.createElement("div");

            empty.className =
                "timeline-empty";

            empty.textContent =
                "No temporal delivery flaws detected.";

            timeline.appendChild(empty);

            return;
        }

        /*
        --------------------------------------------------------
        EVENTS
        --------------------------------------------------------
        */

        validEvents.forEach((event, index) => {
            const type =
                getEventType(event);

            const label =
                getEventLabel(event);

            const time =
                Math.min(
                    Math.max(event.time, 0),
                    safeDuration
                );

            const end =
                Math.min(
                    Math.max(event.end, time),
                    safeDuration
                );

            const leftPercent =
                (time / safeDuration) * 100;

            const durationSeconds =
                Math.max(0, end - time);

            const eventElement =
                document.createElement("button");

            eventElement.type = "button";

            eventElement.className =
                `timeline-event ${type}-event`;

            eventElement.style.left =
                `${leftPercent}%`;

            /*
            A pause is displayed as a wider block
            because it has an actual duration.
            */

            if (
                type === "pause" &&
                durationSeconds > 0
            ) {
                const widthPercent =
                    Math.max(
                        1.5,
                        (durationSeconds / safeDuration) * 100
                    );

                eventElement.style.width =
                    `${Math.min(widthPercent, 30)}%`;
            }

            const dot =
                document.createElement("span");

            dot.className =
                "timeline-event-dot";

            const content =
                document.createElement("span");

            content.className =
                "timeline-event-label";

            content.innerHTML = `
                <strong>${escapeHtml(label)}</strong>
                <small>${formatTime(time)}</small>
            `;

            eventElement.appendChild(dot);
            eventElement.appendChild(content);

            eventElement.title =
                `${label} — ${formatTime(time)}`;

            eventElement.addEventListener(
                "click",
                () => {
                    seekAudio(time);

                    highlightTranscriptAt(
                        time,
                        type
                    );
                }
            );

            timeline.appendChild(
                eventElement
            );
        });
    }

    /*
    ============================================================
    AUDIO SEEKING
    ============================================================
    */

    function seekAudio(seconds) {
        if (!audioPreview) {
            return;
        }

        const target =
            safeNumber(seconds, 0);

        if (!Number.isFinite(target)) {
            return;
        }

        const applySeek = () => {
            if (!audioPreview) {
                return;
            }

            if (
                !Number.isFinite(
                    audioPreview.duration
                )
            ) {
                return;
            }

            const safeTarget =
                Math.min(
                    Math.max(target, 0),
                    audioPreview.duration
                );

            try {
                audioPreview.currentTime =
                    safeTarget;

                const playPromise =
                    audioPreview.play();

                if (
                    playPromise &&
                    typeof playPromise.catch === "function"
                ) {
                    playPromise.catch(() => {});
                }

            } catch (error) {
                console.warn(
                    "Unable to seek audio:",
                    error
                );
            }
        };

        if (
            Number.isFinite(audioPreview.duration) &&
            audioPreview.duration > 0
        ) {
            applySeek();
        } else {
            audioPreview.addEventListener(
                "loadedmetadata",
                applySeek,
                {
                    once: true
                }
            );
        }
    }

    /*
    ============================================================
    TRANSCRIPT
    ============================================================
    */

    function renderTranscript(
        transcriptText,
        wordTimestamps,
        events
    ) {
        if (!transcript) {
            return;
        }

        transcript.innerHTML = "";

        const words =
            Array.isArray(wordTimestamps)
                ? wordTimestamps
                : [];

        /*
        If Whisper word timestamps are available,
        render individual words so they can be
        connected to temporal flaws.
        */

        if (words.length > 0) {
            words.forEach((word, index) => {
                const wordText =
                    String(
                        word.word ??
                        word.text ??
                        ""
                    ).trim();

                if (!wordText) {
                    return;
                }

                const span =
                    document.createElement("span");

                span.className =
                    "transcript-word";

                span.dataset.time =
                    safeNumber(
                        word.start ??
                        word.time ??
                        0
                    );

                span.textContent =
                    wordText;

                /*
                Add spacing between words,
                except before punctuation.
                */

                if (index > 0) {
                    const punctuation =
                        /^[.,!?;:%)\]}]/;

                    if (
                        !punctuation.test(
                            wordText
                        )
                    ) {
                        transcript.appendChild(
                            document.createTextNode(" ")
                        );
                    }
                }

                transcript.appendChild(span);
            });

            applyTranscriptEvents(
                words,
                events
            );

            return;
        }

        /*
        Fallback when word timestamps
        are unavailable.
        */

        transcript.textContent =
            transcriptText ||
            "No transcript available.";
    }

    function applyTranscriptEvents(
        words,
        events
    ) {
        if (
            !Array.isArray(events) ||
            events.length === 0
        ) {
            return;
        }

        const transcriptWords =
            transcript.querySelectorAll(
                ".transcript-word"
            );

        events.forEach((event) => {
            const eventTime =
                getEventTime(event);

            const type =
                getEventType(event);

            let closestElement = null;
            let closestDifference = Infinity;

            transcriptWords.forEach(
                (element, index) => {
                    const word =
                        words[index];

                    if (!word) {
                        return;
                    }

                    const wordTime =
                        safeNumber(
                            word.start ??
                            word.time ??
                            0
                        );

                    const difference =
                        Math.abs(
                            wordTime -
                            eventTime
                        );

                    if (
                        difference <
                        closestDifference
                    ) {
                        closestDifference =
                            difference;

                        closestElement =
                            element;
                    }
                }
            );

            if (
                closestElement &&
                closestDifference <= 2.0
            ) {
                closestElement.classList.add(
                    "flaw-word"
                );

                closestElement.classList.add(
                    `${type}-word`
                );

                closestElement.dataset.eventTime =
                    eventTime;
            }
        });
    }

    function highlightTranscriptAt(
        seconds,
        type
    ) {
        if (!transcript) {
            return;
        }

        const words =
            transcript.querySelectorAll(
                ".transcript-word"
            );

        words.forEach((word) => {
            word.classList.remove(
                "active-word"
            );
        });

        let closestWord = null;
        let closestDifference = Infinity;

        words.forEach((word) => {
            const wordTime =
                safeNumber(
                    word.dataset.time,
                    0
                );

            const difference =
                Math.abs(
                    wordTime -
                    seconds
                );

            if (
                difference <
                closestDifference
            ) {
                closestDifference =
                    difference;

                closestWord =
                    word;
            }
        });

        if (closestWord) {
            closestWord.classList.add(
                "active-word"
            );

            closestWord.scrollIntoView({
                behavior: "smooth",
                block: "center"
            });
        }
    }

    /*
    ============================================================
    FEEDBACK
    ============================================================
    */

    function renderFeedback(items) {
        if (!feedback) {
            return;
        }

        feedback.innerHTML = "";

        let feedbackItems = [];

        if (Array.isArray(items)) {
            feedbackItems = items;
        } else if (
            typeof items === "string"
        ) {
            feedbackItems = [items];
        } else if (
            items &&
            typeof items === "object"
        ) {
            feedbackItems =
                Object.values(items);
        }

        feedbackItems =
            feedbackItems
                .filter(
                    (item) =>
                        item !== null &&
                        item !== undefined &&
                        String(item).trim() !== ""
                );

        if (feedbackItems.length === 0) {
            const empty =
                document.createElement("div");

            empty.className =
                "feedback-empty";

            empty.textContent =
                "Great job. No major coaching points were generated.";

            feedback.appendChild(empty);

            return;
        }

        feedbackItems.forEach(
            (item, index) => {
                const text =
                    typeof item === "string"
                        ? item
                        : (
                            item.message ||
                            item.text ||
                            item.tip ||
                            JSON.stringify(item)
                        );

                const card =
                    document.createElement("div");

                card.className =
                    "feedback-card";

                card.innerHTML = `
                    <div class="feedback-number">
                        ${index + 1}
                    </div>

                    <div class="feedback-content">
                        <strong>Coaching point</strong>
                        <p>${escapeHtml(String(text))}</p>
                    </div>
                `;

                feedback.appendChild(card);
            }
        );
    }

    /*
    ============================================================
    PRACTICE BUTTON
    ============================================================
    */

    if (practiceBtn) {
        practiceBtn.addEventListener(
            "click",
            () => {
                window.scrollTo({
                    top: 0,
                    behavior: "smooth"
                });

                setTimeout(() => {
                    if (audioFile) {
                        audioFile.focus();
                    }
                }, 500);
            }
        );
    }

    /*
    ============================================================
    HTML ESCAPE
    ============================================================
    */

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    /*
    ============================================================
    AUDIO EVENTS
    ============================================================
    */

    if (audioPreview) {
        audioPreview.addEventListener(
            "loadedmetadata",
            () => {
                if (
                    Number.isFinite(
                        audioPreview.duration
                    )
                ) {
                    setStatus(
                        `Audio ready — ${formatNumber(
                            audioPreview.duration,
                            1
                        )} seconds.`
                    );
                }
            }
        );
    }

    /*
    ============================================================
    CLEANUP
    ============================================================
    */

    window.addEventListener(
        "beforeunload",
        () => {
            if (currentAudioUrl) {
                URL.revokeObjectURL(
                    currentAudioUrl
                );
            }

            if (
                mediaRecorder &&
                mediaRecorder.state !== "inactive"
            ) {
                mediaRecorder.stop();
            }
        }
    );

    console.log(
        "Vocalis AI frontend initialized successfully."
    );
});