const RUN_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_CAPTION_LINES = 5000;

const runs = new Map();

const nowIso = () => new Date().toISOString();

const toSafeIndex = (value) => {
    const parsed = Number.parseInt(String(value ?? "0"), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const pruneExpiredRuns = () => {
    const threshold = Date.now() - RUN_TTL_MS;

    for (const [runId, run] of runs.entries()) {
        const updatedAtMs = Date.parse(run.updatedAt || run.createdAt || 0);
        if (Number.isFinite(updatedAtMs) && updatedAtMs < threshold) {
            runs.delete(runId);
        }
    }
};

const updateRun = (runId, updater) => {
    const run = runs.get(runId);

    if (!run) {
        return false;
    }

    updater(run);
    run.updatedAt = nowIso();

    return true;
};

const createRun = ({ runId, userId, meetLink, participantName }) => {
    pruneExpiredRuns();

    const createdAt = nowIso();

    runs.set(runId, {
        runId,
        userId,
        meetLink: String(meetLink || ""),
        participantName: String(participantName || ""),
        status: "starting",
        joined: false,
        joinedAt: "",
        pendingApproval: false,
        pendingAuth: false,
        ended: false,
        failed: false,
        errorMessage: "",
        captureEndReason: "",
        joinButtonLabel: "",
        captions: [],
        createdAt,
        updatedAt: createdAt,
        endedAt: "",
    });
};

const setRunStatus = (runId, status, details = {}) => {
    return updateRun(runId, (run) => {
        if (status) {
            run.status = String(status);
        }

        if (details.pendingApproval !== undefined) {
            run.pendingApproval = Boolean(details.pendingApproval);
        }

        if (details.pendingAuth !== undefined) {
            run.pendingAuth = Boolean(details.pendingAuth);
        }

        if (typeof details.captureEndReason === "string") {
            run.captureEndReason = details.captureEndReason;
        }

        if (typeof details.joinButtonLabel === "string" && details.joinButtonLabel) {
            run.joinButtonLabel = details.joinButtonLabel;
        }
    });
};

const markRunJoined = (runId, details = {}) => {
    return updateRun(runId, (run) => {
        run.joined = true;
        run.pendingApproval = false;
        run.pendingAuth = false;
        run.joinedAt = details.joinedAt || nowIso();
        run.status = "joined";

        if (typeof details.joinButtonLabel === "string" && details.joinButtonLabel) {
            run.joinButtonLabel = details.joinButtonLabel;
        }
    });
};

const appendRunCaption = (runId, entry = {}) => {
    return updateRun(runId, (run) => {
        const text = String(entry.text || "")
            .replace(/\s+/g, " ")
            .trim();

        if (!text) {
            return;
        }

        run.captions.push({
            ts: entry.ts || nowIso(),
            text,
        });

        if (run.captions.length > MAX_CAPTION_LINES) {
            run.captions.splice(0, run.captions.length - MAX_CAPTION_LINES);
        }
    });
};

const completeRun = (runId, result = {}) => {
    return updateRun(runId, (run) => {
        run.ended = true;
        run.failed = false;
        run.errorMessage = "";
        run.endedAt = nowIso();

        if (typeof result.status === "string" && result.status) {
            run.status = result.status;
        } else if (!run.status || run.status === "starting") {
            run.status = "completed";
        }

        run.pendingApproval = Boolean(result.pendingApproval);
        run.pendingAuth = Boolean(result.pendingAuth);

        if (typeof result.captureEndReason === "string") {
            run.captureEndReason = result.captureEndReason;
        }

        if (typeof result.joinButtonLabel === "string" && result.joinButtonLabel) {
            run.joinButtonLabel = result.joinButtonLabel;
        }
    });
};

const failRun = (runId, message) => {
    return updateRun(runId, (run) => {
        run.ended = true;
        run.failed = true;
        run.endedAt = nowIso();
        run.status = "failed";
        run.errorMessage = String(message || "Bot failed");
    });
};

const getRunLive = ({ runId, userId, fromIndex = 0 }) => {
    const run = runs.get(runId);

    if (!run) {
        return null;
    }

    if (userId && run.userId !== userId) {
        return null;
    }

    const safeFromIndex = Math.min(toSafeIndex(fromIndex), run.captions.length);

    return {
        runId: run.runId,
        status: run.status,
        joined: run.joined,
        pendingApproval: run.pendingApproval,
        pendingAuth: run.pendingAuth,
        ended: run.ended,
        failed: run.failed,
        errorMessage: run.errorMessage,
        captureEndReason: run.captureEndReason,
        joinButtonLabel: run.joinButtonLabel,
        captions: run.captions.slice(safeFromIndex),
        totalCaptions: run.captions.length,
        nextIndex: run.captions.length,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        joinedAt: run.joinedAt,
        endedAt: run.endedAt,
    };
};

module.exports = {
    createRun,
    setRunStatus,
    markRunJoined,
    appendRunCaption,
    completeRun,
    failRun,
    getRunLive,
};
