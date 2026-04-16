import { useEffect, useMemo, useRef, useState } from "react";
import {
  clearAuthSession,
  fetchMeetingHistory,
  fetchMe,
  getBotRunLive,
  getStoredSession,
  saveAuthSession,
  setAuthToken,
  signIn,
  signUp,
  startBot,
} from "./services/api";

function App() {
  const [sessionLoading, setSessionLoading] = useState(true);
  const [user, setUser] = useState(null);

  const [authMode, setAuthMode] = useState("signin");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });

  const [meetLink, setMeetLink] = useState("");
  const [customName, setCustomName] = useState("");
  const [joinAsGuest, setJoinAsGuest] = useState(false);
  const [useAccountName, setUseAccountName] = useState(true);
  const [statusMessage, setStatusMessage] = useState("");
  const [summary, setSummary] = useState("");
  const [transcript, setTranscript] = useState("");
  const [liveCaptions, setLiveCaptions] = useState([]);
  const [liveJoined, setLiveJoined] = useState(false);
  const [liveCaptionCount, setLiveCaptionCount] = useState(0);
  const [meetingHistory, setMeetingHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [meta, setMeta] = useState({
    usedParticipantName: "",
    transcriptLineCount: 0,
    captureDurationSeconds: 0,
    joinButtonLabel: "",
    pendingApproval: false,
    captureEndReason: "",
  });
  const [isStarting, setIsStarting] = useState(false);
  const livePollRef = useRef({ timerId: null, runId: "", nextIndex: 0 });

  const stopLivePolling = () => {
    if (livePollRef.current.timerId) {
      clearInterval(livePollRef.current.timerId);
    }

    livePollRef.current = { timerId: null, runId: "", nextIndex: 0 };
  };

  useEffect(() => {
    const initializeSession = async () => {
      const stored = getStoredSession();
      if (!stored.token) { setSessionLoading(false); return; }
      setAuthToken(stored.token);
      if (stored.user) setUser(stored.user);
      try {
        const me = await fetchMe();
        if (me?.user) { setUser(me.user); saveAuthSession({ token: stored.token, user: me.user }); }
      } catch { clearAuthSession(); setUser(null); }
      finally { setSessionLoading(false); }
    };
    initializeSession();

    return () => {
      stopLivePolling();
    };
  }, []);

  const effectiveName = useMemo(() => {
    if (useAccountName) return String(user?.name || "").trim();
    return customName.trim();
  }, [useAccountName, customName, user]);

  const updateAuthForm = (field, value) => setAuthForm((p) => ({ ...p, [field]: value }));

  const resetBotResults = () => {
    setSummary("");
    setTranscript("");
    setLiveCaptions([]);
    setLiveJoined(false);
    setLiveCaptionCount(0);
    setMeta({ usedParticipantName: "", transcriptLineCount: 0, captureDurationSeconds: 0, joinButtonLabel: "", pendingApproval: false, captureEndReason: "" });
  };

  const loadMeetingHistory = async () => {
    if (!user) {
      setMeetingHistory([]);
      setHistoryError("");
      setHistoryLoading(false);
      return;
    }

    setHistoryLoading(true);
    setHistoryError("");

    try {
      const response = await fetchMeetingHistory({ limit: 30 });
      setMeetingHistory(Array.isArray(response?.meetings) ? response.meetings : []);
    } catch (error) {
      if (error?.response?.status === 401) {
        setHistoryError("Session expired. Please sign in again.");
      } else {
        setHistoryError(error?.response?.data?.message || "Failed to load meeting history.");
      }
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (!user) {
      setMeetingHistory([]);
      setHistoryError("");
      setHistoryLoading(false);
      return;
    }

    void loadMeetingHistory();
  }, [user]);

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    const trimmedName = authForm.name.trim();
    const trimmedEmail = authForm.email.trim();
    if (authMode === "signup" && !trimmedName) { setAuthError("Name is required."); return; }
    if (!trimmedEmail) { setAuthError("Email is required."); return; }
    if (!authForm.password) { setAuthError("Password is required."); return; }
    setAuthError("");
    setAuthBusy(true);
    try {
      const authResponse = authMode === "signup"
        ? await signUp({ name: trimmedName, email: trimmedEmail, password: authForm.password })
        : await signIn({ email: trimmedEmail, password: authForm.password });
      saveAuthSession(authResponse);
      setUser(authResponse.user);
      setUseAccountName(true);
      setCustomName("");
      setAuthForm({ name: "", email: "", password: "" });
      setStatusMessage("");
      resetBotResults();
    } catch (error) {
      setAuthError(error?.response?.data?.message || "Authentication failed.");
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = () => {
    stopLivePolling();
    clearAuthSession();
    setUser(null);
    setAuthError("");
    setStatusMessage("");
    setMeetingHistory([]);
    setHistoryError("");
    setHistoryLoading(false);
    resetBotResults();
  };

  const handleStart = async () => {
    if (!user) { setStatusMessage("Please sign in first."); return; }
    const trimmedLink = meetLink.trim();
    if (!trimmedLink) { setStatusMessage("Please enter a Google Meet link."); return; }
    if (joinAsGuest && !effectiveName) { setStatusMessage("Provide a participant name or use account name."); return; }
    setIsStarting(true);
    setStatusMessage("Starting bot...");
    stopLivePolling();
    resetBotResults();

    const runId = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    livePollRef.current = {
      timerId: null,
      runId,
      nextIndex: 0,
    };

    const pollLive = async () => {
      if (livePollRef.current.runId !== runId) {
        return;
      }

      try {
        const live = await getBotRunLive({
          runId,
          fromIndex: livePollRef.current.nextIndex,
        });

        if (live?.joined) {
          setLiveJoined(true);
        }

        if (Array.isArray(live?.captions) && live.captions.length > 0) {
          setLiveCaptions((prev) => [...prev, ...live.captions]);
        }

        if (Number.isFinite(live?.nextIndex)) {
          livePollRef.current.nextIndex = live.nextIndex;
        }

        if (Number.isFinite(live?.totalCaptions)) {
          setLiveCaptionCount(live.totalCaptions);
        }

        if (live?.ended) {
          setLiveJoined(false);
          setLiveCaptions([]);
          setLiveCaptionCount(0);
          stopLivePolling();
        }
      } catch (error) {
        if (error?.response?.status === 401) {
          stopLivePolling();
          handleSignOut();
        }
      }
    };

    const startBotPromise = startBot({ meetLink: trimmedLink, participantName: effectiveName, joinAsGuest, runId });

    // Start live polling after the start request is already in-flight to avoid initial 404 race.
    void setTimeout(() => {
      void pollLive();
    }, 350);

    livePollRef.current.timerId = setInterval(() => {
      void pollLive();
    }, 1200);

    try {
      const res = await startBotPromise;
      setStatusMessage(res?.status || "Bot started.");
      setSummary(res?.summary || "");
      setTranscript(res?.transcript || "");
      setMeta({
        usedParticipantName: res?.usedParticipantName || effectiveName,
        transcriptLineCount: res?.transcriptLineCount || 0,
        captureDurationSeconds: res?.captureDurationSeconds || 0,
        joinButtonLabel: res?.joinButtonLabel || "",
        pendingApproval: Boolean(res?.pendingApproval),
        captureEndReason: res?.captureEndReason || "",
      });
    } catch (error) {
      const apiMessage = error?.response?.data?.message;
      setStatusMessage(apiMessage || "Failed to start bot. Check backend and try again.");
      if (error?.response?.status === 401) handleSignOut();
    } finally {
      stopLivePolling();
      setLiveJoined(false);
      setLiveCaptions([]);
      setLiveCaptionCount(0);
      setIsStarting(false);
      void loadMeetingHistory();
    }
  };

  /* Toggle component */
  const Toggle = ({ checked, onChange }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-200 focus:outline-none ${
        checked ? "bg-neutral-900" : "bg-neutral-200"
      }`}
    >
      <span className={`inline-block h-4 w-4 mt-0.5 rounded-full bg-white shadow transition-transform duration-200 ${
        checked ? "translate-x-4.5" : "translate-x-0.5"
      }`} />
    </button>
  );

  if (sessionLoading) {
    return (
      <div className="min-h-screen bg-[#F8F8F6] flex items-center justify-center">
        <div className="flex items-center gap-2.5 text-sm text-neutral-400">
          <span className="w-4 h-4 border-2 border-neutral-200 border-t-neutral-500 rounded-full animate-spin" />
          Restoring session…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F8F6]">

      {/* ── Navbar ── */}
      <header className="fixed inset-x-0 top-0 z-20 h-13 bg-[#F8F8F6]/80 backdrop-blur border-b border-neutral-200/70">
        <div className="max-w-2xl mx-auto px-5 h-full flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-neutral-900 grid place-items-center">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <rect x="1.5" y="2" width="8" height="1.2" rx="0.6" fill="white"/>
                <rect x="1.5" y="4.9" width="5" height="1.2" rx="0.6" fill="white"/>
                <rect x="1.5" y="7.8" width="6.5" height="1.2" rx="0.6" fill="white"/>
              </svg>
            </div>
            <span className="text-sm font-semibold text-neutral-900 tracking-tight">Scribe</span>
          </div>

          {user && (
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-full bg-neutral-900 grid place-items-center text-white text-[11px] font-bold">
                {user.name?.charAt(0).toUpperCase()}
              </div>
              <span className="text-sm text-neutral-500 hidden sm:block">{user.name}</span>
              <button
                onClick={handleSignOut}
                className="ml-1 text-xs text-neutral-400 hover:text-neutral-700 bg-transparent hover:bg-neutral-100 rounded-lg px-2.5 py-1.5 transition-all"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ── Main ── */}
      <main className="pt-13 flex flex-col items-center">
        <div className="w-full max-w-md px-4 py-14 space-y-3">

          {/* Page heading */}
          <div className="text-center pb-6">
            <span className="inline-block text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400 bg-neutral-100 px-2.5 py-1 rounded-full mb-3">
              Meet Automation
            </span>
            <h1 className="text-[28px] font-bold text-neutral-900 tracking-tight leading-tight">
              Meet AI Scribe
            </h1>
            <p className="mt-1.5 text-sm text-neutral-400">
              {user ? "Launch your meeting bot in seconds." : "Sign in to capture your meetings."}
            </p>
          </div>

          {!user ? (
            /* ── Auth ── */
            <div className="bg-white rounded-2xl border border-neutral-200/80 shadow-[0_1px_8px_rgba(0,0,0,0.06)] overflow-hidden">
              {/* Tabs */}
              <div className="flex">
                {["signin", "signup"].map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => { setAuthMode(mode); setAuthError(""); }}
                    className={`flex-1 py-3.5 text-sm font-medium transition-all border-b-2 ${
                      authMode === mode
                        ? "text-neutral-900 border-neutral-900 bg-white"
                        : "text-neutral-400 border-transparent bg-neutral-50 hover:text-neutral-600"
                    }`}
                  >
                    {mode === "signin" ? "Sign in" : "Sign up"}
                  </button>
                ))}
              </div>

              <form onSubmit={handleAuthSubmit} className="p-5 space-y-3.5">
                {authMode === "signup" && (
                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Name</label>
                    <input
                      type="text"
                      value={authForm.name}
                      onChange={(e) => updateAuthForm("name", e.target.value)}
                      placeholder="Your full name"
                      className="w-full bg-neutral-50 border border-neutral-200 rounded-xl px-3.5 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-300 focus:outline-none focus:bg-white focus:border-neutral-400 transition-all"
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Email</label>
                  <input
                    type="email"
                    value={authForm.email}
                    onChange={(e) => updateAuthForm("email", e.target.value)}
                    placeholder="you@example.com"
                    className="w-full bg-neutral-50 border border-neutral-200 rounded-xl px-3.5 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-300 focus:outline-none focus:bg-white focus:border-neutral-400 transition-all"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Password</label>
                  <input
                    type="password"
                    value={authForm.password}
                    onChange={(e) => updateAuthForm("password", e.target.value)}
                    placeholder="Minimum 6 characters"
                    className="w-full bg-neutral-50 border border-neutral-200 rounded-xl px-3.5 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-300 focus:outline-none focus:bg-white focus:border-neutral-400 transition-all"
                  />
                </div>

                {authError && (
                  <div className="flex gap-2.5 items-start bg-red-50 border border-red-100 rounded-xl px-3.5 py-3">
                    <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 16 16">
                      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4"/>
                      <path d="M8 5v3M8 10.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    <p className="text-sm text-red-600">{authError}</p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={authBusy}
                  className="w-full mt-1 bg-neutral-900 hover:bg-neutral-700 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl py-2.5 transition-all"
                >
                  {authBusy ? "Please wait…" : authMode === "signin" ? "Sign in →" : "Create account →"}
                </button>
              </form>
            </div>

          ) : (
            /* ── Bot Panel ── */
            <>
              {/* Control card */}
              <div className="bg-white rounded-2xl border border-neutral-200/80 shadow-[0_1px_8px_rgba(0,0,0,0.06)] p-5 space-y-4">

                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Meet Link</label>
                  <input
                    type="text"
                    placeholder="https://meet.google.com/abc-defg-hij"
                    value={meetLink}
                    onChange={(e) => setMeetLink(e.target.value)}
                    className="w-full bg-neutral-50 border border-neutral-200 rounded-xl px-3.5 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-300 focus:outline-none focus:bg-white focus:border-neutral-400 transition-all"
                  />
                </div>

                <div className="h-px bg-neutral-100" />

                {/* Toggles */}
                <div className="space-y-3">
                  <label className="flex items-center justify-between gap-3 cursor-pointer">
                    <span className="text-sm text-neutral-700">Join anonymously</span>
                    <Toggle checked={joinAsGuest} onChange={setJoinAsGuest} />
                  </label>

                  {joinAsGuest && (
                    <div className="space-y-3 pl-0">
                      <label className="flex items-center justify-between gap-3 cursor-pointer">
                        <span className="text-sm text-neutral-500">
                          Use account name
                          <span className="ml-1.5 text-neutral-300">({user.name})</span>
                        </span>
                        <Toggle checked={useAccountName} onChange={setUseAccountName} />
                      </label>

                      {!useAccountName && (
                        <input
                          type="text"
                          placeholder="Custom participant name"
                          value={customName}
                          onChange={(e) => setCustomName(e.target.value)}
                          className="w-full bg-neutral-50 border border-neutral-200 rounded-xl px-3.5 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-300 focus:outline-none focus:bg-white focus:border-neutral-400 transition-all"
                        />
                      )}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handleStart}
                  disabled={isStarting}
                  className="w-full flex items-center justify-center gap-2 bg-neutral-900 hover:bg-neutral-700 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl py-3 transition-all"
                >
                  {isStarting ? (
                    <>
                      <span className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                      Starting…
                    </>
                  ) : (
                    <>
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                        <path d="M2.5 2l8 4.5-8 4.5V2z" fill="currentColor"/>
                      </svg>
                      Start Meeting Bot
                    </>
                  )}
                </button>
              </div>

              {/* Status message */}
              {statusMessage && (
                <div className="flex items-start gap-3 bg-white rounded-2xl border border-neutral-200/80 shadow-[0_1px_8px_rgba(0,0,0,0.04)] px-4 py-3.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-1.5 shrink-0" />
                  <p className="text-sm text-neutral-600">{statusMessage}</p>
                </div>
              )}

              {/* Meta chips */}
              {(meta.usedParticipantName || meta.captureEndReason) && (
                <div className="flex flex-wrap gap-2 px-1">
                  {meta.usedParticipantName && (
                    <span className="text-xs bg-neutral-100 text-neutral-500 rounded-full px-3 py-1">
                      👤 {meta.usedParticipantName}
                    </span>
                  )}
                  {meta.captureEndReason && (
                    <span className="text-xs bg-neutral-100 text-neutral-500 rounded-full px-3 py-1">
                      Ended · {meta.captureEndReason}
                    </span>
                  )}
                </div>
              )}

              {/* Pending approval */}
              {meta.pendingApproval && (
                <div className="flex items-start gap-3 bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3.5">
                  <svg className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 16 16">
                    <path d="M8 2.5L13.5 13H2.5L8 2.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
                    <path d="M8 6.5v3M8 11v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                  </svg>
                  <p className="text-sm text-amber-700">Waiting for host approval to start capture.</p>
                </div>
              )}

              {/* Live captions (only after join) */}
              {liveJoined && (
                <div className="bg-white rounded-2xl border border-neutral-200/80 shadow-[0_1px_8px_rgba(0,0,0,0.06)] p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-5 rounded-md bg-emerald-50 border border-emerald-100 grid place-items-center">
                        <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                          <path d="M2 4.5h5M2 2.5h5M2 6.5h3" stroke="#059669" strokeWidth="1.1" strokeLinecap="round"/>
                        </svg>
                      </div>
                      <h2 className="text-sm font-semibold text-neutral-800">Live Captions</h2>
                    </div>
                    <span className="text-xs text-neutral-400">{liveCaptionCount} lines</span>
                  </div>

                  {liveCaptions.length > 0 ? (
                    <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-600 font-sans">
                      {liveCaptions.map((entry) => `[${entry.ts}] ${entry.text}`).join("\n")}
                    </pre>
                  ) : (
                    <p className="text-sm text-neutral-400">Joined successfully. Waiting for incoming captions...</p>
                  )}
                </div>
              )}

              {/* Meeting History */}
              <div className="bg-white rounded-2xl border border-neutral-200/80 shadow-[0_1px_8px_rgba(0,0,0,0.06)] p-5">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-neutral-800">Meeting History</h2>
                  <button
                    type="button"
                    onClick={() => { void loadMeetingHistory(); }}
                    disabled={historyLoading}
                    className="text-xs text-neutral-500 hover:text-neutral-800 disabled:opacity-50"
                  >
                    {historyLoading ? "Refreshing..." : "Refresh"}
                  </button>
                </div>

                {historyLoading ? (
                  <p className="text-sm text-neutral-400">Loading history...</p>
                ) : historyError ? (
                  <p className="text-sm text-red-500">{historyError}</p>
                ) : meetingHistory.length === 0 ? (
                  <p className="text-sm text-neutral-400">No meetings in history yet.</p>
                ) : (
                  <div className="space-y-3">
                    {meetingHistory.map((meeting) => {
                      const createdAtText = meeting?.createdAt
                        ? new Date(meeting.createdAt).toLocaleString()
                        : "Unknown time";
                      const summaryPreview = String(meeting?.summary || "").trim();

                      return (
                        <div key={meeting.id} className="rounded-xl border border-neutral-200 bg-neutral-50 px-3.5 py-3">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs text-neutral-500">{createdAtText}</p>
                            <span className="text-[11px] uppercase tracking-wide text-neutral-500">{meeting?.status || "unknown"}</span>
                          </div>

                          <p className="mt-1 text-xs text-neutral-400 break-all">{meeting?.meetLink || ""}</p>

                          <div className="mt-2 flex items-center gap-2 text-xs text-neutral-500">
                            <span>{meeting?.transcriptLineCount || 0} lines</span>
                            <span className="w-1 h-1 rounded-full bg-neutral-300" />
                            <span>{meeting?.captureDurationSeconds || 0}s</span>
                            {meeting?.captureEndReason && (
                              <>
                                <span className="w-1 h-1 rounded-full bg-neutral-300" />
                                <span>{meeting.captureEndReason}</span>
                              </>
                            )}
                          </div>

                          {summaryPreview && (
                            <p className="mt-2 text-sm text-neutral-600">
                              {summaryPreview.length > 220 ? `${summaryPreview.slice(0, 220)}...` : summaryPreview}
                            </p>
                          )}

                          {meeting?.errorMessage && (
                            <p className="mt-2 text-xs text-red-500">{meeting.errorMessage}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Summary */}
              {summary && (
                <div className="bg-white rounded-2xl border border-neutral-200/80 shadow-[0_1px_8px_rgba(0,0,0,0.06)] p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-5 h-5 rounded-md bg-violet-50 border border-violet-100 grid place-items-center">
                      <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                        <path d="M1 1.5h7M1 4.5h4.5M1 7.5h5.5" stroke="#7C3AED" strokeWidth="1.1" strokeLinecap="round"/>
                      </svg>
                    </div>
                    <h2 className="text-sm font-semibold text-neutral-800">Summary</h2>
                  </div>
                  <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-600 font-sans">{summary}</pre>
                </div>
              )}

              {/* Transcript */}
              {transcript && (
                <div className="bg-white rounded-2xl border border-neutral-200/80 shadow-[0_1px_8px_rgba(0,0,0,0.06)] p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-5 rounded-md bg-blue-50 border border-blue-100 grid place-items-center">
                        <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                          <rect x="1" y="1" width="7" height="7" rx="1" stroke="#3B82F6" strokeWidth="1.1"/>
                          <path d="M2.5 3.5h4M2.5 5.5h2.5" stroke="#3B82F6" strokeWidth="1.1" strokeLinecap="round"/>
                        </svg>
                      </div>
                      <h2 className="text-sm font-semibold text-neutral-800">Transcript</h2>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-neutral-400">
                      <span>{meta.transcriptLineCount} lines</span>
                      <span className="w-1 h-1 rounded-full bg-neutral-200" />
                      <span>{meta.captureDurationSeconds}s</span>
                    </div>
                  </div>
                  <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-600 font-sans">{transcript}</pre>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;