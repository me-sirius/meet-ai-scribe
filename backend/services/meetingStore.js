const prisma = require("./prisma");

const normalizeText = (value) => String(value || "").trim();

const toDateOrNull = (value) => {
    if (!value) {
        return null;
    }

    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
};

const toSafeInt = (value, fallback = 0) => {
    const parsed = Number.parseInt(String(value ?? fallback), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const createMeeting = async ({ runId, userId, meetLink, participantName, joinAsGuest }) => {
    return prisma.meeting.create({
        data: {
            runId: normalizeText(runId),
            userId: normalizeText(userId),
            meetLink: normalizeText(meetLink),
            participantName: normalizeText(participantName),
            joinAsGuest: Boolean(joinAsGuest),
            status: "launching",
        },
    });
};

const updateMeetingFromStatusEvent = async (meetingId, event = {}) => {
    if (!meetingId) {
        return;
    }

    const data = {};

    if (typeof event.status === "string" && event.status.trim()) {
        data.status = event.status.trim();
    }

    if (typeof event.pendingApproval === "boolean") {
        data.pendingApproval = event.pendingApproval;
    }

    if (typeof event.pendingAuth === "boolean") {
        data.pendingAuth = event.pendingAuth;
    }

    if (typeof event.captureEndReason === "string") {
        data.captureEndReason = event.captureEndReason;
    }

    if (typeof event.joinButtonLabel === "string" && event.joinButtonLabel.trim()) {
        data.joinButtonLabel = event.joinButtonLabel.trim();
    }

    if (data.status === "joined") {
        data.joinedAt = new Date();
    }

    if (Object.keys(data).length === 0) {
        return;
    }

    await prisma.meeting.update({
        where: { id: meetingId },
        data,
    });
};

const markMeetingJoined = async (meetingId, details = {}) => {
    if (!meetingId) {
        return;
    }

    await prisma.meeting.update({
        where: { id: meetingId },
        data: {
            status: "joined",
            joinedAt: toDateOrNull(details.ts) || new Date(),
            pendingApproval: false,
            pendingAuth: false,
            joinButtonLabel: normalizeText(details.joinButtonLabel),
        },
    });
};

const completeMeeting = async (meetingId, { result = {}, captions = [] } = {}) => {
    if (!meetingId) {
        return;
    }

    const transcript = String(result.transcript || "");
    const summary = String(result.summary || "");

    const normalizedCaptions = Array.isArray(captions)
        ? captions
            .map((entry, index) => ({
                lineIndex: index,
                ts: toDateOrNull(entry?.ts),
                text: normalizeText(entry?.text),
            }))
            .filter((entry) => entry.text.length > 0)
        : [];

    await prisma.$transaction(async (tx) => {
        await tx.meeting.update({
            where: { id: meetingId },
            data: {
                status: normalizeText(result.status) || "completed",
                summary,
                transcript,
                transcriptLineCount: toSafeInt(result.transcriptLineCount, normalizedCaptions.length),
                captureDurationSeconds: toSafeInt(result.captureDurationSeconds, 0),
                joinButtonLabel: normalizeText(result.joinButtonLabel),
                pendingApproval: Boolean(result.pendingApproval),
                pendingAuth: Boolean(result.pendingAuth),
                captureEndReason: normalizeText(result.captureEndReason),
                errorMessage: "",
                endedAt: new Date(),
            },
        });

        await tx.transcriptLine.deleteMany({
            where: { meetingId },
        });

        if (normalizedCaptions.length > 0) {
            await tx.transcriptLine.createMany({
                data: normalizedCaptions.map((entry) => ({
                    meetingId,
                    lineIndex: entry.lineIndex,
                    ts: entry.ts,
                    text: entry.text,
                })),
            });
        }
    });
};

const failMeeting = async (meetingId, message) => {
    if (!meetingId) {
        return;
    }

    await prisma.meeting.update({
        where: { id: meetingId },
        data: {
            status: "failed",
            errorMessage: normalizeText(message),
            endedAt: new Date(),
        },
    });
};

const listMeetingsForUser = async (userId, { limit = 20 } = {}) => {
    const safeLimit = Math.min(Math.max(toSafeInt(limit, 20), 1), 100);

    return prisma.meeting.findMany({
        where: {
            userId: normalizeText(userId),
        },
        orderBy: {
            createdAt: "desc",
        },
        take: safeLimit,
        select: {
            id: true,
            runId: true,
            meetLink: true,
            participantName: true,
            joinAsGuest: true,
            status: true,
            summary: true,
            transcriptLineCount: true,
            captureDurationSeconds: true,
            joinButtonLabel: true,
            pendingApproval: true,
            pendingAuth: true,
            captureEndReason: true,
            errorMessage: true,
            createdAt: true,
            joinedAt: true,
            endedAt: true,
        },
    });
};

module.exports = {
    createMeeting,
    updateMeetingFromStatusEvent,
    markMeetingJoined,
    completeMeeting,
    failMeeting,
    listMeetingsForUser,
};
