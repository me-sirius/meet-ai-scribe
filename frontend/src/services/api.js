import axios from "axios";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

const TOKEN_STORAGE_KEY = "meetScribeToken";
const USER_STORAGE_KEY = "meetScribeUser";

const api = axios.create({
    baseURL: API_BASE_URL,
});

export const setAuthToken = (token) => {
    if (token) {
        api.defaults.headers.common.Authorization = `Bearer ${token}`;
        return;
    }

    delete api.defaults.headers.common.Authorization;
};

export const saveAuthSession = ({ token, user }) => {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
    setAuthToken(token);
};

export const clearAuthSession = () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);
    setAuthToken("");
};

export const getStoredSession = () => {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY) || "";
    const userRaw = localStorage.getItem(USER_STORAGE_KEY);

    let user = null;
    if (userRaw) {
        try {
            user = JSON.parse(userRaw);
        } catch {
            user = null;
        }
    }

    return { token, user };
};

export const signUp = async ({ name, email, password }) => {
    const response = await api.post("/auth/signup", {
        name,
        email,
        password,
    });

    return response.data;
};

export const signIn = async ({ email, password }) => {
    const response = await api.post("/auth/login", {
        email,
        password,
    });

    return response.data;
};

export const fetchMe = async () => {
    const response = await api.get("/auth/me");
    return response.data;
};

export const startBot = async ({ meetLink, participantName, joinAsGuest, runId }) => {

    const response = await api.post(
        "/start-bot",
        {
            meetLink,
            participantName,
            joinAsGuest,
            runId,
        }
    );

    return response.data;
};

export const getBotRunLive = async ({ runId, fromIndex = 0 }) => {
    const response = await api.get(`/bot-run/${encodeURIComponent(runId)}/live`, {
        params: {
            fromIndex,
        },
    });

    return response.data;
};

export const fetchMeetingHistory = async ({ limit = 20 } = {}) => {
    const response = await api.get("/meetings", {
        params: {
            limit,
        },
    });

    return response.data;
};