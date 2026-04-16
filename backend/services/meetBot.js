const path = require("path");

const axios = require("axios");
const { chromium } = require("playwright");

const DEFAULT_ACTION_TIMEOUT_MS = 20000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 60000;
const DEFAULT_JOIN_CONFIRM_TIMEOUT_MS = 25000;
const BOT_FLOW_VERSION = "2026-04-15-fast-join-hotfix-1";
const DEFAULT_TRANSCRIPT_CAPTURE_SECONDS = 120;
const DEFAULT_TRANSCRIPT_IDLE_GRACE_SECONDS = 12;
const DEFAULT_TRANSCRIPT_MAX_CAPTURE_SECONDS = 900;
const DEFAULT_WAITING_ROOM_TIMEOUT_MS = 300000;
const DEFAULT_FAST_PREJOIN_TIMEOUT_MS = 3500;
const DEFAULT_FAST_JOIN_TIMEOUT_MS = 9000;
const TRANSCRIPT_MONITOR_TICK_MS = 1000;
const DEFAULT_TRANSCRIPT_CONSOLE_LOG_INTERVAL_MS = 2000;
const DEFAULT_GEMINI_MODEL_FALLBACKS = [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
];
const DEFAULT_AUTOMATION_USER_DATA_DIR = path.resolve(__dirname, "..", "chrome-bot-profile");
const TERMINATED_BY_USER_REASON = "terminated-by-user";

const MIC_OFF_PATTERNS = [/turn on microphone/i, /microphone off/i, /unmute/i];
const MIC_ON_PATTERNS = [/turn off microphone/i, /microphone on/i, /\bmute\b/i];

const CAMERA_OFF_PATTERNS = [/turn on camera/i, /camera off/i, /start camera/i];
const CAMERA_ON_PATTERNS = [/turn off camera/i, /camera on/i, /stop camera/i];
const JOIN_BUTTON_PATTERNS = [
    /\bjoin now\b/i,
    /\bask to join\b/i,
    /\brequest to join\b/i,
    /\bjoin meeting\b/i,
    /\bjoin call\b/i,
    /\bjoin\b/i,
];

const CAPTIONS_ON_PATTERNS = [/turn off captions/i, /captions on/i, /hide subtitles/i];
const CAPTIONS_OFF_PATTERNS = [/turn on captions/i, /captions off/i, /show subtitles/i, /caption/i, /subtitle/i];
const WAITING_ROOM_PATTERNS = [
    /please wait until a meeting host brings you into the call/i,
    /you'll join when someone lets you in/i,
    /someone will let you in soon/i,
    /asking to join/i,
    /waiting for the host/i,
    /ask to join/i,
];
const MEETING_ENDED_PATTERNS = [
    /meeting has ended/i,
    /call has ended/i,
    /you left the meeting/i,
    /you left the call/i,
    /no longer available/i,
    /you've been removed from the meeting/i,
    /this video call has ended/i,
];
const MEET_MEDIA_MODAL_PATTERNS = [
    /do you want people to (see and )?hear you in the meeting\??/i,
    /do you want people to see you in the meeting\??/i,
    /allow chrome to use your camera/i,
    /allow chrome to use your microphone/i,
    /open system settings/i,
];
const PROFILE_LOCK_PATTERNS = /profile appears to be in use|user data directory is already in use|processsingleton|singletonlock|failed to create a processsingleton/i;
const MISSING_BROWSER_DEPS_PATTERNS = /Host system is missing dependencies|error while loading shared libraries|lib[a-zA-Z0-9_.-]+\.so/i;

const toPositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toBoolean = (value, fallback = false) => {
    if (value === undefined) {
        return fallback;
    }
    return /^(1|true|yes)$/i.test(String(value));
};

const parseCsv = (value) => {
    return String(value || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
};

const uniqueModels = (models) => {
    return Array.from(new Set(models.filter(Boolean)));
};

const getGeminiModelCandidates = () => {
    const explicitPrimary = String(process.env.GEMINI_MODEL || "").trim();
    const explicitFallbacks = parseCsv(process.env.GEMINI_MODEL_FALLBACKS);

    if (explicitPrimary) {
        return uniqueModels([
            explicitPrimary,
            ...explicitFallbacks,
            ...DEFAULT_GEMINI_MODEL_FALLBACKS,
        ]);
    }

    if (explicitFallbacks.length > 0) {
        return uniqueModels([
            ...explicitFallbacks,
            ...DEFAULT_GEMINI_MODEL_FALLBACKS,
        ]);
    }

    return [...DEFAULT_GEMINI_MODEL_FALLBACKS];
};

const compactErrorMessage = (value, maxLength = 180) => {
    const collapsed = String(value || "unknown error")
        .replace(/\s+/g, " ")
        .trim();

    if (collapsed.length <= maxLength) {
        return collapsed;
    }

    return `${collapsed.slice(0, maxLength)}...`;
};

const formatGeminiModelError = (model, error) => {
    const statusCode = error?.response?.status;
    const apiError = error?.response?.data?.error?.message;
    const message = compactErrorMessage(apiError || error?.message);

    return {
        model,
        statusCode,
        message,
        isRetryable: [408, 429, 500, 502, 503, 504].includes(statusCode),
    };
};

const shouldContinueAfterGeminiError = (errorInfo) => {
    if (errorInfo.isRetryable) {
        return true;
    }

    // Continue on model-specific failures (unknown model, unsupported in region, etc.)
    if (errorInfo.statusCode === 400 || errorInfo.statusCode === 404) {
        return true;
    }

    return true;
};

const createHttpError = (message, statusCode = 500) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};

const logMeetBotStatus = (message, details) => {
    const prefix = `[meetBot][${new Date().toISOString()}]`;

    if (details === undefined) {
        console.log(`${prefix} ${message}`);
        return;
    }

    console.log(`${prefix} ${message}`, details);
};

