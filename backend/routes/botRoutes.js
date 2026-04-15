const express = require("express");
const { randomUUID } = require("crypto");
const router = express.Router();

const startMeetBot = require("../services/meetBot");
const { requireAuth } = require("../middlewares/authMiddleware");
const {
    createRun,
    setRunStatus,
    markRunJoined,
    appendRunCaption,
    completeRun,
    failRun,
    getRunLive,
} = require("../services/botRunStore");
const {
    createMeeting,
    updateMeetingFromStatusEvent,
    markMeetingJoined,
    completeMeeting,
    failMeeting,
    listMeetingsForUser,
} = require("../services/meetingStore");

router.post("/start-bot", requireAuth, async (req, res) => {

    const { meetLink, participantName, joinAsGuest } = req.body;
    const runId = String(req.body?.runId || "").trim() || randomUUID();
    const chosenName = String(participantName || "").trim() || req.user?.name || "";

    createRun({
        runId,
        userId: req.user?.id,
        meetLink,
        participantName: chosenName,
    });

    setRunStatus(runId, "launching");

    let meeting = null;
    const capturedCaptions = [];

    try {
        meeting = await createMeeting({
            runId,
            userId: req.user?.id,
            meetLink,
            participantName: chosenName,
            joinAsGuest,
        });

        const result = await startMeetBot({
            meetLink,
            participantName: chosenName,
            joinAsGuest,
        }, {
            onStatus: (event) => {
                setRunStatus(runId, event?.status || "", event || {});

                if (meeting?.id) {
                    void updateMeetingFromStatusEvent(meeting.id, event || {})
                        .catch((persistError) => {
                            console.error("Failed to persist meeting status event", persistError);
                        });
                }
            },
            onJoined: (event) => {
                markRunJoined(runId, {
                    joinedAt: event?.ts,
                    joinButtonLabel: event?.joinButtonLabel,
                });

                if (meeting?.id) {
                    void markMeetingJoined(meeting.id, event || {})
                        .catch((persistError) => {
                            console.error("Failed to persist meeting joined event", persistError);
                        });
                }
            },
            onCaption: (entry) => {
                const captionEntry = {
                    ts: entry?.ts,
                    text: String(entry?.text || "").trim(),
                };

                if (!captionEntry.text) {
                    return;
                }

                capturedCaptions.push(captionEntry);
                appendRunCaption(runId, captionEntry);
            },
        });

        completeRun(runId, result);

        if (meeting?.id) {
            await completeMeeting(meeting.id, {
                result,
                captions: capturedCaptions,
            });
        }

        res.json({
            runId,
            meetingId: meeting?.id || "",
            status: result?.status || "Bot launched successfully",
            summary: result?.summary || "",
            transcript: result?.transcript || "",
            transcriptLineCount: result?.transcriptLineCount || 0,
            captureDurationSeconds: result?.captureDurationSeconds || 0,
            joinButtonLabel: result?.joinButtonLabel || "",
            pendingApproval: Boolean(result?.pendingApproval),
            pendingAuth: Boolean(result?.pendingAuth),
            captureEndReason: result?.captureEndReason || "",
            usedParticipantName: chosenName,
        });

    } catch (error) {

        console.error(error);

        const statusCode = Number.isInteger(error?.statusCode)
            ? error.statusCode
            : 500;

        failRun(runId, error?.message || "Bot failed to start");

        if (meeting?.id) {
            await failMeeting(meeting.id, error?.message || "Bot failed to start")
                .catch((persistError) => {
                    console.error("Failed to persist failed meeting", persistError);
                });
        }

        res.status(statusCode).json({
            message: error.message || "Bot failed to start",
            runId,
            meetingId: meeting?.id || "",
        });

    }
});

router.get("/bot-run/:runId/live", requireAuth, (req, res) => {
    const runId = String(req.params?.runId || "").trim();

    if (!runId) {
        return res.status(400).json({
            message: "runId is required.",
        });
    }

    const fromIndex = req.query?.fromIndex ?? req.query?.from ?? "0";
    const live = getRunLive({
        runId,
        userId: req.user?.id,
        fromIndex,
    });

    if (!live) {
        return res.status(404).json({
            message: "Run not found.",
        });
    }

    return res.json(live);
});

router.get("/meetings", requireAuth, async (req, res) => {
    const parsedLimit = Number.parseInt(String(req.query?.limit || "20"), 10);

    try {
        const meetings = await listMeetingsForUser(req.user?.id, {
            limit: parsedLimit,
        });

        return res.json({
            meetings,
        });
    } catch {
        return res.status(500).json({
            message: "Failed to load meeting history.",
        });
    }
});

module.exports = router;