const normalizeTranscriptLogText = (value, maxLength = 240) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();

    if (!text) {
        return "";
    }

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength)}...`;
};

const safeCallHook = (hook, payload) => {
    if (typeof hook !== "function") {
        return;
    }

    try {
        hook(payload);
    } catch {
        // Hook failures should never break bot execution.
    }
};

const isValidMeetLink = (link) => {
    try {
        const parsed = new URL(link);
        if (parsed.protocol !== "https:" || parsed.hostname !== "meet.google.com") {
            return false;
        }
        const normalizedPath = parsed.pathname.replace(/\/+$/, "");
        return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(normalizedPath);
    } catch {
        return false;
    }
};

const parseStartPayload = (payload) => {
    if (typeof payload === "string") {
        return {
            meetLink: payload,
            participantName: "",
            joinAsGuest: false,
        };
    }

    return {
        meetLink: payload?.meetLink,
        participantName: payload?.participantName || "",
        joinAsGuest: toBoolean(payload?.joinAsGuest, false),
    };
};

const appendUniqueArgs = (baseArgs = [], extraArgs = []) => {
    const merged = [...baseArgs];

    for (const arg of extraArgs) {
        if (!merged.includes(arg)) {
            merged.push(arg);
        }
    }

    return merged;
};

const getContainerFallbackArgs = (baseArgs = []) => {
    return appendUniqueArgs(baseArgs, [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-zygote",
        "--disable-gpu",
    ]);
};

const formatLaunchFailureMessage = (prefix, launchMessage) => {
    const details = String(launchMessage || "").trim();

    if (!details) {
        return prefix;
    }

    if (MISSING_BROWSER_DEPS_PATTERNS.test(details)) {
        const compact = compactErrorMessage(details, 1200);
        return `${prefix} Missing Linux browser dependencies on host. Playwright: ${compact}`;
    }

    return `${prefix} Playwright: ${compactErrorMessage(details, 1200)}`;
};

const getAutomationUserDataDir = () => {
    const configuredDir = String(
        process.env.CHROME_AUTOMATION_USER_DATA_DIR || process.env.CHROME_USER_DATA_DIR || "",
    ).trim();

    if (!configuredDir) {
        return DEFAULT_AUTOMATION_USER_DATA_DIR;
    }

    return path.isAbsolute(configuredDir)
        ? configuredDir
        : path.resolve(__dirname, "..", configuredDir);
};

const getCommonLaunchOptions = () => {
    const headless = toBoolean(process.env.MEET_BOT_HEADLESS, false);
    const executablePath = String(process.env.CHROME_EXECUTABLE_PATH || "").trim();
    const channel = String(process.env.CHROME_CHANNEL || "").trim().toLowerCase();
    const isContainerRuntime = Boolean(
        process.env.DYNO
        || process.env.RENDER
        || process.env.RAILWAY_ENVIRONMENT
        || process.env.K_SERVICE,
    );
    const disableSandbox = toBoolean(process.env.CHROME_DISABLE_SANDBOX, isContainerRuntime);

    const launchOptions = {
        headless,
        args: [
            "--disable-blink-features=AutomationControlled",
            "--disable-notifications",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--no-default-browser-check",
        ],
    };

    if (headless) {
        launchOptions.args.push("--window-size=1365,900");
    } else {
        launchOptions.args.push("--start-maximized");
    }

    if (disableSandbox) {
        launchOptions.args.push("--no-sandbox", "--disable-setuid-sandbox");
    }

    if (executablePath) {
        launchOptions.executablePath = executablePath;
    } else if (channel) {
        launchOptions.channel = channel;
    } else if (headless) {
        // Prefer bundled Chromium headless mode to avoid missing headless-shell artifacts on PaaS builds.
        launchOptions.channel = "chromium";
    }

    return launchOptions;
};

const launchPersistentChromeContext = async () => {
    const userDataDir = getAutomationUserDataDir();
    const commonLaunchOptions = getCommonLaunchOptions();
    const launchOptions = {
        ...commonLaunchOptions,
        viewport: null,
        args: [...(commonLaunchOptions.args || [])],
    };

    if (process.env.CHROME_PROFILE_DIRECTORY) {
        launchOptions.args.push(`--profile-directory=${process.env.CHROME_PROFILE_DIRECTORY}`);
    }

    let context;
    let launchError;

    try {
        context = await chromium.launchPersistentContext(
            userDataDir,
            launchOptions,
        );
    } catch (error) {
        launchError = error;
        const launchMessage = String(error?.message || "");

        if (PROFILE_LOCK_PATTERNS.test(launchMessage)) {
            throw createHttpError(
                `Chrome user-data-dir is locked by another running Chrome process: ${userDataDir}. Playwright cannot launch a second controlled instance from the same user-data-dir. Close Chrome windows using that data directory, or use a dedicated CHROME_AUTOMATION_USER_DATA_DIR for the bot.`,
                409,
            );
        }

        // Retry once with container-safe fallback flags for hosts where Chromium exits immediately.
        if (!MISSING_BROWSER_DEPS_PATTERNS.test(launchMessage)) {
            const fallbackArgs = getContainerFallbackArgs(launchOptions.args || []);

            if (fallbackArgs.length !== (launchOptions.args || []).length) {
                const retryOptions = {
                    ...launchOptions,
                    args: fallbackArgs,
                };

                if (!retryOptions.executablePath && !retryOptions.channel) {
                    retryOptions.channel = "chromium";
                }

                try {
                    context = await chromium.launchPersistentContext(
                        userDataDir,
                        retryOptions,
                    );
                    launchError = null;
                } catch (retryError) {
                    launchError = retryError;
                }
            }
        }

        if (!context) {
            throw createHttpError(
                formatLaunchFailureMessage(
                    "Failed to launch Playwright persistent context.",
                    launchError?.message,
                ),
                500,
            );
        }
    }

    context.setDefaultTimeout(
        toPositiveInt(process.env.MEET_ACTION_TIMEOUT_MS, DEFAULT_ACTION_TIMEOUT_MS),
    );

    return context;
};

const launchGuestContext = async () => {
    const launchOptions = getCommonLaunchOptions();

    let browser;
    let launchError;

    try {
        browser = await chromium.launch(launchOptions);
    } catch (error) {
        launchError = error;
        const launchMessage = String(error?.message || "");

        // Retry once with container-safe fallback flags for hosts where Chromium exits immediately.
        if (!MISSING_BROWSER_DEPS_PATTERNS.test(launchMessage)) {
            const fallbackArgs = getContainerFallbackArgs(launchOptions.args || []);

            if (fallbackArgs.length !== (launchOptions.args || []).length) {
                const retryOptions = {
                    ...launchOptions,
                    args: fallbackArgs,
                };

                if (!retryOptions.executablePath && !retryOptions.channel) {
                    retryOptions.channel = "chromium";
                }

                try {
                    browser = await chromium.launch(retryOptions);
                    launchError = null;
                } catch (retryError) {
                    launchError = retryError;
                }
            }
        }

        if (!browser) {
            throw createHttpError(
                formatLaunchFailureMessage(
                    "Failed to launch Playwright guest context.",
                    launchError?.message,
                ),
                500,
            );
        }
    }

    const context = await browser.newContext({ viewport: null });

    context.setDefaultTimeout(
        toPositiveInt(process.env.MEET_ACTION_TIMEOUT_MS, DEFAULT_ACTION_TIMEOUT_MS),
    );

    return { browser, context };
};

const grantMeetMediaPermissions = async (context) => {
    await context
        .grantPermissions(["microphone", "camera"], {
            origin: "https://meet.google.com",
        })
        .catch(() => {});
};

const getButtonDescriptor = async (buttonLocator) => {
    const [ariaLabel, title, tooltip, textContent] = await Promise.all([
        buttonLocator.getAttribute("aria-label"),
        buttonLocator.getAttribute("title"),
        buttonLocator.getAttribute("data-tooltip"),
        buttonLocator.textContent(),
    ]);

    return [ariaLabel, title, tooltip, textContent]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
};

const findVisibleButton = async (page, labelPatterns, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const controls = page.locator('button, [role="button"], [aria-label], [data-tooltip], [title]');
        const count = Math.min(await controls.count(), 520);

        for (let index = 0; index < count; index += 1) {
            const candidate = controls.nth(index);
            const isVisible = await candidate.isVisible().catch(() => false);
            const isEnabled = await candidate.isEnabled().catch(() => true);

            if (!isVisible || !isEnabled) {
                continue;
            }

            const descriptor = await getButtonDescriptor(candidate);

            if (labelPatterns.some((pattern) => pattern.test(descriptor))) {
                const canClick = await candidate
                    .click({ trial: true, timeout: 220 })
                    .then(() => true)
                    .catch(() => false);

                if (canClick) {
                    return candidate;
                }
            }
        }

        await page.waitForTimeout(250);
    }

    return null;
};

const clickDialogTopRight = async (dialogLocator, page) => {
    const box = await dialogLocator.boundingBox().catch(() => null);

    if (!box) {
        return false;
    }

    const targetX = Math.round(box.x + box.width - 24);
    const targetY = Math.round(box.y + 24);

    await page.mouse.click(targetX, targetY).catch(() => {});
    await page.waitForTimeout(220);
    return true;
};

const findExplicitJoinButton = async (page) => {
    const candidateLocators = [
        page.getByRole("button", { name: /\bask to join\b/i }).first(),
        page.getByRole("button", { name: /\bjoin now\b/i }).first(),
        page.getByRole("button", { name: /\brequest to join\b/i }).first(),
        page.getByRole("button", { name: /\bjoin meeting\b/i }).first(),
        page.getByRole("button", { name: /\bjoin call\b/i }).first(),
        page.getByRole("button", { name: /^\s*join\s*$/i }).first(),
        page.locator('button:has-text("Ask to join")').first(),
        page.locator('button:has-text("Join now")').first(),
    ];

    for (const locator of candidateLocators) {
        const isVisible = await locator.isVisible().catch(() => false);
        const isEnabled = await locator.isEnabled().catch(() => true);

        if (!isVisible || !isEnabled) {
            continue;
        }

        const canClick = await locator
            .click({ trial: true, timeout: 280 })
            .then(() => true)
            .catch(() => false);

        if (canClick) {
            return locator;
        }
    }

    return null;
};

const dismissAnyOverlayQuick = async (page, timeoutMs = 1000) => {
    const deadline = Date.now() + Math.max(450, timeoutMs);
    let dismissedAny = false;

    const dismissCandidates = [
        page.getByRole("button", { name: /close|dismiss|cancel|not now|got it|skip|maybe later/i }).first(),
        page.getByRole("link", { name: /close|dismiss|cancel|not now|got it|skip|maybe later/i }).first(),
        page.locator('button[aria-label*="close" i], [role="button"][aria-label*="close" i], button[title*="close" i], [role="button"][title*="close" i]').first(),
        page.getByRole("button", { name: /^x$/i }).first(),
        page.locator('button:has-text("×"), [role="button"]:has-text("×")').first(),
    ];

    while (Date.now() < deadline) {
        for (const candidate of dismissCandidates) {
            const isVisible = await candidate.isVisible().catch(() => false);
            if (!isVisible) {
                continue;
            }

            await candidate.click({ timeout: 800 }).catch(() => {});
            dismissedAny = true;
            await page.waitForTimeout(90);
        }

        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(90);
    }

    return dismissedAny;
};

const applyToggleShortcutFallback = async (page, shortcutKeys = []) => {
    for (const shortcutKey of shortcutKeys) {
        await page.keyboard.press(shortcutKey).catch(() => {});
        await page.waitForTimeout(180);
    }
};

const canInteractWithPreJoinControls = async (page) => {
    const interactiveCandidates = [
        page.getByRole("button", { name: /\bjoin now\b|\bask to join\b|\bjoin\b/i }).first(),
        page.getByRole("button", { name: /microphone|camera|mute|unmute|turn on|turn off/i }).first(),
        page.locator('input[aria-label*="name" i]').first(),
        page.locator('input[placeholder*="name" i]').first(),
    ];

    for (const candidate of interactiveCandidates) {
        const visible = await candidate.isVisible().catch(() => false);
        if (visible) {
            return true;
        }
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");
    return /what'?s your name\?|ask to join|join now|ready to join/i.test(bodyText);
};

const dismissMeetMediaModalIfPresent = async (page, timeoutMs) => {
    const modalTitles = MEET_MEDIA_MODAL_PATTERNS.map((pattern) => (
        page.getByText(pattern).first()
    ));

    let visibleModalTitle = null;

    for (const candidateTitle of modalTitles) {
        const isVisible = await candidateTitle
            .waitFor({ state: "visible", timeout: Math.min(700, timeoutMs) })
            .then(() => true)
            .catch(() => false);

        if (isVisible) {
            visibleModalTitle = candidateTitle;
            break;
        }
    }

    if (!visibleModalTitle) {
        const osPermissionDialogTitle = page.getByText(/allow chrome to use your (camera|microphone)/i).first();
        const osDialogVisible = await osPermissionDialogTitle
            .waitFor({ state: "visible", timeout: Math.min(650, timeoutMs) })
            .then(() => true)
            .catch(() => false);

        if (osDialogVisible) {
            visibleModalTitle = osPermissionDialogTitle;
        }
    }

    const modalAppeared = Boolean(visibleModalTitle);

    if (!modalAppeared) {
        return "not-present";
    }

    const modalDialog = visibleModalTitle.locator('xpath=ancestor::*[@role="dialog"][1]').first();

    const dismissCandidates = [
        page.getByRole("button", { name: /continue without microphone and camera/i }).first(),
        page.getByRole("link", { name: /continue without microphone and camera/i }).first(),
        page.getByText(/continue without microphone and camera/i).first(),
        page.getByRole("button", { name: /continue without.*camera/i }).first(),
        page.getByRole("button", { name: /close|dismiss|cancel/i }).first(),
        page.locator('button[aria-label*="close" i], [role="button"][aria-label*="close" i], button[title*="close" i], [role="button"][title*="close" i]').first(),
        page.getByRole("button", { name: /^x$/i }).first(),
        page.locator('button:has-text("×"), [role="button"]:has-text("×")').first(),
    ];

    const deadline = Date.now() + Math.min(timeoutMs, 4500);

    while (Date.now() < deadline) {
        for (const candidate of dismissCandidates) {
            const isVisible = await candidate.isVisible().catch(() => false);
            if (!isVisible) {
                continue;
            }

            await candidate.click({ timeout: 2500 }).catch(() => {});
            await page.waitForTimeout(140);

            const stillVisible = await visibleModalTitle.isVisible().catch(() => false);
            if (!stillVisible) {
                return "dismissed";
            }
        }

        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(120);

        const stillVisible = await visibleModalTitle.isVisible().catch(() => false);
        if (!stillVisible) {
            return "dismissed";
        }

        await clickDialogTopRight(modalDialog, page);
        const stillVisibleAfterCornerClick = await visibleModalTitle.isVisible().catch(() => false);
        if (!stillVisibleAfterCornerClick) {
            return "dismissed";
        }

        await dismissAnyOverlayQuick(page, 450);
    }

    return "still-visible";
};

const findGuestNameInput = async (page, timeoutMs) => {
    const candidateLocators = [
        page.getByRole("textbox", { name: /your name|name/i }).first(),
        page.locator('input[aria-label*="name" i]').first(),
        page.locator('input[placeholder*="name" i]').first(),
        page.locator('input[type="text"]').first(),
    ];

    for (const locator of candidateLocators) {
        const visible = await locator
            .waitFor({ state: "visible", timeout: 1500 })
            .then(() => true)
            .catch(() => false);

        if (visible) {
            return locator;
        }
    }

    await page.waitForTimeout(Math.min(timeoutMs, 1500));
    return null;
};

const setGuestDisplayName = async (page, participantName, timeoutMs) => {
    const trimmedName = participantName?.trim();

    if (!trimmedName) {
        throw createHttpError("participantName is required for anonymous join mode.", 400);
    }

    const nameInput = await findGuestNameInput(page, timeoutMs);

    if (!nameInput) {
        throw createHttpError("Could not find the name input in Meet pre-join screen.", 409);
    }

    await nameInput.click({ timeout: 3000 }).catch(() => {});
    await nameInput.fill("");
    await nameInput.type(trimmedName, { delay: 20 });

    const inputValue = await nameInput.inputValue().catch(() => "");

    if (!inputValue.trim()) {
        throw createHttpError("Failed to enter guest name automatically.", 500);
    }

    return inputValue.trim();
};

const ensureToggleIsOff = async ({
    page,
    controlName,
    offPatterns,
    onPatterns,
    findTimeoutMs,
    shortcutKeys,
}) => {
    let button = await findVisibleButton(page, [...offPatterns, ...onPatterns], findTimeoutMs);

    if (!button) {
        const controlsReachable = await canInteractWithPreJoinControls(page);

        if (controlsReachable) {
            await applyToggleShortcutFallback(page, shortcutKeys);

            button = await findVisibleButton(
                page,
                [...offPatterns, ...onPatterns],
                Math.min(findTimeoutMs, 2600),
            );

            if (!button) {
                return `${controlName}-shortcut-assumed-off`;
            }
        } else {
            throw createHttpError(`Could not find ${controlName} toggle in Meet pre-join screen.`);
        }
    }

    const beforeDescriptor = await getButtonDescriptor(button);

    if (offPatterns.some((pattern) => pattern.test(beforeDescriptor))) {
        return "already-off";
    }

    await button.click({ timeout: 5000 });
    await page.waitForTimeout(500);

    const afterDescriptor = await getButtonDescriptor(button);

    if (!offPatterns.some((pattern) => pattern.test(afterDescriptor))) {
        const controlsReachable = await canInteractWithPreJoinControls(page);
        if (controlsReachable) {
            await applyToggleShortcutFallback(page, shortcutKeys);
            return `${controlName}-unverified`;
        }

        throw createHttpError(`Failed to disable ${controlName} automatically.`);
    }

    return "toggled-off";
};

const ensureToggleIsOffBestEffort = async (params) => {
    try {
        return await ensureToggleIsOff(params);
    } catch {
        return `${params.controlName}-best-effort-skipped`;
    }
};

const clickJoinButton = async (page, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let lastModalState = "not-checked";

    while (Date.now() < deadline) {
        await dismissAnyOverlayQuick(page, 650);

        // This modal can appear late in signed-in mode and block Join button clickability.
        lastModalState = await dismissMeetMediaModalIfPresent(page, Math.min(timeoutMs, 1600));

        const joinButton = await findExplicitJoinButton(page)
            || await findVisibleButton(
                page,
                JOIN_BUTTON_PATTERNS,
                700,
            );

        if (joinButton) {
            const joinLabel = await getButtonDescriptor(joinButton);
            await joinButton.click({ timeout: 5000 });
            return joinLabel;
        }

        const inCallUiVisible = await isLikelyInCallUi(page);
        if (inCallUiVisible) {
            return "already-in-call";
        }

        const bodyText = await page.locator("body").innerText().catch(() => "");
        if (WAITING_ROOM_PATTERNS.some((pattern) => pattern.test(bodyText))) {
            return "already-waiting-room";
        }

        await page.waitForTimeout(120);
    }

    const bodyPreview = compactErrorMessage(
        await page.locator("body").innerText().catch(() => ""),
        260,
    );

    throw createHttpError(
        `Could not find Join button in Meet pre-join screen. Last media modal state: ${lastModalState}. Visible text snapshot: ${bodyPreview}`,
        409,
    );
};

const isLikelyInCallUi = async (page) => {
    const leaveCallButton = page.getByRole("button", { name: /leave call|leave meeting|end call|hang up/i }).first();
    const joinButton = page.getByRole("button", { name: /\bjoin now\b|\bask to join\b|\bjoin\b/i }).first();
    const chatButton = page.getByRole("button", { name: /chat with everyone|chat/i }).first();
    const peopleButton = page.getByRole("button", { name: /show everyone|participants|people/i }).first();
    const captionsButton = page.getByRole("button", { name: /captions|subtitles/i }).first();

    const [leaveVisible, joinVisible, chatVisible, peopleVisible, captionsVisible] = await Promise.all([
        leaveCallButton.isVisible().catch(() => false),
        joinButton.isVisible().catch(() => false),
        chatButton.isVisible().catch(() => false),
        peopleButton.isVisible().catch(() => false),
        captionsButton.isVisible().catch(() => false),
    ]);

    if (leaveVisible) {
        return true;
    }

    if (joinVisible) {
        return false;
    }

    return chatVisible || peopleVisible || captionsVisible;
};

const waitUntilJoined = async (page, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const bodyText = await page.locator("body").innerText().catch(() => "");

        if (WAITING_ROOM_PATTERNS.some((pattern) => pattern.test(bodyText))) {
            return "waiting-room";
        }

        if (MEETING_ENDED_PATTERNS.some((pattern) => pattern.test(bodyText))) {
            return "ended";
        }

        const inCallUiVisible = await isLikelyInCallUi(page);
        if (inCallUiVisible) {
            return "joined";
        }

        await page.waitForTimeout(350);
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (WAITING_ROOM_PATTERNS.some((pattern) => pattern.test(bodyText))) {
        return "waiting-room";
    }

    if (MEETING_ENDED_PATTERNS.some((pattern) => pattern.test(bodyText))) {
        return "ended";
    }

    const inCallUiVisible = await isLikelyInCallUi(page);
    if (inCallUiVisible) {
        return "joined";
    }

    return "not-confirmed";
};

const waitForHostAdmission = async (page, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    const leaveCallButton = page.getByRole("button", { name: /leave call|end call|hang up/i }).first();

    while (Date.now() < deadline) {
        const leaveVisible = await leaveCallButton.isVisible().catch(() => false);
        if (leaveVisible) {
            return "admitted";
        }

        const bodyText = await page.locator("body").innerText().catch(() => "");

        if (WAITING_ROOM_PATTERNS.some((pattern) => pattern.test(bodyText))) {
            await page.waitForTimeout(850);
            continue;
        }

        if (/meeting has ended|no longer available|you can'?t join this call/i.test(bodyText)) {
            return "ended";
        }

        await page.waitForTimeout(550);
    }

    return "timeout";
};

const ensureCaptionsEnabled = async (page, timeoutMs) => {
    let captionsButton = await findVisibleButton(
        page,
        [...CAPTIONS_ON_PATTERNS, ...CAPTIONS_OFF_PATTERNS],
        timeoutMs,
    );

    if (!captionsButton) {
        await page.keyboard.press("c").catch(() => {});
        await page.waitForTimeout(450);

        captionsButton = await findVisibleButton(
            page,
            [...CAPTIONS_ON_PATTERNS, ...CAPTIONS_OFF_PATTERNS],
            Math.min(timeoutMs, 2600),
        );

        if (!captionsButton) {
            return "not-found";
        }
    }

    const beforeDescriptor = await getButtonDescriptor(captionsButton);

    if (CAPTIONS_ON_PATTERNS.some((pattern) => pattern.test(beforeDescriptor))) {
        return "already-on";
    }

    await captionsButton.click({ timeout: 5000 });
    await page.waitForTimeout(600);

    const afterDescriptor = await getButtonDescriptor(captionsButton);

    if (!CAPTIONS_ON_PATTERNS.some((pattern) => pattern.test(afterDescriptor))) {
        await page.keyboard.press("c").catch(() => {});
        return "unverified";
    }

    return "enabled";
};

const startTranscriptCollector = async (page) => {
    await page.evaluate(() => {
        const NOISE_PATTERNS = [
            /^meeting details$/i,
            /^ready to join\?$/i,
            /^present now$/i,
            /^use companion mode$/i,
            /^share your screen$/i,
            /^more options$/i,
            /^chat with everyone$/i,
        ];

        const normalize = (value) => {
            return String(value || "").replace(/\s+/g, " ").trim();
        };

        const isNoise = (line) => {
            return NOISE_PATTERNS.some((pattern) => pattern.test(line));
        };

        const pushLine = (rawLine) => {
            const line = normalize(rawLine);

            if (!line || line.length < 3 || line.length > 300 || isNoise(line)) {
                return;
            }

            if (!window.__meetBotTranscriptSeen) {
                window.__meetBotTranscriptSeen = {};
            }

            if (!window.__meetBotTranscriptBuffer) {
                window.__meetBotTranscriptBuffer = [];
            }

            const key = line.toLowerCase();

            if (window.__meetBotTranscriptSeen[key]) {
                return;
            }

            window.__meetBotTranscriptSeen[key] = true;
            window.__meetBotTranscriptBuffer.push({
                ts: new Date().toISOString(),
                text: line,
            });

            if (window.__meetBotTranscriptBuffer.length > 2000) {
                window.__meetBotTranscriptBuffer.shift();
            }
        };

        const captureFromText = (rawText) => {
            const lines = String(rawText || "")
                .split(/\n+/)
                .map((line) => line.trim())
                .filter(Boolean);

            for (const line of lines) {
                pushLine(line);
            }
        };

        const captureNode = (node) => {
            if (!node) {
                return;
            }

            if (node.nodeType === Node.TEXT_NODE) {
                captureFromText(node.textContent);
                return;
            }

            if (node.nodeType !== Node.ELEMENT_NODE) {
                return;
            }

            const element = node;
            const selector = [
                '[aria-live="polite"]',
                '[aria-live="assertive"]',
                '[class*="caption" i]',
                '[class*="subtitle" i]',
                '[jsname="tgaKEf"]',
                '[data-self-name]',
            ].join(",");

            if (element.matches(selector)) {
                captureFromText(element.textContent);
            }

            const matchingDescendants = element.querySelectorAll(selector);
            matchingDescendants.forEach((item) => captureFromText(item.textContent));
        };

        if (window.__meetBotTranscriptObserver) {
            window.__meetBotTranscriptObserver.disconnect();
        }

        window.__meetBotTranscriptBuffer = [];
        window.__meetBotTranscriptSeen = {};

        captureNode(document.body);

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === "characterData") {
                    captureNode(mutation.target);
                    continue;
                }

                mutation.addedNodes.forEach((addedNode) => captureNode(addedNode));
                captureNode(mutation.target);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
        });

        window.__meetBotTranscriptObserver = observer;
    });
};

const getTranscriptEntryCount = async (page) => {
    return page
        .evaluate(() => {
            return Array.isArray(window.__meetBotTranscriptBuffer)
                ? window.__meetBotTranscriptBuffer.length
                : 0;
        })
        .catch(() => 0);
};

const getTranscriptEntriesSince = async (page, fromIndex = 0) => {
    return page
        .evaluate((startIndex) => {
            const entries = Array.isArray(window.__meetBotTranscriptBuffer)
                ? window.__meetBotTranscriptBuffer
                : [];

            if (!Number.isInteger(startIndex) || startIndex <= 0) {
                return entries;
            }

            return entries.slice(startIndex);
        }, fromIndex)
        .catch(() => []);
};

const logTranscriptEntries = (entries, onCaption) => {
    for (const entry of entries) {
        const captionLine = normalizeTranscriptLogText(entry?.text);

        if (!captionLine) {
            continue;
        }

        const timestamp = entry?.ts || new Date().toISOString();
        console.log(`[meetBot][caption][${timestamp}] ${captionLine}`);
        safeCallHook(onCaption, {
            ts: timestamp,
            text: captionLine,
        });
    }
};

const detectCaptureStopReason = async (page) => {
    if (page.isClosed()) {
        return "meeting-page-closed";
    }

    const leaveCallButton = page.getByRole("button", { name: /leave call|end call|hang up/i }).first();
    const [leaveCallVisible, bodyText] = await Promise.all([
        leaveCallButton.isVisible().catch(() => false),
        page.locator("body").innerText().catch(() => ""),
    ]);

    if (MEETING_ENDED_PATTERNS.some((pattern) => pattern.test(bodyText))) {
        return "meeting-ended";
    }

    if (!leaveCallVisible && /rejoin|return to home screen|meeting ended|call ended/i.test(bodyText)) {
        return "meeting-ended";
    }

    return "";
};

const waitForTranscriptWindow = async (
    page,
    {
        baseSeconds,
        idleGraceSeconds,
        maxSeconds,
        consoleLogIntervalMs = DEFAULT_TRANSCRIPT_CONSOLE_LOG_INTERVAL_MS,
        onCaption,
        shouldStop,
    },
) => {
    const startedAt = Date.now();
    const logEveryMs = toPositiveInt(
        consoleLogIntervalMs,
        DEFAULT_TRANSCRIPT_CONSOLE_LOG_INTERVAL_MS,
    );
    let lastCount = await getTranscriptEntryCount(page);
    let lastActivityAt = Date.now();
    let lastConsoleLogAt = Date.now();
    let lastLoggedIndex = 0;

    const flushPendingTranscriptLogs = async () => {
        const pendingEntries = await getTranscriptEntriesSince(page, lastLoggedIndex);

        if (pendingEntries.length > 0) {
            logTranscriptEntries(pendingEntries, onCaption);
            lastLoggedIndex += pendingEntries.length;
        }
    };

    logMeetBotStatus("Transcript collector started.", {
        captureMode: "event-driven-dom-observer",
        monitorTickMs: TRANSCRIPT_MONITOR_TICK_MS,
        consoleLogIntervalMs: logEveryMs,
    });

    while (true) {
        await page.waitForTimeout(TRANSCRIPT_MONITOR_TICK_MS).catch(() => {
            return;
        });

        const now = Date.now();

        if (typeof shouldStop === "function" && shouldStop()) {
            await flushPendingTranscriptLogs();

            const elapsedMs = now - startedAt;
            return {
                actualDurationSeconds: Math.max(1, Math.round(elapsedMs / 1000)),
                endReason: TERMINATED_BY_USER_REASON,
            };
        }

        const stopReason = await detectCaptureStopReason(page);

        if (stopReason) {
            await flushPendingTranscriptLogs();

            const elapsedMs = now - startedAt;
            return {
                actualDurationSeconds: Math.max(1, Math.round(elapsedMs / 1000)),
                endReason: stopReason,
            };
        }

        const currentCount = await getTranscriptEntryCount(page);

        if (currentCount > lastCount) {
            lastCount = currentCount;
            lastActivityAt = now;
        }

        if (now - lastConsoleLogAt >= logEveryMs) {
            const newEntries = await getTranscriptEntriesSince(page, lastLoggedIndex);

            if (newEntries.length > 0) {
                logTranscriptEntries(newEntries, onCaption);
                lastLoggedIndex += newEntries.length;
            } else {
                logMeetBotStatus("Transcript collector heartbeat.", {
                    totalCaptionLines: currentCount,
                    elapsedSeconds: Math.max(1, Math.round((now - startedAt) / 1000)),
                });
            }

            lastConsoleLogAt = now;
        }

        const elapsedMs = now - startedAt;
        const idleMs = now - lastActivityAt;

        if (elapsedMs >= baseSeconds * 1000 && idleMs >= idleGraceSeconds * 1000) {
            await flushPendingTranscriptLogs();

            return {
                actualDurationSeconds: Math.max(1, Math.round(elapsedMs / 1000)),
                endReason: "idle-after-base-window",
            };
        }

        if (elapsedMs >= maxSeconds * 1000) {
            await flushPendingTranscriptLogs();

            return {
                actualDurationSeconds: Math.max(1, Math.round(elapsedMs / 1000)),
                endReason: "max-window-reached",
            };
        }
    }
};

const stopTranscriptCollector = async (page) => {
    return page.evaluate(() => {
        if (window.__meetBotTranscriptObserver) {
            window.__meetBotTranscriptObserver.disconnect();
            window.__meetBotTranscriptObserver = null;
        }

        const entries = Array.isArray(window.__meetBotTranscriptBuffer)
            ? window.__meetBotTranscriptBuffer
            : [];

        const transcript = entries
            .map((entry) => `[${entry.ts}] ${entry.text}`)
            .join("\n");

        return { entries, transcript };
    });
};

const summarizeTranscriptWithGemini = async (transcript) => {
    if (!transcript || !transcript.trim()) {
        return "No transcript captured, so summary could not be generated.";
    }

    if (!process.env.GEMINI_API_KEY) {
        return "Transcript captured, but GEMINI_API_KEY is missing. Summary was skipped.";
    }

    const modelCandidates = getGeminiModelCandidates();

    const prompt = [
        "You are an AI meeting scribe.",
        "Summarize the meeting transcript in this exact structure:",
        "1) Executive summary",
        "2) Key discussion points (bullets)",
        "3) Action items (bullets with owners when detectable)",
        "4) Open questions or risks",
        "",
        "Transcript:",
        transcript,
    ].join("\n");

    const modelErrors = [];

    for (const model of modelCandidates) {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

        try {
            const response = await axios.post(endpoint, {
                contents: [
                    {
                        role: "user",
                        parts: [{ text: prompt }],
                    },
                ],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 900,
                },
            }, {
                timeout: 30000,
            });

            const summary = response?.data?.candidates?.[0]?.content?.parts
                ?.map((part) => part.text || "")
                .join("\n")
                .trim();

            if (summary) {
                return summary;
            }

            modelErrors.push({
                model,
                statusCode: 200,
                message: "empty summary",
            });
        } catch (error) {
            const errorInfo = formatGeminiModelError(model, error);
            modelErrors.push(errorInfo);

            if (!shouldContinueAfterGeminiError(errorInfo)) {
                break;
            }
        }
    }

    const details = modelErrors
        .slice(0, 4)
        .map((item) => `${item.model}${item.statusCode ? ` (${item.statusCode})` : ""}: ${item.message}`)
        .join(" | ");

    if (details) {
        return `Transcript captured, but summary generation failed across configured Gemini models: ${details}`;
    }

    return "Transcript captured, but summary generation failed for unknown reasons.";
};

const startMeetBot = async (payload, hooks = {}, runtime = {}) => {
    const { meetLink, participantName, joinAsGuest } = parseStartPayload(payload);
    const shouldStop = () => Boolean(runtime?.signal?.aborted);
    const trimmedLink = meetLink?.trim();
    const emitStatus = (status, details = {}) => {
        safeCallHook(hooks?.onStatus, {
            status,
            ...details,
        });
    };
    const emitJoined = (details = {}) => {
        safeCallHook(hooks?.onJoined, {
            ts: new Date().toISOString(),
            ...details,
        });
    };
    const emitCaption = (entry) => {
        safeCallHook(hooks?.onCaption, entry);
    };

    if (!trimmedLink) {
        throw createHttpError("meetLink is required", 400);
    }

    if (!isValidMeetLink(trimmedLink)) {
        throw createHttpError("Invalid Google Meet link format", 400);
    }

    if (joinAsGuest && !participantName?.trim()) {
        throw createHttpError("participantName is required for anonymous join mode.", 400);
    }

    logMeetBotStatus("Start request received.", {
        botFlowVersion: BOT_FLOW_VERSION,
        meetLink: trimmedLink,
        joinAsGuest,
        participantName: participantName?.trim() || "",
    });
    emitStatus("starting", {
        joinAsGuest,
    });

    const navigationTimeoutMs = toPositiveInt(
        process.env.MEET_NAVIGATION_TIMEOUT_MS,
        DEFAULT_NAVIGATION_TIMEOUT_MS,
    );
    const actionTimeoutMs = toPositiveInt(
        process.env.MEET_ACTION_TIMEOUT_MS,
        DEFAULT_ACTION_TIMEOUT_MS,
    );
    const joinConfirmTimeoutMs = toPositiveInt(
        process.env.MEET_JOIN_CONFIRM_TIMEOUT_MS,
        DEFAULT_JOIN_CONFIRM_TIMEOUT_MS,
    );
    const captureSeconds = toPositiveInt(
        process.env.TRANSCRIPT_CAPTURE_SECONDS,
        DEFAULT_TRANSCRIPT_CAPTURE_SECONDS,
    );
    const captureIdleGraceSeconds = toPositiveInt(
        process.env.TRANSCRIPT_IDLE_GRACE_SECONDS,
        DEFAULT_TRANSCRIPT_IDLE_GRACE_SECONDS,
    );
    const captureMaxSeconds = Math.max(
        captureSeconds,
        toPositiveInt(
            process.env.TRANSCRIPT_MAX_CAPTURE_SECONDS,
            DEFAULT_TRANSCRIPT_MAX_CAPTURE_SECONDS,
        ),
    );
    const waitingRoomTimeoutMs = toPositiveInt(
        process.env.MEET_WAITING_ROOM_TIMEOUT_MS,
        DEFAULT_WAITING_ROOM_TIMEOUT_MS,
    );
    const keepBrowserOpenOnPending = toBoolean(
        process.env.MEET_KEEP_BROWSER_OPEN_ON_PENDING,
        false,
    );
    const keepBrowserOpenOnAuthRequired = toBoolean(
        process.env.MEET_KEEP_BROWSER_OPEN_ON_AUTH_REQUIRED,
        true,
    );
    const fastPrejoinTimeoutMs = toPositiveInt(
        process.env.MEET_FAST_PREJOIN_TIMEOUT_MS,
        DEFAULT_FAST_PREJOIN_TIMEOUT_MS,
    );
    const fastJoinTimeoutMs = toPositiveInt(
        process.env.MEET_FAST_JOIN_TIMEOUT_MS,
        DEFAULT_FAST_JOIN_TIMEOUT_MS,
    );
    const transcriptConsoleLogIntervalMs = toPositiveInt(
        process.env.TRANSCRIPT_CONSOLE_LOG_INTERVAL_MS,
        DEFAULT_TRANSCRIPT_CONSOLE_LOG_INTERVAL_MS,
    );

    logMeetBotStatus("Runtime settings resolved.", {
        navigationTimeoutMs,
        actionTimeoutMs,
        joinConfirmTimeoutMs,
        captureSeconds,
        captureIdleGraceSeconds,
        captureMaxSeconds,
        transcriptConsoleLogIntervalMs,
        captureMode: "event-driven-dom-observer",
        monitorTickMs: TRANSCRIPT_MONITOR_TICK_MS,
        waitingRoomTimeoutMs,
        keepBrowserOpenOnPending,
        keepBrowserOpenOnAuthRequired,
        fastPrejoinTimeoutMs,
        fastJoinTimeoutMs,
        botFlowVersion: BOT_FLOW_VERSION,
    });

    let context;
    let browser;
    let skipCleanup = false;

    try {
        if (joinAsGuest) {
            logMeetBotStatus("Launching guest browser context.");
            const guestSession = await launchGuestContext();
            browser = guestSession.browser;
            context = guestSession.context;
        } else {
            logMeetBotStatus("Launching persistent browser context.", {
                userDataDir: getAutomationUserDataDir(),
            });
            context = await launchPersistentChromeContext();
        }

        await grantMeetMediaPermissions(context);

        logMeetBotStatus("Browser context ready.");

        const page = context.pages()[0] || (await context.newPage());
        await page.bringToFront();
        page.setDefaultTimeout(actionTimeoutMs);

        logMeetBotStatus("Opening Google Meet page.", {
            meetLink: trimmedLink,
        });

        await page.goto(trimmedLink, {
            waitUntil: "domcontentloaded",
            timeout: navigationTimeoutMs,
        });

        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        logMeetBotStatus("Google Meet page loaded.");

        if (!joinAsGuest && /accounts\.google\.com/i.test(page.url())) {
            if (keepBrowserOpenOnAuthRequired) {
                skipCleanup = true;

                logMeetBotStatus("Google sign-in required for automation profile. Keeping browser open for manual sign-in.", {
                    userDataDir: getAutomationUserDataDir(),
                });

                emitStatus("auth-required", {
                    pendingAuth: true,
                    captureEndReason: "auth-required",
                });

                return {
                    status: "Google sign-in required for the selected profile. Complete sign-in in the opened Chrome window, then click Start Meeting Bot again.",
                    joinButtonLabel: "",
                    transcript: "",
                    summary: "Sign-in was not detected for this profile yet. After signing in, run the bot again.",
                    transcriptLineCount: 0,
                    captureDurationSeconds: 0,
                    pendingApproval: false,
                    pendingAuth: true,
                    captureEndReason: "auth-required",
                };
            }

            throw createHttpError(
                "Automation profile is not logged into Google. Sign in once with CHROME_AUTOMATION_USER_DATA_DIR/CHROME_USER_DATA_DIR and retry.",
                400,
            );
        }

        const mediaModalState = await dismissMeetMediaModalIfPresent(page, actionTimeoutMs);
        logMeetBotStatus("Pre-join media modal check complete.", { mediaModalState });

        if (mediaModalState === "still-visible") {
            throw createHttpError(
                "Meet media modal is still blocking automation. Dismiss it once manually, then retry.",
                409,
            );
        }

        if (joinAsGuest) {
            const appliedName = await setGuestDisplayName(page, participantName, actionTimeoutMs);
            logMeetBotStatus("Guest name applied.", { participantName: appliedName });
            await dismissMeetMediaModalIfPresent(page, actionTimeoutMs);
        }

        await page.waitForTimeout(320);

        let joinButtonLabel = "";
        let joinState = "not-attempted";

        if (!joinAsGuest) {
            logMeetBotStatus("Attempting early join before extended pre-join checks.");
            await dismissAnyOverlayQuick(page, 1000);

            const earlyMediaModalState = await dismissMeetMediaModalIfPresent(
                page,
                Math.min(actionTimeoutMs, 1800),
            );
            logMeetBotStatus("Early join modal sweep complete.", { earlyMediaModalState });

            try {
                joinButtonLabel = await clickJoinButton(page, Math.min(fastJoinTimeoutMs, 3200));
                logMeetBotStatus("Early join action triggered.", { joinButtonLabel });

                if (joinButtonLabel === "already-in-call") {
                    joinState = "joined";
                } else if (joinButtonLabel === "already-waiting-room") {
                    joinState = "waiting-room";
                } else {
                    joinState = await waitUntilJoined(page, Math.min(joinConfirmTimeoutMs, 5000));
                }

                logMeetBotStatus("Early join confirmation result.", { joinState });

                if (joinState === "not-confirmed") {
                    joinState = "not-attempted";
                    joinButtonLabel = "";
                }
            } catch (error) {
                logMeetBotStatus("Early join attempt fell back to standard flow.", {
                    message: compactErrorMessage(error?.message),
                });

                joinState = "not-attempted";
                joinButtonLabel = "";
            }
        }

        if (joinState === "not-attempted") {
            if (!joinAsGuest) {
                logMeetBotStatus("Fast retry join (non-anonymous) without media-toggle waits.");
                await dismissAnyOverlayQuick(page, 900);

                const retryMediaModalState = await dismissMeetMediaModalIfPresent(
                    page,
                    Math.min(actionTimeoutMs, 1800),
                );
                logMeetBotStatus("Fast retry modal sweep complete.", { retryMediaModalState });

                joinButtonLabel = await clickJoinButton(page, Math.min(actionTimeoutMs, fastJoinTimeoutMs));
                logMeetBotStatus("Join action triggered.", { joinButtonLabel });

                if (joinButtonLabel === "already-in-call") {
                    joinState = "joined";
                } else if (joinButtonLabel === "already-waiting-room") {
                    joinState = "waiting-room";
                } else {
                    joinState = await waitUntilJoined(page, Math.min(joinConfirmTimeoutMs, 7000));
                }
            } else {
                await dismissAnyOverlayQuick(page, 900);

                await dismissMeetMediaModalIfPresent(page, Math.min(actionTimeoutMs, 2200));
                logMeetBotStatus("Ensuring microphone and camera are disabled before joining (guest-only fallback).");

                await applyToggleShortcutFallback(page, ["Meta+d", "Control+d"]);
                await applyToggleShortcutFallback(page, ["Meta+e", "Control+e"]);

                const microphoneState = await ensureToggleIsOffBestEffort({
                    page,
                    controlName: "microphone",
                    offPatterns: MIC_OFF_PATTERNS,
                    onPatterns: MIC_ON_PATTERNS,
                    findTimeoutMs: Math.min(actionTimeoutMs, fastPrejoinTimeoutMs),
                    shortcutKeys: ["Meta+d", "Control+d"],
                });

                const cameraState = await ensureToggleIsOffBestEffort({
                    page,
                    controlName: "camera",
                    offPatterns: CAMERA_OFF_PATTERNS,
                    onPatterns: CAMERA_ON_PATTERNS,
                    findTimeoutMs: Math.min(actionTimeoutMs, fastPrejoinTimeoutMs),
                    shortcutKeys: ["Meta+e", "Control+e"],
                });

                logMeetBotStatus("Pre-join media toggle result.", {
                    microphoneState,
                    cameraState,
                });

                const lateMediaModalState = await dismissMeetMediaModalIfPresent(
                    page,
                    Math.min(actionTimeoutMs, 2600),
                );
                logMeetBotStatus("Late pre-join media modal check complete.", { lateMediaModalState });

                joinButtonLabel = await clickJoinButton(page, Math.min(actionTimeoutMs, fastJoinTimeoutMs));
                logMeetBotStatus("Join action triggered.", { joinButtonLabel });

                if (joinButtonLabel === "already-in-call") {
                    joinState = "joined";
                } else if (joinButtonLabel === "already-waiting-room") {
                    joinState = "waiting-room";
                } else {
                    joinState = await waitUntilJoined(page, joinConfirmTimeoutMs);
                }
            }
        }
        logMeetBotStatus("Join confirmation result.", { joinState });

        if (joinState === "not-confirmed") {
            const postJoinModalState = await dismissMeetMediaModalIfPresent(
                page,
                Math.min(actionTimeoutMs, 4500),
            );

            logMeetBotStatus("Post-join media modal check complete.", { postJoinModalState });

            joinState = await waitUntilJoined(page, Math.min(9000, joinConfirmTimeoutMs));
            logMeetBotStatus("Join confirmation retry result.", { joinState });
        }

        if (joinState !== "joined") {
            if (joinState === "ended") {
                logMeetBotStatus("Meeting ended before join confirmation.");
                emitStatus("ended-before-join", {
                    captureEndReason: "meeting-ended-before-join",
                });

                return {
                    status: "Meeting appears to have ended before the bot could join.",
                    joinButtonLabel,
                    transcript: "",
                    summary: "Meeting ended or became unavailable before successful join.",
                    transcriptLineCount: 0,
                    captureDurationSeconds: 0,
                    pendingApproval: false,
                    captureEndReason: "meeting-ended-before-join",
                };
            }

            if (joinState === "waiting-room" || /ask to join/i.test(joinButtonLabel)) {
                logMeetBotStatus("Waiting for host admission.", {
                    waitingRoomTimeoutMs,
                });
                const admissionState = await waitForHostAdmission(page, waitingRoomTimeoutMs);
                logMeetBotStatus("Host admission check completed.", { admissionState });

                if (admissionState === "admitted") {
                    await page.waitForTimeout(800);
                } else {
                    if (keepBrowserOpenOnPending) {
                        skipCleanup = true;
                    }

                    const waitSeconds = Math.round(waitingRoomTimeoutMs / 1000);
                    const reason = admissionState === "ended"
                        ? "Meeting ended or became unavailable before admission."
                        : `No host admission within ${waitSeconds}s.`;

                    logMeetBotStatus("Returning pending-approval response.", {
                        reason,
                        keepBrowserOpenOnPending,
                    });

                    emitStatus("pending-approval", {
                        pendingApproval: true,
                        captureEndReason: "waiting-for-host-admission",
                        joinButtonLabel,
                    });

                    return {
                        status: "Bot entered your name, disabled mic/camera, and sent Ask to join. Waiting for host approval.",
                        joinButtonLabel,
                        transcript: "",
                        summary: `${reason} Transcript and summary begin only after admission.`,
                        transcriptLineCount: 0,
                        captureDurationSeconds: 0,
                        pendingApproval: true,
                        captureEndReason: "waiting-for-host-admission",
                    };
                }
            } else {
                const bodyPreview = compactErrorMessage(
                    await page.locator("body").innerText().catch(() => ""),
                    260,
                );

                logMeetBotStatus("Join could not be confirmed after retries.", {
                    joinButtonLabel,
                    bodyPreview,
                });

                throw createHttpError(
                    "Join click was sent, but bot could not confirm entry into the meeting. Please check if Meet is showing an intermediate screen (permissions, account chooser, or admission prompt) and retry.",
                    409,
                );
            }
        }

        emitJoined({
            joinButtonLabel,
            joinState,
        });
        emitStatus("joined", {
            joinButtonLabel,
        });

        const captionsState = await ensureCaptionsEnabled(page, actionTimeoutMs);
        logMeetBotStatus("Captions toggle result.", { captionsState });
        emitStatus("capturing", {
            joinButtonLabel,
            captionsState,
        });

        await startTranscriptCollector(page);
        logMeetBotStatus("Transcript collector initialized on Meet page.");

        const captureWindowResult = await waitForTranscriptWindow(page, {
            baseSeconds: captureSeconds,
            idleGraceSeconds: captureIdleGraceSeconds,
            maxSeconds: captureMaxSeconds,
            consoleLogIntervalMs: transcriptConsoleLogIntervalMs,
            onCaption: emitCaption,
            shouldStop,
        });

        logMeetBotStatus("Transcript capture window ended.", captureWindowResult);

        const { entries, transcript } = await stopTranscriptCollector(page);
        logMeetBotStatus("Transcript collector stopped.", {
            transcriptLineCount: entries.length,
        });

        if (captureWindowResult.endReason === TERMINATED_BY_USER_REASON) {
            emitStatus("terminated", {
                captureEndReason: TERMINATED_BY_USER_REASON,
            });

            return {
                status: "Meeting capture terminated by user.",
                joinButtonLabel,
                transcript,
                summary: transcript
                    ? "Capture was terminated by user. Partial transcript has been saved."
                    : "Capture was terminated by user before transcript lines were captured.",
                transcriptLineCount: entries.length,
                captureDurationSeconds: captureWindowResult.actualDurationSeconds,
                pendingApproval: false,
                captureEndReason: TERMINATED_BY_USER_REASON,
            };
        }

        logMeetBotStatus("Generating summary from captured transcript.", {
            transcriptLineCount: entries.length,
        });

        const summary = await summarizeTranscriptWithGemini(transcript);
        logMeetBotStatus("Summary generation completed.", {
            summaryLength: summary.length,
        });

        emitStatus("completed", {
            captureEndReason: captureWindowResult.endReason,
        });

        const endedEarly = ["meeting-ended", "meeting-page-closed"].includes(captureWindowResult.endReason);
        const captionsStatusPrefix = endedEarly
            ? "Meeting ended. Captured available transcript and generated summary from captured text."
            : captionsState === "not-found" || captionsState === "unverified"
                ? "Meeting joined automatically. Mic/camera disabled. Captions could not be fully verified, but transcript capture was attempted."
                : "Meeting joined automatically. Mic/camera disabled, captions enabled, transcript captured, summary generated.";

        return {
            status: captionsStatusPrefix,
            joinButtonLabel,
            transcript,
            summary,
            transcriptLineCount: entries.length,
            captureDurationSeconds: captureWindowResult.actualDurationSeconds,
            pendingApproval: false,
            captureEndReason: captureWindowResult.endReason,
        };
    } catch (error) {
        logMeetBotStatus("Bot run failed.", {
            message: error?.message || "Unknown error",
            statusCode: error?.statusCode || 500,
        });
        throw error;
    } finally {
        logMeetBotStatus("Cleaning up browser resources.", { skipCleanup });

        if (!skipCleanup && context) {
            await context.close().catch(() => {});
        }

        if (!skipCleanup && browser) {
            await browser.close().catch(() => {});
        }

        logMeetBotStatus("Cleanup complete.");
    }
};

module.exports = startMeetBot;